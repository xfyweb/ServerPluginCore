// 插件管理器：**唯一状态机** + 唯一锁（docs/plugin-lifecycle-design.md §2/§5）
//
// 为什么状态机只能有一个地方：插件管理操作（load/start/stop/reload/enable/disable）会
// 并发来自 CLI、HTTP 与失败重启定时器。分散在各处的 if 判断很快就会出现"两个 load 撞在一起
// → 能力登记叠加、沙箱泄漏"。所以：**每个状态变更都过 `withLock`**，串行执行。
//
// 单一事实源：
//   · 安装记录（plugins.json）= 持久状态（enabled / grants / state / lastError / restartAttempts）
//   · `loaded` 内存表 = 活着的沙箱句柄
//   两者不重复：state 一律写记录，句柄只在内存。
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Manifest, PluginType } from '../../sdk/types';
import {
  audit,
  coreActor,
  digest,
  digestParams,
  operatorActor,
  pluginActor,
  currentChannel,
  type AuditActor,
  type AuditVia,
  type AuditDetail,
} from '../audit';
import {
  DEFAULT_LOCAL_SOURCE,
  ensureDir,
  hostedPackageDir,
  isValidSource,
  loadConfig,
  packagesDir,
  pluginConfigPath,
  pluginDataDir,
  type PluginLimits,
  type SpcConfig,
} from '../config';
import { SpcError, toErrorShape } from '../errors';
import { coreCompat } from './compat';
import { VERSION } from '../version';
import type { CallDispatchRequest, CallDispatchResult } from '../hostApi';
import { isValidGrantPoint } from '../permissions/check';
import { CALL_POINT_PREFIX, SUBSCRIBE_POINT_PREFIX, callPointOf } from '../permissions/points';
import { resolveGrant } from '../permissions/registry';
import { missingHostGrants, pointSource } from '../permissions/source';
import { hostLogMethod, logs } from '../logs';
import { findAuthor, loadAuthors, moveAuthor, rememberAuthor } from '../sources/authors';
import { fingerprintOf } from '../sources/keys';
import { keyring, type SourceKind } from '../sources/keyring';
import { unpackSpc } from '../sources/unpack';
import { loadLocalEnvelope } from '../sources/verify';
import { capabilities } from './capabilities';
import { withBusyRetry } from './call-retry';
import { resolveDependency, type DependencyDecl } from './deps';
import {
  loadPlugin,
  readManifestFromDir,
  readRecordManifest,
  unloadPlugin,
  type RunningPlugin,
  type StopReason,
} from './loader';
import {
  dropRecord,
  findRecord,
  loadRecords,
  newRecord,
  pluginRef,
  resolveRecord,
  saveRecords,
  upsertRecord,
  type PluginErrorRecord,
  type PluginRecord,
  type PluginState,
} from './records';

/**
 * 对端忙时的**有界重试**策略在 `core/plugin/call-retry.ts`（单独一个文件是为了能被判别性地测出来：
 * 真实环境里"对端正忙"只能由对端自己的定时器/监视回调制造，写成集成用例就是时序赌博）。
 */

/** 对外视图（CLI / HTTP / 面板共用同一份；不含沙箱句柄） */export interface PluginView {
  /** **完整引用** `<origin>/<id>` —— 管理命令与跨插件引用都用它（`(origin, id)` 才是身份，见设计 §3.2） */
  ref: string;
  id: string;
  dir: string;
  version: { code: number; name: string };
  type: PluginType;
  enabled: boolean;
  state: PluginState;
  grants: string[];
  /**
   * **清单里声明的**权限点（需求面，只取名字）。与上面 `grants`（已授予）是两件事：
   * 管理员要看的正是"它要什么 / 我授了什么 / 还差什么"。
   */
  permissions: string[];
  /** 声明了、但**还没授予**的 host 作用域点（由守护进程算 —— 只有它持有完整的点表） */
  missingGrants: string[];
  capabilities: string[];
  lastError: PluginErrorRecord | null;
  restartAttempts: number;
  dataDir: string;
  configPath: string;
  /** 来源（身份的一半）：`local:<名字>` 或市场域名。**不再是 null** */
  origin: string;
  /** 作者公钥指纹（`sha256:…`）；`null` = 这个包没有作者身份（本地包没带信封） */
  authorFingerprint: string | null;
  /** 授权/配置变更后是否需要 reload 才生效 */
  reloadRequired: boolean;
}

export interface InstallOptions {
  grants?: string[];
  /** 安装后是否立即装载（默认 true：安装清单即授权，见 intent-capture §8.1） */
  start?: boolean;
  /**
   * 归属来源（**身份的一半**）：`local:<名字>` 或市场域名。缺省 `local:default`。
   * ⚠️ 同 id 不同来源是**两个插件**——所以这个参数决定数据/配置/授权落在哪一份里，
   * 不是"元数据备注"（设计 §3.2/§3.3）。
   */
  source?: string;
  /**
   * **显式接受换钥**（v4）：同 `(origin, id)` 的作者公钥与宿主记忆不符时，默认**拒装**
   * （`PLUGIN_AUTHOR_MISMATCH` —— 机器分不清"作者换了钥"还是"另一个人"）。
   * 管理员确认后带这个开关重来：覆盖名册 + 落一条 `plugin.key-change` 审计。
   */
  acceptKeyChange?: boolean;
  /**
   * **内部用**：载荷是"我们的托管副本"（只由 `installPackage` 传 `true`）⇒ 记录里写上 `hosted`
   * ⇒ **卸载时连副本一起删**（见 `PluginRecord.hosted`）。
   * ⚠️ CLI / HTTP 面**不暴露**它：是不是托管副本由"从哪条入口装进来"决定，不该让调用方随手声明
   * （声明错了的后果是删错目录，不可逆）。
   */
  hosted?: boolean;
}

/** 预检计划里的一条"错"（**非空即不能执行**；CLI 直接渲染这些码） */
export interface ReanchorPlanError {
  code: string;
  params: Record<string, string>;
}

/** 预检计划里的一条"提示"（能执行，但管理员该知道） */
export interface ReanchorPlanWarning {
  code: string;
  params: Record<string, string>;
}

export interface ReanchorPlanMove {
  /** 旧完整引用 */
  from: string;
  /** 旧来源（名册搬家要用它拼 `(origin, id)`；不从 `from` 里反解字符串） */
  fromOrigin: string;
  /** 新完整引用 */
  to: string;
  id: string;
  version: { code: number; name: string };
  /** 原本是否启用（决定搬完要不要重启） */
  enabled: boolean;
  state: PluginState;
  authorFingerprint: string | null;
  dataDir: { from: string; to: string; exists: boolean };
  config: { from: string; to: string; exists: boolean };
  /**
   * **托管副本**（`.spc` 装进来的那种，见 `PluginRecord.hosted`）：换了来源 ⇒ 副本也要搬到
   * `<packages>/<新来源>/<id>/`，`record.dir` 跟着改。
   * 就地安装（`exists: false`）**不搬** —— 那是作者的目录，它跟着作者走，不跟着来源走。
   */
  pkg: { from: string; to: string; exists: boolean };
}

/**
 * 换源的**预检计划**（`spc plugin reanchor --plan` / `POST /api/plugins/reanchor/plan`）。
 * 结构是给机器看的，本地化文案由 CLI / 面板渲染 —— 与错误码同一条规矩。
 */
export interface ReanchorPlan {
  target: {
    origin: string;
    kind: SourceKind | null;
    alias: string;
    enabled: boolean;
    suspended: string | null;
    anchorFingerprint: string | null;
  };
  moves: ReanchorPlanMove[];
  /** 会被**改写**的第三方授权（`ref` = 那条记录；`pairs` = 逐条点名映射） */
  grantRewrites: { ref: string; pairs: { from: string; to: string }[] }[];
  /** 运行中、且授权被改写 ⇒ 需要 reload 才生效 */
  needsReload: string[];
  /** 已装载、但**不在名单里**的依赖方 ⇒ 会拦执行 */
  blockedBy: { ref: string; dependents: string[] }[];
  /** 已启用但没在跑（停用/失败态）的依赖方 ⇒ **只提示**：它下一次启动才会撞依赖解析 */
  idleDependents: string[];
  warnings: ReanchorPlanWarning[];
  errors: ReanchorPlanError[];
}

export interface ReanchorResult {
  plan: ReanchorPlan;
  moved: { from: string; to: string }[];
  views: PluginView[];
  /** 原本 enabled、但搬完没能起来的（单插件失败不影响其它插件） */
  failedToStart: { ref: string; code: string }[];
}

/**
 * 点名里的**来源前缀替换**（§3.6 原话："字符串替换、不解析点名"）。
 * 点名的形状是 `<前缀>.<完整引用>.<尾段>`（`core/permissions/points.ts`），前缀带尾随 `.`
 * ⇒ 两个引用互为前缀（`@x/y` 与 `@x/yz`）也不会误伤。多个一起搬时用**同一张映射表**同时替换。
 */
function rewritePoint(point: string, map: Map<string, string>): string | undefined {
  for (const [from, to] of map) {
    for (const prefix of [CALL_POINT_PREFIX, SUBSCRIBE_POINT_PREFIX]) {
      const head = `${prefix}.${from}.`;
      if (point.startsWith(head)) return `${prefix}.${to}.${point.slice(head.length)}`;
    }
  }
  return undefined;
}

/**
 * **promote 建议**（§3bis）："同一把钥的第二例出现了 ⇒ 给它建个专属桶，把这一组搬过去"。
 * 结构给机器看，命令由 CLI / 面板拼（本地化文案同理）。
 */
export interface PromoteSuggestion {
  /** 建议建的桶名（`local:<发布者>`，被占了会加 `-2`/`-3`） */
  origin: string;
  /** 建议的别名（给管理员看的标签） */
  alias: string;
  /** 作者公钥指纹（= 桶该绑的锚） */
  anchor: string;
  /** 作者公钥（`spc source add --anchor` 要用它） */
  pub: string;
  /** 建议一起搬过去的完整引用（当前散落在没有锚的桶里、同一把钥签的那些） */
  refs: string[];
}

export class PluginManager {
  /** 活着的沙箱句柄 */
  private readonly loaded = new Map<string, RunningPlugin>();
  /** 唯一锁：所有状态变更串行（单进程内） */
  private chain: Promise<unknown> = Promise.resolve();
  /** auto 重启定时器（unref，不阻止进程退出） */
  private readonly restartTimers = new Set<NodeJS.Timeout>();
  /** 曾尝试过 reload 但未生效的插件（授权/配置变更提示用） */
  private readonly needsReload = new Set<string>();

