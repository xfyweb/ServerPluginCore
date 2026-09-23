// 单插件装载与卸载（docs/plugin-lifecycle-design.md §5）
//
// 顺序是契约的一部分，不要"顺手调换"：
//   装载：目录/入口 → 依赖 → 沙箱+限额 → bundle+导出契约 → 能力登记 → init → start
//   卸载：stop → 撤销能力登记 → dispose（**stop 抛错或超时都继续**，绝不为一个插件卡住核心）
//
// 失败回滚：装载过程中任何一步失败，都必须把"已登记的"和"已建的沙箱"清掉，
// 不留半装载状态（否则重载会叠加能力，卸载会漏释放 handle → QuickJS GC 断言）。
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { transform, type Loader } from 'esbuild';
import type { Manifest } from '../../sdk/types';
import { validateManifest } from '../../sdk/validate';
import { audit, digest, digestParams } from '../audit';
import { ensureDir, pluginDataDir, type PluginLimits } from '../config';
import { SpcError, toErrorShape } from '../errors';
import { buildHostApi } from '../hostApi';
import { createSandbox, type Sandbox, type SandboxBridge } from '../sandbox';
import { capabilities } from './capabilities';
import { loadPluginConfig } from './config';
import { pluginRef, type PluginRecord } from './records';

/** 卸载原因（§12-2：stop 是否接收 reason 尚在待定，这里先用于审计，不注入钩子签名） */
export type StopReason = 'reload' | 'disable' | 'shutdown' | 'failed' | 'uninstall';

export interface LoadDeps {
  limits: PluginLimits;
  /**
   * 依赖是否就绪；不就绪时给出原因，好让这里报准确的码：
   * `missing` = 未安装或未启用；`not-loaded` = 已启用但当前没在跑（例如它自己 failed）。
   */
  dependencyStatus(
    id: string,
  ): { ok: true } | { ok: false; reason: 'missing' | 'not-loaded'; state?: string };
  /** 插件日志出口 */
  logger?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** 一个已装载（init/start 成功）的插件句柄 */
export interface RunningPlugin {
  record: PluginRecord;
  manifest: Manifest;
  /** 主题包没有沙箱（无 JS、豁免 init）；能力插件必有 */
  sandbox?: Sandbox;
  /** 本次登记的能力清单（与记录里的 capabilities 一致） */
  capabilities: string[];
  dataDir: string;
}

function auditLifecycle(
  pluginId: string,
  method: string,
  result: 'ok' | 'error',
  started: number,
  extra?: { cause?: string; paramsDigest?: string; suspendedMs?: number },
): void {
  audit({
    ts: Date.now(),
    pluginId,
    method,
    target: pluginId,
    paramsDigest: extra?.paramsDigest ?? digest(pluginId),
    result,
    error: result === 'error' ? { code: extra?.cause ?? 'PLUGIN_ERROR' } : undefined,
    // 挂起时长与 durationMs 分列：插件"自己算了 3 秒"与"等宿主 I/O 3 秒"是两件事（见 AuditEntry.suspendedMs）
    suspendedMs: extra?.suspendedMs,
    durationMs: Date.now() - started,
  });
}

/** 读 + 校验某目录下的插件清单（install 的输入；也是装载前的一致性检查） */
export function readManifestFromDir(dir: string): Manifest {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new SpcError('PLUGIN_MANIFEST_INVALID', { dir, detail: 'manifest.json missing' });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new SpcError('PLUGIN_MANIFEST_INVALID', {
      dir,
      detail: err instanceof Error ? err.message : 'malformed json',
    });
  }
  const check = validateManifest(raw);
  if (!check.ok) {
    throw new SpcError('PLUGIN_MANIFEST_INVALID', { dir, detail: check.errors.join('; ') });
  }
  return raw as Manifest;
}

/** 读 + 校验插件清单（记录里的 dir 是可信来源；目录扫描只是 install 的输入） */
export function readRecordManifest(record: PluginRecord): Manifest {
  const manifest = readManifestFromDir(record.dir);
  if (manifest.id !== record.id) {
    // 记录与清单对不上：宁可拒载，也不要"装的是 A、跑的是 B"
    throw new SpcError('PLUGIN_MANIFEST_INVALID', {
      pluginId: record.id,
      detail: `manifest id mismatch: ${manifest.id}`,
    });
  }
  return manifest;
}

