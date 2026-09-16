// 核心最小配置面 + 状态目录统一（docs/plugin-lifecycle-design.md §1.4/§1.6/§10/§12-5）
//
// 状态目录统一（§12-5 定的方向）：
//   SPC_STATE_DIR（默认 <repo>/.spc）是**基座**，其下：
//     config.json                     ← 本文件的配置面
//     plugins.json                    ← 安装记录（core/plugin/records.ts）
//     config/plugins/<sanitized>.json ← 插件配置值（core/plugin/config.ts）
//     data/plugins/<sanitized>/       ← 插件数据目录（ctx.dataDir，插件唯一可写位置）
//     audit/audit.jsonl               ← 审计
//     keyring.json                    ← 源与密钥
//   SPC_AUDIT_DIR / SPC_KEYRING_DIR / SPC_DATA_DIR 降级为**覆盖项**——避免三套状态目录变量并存。
//
// 路径一律用**函数**求值（不在模块加载时固化成常量）：测试可以在动态 import 前设置环境变量，
// 运行期也允许覆盖。core/audit.ts 的模块级常量是历史包袱，但它的默认值现在从这里取，保证两者一致。
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpcError } from './errors';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 状态目录基座：SPC_STATE_DIR 覆盖，默认 <repo>/.spc */
export function stateDir(): string {
  return process.env.SPC_STATE_DIR ?? join(__dirname, '..', '.spc');
}

/** 插件数据根：SPC_DATA_DIR 覆盖，默认 <STATE_DIR>/data（插件数据在 data/plugins/<sanitized>/） */
export function dataDir(): string {
  return process.env.SPC_DATA_DIR ?? join(stateDir(), 'data');
}

/** 审计目录：SPC_AUDIT_DIR 覆盖，默认 <STATE_DIR>/audit */
export function auditDir(): string {
  return process.env.SPC_AUDIT_DIR ?? join(stateDir(), 'audit');
}

/** 配置面文件（§10） */
export function configFile(): string {
  return join(stateDir(), 'config.json');
}

/** 安装记录文件（§6） */
export function pluginsFile(): string {
  return join(stateDir(), 'plugins.json');
}

/** 插件配置值目录（§1.6） */
export function pluginConfigDir(): string {
  return join(stateDir(), 'config', 'plugins');
}

/**
 * 插件 ID → 目录名（§1.4）：`@xfy2412/hello` → `xfy2412__hello`。
 * 映射唯一且可读；同时是路径收敛的**唯一入口**——所有由 ID 拼出来的路径都必须过这里，
 * 否则 ID 里的 `/` 或 `..` 就能逃出数据目录。
 */
export function sanitizePluginId(id: string): string {
  const safe = id.replace(/^@/, '').replace(/[/\\]/g, '__').replace(/[^a-zA-Z0-9_.-]/g, '_');
  // 双保险：即使上面的替换被绕过，也不允许出现路径分隔与上跳
  if (safe.includes('/') || safe.includes('\\') || safe.includes('..') || safe.length === 0) {
    throw new SpcError('PLUGIN_ID_INVALID', { id });
  }
  return safe;
}

/** 插件数据目录（宿主创建并保证存在；插件唯一可写位置） */
export function pluginDataDir(id: string): string {
  return join(dataDir(), 'plugins', sanitizePluginId(id));
}