  private config(): SpcConfig {
    return loadConfig();
  }

  private limits(): PluginLimits {
    return this.config().plugin.limits;
  }

  /**
   * 串行化：所有会改变插件状态的操作都从这里进。
   * 用"接在链尾"的方式而不是队列数组——上一次失败不能卡死后续操作。
   */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // 链上只保留"完成"信号，吞掉结果与异常，避免未处理拒绝
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---- 视图 ----

  private toView(record: PluginRecord): PluginView {
    let type: PluginType = 'ability';
    let permissions: string[] = [];
    try {
      // 顺手把**声明的权限点**一起取出来（本来就要读清单拿 `type`，不多花一次 IO）
      const manifest = readRecordManifest(record);
      type = manifest.type ?? 'ability';
      // 清单里声明的是 `{name, reason?}`（作者写的理由），这里只要名字
      permissions = (manifest.permissions ?? []).map((p) => p.name);
    } catch {
      // 清单读不出来（被删/改坏）也要能列出来——管理面必须能看到"坏掉的插件"
      type = 'ability';
    }
    return {
      ref: pluginRef(record),
      id: record.id,
      dir: record.dir,
      version: record.version,
      type,
      enabled: record.enabled,
      state: record.state,
      grants: [...record.grants],
      permissions,
      // 在**这里**算（守护进程持有完整点表）：客户端进程里没有 `exec.template.*` 与跨插件点
      missingGrants: missingHostGrants(permissions, record.grants),
      capabilities: [...record.capabilities],
      lastError: record.lastError,
      restartAttempts: record.restartAttempts,
      dataDir: pluginDataDir(record.origin, record.id),
      configPath: record.configPath,
      origin: record.origin,
      authorFingerprint: record.authorFingerprint ?? null,
      reloadRequired: this.needsReload.has(pluginRef(record)),
    };
  }

  list(): PluginView[] {
    return loadRecords().plugins.map((r) => this.toView(r));
  }

  /**
   * `input` 可以是**完整引用**（`local:default/@a/b`），也可以是**裸 id**（`@a/b`，唯一匹配才认）。
   * 歧义 ⇒ `PLUGIN_REF_AMBIGUOUS`；没有 ⇒ `PLUGIN_NOT_FOUND`（见 `resolveRecord`）。
   */
  status(input: string): PluginView {
    return this.toView(this.mustRecord(input));
  }

  /** 管理面输入 → 记录；找不到就抛 `PLUGIN_NOT_FOUND`（带**原样输入**，方便对照打错的 ref） */
  private mustRecord(input: string): PluginRecord {
    const record = resolveRecord(loadRecords(), input);
    if (!record) throw new SpcError('PLUGIN_NOT_FOUND', { pluginId: input });
    return record;
  }

  // ---- 记录写入（唯一入口，保证 state 与记录不脱节）----

  /** ⚠️ 参数是**完整引用**（内部一律用 ref 作键；管理面输入要先过 `mustRecord`） */
  private patchRecord(ref: string, patch: Partial<PluginRecord>): PluginRecord {
    const file = loadRecords();
    const record = findRecord(file, ref);
    if (!record) throw new SpcError('PLUGIN_NOT_FOUND', { pluginId: ref });
    Object.assign(record, patch);
    saveRecords(file);
    return record;
  }

  private setState(ref: string, state: PluginState, error?: PluginErrorRecord | null): void {
    this.patchRecord(ref, { state, ...(error === undefined ? {} : { lastError: error }) });
  }

  // ---- 依赖图：装载顺序 + 反向依赖保护 ----
  //
  // 语义（plugin-lifecycle-design §5）：
  //   · **依赖必须已装载**，不只是"已启用"——依赖没跑起来，依赖方不许起（否则它会跑在一个
  //     它本不该能进入的状态里）；未安装/未启用 → MISSING，已启用但没在跑 → NOT_LOADED。
  //   · **装载顺序依赖优先**（拓扑排序），环上的插件直接判失败而不是互相报"依赖缺失"。
  //   · **反向保护**：被已启用插件依赖时，不许卸载／禁用。

  /**
   * 直接依赖的**完整引用**（不是裸 id）。
   * 依赖声明里 `origin` 可省略 ⇒ 省略时取**依赖方自己的来源**（同源简写，见 plugin-signature-design §7.1）。
   * 清单读不出来时返回空并告警——一个坏插件不该阻塞别人的管理操作。
   */
  private directDeps(record: PluginRecord): string[] {
    try {
      const deps = readManifestFromDir(record.dir).dependencies?.plugins ?? [];
      return deps.map((d) => pluginRef({ origin: d.origin ?? record.origin, id: d.id }));
    } catch (err) {
      console.warn(
        `[plugin] ${pluginRef(record)} 清单不可读，依赖关系未知：${toErrorShape(err)?.code ?? 'INTERNAL'}`,
      );
      return [];
    }
  }

  /** 依赖是否就绪（参数是**完整引用**）；不就绪时给出**原因**，让装载期能报准确的码 */
  private dependencyStatus = (
    ref: string,
  ): { ok: true } | { ok: false; reason: 'missing' | 'not-loaded'; state?: string } => {
    const record = findRecord(loadRecords(), ref);
    if (!record || !record.enabled) return { ok: false, reason: 'missing' };
    if (!this.loaded.has(ref)) return { ok: false, reason: 'not-loaded', state: record.state };
    return { ok: true };
  };

  /**
   * 依赖声明的解析（v4）：`{ id, origin?, author }` → 实际引用（见 `core/plugin/deps.ts`）。
   * 需要安装记录与**作者名册**，所以由 manager 提供；解析失败直接抛（fail-closed）。
   */
  private resolveDep = (dep: DependencyDecl, self: { origin: string; ref: string }): string =>
    resolveDependency(dep, self, { records: loadRecords().plugins, authors: loadAuthors() });

  /**
   * 哪些**正在运行**的插件依赖它 —— 反向保护的判据。
   *
   * 为什么看"运行态"而不是记录里的 `enabled`：
   * 保护要防的是"依赖方正在跑、依赖却被抽走"这件事。谁没在跑，就没有谁的运行会被悄悄打断。
   * 于是维护模式（不装载任何插件）**天然**没有阻拦——不需要"跳过检查"的开关：
   * 维护模式是**启动形态**（启不启动插件），不是**校验开关**（检查要不要执行）；
   * 检查在任何形态下都照常执行，只是在不装载的形态下它没有对象可拦。
   */
  private activeDependents(ref: string): string[] {
    const file = loadRecords();
    const users: string[] = [];
    for (const loadedRef of this.loaded.keys()) {
      if (loadedRef === ref) continue;
      const record = findRecord(file, loadedRef);
      if (record && this.directDeps(record).includes(ref)) users.push(loadedRef);
    }
    return users.sort();
  }

  /** 被运行中的插件依赖时拒绝卸载／禁用：否则它会毫无察觉地失去依赖 */
  private assertNotInUse(ref: string, action: 'uninstall' | 'disable'): void {
    const dependents = this.activeDependents(ref);
    if (dependents.length > 0) {
      throw new SpcError('PLUGIN_IN_USE', {
        pluginId: ref,
        dependents: dependents.join(', '),
        action,
      });
    }
  }

  /**
   * 拓扑排序（依赖优先）。
   * 环上的插件单独返回：它们的依赖关系互相死锁，装载期永远无法满足——直接判失败，
   * 比让它们各自报一个看不出所以然的 `PLUGIN_DEPENDENCY_MISSING` 清楚得多。
   */
  private resolveLoadOrder(records: PluginRecord[]): { order: PluginRecord[]; cyclic: Set<string> } {
    const byRef = new Map(records.map((r) => [pluginRef(r), r]));
    const state = new Map<string, 'visiting' | 'done'>();
    const order: PluginRecord[] = [];
    const cyclic = new Set<string>();
    const stack: string[] = [];

    const visit = (ref: string): void => {
      const st = state.get(ref);
      if (st === 'done') return;
      if (st === 'visiting') {
        // 回边：栈上从该 ref 起（含）的都在环里
        const from = stack.indexOf(ref);
        if (from !== -1) for (const member of stack.slice(from)) cyclic.add(member);
        return;
      }
      const record = byRef.get(ref);
      if (!record) return; // 依赖不在本次装载集合里 → 交给装载期报 MISSING / NOT_LOADED
      state.set(ref, 'visiting');
      stack.push(ref);
      for (const dep of this.directDeps(record)) visit(dep);
      stack.pop();
      state.set(ref, 'done');
      order.push(record);
    };

    for (const r of records) visit(pluginRef(r));
    return { order, cyclic };
  }

  // ---- 装载 / 卸载 ----

  /**
   * **管理动作**的审计（2026-10-14 加）：`plugin.install` / `.uninstall` / `.enable` / `.disable` / `.reload`。
   *
   * 为什么非加不可：这些动作以前**一条都不落**（只有它们**带出来**的 `lifecycle.*` 条目）——
   * 于是"谁在什么时候装了/卸了/停用了什么"在审计里查不到；`uninstall` 之后记录就没了，
   * 事后再也说不清当初是从哪个源装的。
   *
   * 规矩：`detail` 只放**码值**（来源 / 权限点 / 计数），**路径一律只留摘要**（契约：路径敏感）。
   */
  private auditAdmin(method: string, ref: string, detail?: AuditDetail, started?: number, via?: AuditVia): void {
    audit({
      ts: Date.now(),
      actor: operatorActor(via),
      subject: { kind: 'plugin', ref },
      method,
      paramsDigest: digestParams(detail) ?? digest(ref),
      result: 'ok',
      ...(detail === undefined ? {} : { detail }),
      timing: { ms: started === undefined ? 0 : Date.now() - started },
    });
  }