function bundleLoaderFor(entry: string): Loader {
  const ext = extname(entry).toLowerCase();
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'ts';
  if (ext === '.jsx' || ext === '.tsx') return 'tsx';
  return 'js';
}

/** 调用钩子并记 lifecycle.<hook> 审计（result + durationMs + suspendedMs） */
async function runHook(
  sandbox: Sandbox,
  hook: 'init' | 'start' | 'stop',
  pluginId: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  try {
    await sandbox.callHook(hook, timeoutMs);
    auditLifecycle(pluginId, `lifecycle.${hook}`, 'ok', started, {
      suspendedMs: sandbox.lastSuspendedMs(),
    });
  } catch (err) {
    const shape = toErrorShape(err);
    auditLifecycle(pluginId, `lifecycle.${hook}`, 'error', started, {
      cause: shape?.code,
      // 失败路径也要这笔账：**超时**恰恰是最需要知道"时间花在等宿主还是在跑插件"的场合
      suspendedMs: sandbox.lastSuspendedMs(),
    });
    throw err;
  }
}

/**
 * 装载一个插件（含 init / start）。
 * 失败时自行回滚（撤销能力登记 + dispose 沙箱）后抛出，调用方只负责落 failed 状态。
 */
export async function loadPlugin(record: PluginRecord, deps: LoadDeps): Promise<RunningPlugin> {
  const id = record.id;
  const dir = record.dir;
  // 生命周期层一律用**完整引用**（身份是 `(origin, id)`：同 id 不同来源是两个插件，
  // 审计与错误里带裸 id 就分不清是谁）。⚠️ 沙箱运行时的 `ctx.pluginId` 仍是裸 id —— 那一层统一改
  // 是紧随其后的一小批（见 docs/events-and-hooks-design.md §4.3 的 ②b）。
  const ref = pluginRef(record);

  // 1) 目录 / 清单（P4 之后在此加：验签 + verifiedMeta 文件哈希校验）
  if (!existsSync(dir)) {
    throw new SpcError('PLUGIN_DIR_MISSING', { pluginId: ref, dir });
  }
  const manifest = readRecordManifest(record);
  const isTheme = (manifest.type ?? 'ability') === 'theme';

  // 2) 依赖检查（P1.5：只查直接依赖、不解析 version 区间；装载顺序由 manager 的拓扑排序保证）
  //    「已启用」不够——依赖必须**已经在跑**，否则依赖方会进入一个它本不该能进入的状态
  for (const dep of manifest.dependencies?.plugins ?? []) {
    // 依赖按**完整引用**找；声明里省略 `origin` ⇒ 同源简写（取依赖方自己的来源，§7.1）
    const depRef = pluginRef({ origin: dep.origin ?? record.origin, id: dep.id });
    const status = deps.dependencyStatus(depRef);
    if (status.ok) continue;
    if (status.reason === 'missing') {
      throw new SpcError('PLUGIN_DEPENDENCY_MISSING', { pluginId: ref, dependency: depRef });
    }
    throw new SpcError('PLUGIN_DEPENDENCY_NOT_LOADED', {
      pluginId: ref,
      dependency: depRef,
      state: status.state ?? 'unknown',
    });
  }

  // 数据目录由宿主创建并保证存在：这是插件唯一可写位置（也是 fs 权限点的作用域）
  const dataDir = ensureDir(pluginDataDir(record.origin, id));
  // `os.tmpdir()` 返回的是 **`<dataDir>/tmp`**（设计 §13.1-2：返回宿主 tmp 会让插件一用就 EACCES），
  // 所以这个目录也得**宿主建好**——否则 `tmp`、`fs.mkdtempSync(os.tmpdir()+'/x-')` 这类用法直接 ENOENT
  // （实测：`tmp` 包默认 dir 就是 os.tmpdir()，装载期就炸）。放这儿而不是 os 仿真层：
  // 那是只读快照，不该有副作用。
  ensureDir(join(dataDir, 'tmp'));

  // 主题包：无后端脚本 → 不建沙箱、不要求 init，装载只做"登记主题令牌"（§1.2）
  if (isTheme) {
    const entry = typeof manifest.theme === 'string' ? manifest.theme.trim() : '';
    if (entry.length === 0 || !existsSync(join(dir, entry))) {
      throw new SpcError('PLUGIN_NO_ENTRY', { pluginId: id, hook: 'theme' });
    }
    const caps = capabilities.register(ref, manifest, entry);
    return { record, manifest, capabilities: caps, dataDir };
  }

  // 3) 沙箱 + 四层限额（内存/栈在 createSandbox 里装配；CPU 中断按钩子设 deadline）
  const config = loadPluginConfig(record.origin, id, manifest.configSchema);
  const entry = manifest.entry ?? 'main.ts';
  const entryPath = join(dir, entry);
  if (!existsSync(entryPath)) {
    throw new SpcError('PLUGIN_NO_ENTRY', { pluginId: ref, hook: 'entry', path: entry });
  }

  const bridge: SandboxBridge = {};
  const sandbox = await createSandbox(
    buildHostApi({
      pluginId: id,
      dataDir,
      declaredTopics: (manifest.exports?.events?.publish ?? []).map((e) => e.topic),
      bridge,
    }),
    {
      pluginId: id,
      permissions: manifest.permissions.map((p) => p.name),
      grants: record.grants,
      limits: deps.limits,
      facts: { version: manifest.version, dataDir, manifest, config },
      logger: deps.logger,
      bridge,
    },
  );

  let caps: string[] = [];
  try {
    // 4) 构建期雏形（TS → ESM JS）→ 载入 + 导出契约校验（缺 init → PLUGIN_NO_ENTRY）
    const { code } = await transform(readFileSync(entryPath, 'utf8'), {
      loader: bundleLoaderFor(entry),
      format: 'esm',
      target: 'es2022',
    });
    await sandbox.runModule(id, code);
    if (!sandbox.hasFunctionExport('init')) {
      throw new SpcError('PLUGIN_NO_ENTRY', { pluginId: ref, hook: 'init' });
    }

    // 5) 能力登记（插件不参与；冲突 → PLUGIN_EXPORT_INVALID 且不留半登记状态）
    caps = capabilities.register(ref, manifest);

    // 6/7) init（准备）→ start（开始工作）；都是可选的 start 除外
    await runHook(sandbox, 'init', ref, deps.limits.initTimeoutMs);
    if (sandbox.hasFunctionExport('start')) {
      await runHook(sandbox, 'start', ref, deps.limits.startTimeoutMs);
    }
  } catch (err) {
    // 回滚：能力登记先撤（否则重载会叠加），再释放沙箱 handle
    capabilities.revoke(ref);
    try {
      sandbox.dispose();
    } catch {
      /* dispose 失败不掩盖原始错误 */
    }
    throw err;
  }

  return { record, manifest, sandbox, capabilities: caps, dataDir };
}

/**
 * 卸载（stop → 撤销能力登记 → dispose）。
 * stop 抛错或超时**都继续卸载**：只告警 + 审计，绝不因一个插件卡住核心停机。
 */
export async function unloadPlugin(
  run: RunningPlugin,
  reason: StopReason,
  limits: PluginLimits,
): Promise<void> {
  const ref = pluginRef(run.record);
  const auditParams = digestParams({ reason });
  if (run.sandbox && run.sandbox.hasFunctionExport('stop')) {
    try {
      await runHook(run.sandbox, 'stop', ref, limits.stopTimeoutMs);
    } catch (err) {
      const shape = toErrorShape(err);
      console.warn(
        `[plugin] ${ref} stop 未正常结束（${shape?.code ?? 'PLUGIN_STOP_FAILED'}），继续卸载`,
      );
      auditLifecycle(ref, 'lifecycle.stop', 'error', Date.now(), {
        cause: shape?.code,
        paramsDigest: auditParams,
      });
    }
  }
  capabilities.revoke(ref);
  run.sandbox?.dispose();
  auditLifecycle(ref, 'lifecycle.unload', 'ok', Date.now(), { paramsDigest: auditParams });
}