/** 插件配置值文件 */
export function pluginConfigPath(id: string): string {
  return join(pluginConfigDir(), `${sanitizePluginId(id)}.json`);
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

// ---- 配置面（§10）----

/** 四层限额的配置值（§4.1；timerTimeoutMs 见 limits.ts 注释——设计清单未列，为实现所需新增） */
export interface PluginLimits {
  /** 内存上限（QuickJS setMemoryLimit） */
  memoryBytes: number;
  /** 栈上限（QuickJS setMaxStackSize） */
  maxStackBytes: number;
  /** init 钩子 CPU 中断 deadline */
  initTimeoutMs: number;
  /** start 钩子 */
  startTimeoutMs: number;
  /** stop 钩子（超时后强制卸载，绝不为一个插件卡住核心） */
  stopTimeoutMs: number;
  /** 定时器回调的 CPU 中断 deadline */
  timerTimeoutMs: number;
}

export type FailedRestart = 'manual' | 'auto';

export interface SpcConfig {
  configSchema: 1;
  plugin: {
    limits: PluginLimits;
    /** 失败后是否自动重启（默认 manual：只落审计 + 状态 failed，等管理员 reload） */
    failedRestart: FailedRestart;
    /** auto 时的连续失败上限，成功后清零 */
    maxRestartAttempts: number;
    /** auto 时的线性退避 */
    restartBackoffMs: number;
  };
}

export const DEFAULT_LIMITS: PluginLimits = {
  memoryBytes: 32 * 1024 * 1024, // 32 MiB
  maxStackBytes: 512 * 1024, // 512 KiB
  initTimeoutMs: 5_000,
  startTimeoutMs: 5_000,
  stopTimeoutMs: 3_000,
  timerTimeoutMs: 5_000,
};

export const DEFAULT_CONFIG: SpcConfig = {
  configSchema: 1,
  plugin: {
    limits: { ...DEFAULT_LIMITS },
    failedRestart: 'manual',
    maxRestartAttempts: 3,
    restartBackoffMs: 1_000,
  },
};

/** 正整数环境变量：非法值 → 报错（配置写错不该被静默忽略成默认值） */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new SpcError('CONFIG_INVALID', { key: name, value: raw, reason: 'positive-integer-required' });
  }
  return n;
}

function envFailedRestart(fallback: FailedRestart): FailedRestart {
  const raw = process.env.SPC_PLUGIN_FAILED_RESTART;
  if (raw === undefined || raw === '') return fallback;
  if (raw !== 'manual' && raw !== 'auto') {
    throw new SpcError('CONFIG_INVALID', { key: 'SPC_PLUGIN_FAILED_RESTART', value: raw, reason: 'manual|auto' });
  }
  return raw;
}

/**
 * 读配置：文件（若存在）→ 补默认值 → 环境变量覆盖。
 * 每次调用都重新求值（测试与运行期覆盖都依赖这一点）。
 */
export function loadConfig(): SpcConfig {
  const file = configFile();
  let fromFile: Partial<SpcConfig> | undefined;
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<SpcConfig>;
    } catch (err) {
      throw new SpcError('CONFIG_INVALID', {
        key: file,
        reason: 'malformed-json',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const limits = { ...DEFAULT_LIMITS, ...(fromFile?.plugin?.limits ?? {}) };
  const plugin = {
    limits,
    failedRestart: fromFile?.plugin?.failedRestart ?? DEFAULT_CONFIG.plugin.failedRestart,
    maxRestartAttempts: fromFile?.plugin?.maxRestartAttempts ?? DEFAULT_CONFIG.plugin.maxRestartAttempts,
    restartBackoffMs: fromFile?.plugin?.restartBackoffMs ?? DEFAULT_CONFIG.plugin.restartBackoffMs,
  };

  // 环境变量覆盖（测试 / CI 用；§10）
  plugin.limits.memoryBytes = envInt('SPC_PLUGIN_MEMORY_LIMIT', limits.memoryBytes);
  plugin.limits.maxStackBytes = envInt('SPC_PLUGIN_MAX_STACK_BYTES', limits.maxStackBytes);
  plugin.limits.initTimeoutMs = envInt('SPC_PLUGIN_INIT_TIMEOUT_MS', limits.initTimeoutMs);
  plugin.limits.startTimeoutMs = envInt('SPC_PLUGIN_START_TIMEOUT_MS', limits.startTimeoutMs);
  plugin.limits.stopTimeoutMs = envInt('SPC_PLUGIN_STOP_TIMEOUT_MS', limits.stopTimeoutMs);
  plugin.limits.timerTimeoutMs = envInt('SPC_PLUGIN_TIMER_TIMEOUT_MS', limits.timerTimeoutMs);
  plugin.failedRestart = envFailedRestart(plugin.failedRestart);
  plugin.maxRestartAttempts = envInt('SPC_PLUGIN_MAX_RESTART_ATTEMPTS', plugin.maxRestartAttempts);
  plugin.restartBackoffMs = envInt('SPC_PLUGIN_RESTART_BACKOFF_MS', plugin.restartBackoffMs);

  return { configSchema: 1, plugin };
}