  private async loadAndStart(
    record: PluginRecord,
    opts: { isRestart?: boolean; actor?: AuditActor } = {},
  ): Promise<void> {
    const ref = pluginRef(record);
    // 重入保护：同一插件已在装载中/已装载 → 先干净卸载再装。
    // 没有这一条，"重装同一个插件"或"startAll 撞上已有句柄"就会叠加能力登记 + 泄漏沙箱。
    if (this.loaded.has(ref)) {
      await this.stopAndUnload(ref, 'reload', this.limits(), opts.actor ?? operatorActor());
    }
    this.setState(ref, 'loading');
    let run: RunningPlugin | undefined;
    try {
      // ① 契约兼容闸（2026-10-14 落）：`compat.minCore` 是插件**唯一**的兼容要求，
      //    判据与"开发占位豁免"见 `core/plugin/compat.ts`。放在装载前 ⇒ 不满足就不进沙箱。
      //    失败也留痕：这条审计是"为什么没跑起来"的唯一出处（loader 的 lifecycle.load 到不了这里）。
      const manifest = readRecordManifest(record);
      const verdict = coreCompat(manifest.compat?.minCore);
      if (!verdict.ok) {
        audit({
          ts: Date.now(),
          actor: opts.actor ?? operatorActor(),
          subject: { kind: 'plugin', ref },
          method: 'lifecycle.load',
          paramsDigest: digestParams({ minCore: manifest.compat?.minCore ?? '' }) ?? digest(ref),
          result: 'error',
          error: { code: 'CONTRACT_MISMATCH' },
          detail: { minCore: manifest.compat?.minCore ?? '', core: VERSION, reason: verdict.reason },
          timing: { ms: 0 },
        });
        throw new SpcError('CONTRACT_MISMATCH', { minCore: manifest.compat?.minCore ?? '', core: VERSION });
      }
      run = await loadPlugin(record, {
        limits: this.limits(),
        dependencyStatus: this.dependencyStatus,
        resolveDep: this.resolveDep,
        dispatchCall: this.dispatchCall,
        // 插件日志出口：**打 stdout 照旧**（运维 / pm2 看得到，行为不变）+ **进聚合器**（`spc log` 读它）。
        // 两件事都要：只打 stdout 就没法查历史，只进聚合器就把现有运维链路打断。
        // ⚠️ 宿主方法按 `hostLogMethod` 映射：`info` ⇒ `console.log`（**不是** `console.info`）——
        // 这条改错会让所有"捕获宿主 console.log"的用例静默收不到东西（2026-10-14 踩过）。
        logger: (level, message) => {
          // `ctx.logger.*`：**带前缀**（历史行为）+ 进聚合器
          console[hostLogMethod(level)](`[${ref}] ${message}`);
          logs.append({ ref, level, text: message });
        },
        // `console.*`：宿主 stdout 那份**由沙箱自己打（不带前缀，历史行为）**，这里只负责进聚合器
        onLog: (level, message) => logs.append({ ref, level, text: message }),
        // **谁触发的这次装载**：管理员（install/enable/reload）⇒ operator；自动重启/开机 ⇒ core
        actor: opts.actor ?? operatorActor(),
      });
      this.loaded.set(ref, run);
      // 能力清单落记录（撤销依据 + 展示 + 审计追溯）
      this.setState(ref, 'running', null);
      this.patchRecord(ref, {
        capabilities: run.capabilities,
        // 一次成功 running 后清零连续失败计数（§2）
        ...(opts.isRestart ? {} : {}),
        restartAttempts: 0,
      });
      this.needsReload.delete(ref);
    } catch (err) {
      const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
      const pluginError: PluginErrorRecord = {
        code: shape.code,
        params: shape.params,
        at: Date.now(),
      };
      this.setState(ref, 'failed', pluginError);
      this.loaded.delete(ref);
      await this.scheduleRestartIfConfigured(ref, pluginError);
      throw new SpcError(shape.code, shape.params);
    }
  }

  private async stopAndUnload(
    ref: string,
    reason: StopReason,
    limits = this.limits(),
    actor: AuditActor = operatorActor(),
  ): Promise<void> {
    const run = this.loaded.get(ref);
    const record = findRecord(loadRecords(), ref);
    if (!run) {
      if (record) {
        // 没装载：能力登记也该是空的（保险：清一次保证幂等）
        capabilities.revoke(ref);
        this.patchRecord(ref, { capabilities: [] });
      }
      return;
    }
    this.setState(ref, 'stopping');
    await unloadPlugin(run, reason, limits, actor);
    this.loaded.delete(ref);
    this.patchRecord(ref, { capabilities: [] });
  }

  /** 失败重启策略（§2）：默认 manual —— 只落 failed，等管理员 reload */
  private async scheduleRestartIfConfigured(ref: string, error: PluginErrorRecord): Promise<void> {
    const cfg = this.config().plugin;
    if (cfg.failedRestart !== 'auto') return;

    const file = loadRecords();
    const record = findRecord(file, ref);
    if (!record) return;
    const attempts = record.restartAttempts + 1;
    this.patchRecord(ref, { restartAttempts: attempts });

    if (attempts > cfg.maxRestartAttempts) {
      audit({
        ts: Date.now(),
        // 自动重启是**核心**自己触发的（不是管理员点出来的）⇒ actor = core
        actor: coreActor(),
        subject: { kind: 'plugin', ref },
        method: 'lifecycle.restart',
        paramsDigest: digestParams({ attempts: String(attempts), decision: 'give-up' }) ?? digest(ref),
        result: 'error',
        error: { code: error.code },
        detail: { attempts, decision: 'give-up' },
        timing: { ms: 0 },
      });
      return;
    }

    audit({
      ts: Date.now(),
      actor: coreActor(),
      subject: { kind: 'plugin', ref },
      method: 'lifecycle.restart',
      paramsDigest:
        digestParams({ attempts: String(attempts), backoffMs: String(cfg.restartBackoffMs) }) ?? digest(ref),
      result: 'ok',
      detail: { attempts, backoffMs: cfg.restartBackoffMs },
      timing: { ms: 0 },
    });

    const timer = setTimeout(() => {
      this.restartTimers.delete(timer);
      void this.withLock(async () => {
        const rec = findRecord(loadRecords(), ref);
        if (!rec || !rec.enabled) return;
        try {
          await this.loadAndStart(rec, { isRestart: true, actor: coreActor() });
        } catch {
          /* 失败已在 loadAndStart 里落状态与审计 */
        }
      });
    }, cfg.restartBackoffMs * attempts); // 线性退避（P2 再升级策略）
    timer.unref?.();
    this.restartTimers.add(timer);
  }

  // ---- 管理操作（全部过锁）----

  /**
   * 装入前的公共前奏：读清单 → 读可选信封 → **定归属来源**。
   *
   * 抽出来是因为 `.spc` 那条入口（`installPackage`）**在搬副本之前**就得知道来源
   * —— 托管副本要落到 `<packages>/<来源>/<id 目录名>/`，而来源可能由作者公钥自动落桶决定。
   * 两条入口共用这一段 ⇒ 不会出现"目录安装按一套规则定来源、包安装按另一套"。
   */
  private prepareInstall(
    dir: string,
    opts: InstallOptions,
  ): { manifest: Manifest; authorPub: string | undefined; origin: string } {
    const manifest = readManifestFromDir(dir);
    // ① 作者信封（本地路径；有源安装的市场验签流在 P4，见 sources/verify.ts 的 verifyPackage）
    const envelope = loadLocalEnvelope(dir);
    if (envelope.kind === 'error') throw new SpcError(envelope.code, envelope.params);
    const authorPub = envelope.kind === 'ok' ? envelope.authorPub : undefined;
    // ② 归属来源（v4 ⑥c）：显式给 ⇒ 必须是 keyring 里真有的桶；没给 ⇒ 按包的公钥**自动落进作者的桶**
    const origin = this.resolveInstallSource(opts.source, authorPub === undefined ? null : fingerprintOf(authorPub));
    return { manifest, authorPub, origin };
  }

  /**
   * 从 `.spc` 装入（`docs/build-layer-design.md` §10.6 的**第二条入口**）：**托管副本**。
   *
   * 管线与 `install(dir)` **完全一样**（身份 / 授权 / 审计 / 记录语义都不变），只有**载荷放哪**不同：
   *   ① 解到 `<STATE_DIR>/packages/.staging/<唯一名>` —— 容器层的全部 fail-closed 判定在解包器里
   *      （路径形状 / 体积 / 条目数 / 符号链接 / 加密 / 重名，见 `sources/unpack.ts`）；
   *   ② 按清单 id 与解析出的来源算出托管副本路径；
   *   ③ 整份搬过去（同卷 `rename`，跨卷退回复制），然后调 `install(托管路径)`。
   *
   * 本地 `.spc` ⇒ 仍是**局部语义**（`unanchored`、没有更新渠道）：托管的只是"载荷放哪"，不是"有了来源"。
   *
   * ⚠️ **失败要双向清理**：解包失败由解包器清 staging；**装失败这里要删掉托管副本**
   * —— 孤儿副本最坑：它看起来像个装好的包，但名册里没有它。
   */
  async installPackage(file: string, opts: InstallOptions = {}): Promise<PluginView> {
    const stagingRoot = join(packagesDir(), '.staging');
    ensureDir(stagingRoot);
    const staging = join(stagingRoot, `unpack-${Date.now()}-${randomBytes(4).toString('hex')}`);
    await unpackSpc(file, staging); // 失败时它自己把 staging 删掉

    let dest: string;
    let origin: string;
    try {
      const prepared = this.prepareInstall(staging, opts);
      origin = prepared.origin;
      dest = hostedPackageDir(origin, prepared.manifest.id);
      // 重装 / 升级：托管副本是**我们自己的副本**，整体替换（就地安装则反过来 —— 那是作者的目录，一个字都不许动）
      rmSync(dest, { recursive: true, force: true });
      ensureDir(dirname(dest));
      try {
        renameSync(staging, dest);
      } catch {
        cpSync(staging, dest, { recursive: true });
        rmSync(staging, { recursive: true, force: true });
      }
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }

    try {
      return await this.install(dest, { ...opts, source: origin, hosted: true });
    } catch (e) {
      rmSync(dest, { recursive: true, force: true });
      throw e;
    }
  }

  /**
   * 卸载时清掉**我们自己的**托管副本（`.spc` 装进来的那种）。
   *
   * ⚠️ **两个条件都满足才删**，缺一不删：
   *   ① 记录标了 `hosted`（就地安装的记录没有这个标）；
   *   ② `dir` 确实在 `<STATE_DIR>/packages` **之内** —— 纵深防御：哪怕记录被手改过，
   *      也不能把作者的工作目录当副本删掉（删错目录不可逆）。
   * 就地安装的目录**永远不碰**；数据目录与配置值也照旧保留（§12-3 的倾向不变，那是另一件事）。
   */
  private dropHostedCopy(record: PluginRecord): void {
    if (record.hosted !== true) return;
    const root = resolve(packagesDir());
    const dir = resolve(record.dir);
    if (!dir.startsWith(root + sep)) return;
    rmSync(dir, { recursive: true, force: true });
    // 顺手收掉空掉的 `<来源>/` 目录（非空的留着 —— 同来源下还有别的插件；不存在也无所谓）
    try {
      rmdirSync(dirname(dir));
    } catch {
      /* 非空 / 不存在：都不是问题 */
    }
  }

  /**
   * 安装：读目录 → 校验清单 → 写记录 → （默认）立即装载。
   * **来源（`opts.source`）决定归属**：身份是 `(origin, id)`，同 id 不同源是**两个插件**（各自的目录/配置/授权）；
   * 缺省 `local:default`。本地安装 ⇒ `signedBy`/`verifiedMeta` 为 null（unanchored：没有更新渠道）。
   *
   * **授权播种**（2026-09-24）：`install` 档的点**只在记录第一次被创建时**按清单播种一次（见 `seedGrants`）。
   * 之后升级新增的 `install` 档点**不自动生效** ⇒ 报 `NOT_GRANTED` 等管理员授予（增量同意，§8.4）。
   *
   * `opts.grants`（CLI `--grant` / HTTP body）走与 `grant()` **同一套校验** —— 否则这里就是一条
   * 绕过"精确 / 已登记 / 已声明 / 可授予"四道闸的后门（2026-09-23 之前它确实是一条直通车道）。
   *
   * **作者身份**（2026-09-25，v4）：读可选信封（`plugin.meta.json` + `plugin.author.sig`）→ 验自洽
   * → 与**宿主记忆**（名字册）比对：首见即记（TOFU）、不符则拒（`PLUGIN_AUTHOR_MISMATCH`，
   * 除非 `acceptKeyChange` 显式接受并落审计）。没有信封 ⇒ `authorFingerprint = null`
   * （该包满足不了任何带 `author.pub` 的依赖声明）。
   */
  install(dir: string, opts: InstallOptions = {}): Promise<PluginView> {
  // ⚠️ **同步**取通道：`withLock` 的排队链上 AsyncLocalStorage 上下文会丢，进去再取就是 internal
  const via = currentChannel();
  return this.withLock(async () => {
      // ① 读清单 ② 读可选信封 ③ 定归属来源 —— 与 `.spc` 那条入口共用（见 prepareInstall）
      const started = Date.now();
      const { manifest, authorPub, origin } = this.prepareInstall(dir, opts);
      const file = loadRecords();
      const ref = pluginRef({ origin, id: manifest.id });
      const existing = findRecord(file, ref);
      // ③ 身份闸（在写记录**之前**：被拒就不该留下任何痕迹）
      const authorFingerprint = this.authorIdentityGate(
        { origin, id: manifest.id, ref },
        authorPub,
        existing?.authorFingerprint ?? null,
        opts.acceptKeyChange === true,
      );
      const record = newRecord(manifest, dir, {
        source: origin,
        grants: opts.grants ?? existing?.grants ?? [],
        signedBy: existing?.signedBy ?? null,
        authorFingerprint,
        hosted: opts.hosted === true,
      });
      if (opts.grants?.length) {
        // 校验用的是**这次装进来的清单**（声明以新包为准）
        this.assertPointsOperable(record, opts.grants, true);
        record.grants = [...new Set([...record.grants, ...opts.grants])].sort();
      }
      // 首次安装：把清单里 `install` 档的点播种进白名单（"安装清单即同意书"，只播一次）
      if (!existing) this.seedGrants(record);
      // 重新安装保留原 installedAt（"装了什么"的时间不该被覆盖）
      if (existing) record.installedAt = existing.installedAt;
      record.enabled = opts.start === false ? (existing?.enabled ?? false) : true;
      upsertRecord(file, record);
      saveRecords(file);

      if (record.enabled) {
        await this.loadAndStart(record);
      }
      // 管理动作留痕：装了谁、从哪个源来（**路径只进摘要**：契约里路径算敏感值）
      this.auditAdmin('plugin.install', ref, { origin }, started, via);
      return this.status(ref);
    });
  }

  /**
   * **装到哪个桶**（v4 ⑥c，`plugin-signature-design.md` §3bis / §7.2）：
   *
   * - **显式给了 `--source`** ⇒ 形状必须先合法，且那个桶**必须已经在 keyring 里**
   *   （⑥a 起"桶"就是源条目）⇒ 否则 `SOURCE_NOT_CONFIGURED`，提示 `spc source add`。
   *   为什么不做"显式即自动建桶"：那样"这台机器上有哪些桶"又变成一个要靠翻记录才知道的事，
   *   而 ⑥a 的全部意义正是让桶清单成为权威。
   * - **没给** ⇒ 按**包的公钥**找绑了同一把锚的本地桶（"本地源 = 一个作者的桶"）：
   *   恰好一个就用它（这就是 promote 之后的默认行为）；**多个 ⇒ 歧义拒**（`PLUGIN_SOURCE_AMBIGUOUS`
   *   —— 锚相同是同一组，说不清该进哪一个，让管理员显式指定）；零个 ⇒ 杂桶 `local:default`。
   * - 包**没有作者身份**（没带信封）⇒ 只能进杂桶（它满足不了任何绑了锚的桶）。
   *
   * 内置条目在这里**按需播种**（幂等）：核心只要碰 keyring，两个内置桶就该在 ——
   * 否则"装到 local:default"会因为"keyring 里没这条"而失败，而那明显不是管理员的问题。
   */
  private resolveInstallSource(explicit: string | undefined, fingerprint: string | null): string {
    const kr = keyring();
    kr.ensureBuiltins();
    if (explicit !== undefined) {
      if (!isValidSource(explicit)) throw new SpcError('PLUGIN_SOURCE_INVALID', { origin: explicit });
      if (!kr.get(explicit)) throw new SpcError('SOURCE_NOT_CONFIGURED', { origin: explicit, reason: 'not-found' });
      return explicit;
    }
    if (fingerprint === null) return DEFAULT_LOCAL_SOURCE;
    const mine = kr
      .list()
      .filter((s) => s.kind === 'local' && s.authorAnchor?.fingerprint === fingerprint);
    if (mine.length === 1) return mine[0].origin;
    if (mine.length > 1) {
      throw new SpcError('PLUGIN_SOURCE_AMBIGUOUS', {
        author: fingerprint,
        origins: mine.map((s) => s.origin).sort().join('、'),
      });
    }
    return DEFAULT_LOCAL_SOURCE;
  }

  /**
   * **promote 建议**（§3bis：同钥第二例 ⇒ 建议为该作者单独建源并搬迁）。
   *
   * 什么时候给：这个包**没进**"属于它作者的那个桶"（杂桶或别人的桶），而同一把钥签的插件**不止一个**时。
   * 给什么：一个可执行的两条命令 —— 建桶（带锚）+ 把这几个一起搬过去（`reanchor` 已经是批量原子的）。
   * 桶名由插件 id 的发布者段推出来（`@std/x` → `local:std`），被占了就加 `-2`/`-3`；
   * 已经存在**同锚**的桶就直接用它（那种情况通常是显式 `--source` 装进了别的桶）。
   *
   * ⚠️ 它只是**建议**：不自动建桶、不自动搬（"永不自动新增源" + 显式动作）。
   */
  promoteSuggestion(ref: string): PromoteSuggestion | undefined {
    const file = loadRecords();
    const record = findRecord(file, ref);
    if (!record) return undefined;
    const fingerprint = record.authorFingerprint;
    if (fingerprint === null) return undefined; // 没作者身份 ⇒ 无从分组
    const current = keyring().get(record.origin);
    if (current?.authorAnchor) return undefined; // 已经在"属于它作者的桶"里了

    // 同一把钥签的、且**还没进**自己桶的那些（含刚装的这个）
    const group = file.plugins.filter(
      (p) => p.authorFingerprint === fingerprint && keyring().get(p.origin)?.authorAnchor === undefined,
    );
    if (group.length < 2) return undefined; // "只出现过一次" ⇒ 杂桶就够
    const author = findAuthor(record.origin, record.id) ?? file.plugins
      .map((p) => findAuthor(p.origin, p.id))
      .find((a) => a?.fingerprint === fingerprint);
    if (!author) return undefined; // 名册里没有公钥 ⇒ 拼不出建桶命令

    const kr = keyring();
    const base = `local:${(record.id.split('/')[0] ?? '').replace(/^@/, '').toLowerCase()}`;
    let origin = base;
    for (let i = 2; kr.get(origin)?.authorAnchor && kr.get(origin)?.authorAnchor?.fingerprint !== fingerprint; i++) {
      origin = `${base}-${i}`;
    }
    return {
      origin,
      alias: record.id.split('/')[0] ?? origin,
      anchor: fingerprint,
      pub: author.pub,
      refs: group.map((p) => pluginRef(p)).sort(),
    };
  }

  /**
   * 作者身份闸（`plugin-signature-design.md` §3bis 的"期望值解析"）。
   *
   * 判据链（**顺序写死**）：**源级作者锚 → 名册首见值 →（名册没有时）记录里的指纹 →（都没有即首见，TOFU）**。
   * - **源锚第一**（⑥c）：桶声明了"只收这把钥的包"，它就是这个源里最强的期望值 ⇒
   *   不符即 `PLUGIN_ANCHOR_MISMATCH`（**`--accept-key-change` 绕不过它** —— 那是"在同一把钥的连续性上改认"，
   *   而锚是管理员对**这个桶**的断言；要换请 `spc source anchor` 改锚，或换个桶）；
   * - 一致 / 首见 ⇒ 记名册，返回本次的指纹（写进记录）；
   * - 不符 ⇒ 抛 `PLUGIN_AUTHOR_MISMATCH`（错误里给两条出路：换个源 / `--accept-key-change`），
   *   除非管理员显式接受 —— 那时**覆盖名册**并落一条 `plugin.key-change` 审计（旧/新指纹都记）；
   * - 包没带作者身份（`authorPub === undefined`）⇒ 在**绑了锚**的桶里直接拒；否则返回 `null`：
   *   **名册不动**（那是宿主记忆，不该被一个"没自报家门"的版本抹掉），但这个版本满足不了带 `author.pub` 的依赖声明。
   */
  private authorIdentityGate(
    who: { origin: string; id: string; ref: string },
    authorPub: string | undefined,
    recordFingerprint: string | null,
    acceptKeyChange: boolean,
  ): string | null {
    const anchor = keyring().get(who.origin)?.authorAnchor?.fingerprint ?? null;
    const actual = authorPub === undefined ? null : fingerprintOf(authorPub);
    if (anchor !== null && actual !== anchor) {
      throw new SpcError('PLUGIN_ANCHOR_MISMATCH', {
        pluginId: who.ref,
        origin: who.origin,
        expected: anchor,
        actual: actual ?? 'none',
      });
    }
    if (authorPub === undefined) return null;
    const fingerprint = actual as string;
    const known = findAuthor(who.origin, who.id);
    const expected = known?.fingerprint ?? recordFingerprint;
    if (expected !== null && expected !== undefined && expected !== fingerprint) {
      if (!acceptKeyChange) {
        throw new SpcError('PLUGIN_AUTHOR_MISMATCH', {
          pluginId: who.ref,
          expected,
          actual: fingerprint,
        });
      }
      audit({
        ts: Date.now(),
        // 管理员接受换钥：操作者身份 + 关于那个插件
        actor: operatorActor(),
        subject: { kind: 'plugin', ref: who.ref },
        method: 'plugin.key-change',
        paramsDigest: digestParams({ previous: String(expected) }) ?? digest(who.ref),
        result: 'ok',
        // 新指纹是**公开值**（旧指纹在摘要里）：进明细，读得回来
        detail: { fingerprint },
        timing: { ms: 0 },
      });
    }
    rememberAuthor({ origin: who.origin, id: who.id, pub: authorPub });
    return fingerprint;
  }

  /**
   * 把清单里**属于 `install` 档**的声明播种进 `grants`（只在记录第一次创建时调用一次）。
   *
   * 为什么要有这一步：`install` 档的设计意图是"安装清单即同意书"（不用管理员逐点点），
   * 而判定链只有一条白名单 —— 那就得有人把"同意"**落成一条真授权**。播种的就是它。
   * 于是 `install` 与 `explicit` **在判定上完全一样**（白名单里有就通），差别只在"谁写第一条"。
   *
   * 为什么只播一次：升级时新增的 `install` 档点**不该**静默生效（那是 §8.4 增量同想要挡的），
   * 播种一次 + 之后按白名单管理，正好把这两件事同时办到。
   *
   * ⚠️ 播种要知道档位（`pointSource.get`）—— 驱动插件的点必须在**能力插件安装之前**就已固化，
   * 这正是"两阶段启动"的约束（`core/permissions/registry.ts` 头部）。查不到的点**不播**（fail-closed）。
   */
  private seedGrants(record: PluginRecord): void {
    let manifest: Manifest;
    try {
      manifest = readRecordManifest(record);
    } catch {
      return; // 清单读不出来 ⇒ 没有可播的（装载会自己报错）
    }
    const seeded: string[] = [];
    // 主题包没有 `permissions`（schema 豁免）⇒ 必须兜空数组，别让播种把装载路径炸掉
    for (const declared of manifest.permissions ?? []) {
      const point = pointSource.get(declared.name);
      if (point && resolveGrant(point.scope, point.grant) === 'install' && !record.grants.includes(declared.name)) {
        seeded.push(declared.name);
      }
    }
    if (seeded.length === 0) return;
    record.grants = [...new Set([...record.grants, ...seeded])].sort();
    audit({
      ts: Date.now(),
      // 安装时播种 install 档权限点：**管理员装出来的**（不是插件自己要的）
      actor: operatorActor(),
      subject: { kind: 'plugin', ref: pluginRef(record) },
      method: 'plugin.grant',
      paramsDigest: digestParams({ via: 'install-seed' }) ?? digest(pluginRef(record)),
      result: 'ok',
      detail: { points: seeded, via: 'install-seed' },
      timing: { ms: 0 },
    });
  }

  /**
   * 启用。`load` 默认 true（顺带装载）。
   *
   * `{ load: false }` 是**维护模式**（`--maintenance`）用的形态：那时不该有任何插件在跑，
   * 装载就自毁前提 ⇒ 只改记录，并在审计里标 `mode: 'maintenance'`（"改了记录但没跑"必须看得见）。
   */
  enable(input: string, opts: { load?: boolean } = {}): Promise<PluginView> {
  const via = currentChannel();
  const load = opts.load !== false;
  return this.withLock(async () => {
      const ref = pluginRef(this.mustRecord(input));
      const record = this.patchRecord(ref, { enabled: true, state: 'installed', lastError: null });
      if (load && !this.loaded.has(ref)) {
        await this.loadAndStart(record);
      }
      this.auditAdmin('plugin.enable', ref, load ? undefined : { mode: 'maintenance' }, undefined, via);
      return this.status(ref);
    });
  }

  disable(input: string): Promise<PluginView> {
  const via = currentChannel();
  return this.withLock(async () => {
      const ref = pluginRef(this.mustRecord(input));
      // 禁用同样会让依赖方失去依赖（`dependencyStatus` 要求"已启用且已装载"）→ 一并设防
      this.assertNotInUse(ref, 'disable');
      await this.stopAndUnload(ref, 'disable');
      this.patchRecord(ref, { enabled: false, state: 'disabled' });
      this.auditAdmin('plugin.disable', ref, undefined, undefined, via);
      return this.status(ref);
    });
  }

  /** 重载：整插件 stop → 重新 load（不做模块热替换），也是 failed 的恢复通道 */
  reload(input: string): Promise<PluginView> {
  const via = currentChannel();
  return this.withLock(async () => {
      const record = this.mustRecord(input);
      const ref = pluginRef(record);
      if (!record.enabled) throw new SpcError('PLUGIN_DISABLED', { pluginId: ref });
      // reload 是管理动作（管理员/控制台发起）⇒ 操作者身份
      await this.stopAndUnload(ref, 'reload', this.limits(), operatorActor());
      await this.loadAndStart(record);
      this.auditAdmin('plugin.reload', ref, undefined, undefined, via);
      return this.status(ref);
    });
  }

  /**
   * 卸载：**托管副本一起删**（`.spc` 装的那种，见 `dropHostedCopy`）；**就地安装的目录永不动**；
   * 数据目录与配置值一律保留（§12-3 倾向）；v2 起没有 reserved 例外。
   *
   * 返回**解析后的完整引用**：管理命令允许传裸 id（唯一匹配），但调用方要能把"到底动了哪一个来源"
   * 打给管理员看 —— 回显他打的字符串是没法复核的（同名插件可能在多个来源下都出现过）。
   */
  uninstall(input: string): Promise<{ ref: string }> {
  const via = currentChannel();
  return this.withLock(async () => {
    const started = Date.now();
      const record = this.mustRecord(input);
      const ref = pluginRef(record);
      const file = loadRecords();
      // 被别的（已启用）插件依赖时不许卸载：先禁用/卸载依赖方
      this.assertNotInUse(ref, 'uninstall');
      await this.stopAndUnload(ref, 'uninstall');
      // 先删副本、后删记录：删失败（比如文件被占）就整体失败，记录还在 ⇒ 管理员能重试。
      // 反过来先删记录的话，删副本失败就变成"名册里没有、磁盘上却有"的孤儿。
      this.dropHostedCopy(record);
      dropRecord(file, ref);
      saveRecords(file);
      this.needsReload.delete(ref);
      // 记录已经删了：这条审计是"谁在什么时候卸的、从哪个源来"的**唯一**出处
      this.auditAdmin('plugin.uninstall', ref, { origin: record.origin }, started, via);
      return { ref };
    });
  }

  /**
   * 校验一批权限点**能不能被授予 / 撤回**。
   *
   * 校验项（`grant` / `revoke` / `install --grant` **共用这一份**，否则三条入口的口径迟早分叉）：
   * ① 必须精确：通配或空 ⇒ `GRANT_WILDCARD`（管理员最常犯的错是写 `kv.*`，"权限被拒绝"听起来像插件的问题）；
   * ② 必须查得到（冻结表 ∪ 临时表）⇒ `UNKNOWN_POINT`；
   * ③ 档位必须**可操作**：`auto` 档够不着别人、也没有承载授权的载体 ⇒ `GRANT_NOT_APPLICABLE`
   *    （2026-09-23 之前这里不报错，于是"授予/撤销一个 self 点"看起来成功、实际什么都没发生）；
   * ④ 授予时还要求**这个插件声明过**（`requireDeclared`）⇒ `NOT_DECLARED`（授予没申请的点没有意义，
   *    通常是打错字）。**撤回不要求**：撤回是收窄，收窄不该被"它现在没声明"挡住
   *    —— 插件升级后把声明删了，管理员仍然要能把那条陈旧授权清掉。
   */
  /**
   * 这个插件**声明过的点** —— "授予的点必须是它申请过的"（`NOT_DECLARED`）读的就是这里。
   *
   * = 清单 `permissions[]` ∪ **依赖条目 `call` 派生出的跨插件点**（⑤ 起）。
   * 为什么后者也算声明：调用面的请求写在 `dependencies.plugins[].call` 里（包内被签名的字节，
   * 且**故意不带源**），宿主把它锚定解析成实际引用后才生成 `plugins.call.<引用>.<path>`。
   * 只读 `permissions[]` 的话，"安装时顺手把这条跨插件授权一起授予"这条合法路径会被
   * `NOT_DECLARED` 挡掉 —— 那正是本函数存在的意义（装载器里的声明集合同源，见 `loader.ts`）。
   */
  private declaredPoints(record: PluginRecord): string[] {
    const manifest = readRecordManifest(record);
    const points = (manifest.permissions ?? []).map((p) => p.name);
    for (const dep of manifest.dependencies?.plugins ?? []) {
      if (!dep.call || dep.call.length === 0) continue;
      try {
        const depRef = this.resolveDep(dep, { origin: record.origin, ref: pluginRef(record) });
        for (const path of dep.call) points.push(callPointOf(depRef, path));
      } catch {
        // 解析不出来（依赖没装 / 身份不符 / 本地范围内歧义）⇒ 那条依赖本来就不成立，装载会报它。
        // 这里静默跳过：授权校验不该被一个与授权无关的原因挡住。
      }
    }
    return points;
  }

  private assertPointsOperable(record: PluginRecord, points: string[], requireDeclared: boolean): void {
    const declared = requireDeclared ? this.declaredPoints(record) : [];
    for (const point of points) {
      if (!isValidGrantPoint(point)) {
        throw new SpcError('GRANT_WILDCARD', { permission: point });
      }
      const known = pointSource.get(point);
      if (!known) {
        throw new SpcError('UNKNOWN_POINT', { permission: point });
      }
      if (
        requireDeclared &&
        !declared.some((d) => d === point || d === '*' || (d.endsWith('.*') && point.startsWith(d.slice(0, -1))))
      ) {
        throw new SpcError('NOT_DECLARED', { permission: point });
      }
      const tier = resolveGrant(known.scope, known.grant);
      if (tier === 'auto') {
        throw new SpcError('GRANT_NOT_APPLICABLE', { permission: point, grant: tier });
      }
    }
  }

  /**
   * 逐点授予：**把点加进白名单**（`install` 与 `explicit` 同一条道 —— 判定链只问"在不在 `grants` 里"）。
   * `auto` 档 ⇒ `GRANT_NOT_APPLICABLE`（够不着别人，没有可授予的东西）。
   *
   * 授权变更**落一条审计**（`plugin.grant`）—— 权限变更不留痕是比"少一个状态字段"更严重的问题；
   * "是谁撤的、什么时候撤的"因此从日志里就能回答，不需要在记录里再存一份"已撤回"名单。
   */
  grant(input: string, points: string[]): PluginView {
    if (points.length === 0) {
      throw new SpcError('INVALID_ARGS', { reason: 'no-permission-point-given' });
    }
    const record = this.mustRecord(input);
    const ref = pluginRef(record);
    this.assertPointsOperable(record, points, true);
    const before = new Set(record.grants);
    const grants = [...new Set([...record.grants, ...points])].sort();
    this.patchRecord(ref, { grants });
    this.auditAuthz(ref, 'plugin.grant', points.filter((p) => !before.has(p)));
    // 沙箱持有的是装载时的授予快照 → 运行中的插件需要 reload 才生效
    if (this.loaded.has(ref)) this.needsReload.add(ref);
    return this.status(ref);
  }

  /**
   * 逐点撤回：**把点移出白名单**。`auto` 档 ⇒ `GRANT_NOT_APPLICABLE`（它本来就不需要授予，
   * 也就没有"撤回"可言；要停用它请禁用或卸载插件）。
   *
   * 撤回后判定链给出的是 `NOT_GRANTED`（"未授予"）—— 与"从未授予"同一个码。
   * 想区分"谁在什么时候撤的"看审计（`plugin.revoke`），不靠记录里的状态字段。
   */
  revoke(input: string, points: string[]): PluginView {
    if (points.length === 0) {
      throw new SpcError('INVALID_ARGS', { reason: 'no-permission-point-given' });
    }
    const record = this.mustRecord(input);
    const ref = pluginRef(record);
    this.assertPointsOperable(record, points, false);
    const remove = new Set(points);
    this.patchRecord(ref, { grants: record.grants.filter((g) => !remove.has(g)) });
    this.auditAuthz(ref, 'plugin.revoke', points.filter((p) => record.grants.includes(p)));
    if (this.loaded.has(ref)) this.needsReload.add(ref);
    return this.status(ref);
  }

  // ---- 换源（reanchor）：docs/events-and-hooks-design.md §3.6 ----

  /**
   * **预检**：这一搬会发生什么（只读，不改任何东西）。
   *
   * 为什么预检与执行**共用同一个函数**：CLI 要在执行前把计划给管理员看，而两次之间世界会变
   * （TOCTOU）⇒ 执行时必须在锁内**重算一遍**，两次用的是同一份判据。写成两份迟早分叉。
   *
   * 判据（设计 §3.6 + 2026-09-25 用户拍板）：
   * - **目标桶必须是 keyring 里的真条目**（⑥a 起"桶"就是源条目）⇒ 否则 `SOURCE_NOT_CONFIGURED`；
   * - 目标桶绑了作者锚 ⇒ 被搬插件的 `authorFingerprint` 必须**等于**锚，否则那条声明不成立 ⇒
   *   `PLUGIN_ANCHOR_MISMATCH`（插件没有作者身份而桶有锚，同样是这条）；
   * - 目标位置（记录 / 数据目录 / 配置文件）已占用 ⇒ `PLUGIN_REANCHOR_CONFLICT`（**不做合并**：
   *   静默合并两份数据是事故，宁可让管理员先处理）；
   * - 不在名单里的**已装载**依赖方 ⇒ `PLUGIN_IN_USE`（要么把它们也放进名单，要么先停掉）；
   * - 已启用但**没在跑**的依赖方 ⇒ **只提示**（它下一次启动才会撞 `PLUGIN_DEPENDENCY_SOURCE_CHANGED`）；
   * - 目标桶停用 / 暂停 ⇒ **只提示**（用户拍板：管理员自己知道在干什么）。
   */
  planReanchor(refs: string[], targetOrigin: string): ReanchorPlan {
    const errors: ReanchorPlanError[] = [];
    const warnings: ReanchorPlanWarning[] = [];
    const file = loadRecords();

    // ① 目标桶
    const bucket = isValidSource(targetOrigin) ? keyring().get(targetOrigin) : undefined;
    if (!isValidSource(targetOrigin)) {
      errors.push({ code: 'SOURCE_ORIGIN_INVALID', params: { origin: targetOrigin } });
    } else if (!bucket) {
      errors.push({ code: 'SOURCE_NOT_CONFIGURED', params: { origin: targetOrigin, reason: 'not-found' } });
    }
    const target: ReanchorPlan['target'] = {
      origin: targetOrigin,
      kind: bucket?.kind ?? null,
      alias: bucket?.alias ?? '',
      enabled: bucket?.enabled ?? false,
      suspended: bucket?.suspended?.reason ?? null,
      anchorFingerprint: bucket?.authorAnchor?.fingerprint ?? null,
    };

    // 目标来源形状非法 ⇒ 后面的目录计算根本做不了（`sanitizeOrigin` 会抛）⇒ 到此为止，
    // 计划里已经有那条错，交给调用方渲染
    if (!isValidSource(targetOrigin)) {
      return {
        target,
        moves: [],
        grantRewrites: [],
        needsReload: [],
        blockedBy: [],
        idleDependents: [],
        warnings,
        errors,
      };
    }

    // ② 输入 → 记录（去重；歧义/找不到都记进计划，不抛）
    const records: PluginRecord[] = [];
    for (const input of refs) {
      let rec: PluginRecord | undefined;
      try {
        rec = resolveRecord(file, input);
      } catch (e) {
        const shape = toErrorShape(e);
        errors.push({ code: shape?.code ?? 'PLUGIN_NOT_FOUND', params: shape?.params ?? { pluginId: input } });
        continue;
      }
      if (!rec) {
        errors.push({ code: 'PLUGIN_NOT_FOUND', params: { pluginId: input } });
        continue;
      }
      if (!records.some((r) => pluginRef(r) === pluginRef(rec))) records.push(rec);
    }

    // ③ 逐条查目标位置与锚
    const moves: ReanchorPlanMove[] = [];
    const taken = new Set<string>();
    for (const rec of records) {
      const from = pluginRef(rec);
      const to = pluginRef({ origin: targetOrigin, id: rec.id });
      if (from === to) {
        errors.push({ code: 'PLUGIN_REANCHOR_CONFLICT', params: { pluginId: from, ref: to, reason: 'same-origin' } });
        continue;
      }
      if (taken.has(to) || findRecord(file, to)) {
        errors.push({ code: 'PLUGIN_REANCHOR_CONFLICT', params: { pluginId: from, ref: to, reason: 'target-occupied' } });
        continue;
      }
      taken.add(to);
      if (target.anchorFingerprint !== null && rec.authorFingerprint !== target.anchorFingerprint) {
        errors.push({
          code: 'PLUGIN_ANCHOR_MISMATCH',
          params: {
            pluginId: from,
            origin: targetOrigin,
            expected: target.anchorFingerprint,
            actual: rec.authorFingerprint ?? 'none',
          },
        });
        continue;
      }
      const dataDir = { from: pluginDataDir(rec.origin, rec.id), to: pluginDataDir(targetOrigin, rec.id) };
      const config = { from: rec.configPath, to: pluginConfigPath(targetOrigin, rec.id) };
      if (existsSync(dataDir.to)) {
        errors.push({ code: 'PLUGIN_REANCHOR_CONFLICT', params: { pluginId: from, ref: dataDir.to, reason: 'data-dir-exists' } });
        continue;
      }
      if (existsSync(config.to)) {
        errors.push({ code: 'PLUGIN_REANCHOR_CONFLICT', params: { pluginId: from, ref: config.to, reason: 'config-exists' } });
        continue;
      }
      // 托管副本：只有"我们的副本"才搬（就地安装的 `exists: false` —— 那是作者的目录）
      const pkgDir = { from: rec.dir, to: hostedPackageDir(targetOrigin, rec.id) };
      if (rec.hosted === true && existsSync(pkgDir.to)) {
        errors.push({ code: 'PLUGIN_REANCHOR_CONFLICT', params: { pluginId: from, ref: pkgDir.to, reason: 'package-dir-exists' } });
        continue;
      }
      moves.push({
        from,
        fromOrigin: rec.origin,
        to,
        id: rec.id,
        version: { ...rec.version },
        enabled: rec.enabled,
        state: rec.state,
        authorFingerprint: rec.authorFingerprint,
        dataDir: { ...dataDir, exists: existsSync(dataDir.from) },
        config: { ...config, exists: existsSync(config.from) },
        pkg: { ...pkgDir, exists: rec.hosted === true && existsSync(pkgDir.from) },
      });
    }

    // ④ 别人的授权会被改成什么（批内互指也一起改对 ⇒ 用同一张映射表同时替换）
    const map = new Map(moves.map((m) => [m.from, m.to]));
    const grantRewrites: ReanchorPlan['grantRewrites'] = [];
    for (const rec of file.plugins) {
      const pairs: { from: string; to: string }[] = [];
      for (const g of rec.grants) {
        const to = rewritePoint(g, map);
        if (to !== undefined) pairs.push({ from: g, to });
      }
      if (pairs.length > 0) grantRewrites.push({ ref: pluginRef(rec), pairs });
    }
    const batch = new Set(moves.map((m) => m.from));
    const needsReload = grantRewrites
      .filter((a) => !batch.has(a.ref) && this.loaded.has(a.ref))
      .map((a) => a.ref)
      .sort();

    // ⑤ 依赖方：已装载的拦、已启用没在跑的只提示
    const blockedBy: ReanchorPlan['blockedBy'] = [];
    const idle = new Set<string>();
    for (const m of moves) {
      const dependents = this.activeDependents(m.from).filter((r) => !batch.has(r));
      if (dependents.length > 0) blockedBy.push({ ref: m.from, dependents });
      for (const rec of file.plugins) {
        const ref = pluginRef(rec);
        if (batch.has(ref) || !rec.enabled || this.loaded.has(ref)) continue;
        if (this.directDeps(rec).includes(m.from)) idle.add(ref);
      }
    }
    for (const b of blockedBy) {
      errors.push({
        code: 'PLUGIN_IN_USE',
        params: { pluginId: b.ref, dependents: b.dependents.join(', '), action: 'reanchor' },
      });
    }

    // ⑥ 提示（能搬，但管理员该知道）
    if (bucket && !bucket.enabled) warnings.push({ code: 'REANCHOR_TARGET_DISABLED', params: { origin: targetOrigin } });
    if (bucket?.suspended) {
      warnings.push({ code: 'REANCHOR_TARGET_SUSPENDED', params: { origin: targetOrigin, reason: bucket.suspended.reason } });
    }
    if (bucket?.kind === 'market') {
      // 从"没有更新渠道"搬进一个有源的源：**一次实质的信任升级**（§3.6 要求必须提示）
      const fromUnanchored = moves.some((m) => {
        const rec = findRecord(file, m.from);
        return rec?.signedBy === null || rec?.signedBy === undefined;
      });
      warnings.push({ code: fromUnanchored ? 'REANCHOR_BECOMES_ANCHORED' : 'REANCHOR_KEEPS_CHANNEL', params: { origin: targetOrigin } });
    } else if (moves.some((m) => (findRecord(file, m.from)?.signedBy ?? null) !== null)) {
      warnings.push({ code: 'REANCHOR_LOSES_CHANNEL', params: { origin: targetOrigin } });
    }
    if (target.anchorFingerprint !== null) {
      warnings.push({ code: 'REANCHOR_ANCHOR_MATCHED', params: { origin: targetOrigin, fingerprint: target.anchorFingerprint } });
    }
    if (idle.size > 0) {
      warnings.push({ code: 'REANCHOR_IDLE_DEPENDENTS', params: { refs: [...idle].sort().join(', ') } });
    }

    return { target, moves, grantRewrites, needsReload, blockedBy, idleDependents: [...idle].sort(), warnings, errors };
  }

  /**
   * **执行换源**（批量、原子）。顺序是设计好的，不要调换：
   *
   * ① 锁内**重算计划**（TOCTOU）→ ② **停机**（依赖方优先；改 ref 前必须停干净：能力登记 / `loaded` /
   * `needsReload` 全以 ref 为键）→ ③ **先搬磁盘再写记录**（记录是"已经搬完"的凭证，反过来就会出现
   * "记录说搬了、目录没搬"；磁盘失败则回滚已搬目录，记录一个字都没改 ⇒ 状态自洽）→ ④ 重写记录
   * （别人的授权点名随源变 + 自己的 `origin`/`configPath`）→ ⑤ 名册搬家 → ⑥ `needsReload` →
   * ⑦ 重启原本 enabled 的（依赖优先，单插件失败不影响其它）→ ⑧ 审计（`pluginId` = 旧引用、`ref` = 新引用）。
   */
  reanchor(refs: string[], targetOrigin: string): Promise<ReanchorResult> {
    return this.withLock(async () => {
      const started = Date.now();
      const plan = this.planReanchor(refs, targetOrigin);
      if (plan.errors.length > 0) {
        const first = plan.errors[0];
        throw new SpcError(first.code, first.params);
      }
      const batch = new Set(plan.moves.map((m) => m.from));
      const map = new Map(plan.moves.map((m) => [m.from, m.to]));
      // 装载顺序（依赖优先）在**停机前**算好：停机要反着走，重启要正着走
      const order = this.resolveLoadOrder(loadRecords().plugins).order.map((r) => pluginRef(r));

      // ② 停机（依赖方优先）
      for (const ref of order.filter((r) => batch.has(r)).reverse()) {
        if (this.loaded.has(ref)) await this.stopAndUnload(ref, 'reanchor');
      }

      // ③ 搬磁盘（失败即回滚已搬的，然后把错误抛出去）
      const moved: { from: string; to: string }[] = [];
      const rollback: { from: string; to: string }[] = [];
      let step = '';
      try {
        for (const m of plan.moves) {
          if (m.dataDir.exists) {
            step = `${m.dataDir.from} → ${m.dataDir.to}`;
            // ⚠️ **目标来源的目录段通常还不存在**（新桶里一个插件都没有）⇒ 先建父目录，
            // 否则 `rename` 直接 ENOENT（本用例抓到的实现 bug：`data/plugins/local_std-a/` 没建）
            ensureDir(dirname(m.dataDir.to));
            renameSync(m.dataDir.from, m.dataDir.to);
            rollback.push({ from: m.dataDir.from, to: m.dataDir.to });
          }
          if (m.config.exists) {
            step = `${m.config.from} → ${m.config.to}`;
            ensureDir(dirname(m.config.to));
            renameSync(m.config.from, m.config.to);
            rollback.push({ from: m.config.from, to: m.config.to });
          }
          // 托管副本（`.spc` 装的那种）：换了来源 ⇒ 副本也搬到新来源的目录段下（`record.dir` 在 ④ 里跟着改）
          if (m.pkg.exists) {
            step = `${m.pkg.from} → ${m.pkg.to}`;
            ensureDir(dirname(m.pkg.to));
            renameSync(m.pkg.from, m.pkg.to);
            rollback.push({ from: m.pkg.from, to: m.pkg.to });
            // 顺手收掉搬空的旧来源目录（与卸载那条路同一做法：非空/不存在都不管）
            try {
              rmdirSync(dirname(m.pkg.from));
            } catch {
              /* 非空（同来源下还有别的插件）或不存在：都不是问题 */
            }
          }
          moved.push({ from: m.from, to: m.to });
        }
      } catch (err) {
        for (const r of rollback.reverse()) {
          try {
            renameSync(r.to, r.from);
          } catch {
            /* 回滚失败：记录仍未改，人工介入（目录留在新位置） */
          }
        }
        throw new SpcError('PLUGIN_REANCHOR_FAILED', {
          move: step,
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      // ④ 重写记录（先改别人的授权，再改自己的键 —— 顺序决定 `pluginRef(rec)` 还是旧的）
      const file = loadRecords();
      const affected: { ref: string; pairs: { from: string; to: string }[] }[] = [];
      for (const rec of file.plugins) {
        const pairs: { from: string; to: string }[] = [];
        const next = rec.grants.map((g) => {
          const to = rewritePoint(g, map);
          if (to !== undefined) pairs.push({ from: g, to });
          return to ?? g;
        });
        if (pairs.length > 0) {
          rec.grants = [...new Set(next)].sort();
          affected.push({ ref: pluginRef(rec), pairs });
        }
      }
      for (const m of plan.moves) {
        const rec = findRecord(file, m.from);
        if (!rec) continue; // 计划刚算出来，这里不该缺
        rec.origin = targetOrigin;
        rec.configPath = m.config.to;
        // 托管副本搬过位置了 ⇒ `dir` 必须跟着改（不改就是"记录指向一个已经不存在的目录"）
        if (m.pkg.exists) rec.dir = m.pkg.to;
      }
      saveRecords(file);

      // ⑤ 名册：记忆跟着插件走（写新键 + 删旧键）
      let authorsMoved = 0;
      for (const m of plan.moves) {
        if (moveAuthor({ origin: m.fromOrigin, id: m.id }, { origin: targetOrigin, id: m.id })) authorsMoved++;
      }

      // ⑥ 授权被改写的**运行中**（非批内）插件要 reload 才生效
      for (const a of affected) {
        if (!batch.has(a.ref) && this.loaded.has(a.ref)) this.needsReload.add(a.ref);
      }
      for (const m of plan.moves) this.needsReload.delete(m.from);

      // ⑦ 重启（依赖优先；单插件失败不影响其它 —— 与 startAll 同一条口径）
      const failedToStart: { ref: string; code: string }[] = [];
      for (const oldRef of order.filter((r) => batch.has(r))) {
        const m = plan.moves.find((x) => x.from === oldRef);
        if (!m?.enabled) continue;
        const rec = findRecord(loadRecords(), m.to);
        if (!rec) continue;
        try {
          await this.loadAndStart(rec);
        } catch (e) {
          failedToStart.push({ ref: m.to, code: toErrorShape(e)?.code ?? 'PLUGIN_LOAD_FAILED' });
        }
      }

      // ⑧ 审计：一条一插件（`pluginId` = 旧引用、`ref` = 新引用 ⇒ 旧新都在同一条里）
      for (const m of plan.moves) {
        audit({
          ts: Date.now(),
          // 管理员发起的换源：关于**搬过去之后的那个引用**，新来源进明细
          actor: operatorActor(),
          subject: { kind: 'plugin', ref: m.to },
          method: 'plugin.reanchor',
          paramsDigest:
            digestParams({
              to: m.to,
              fingerprint: m.authorFingerprint ?? 'none',
              ownGrantPairs: String(affected.find((a) => a.ref === m.from)?.pairs.length ?? 0),
              involvedRecords: String(affected.length),
              authorsMoved: String(authorsMoved),
            }) ?? digest(m.from),
          result: 'ok',
          detail: { origin: targetOrigin, from: m.from },
          timing: { ms: Date.now() - started },
        });
      }

      return { plan, moved, views: plan.moves.map((m) => this.status(m.to)), failedToStart };
    });
  }

  /**
   * 授权变更审计（`plugin.grant` / `plugin.revoke`）。
   * 只记**实际变了**的点（重复授予、撤回一个本来就没有的点都不留噪声）；`target` 是点名列表，
   * 属非敏感信息（点名的形状本就是插件作者写在清单里的东西）。
   */
  private auditAuthz(ref: string, method: 'plugin.grant' | 'plugin.revoke', changed: string[]): void {
    if (changed.length === 0) return;
    audit({
      ts: Date.now(),
      // 授权/撤回是**管理员动作**：契约里"谁在什么时候改了授权"的唯一出处
      actor: operatorActor(),
      subject: { kind: 'plugin', ref },
      method,
      paramsDigest: digestParams({ count: String(changed.length) }) ?? digest(ref),
      result: 'ok',
      // 变了哪几个点是这条审计的重点 ⇒ 明文（权限点是码，不敏感）
      detail: { points: [...changed].sort() },
      timing: { ms: 0 },
    });
  }

  // ---- 跨插件调用（`plugins.call` 的宿主侧：投递链）----
  //
  // 分工：hostApi 那一半只做"句柄 → 实际引用 → 点名"（门槛 ①②），这里做"找对端、查门槛④、
  // 有界重试、记账"——因为只有 manager 知道谁在跑、谁在忙。
  //
  // 四个决定（都是设计 §3.7 定的，别再改）：
  //   · **不排队**：对端忙 ⇒ 有界重试（见下），重试完还忙就失败。顺序等待会让调用方的阶段预算
  //     被对端吃掉，而且"谁先谁后"变得不可解释；
  //   · **崩溃/卸载不重试**：反复去叫一个坏掉的插件没有意义；
  //   · **超时不返回部分结果**：fail-closed；
  //   · **深度上限**：串行契约已经让回环快速失败（A→B→A 时 A 正忙 ⇒ PLUGIN_BUSY），
  //     但一条**不成环的深链**照样能吃掉宿主栈，所以另有一道计数器。
  //
  /** 当前嵌套到第几层（同一时刻只有一条调用链在跑：宿主是单线程，且每层都在 await 下一层） */
  private callDepth = 0;

  private dispatchCall = async (req: CallDispatchRequest): Promise<CallDispatchResult> => {
    const limits = this.limits();
    if (this.callDepth >= limits.maxCallDepth) {
      throw new SpcError('PLUGIN_CALL_DEPTH_EXCEEDED', {
        pluginId: req.caller.ref ?? req.caller.pluginId,
        callee: req.calleeRef,
        depth: String(this.callDepth),
        maxDepth: String(limits.maxCallDepth),
      });
    }
    this.callDepth += 1;
    try {
      return await this.deliverCall(req, limits);
    } finally {
      this.callDepth -= 1;
    }
  };

  /** 一次投递（深度已计过；见 `dispatchCall` 的四个决定） */
  private deliverCall = async (req: CallDispatchRequest, limits: PluginLimits): Promise<CallDispatchResult> => {
    const callee = this.loaded.get(req.calleeRef);
    const calleeRecord = callee ? findRecord(loadRecords(), req.calleeRef) : undefined;
    if (!callee || !callee.sandbox || !calleeRecord) {
      // 卸载 / 禁用 / 崩溃 / 还没起来 —— 都不重试（重试一个不在的对端只会拖长调用方的时间）
      throw new SpcError('PLUGIN_CALL_TARGET_UNAVAILABLE', {
        pluginId: req.caller.ref ?? req.caller.pluginId,
        callee: req.calleeRef,
        path: req.path,
        state: calleeRecord?.state ?? 'unloaded',
      });
    }
    // 门槛④：端点必须声明 `callable: ['plugins']`（缺省只有 'panel' ⇒ 默认不给插件调）
    const endpoint = capabilities.endpointOf(req.calleeRef, req.path);
    if (!endpoint || !endpoint.callable.includes('plugins')) {
      throw new SpcError('PLUGIN_CALL_NOT_CALLABLE', {
        pluginId: req.caller.ref ?? req.caller.pluginId,
        callee: req.calleeRef,
        path: req.path,
      });
    }

    const callId = randomBytes(8).toString('hex');
    const started = Date.now();
    // 调用方那次宿主调用**自己**的预算（`remainingMs`；没有阶段在跑时是 Infinity）。
    // 对端不能用"我自己的 callTimeoutMs"去跑：调用方可能只留了 200ms —— 那会把调用方的阶段拖爆。
    const budgetMs = req.budgetMs ?? Number.POSITIVE_INFINITY;
    const deadline = started + budgetMs;
    const sandbox = callee.sandbox;
    // 响应信封里的版本用**字符串**（`1.2.0`）：插件要的是"对端是哪一版"这个事实，
    // 而 manifest 里的 `{code, name}` 里 `code` 是给核心比较用的整数（P2 不做 API 版本目录）
    const version = callee.manifest.version.name;
    let attempts = 0;
    let waitedMs = 0;
    try {
      // 忙时有界重试（策略整个在 core/plugin/call-retry.ts 里：3 次尝试含首次、等 50+100ms、≤350ms、不排队）
      const outcome = await withBusyRetry(
        async () => {
          const timeoutMs = Math.max(1, Math.min(limits.callTimeoutMs, deadline - Date.now()));
          return sandbox.callEndpoint(req.path, req.paramsJson, req.bytes, timeoutMs, callId);
        },
        { deadline },
      );
      attempts = outcome.attempts;
      waitedMs = outcome.waitedMs;
      const text = outcome.value;
      // 被调方返回的是 JSON 文本（引导层已确认是字符串）。**在这里解析**而不是把文本套进信封：
      // 调用方拿到的是嵌套好的结果，不必二次 parse；解析失败 = 被调方违约，fail-closed。
      let result: unknown;
      try {
        result = JSON.parse(text);
      } catch (err) {
        throw new SpcError('PLUGIN_CALL_BAD_RESULT', {
          pluginId: calleeRecord.id,
          callee: req.calleeRef,
          path: req.path,
          callId,
          reason: 'result-not-json',
          message: err instanceof Error ? err.message.slice(0, 200) : 'parse failed',
        });
      }
      const durationMs = Date.now() - started;
      // 调用方这一侧的账：**一次跨插件交互一条**，callId 让对端内部那几条能串回来
      audit({
        ts: Date.now(),
        // 发起者是**调用方插件**（以前这槽里放的是被调方 —— 正是"分不清谁"的来源）；对端进 subject
        actor: pluginActor(req.caller.ref ?? req.caller.pluginId),
        subject: { kind: 'plugin', ref: req.calleeRef },
        method: 'plugins.call',
        paramsDigest: digest(JSON.stringify([req.calleeRef, req.path])),
        result: 'ok',
        detail: { path: req.path },
        corr: { callId, attempts, waitedMs },
        resultBytes: Buffer.byteLength(text),
        timing: { ms: durationMs },
      });
      return {
        envelope: {
          ok: true,
          callId,
          callee: { origin: calleeRecord.origin, id: calleeRecord.id, version },
          path: req.path,
          result: result ?? null,
        },
        callId,
        attempts,
        waitedMs,
      };
    } catch (err) {
      const shape = toErrorShape(err);
      audit({
        ts: Date.now(),
        actor: pluginActor(req.caller.ref ?? req.caller.pluginId),
        subject: { kind: 'plugin', ref: req.calleeRef },
        method: 'plugins.call',
        paramsDigest: digest(JSON.stringify([req.calleeRef, req.path])),
        result: 'error',
        error: { code: shape?.code ?? 'INTERNAL', paramsDigest: digestParams(shape?.params) },
        detail: { path: req.path },
        corr: { callId, attempts, waitedMs },
        timing: { ms: Date.now() - started },
      });
      throw err;
    }
  };

  // ---- 启动 / 停机 ----
  /**
   * 启动时自动装载 enabled 的插件（§2）。
   * **按依赖拓扑序装载**（依赖先起）；环上的插件直接判 failed，其余逐个 try/catch——
   * 单插件失败不影响其它插件。
   */
  startAll(): Promise<PluginView[]> {
    return this.withLock(async () => {
      const file = loadRecords();
      // 上次进程留下的"运行中"状态一律归零：进程都没了，插件不可能还在跑
      let dirty = false;
      for (const record of file.plugins) {
        if (record.state !== 'stopped' && record.state !== 'disabled' && record.state !== 'installed') {
          record.state = record.enabled ? 'installed' : 'disabled';
          dirty = true;
        }
      }
      if (dirty) saveRecords(file);

      const pending = file.plugins.filter((r) => r.enabled && !this.loaded.has(pluginRef(r)));
      const { order, cyclic } = this.resolveLoadOrder(pending);

      for (const ref of cyclic) {
        const error: PluginErrorRecord = { code: 'PLUGIN_DEPENDENCY_CYCLE', at: Date.now() };
        this.setState(ref, 'failed', error);
        console.warn(`[plugin] ${ref} 处在依赖环上，跳过装载（环成员：${[...cyclic].join(', ')}）`);
      }

      for (const record of order) {
        const ref = pluginRef(record);
        if (cyclic.has(ref) || this.loaded.has(ref)) continue;
        try {
          await this.loadAndStart(record);
        } catch (err) {
          const shape = toErrorShape(err);
          console.warn(`[plugin] ${ref} 装载失败：${shape?.code ?? 'PLUGIN_LOAD_FAILED'}（继续装载下一个）`);
        }
      }
      return this.list();
    });
  }

  /**
   * 停机：逐个 stop → 撤销能力登记 → dispose。**stop 抛错或超时都继续**（一个插件不该拖住核心停机）。
   *
   * `opts.budgetMs` = **整场停机的总预算**：每个插件的 stop 预算被压成
   * `min(它自己的 stopTimeoutMs, 剩余总预算)`。
   * 为什么必须有这一条：插件的 `stop` 里死循环时，**宿主会被同步阻塞** ——
   * 那种阻塞连"全局超时定时器"都轮不上（事件循环被占住），所以只能在**进沙箱之前**
   * 就把这一次的 stop 预算压小；否则 N 个卡住的插件就是 N × stopTimeoutMs，
   * "停机要等多久"随插件数线性增长。预算用尽的插件**放弃等待**并记一笔审计（进程反正要退）。
   */
  stopAll(reason: StopReason = 'shutdown', opts: { budgetMs?: number } = {}): Promise<void> {
    return this.withLock(async () => {
      for (const timer of this.restartTimers) clearTimeout(timer);
      this.restartTimers.clear();
      const deadline =
        opts.budgetMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + opts.budgetMs;
      const base = this.limits();
      for (const ref of [...this.loaded.keys()]) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          console.warn(`[plugin] 停机预算用尽，放弃等待 ${ref}`);
          audit({
            ts: Date.now(),
            // 停机预算用完 ⇒ 放弃等这个插件：核心动作
            actor: coreActor(),
            subject: { kind: 'plugin', ref },
            method: 'lifecycle.shutdown-abandoned',
            paramsDigest: digestParams({ reason }) ?? digest(ref),
            result: 'error',
            error: { code: 'SHUTDOWN_BUDGET_EXHAUSTED' },
            detail: { reason },
            timing: { ms: 0 },
          });
          continue;
        }
        try {
          const limits = { ...base, stopTimeoutMs: Math.min(base.stopTimeoutMs, remaining) };
          await this.stopAndUnload(ref, reason, limits, coreActor());
          const record = findRecord(loadRecords(), ref);
          this.patchRecord(ref, { state: record?.enabled ? 'stopped' : 'disabled' });
        } catch (err) {
          const shape = toErrorShape(err);
          console.warn(`[plugin] ${ref} 卸载异常：${shape?.code ?? 'INTERNAL'}`);
        }
      }
    });
  }

  /** 当前活着的插件数（诊断用） */
  runningCount(): number {
    return this.loaded.size;
  }

  /** 测试用：重置内存态（不动磁盘） */
  resetMemory(): void {
    this.loaded.clear();
    this.needsReload.clear();
    for (const timer of this.restartTimers) clearTimeout(timer);
    this.restartTimers.clear();
    capabilities.reset();
  }
}

export const manager = new PluginManager();
