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
import type { Manifest, PluginType } from '../../sdk/types';
import { audit, digest, digestParams } from '../audit';
import { DEFAULT_LOCAL_SOURCE, loadConfig, pluginDataDir, type PluginLimits, type SpcConfig } from '../config';
import { SpcError, toErrorShape } from '../errors';
import type { CallDispatchRequest, CallDispatchResult } from '../hostApi';
import { isValidGrantPoint } from '../permissions/check';
import { callPointOf } from '../permissions/points';
import { resolveGrant } from '../permissions/registry';
import { pointSource } from '../permissions/source';
import { findAuthor, loadAuthors, rememberAuthor } from '../sources/authors';
import { fingerprintOf } from '../sources/keys';
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
    try {
      type = readRecordManifest(record).type ?? 'ability';
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

  private async loadAndStart(record: PluginRecord, opts: { isRestart?: boolean } = {}): Promise<void> {
    const ref = pluginRef(record);
    // 重入保护：同一插件已在装载中/已装载 → 先干净卸载再装。
    // 没有这一条，"重装同一个插件"或"startAll 撞上已有句柄"就会叠加能力登记 + 泄漏沙箱。
    if (this.loaded.has(ref)) {
      await this.stopAndUnload(ref, 'reload');
    }
    this.setState(ref, 'loading');
    let run: RunningPlugin | undefined;
    try {
      run = await loadPlugin(record, {
        limits: this.limits(),
        dependencyStatus: this.dependencyStatus,
        resolveDep: this.resolveDep,
        dispatchCall: this.dispatchCall,
        logger: (level, message) => console[level](`[${ref}] ${message}`),
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

  private async stopAndUnload(ref: string, reason: StopReason, limits = this.limits()): Promise<void> {
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
    await unloadPlugin(run, reason, limits);
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
        pluginId: ref,
        method: 'lifecycle.restart',
        target: ref,
        paramsDigest: digestParams({ attempts: String(attempts), decision: 'give-up' }) ?? digest(ref),
        result: 'error',
        error: { code: error.code },
        durationMs: 0,
      });
      return;
    }

    audit({
      ts: Date.now(),
      pluginId: ref,
      method: 'lifecycle.restart',
      target: ref,
      paramsDigest:
        digestParams({ attempts: String(attempts), backoffMs: String(cfg.restartBackoffMs) }) ?? digest(ref),
      result: 'ok',
      durationMs: 0,
    });

    const timer = setTimeout(() => {
      this.restartTimers.delete(timer);
      void this.withLock(async () => {
        const rec = findRecord(loadRecords(), ref);
        if (!rec || !rec.enabled) return;
        try {
          await this.loadAndStart(rec, { isRestart: true });
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
    return this.withLock(async () => {
      const manifest = readManifestFromDir(dir);
      const file = loadRecords();
      const origin = opts.source ?? DEFAULT_LOCAL_SOURCE;
      const ref = pluginRef({ origin, id: manifest.id });
      const existing = findRecord(file, ref);
      // ① 作者信封（本地路径；有源安装的市场验签流在 P4，见 sources/verify.ts 的 verifyPackage）
      const envelope = loadLocalEnvelope(dir);
      if (envelope.kind === 'error') throw new SpcError(envelope.code, envelope.params);
      const authorPub = envelope.kind === 'ok' ? envelope.authorPub : undefined;
      // ② 身份闸（在写记录**之前**：被拒就不该留下任何痕迹）
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
      return this.status(ref);
    });
  }

  /**
   * 作者身份闸（`plugin-signature-design.md` §3bis 的"期望值解析"）。
   *
   * 判据链：**名册首见值 →（名册没有时）记录里的指纹 →（都没有即首见，TOFU）**。
   * - 一致 / 首见 ⇒ 记名册，返回本次的指纹（写进记录）；
   * - 不符 ⇒ 抛 `PLUGIN_AUTHOR_MISMATCH`（错误里给两条出路：换个源 / `--accept-key-change`），
   *   除非管理员显式接受 —— 那时**覆盖名册**并落一条 `plugin.key-change` 审计（旧/新指纹都记）；
   * - 包没带作者身份（`authorPub === undefined`）⇒ 返回 `null`：**名册不动**（那是宿主记忆，
   *   不该被一个"没自报家门"的版本抹掉），但这个版本满足不了带 `author.pub` 的依赖声明。
   */
  private authorIdentityGate(
    who: { origin: string; id: string; ref: string },
    authorPub: string | undefined,
    recordFingerprint: string | null,
    acceptKeyChange: boolean,
  ): string | null {
    if (authorPub === undefined) return null;
    const fingerprint = fingerprintOf(authorPub);
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
        pluginId: who.ref,
        ref: who.ref,
        method: 'plugin.key-change',
        target: fingerprint,
        paramsDigest: digestParams({ previous: String(expected) }) ?? digest(who.ref),
        result: 'ok',
        durationMs: 0,
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
      pluginId: pluginRef(record),
      ref: pluginRef(record),
      method: 'plugin.grant',
      target: seeded.join(','),
      paramsDigest: digestParams({ via: 'install-seed' }) ?? digest(pluginRef(record)),
      result: 'ok',
      durationMs: 0,
    });
  }

  enable(input: string): Promise<PluginView> {
    return this.withLock(async () => {
      const ref = pluginRef(this.mustRecord(input));
      const record = this.patchRecord(ref, { enabled: true, state: 'installed', lastError: null });
      if (!this.loaded.has(ref)) {
        await this.loadAndStart(record);
      }
      return this.status(ref);
    });
  }

  disable(input: string): Promise<PluginView> {
    return this.withLock(async () => {
      const ref = pluginRef(this.mustRecord(input));
      // 禁用同样会让依赖方失去依赖（`dependencyStatus` 要求"已启用且已装载"）→ 一并设防
      this.assertNotInUse(ref, 'disable');
      await this.stopAndUnload(ref, 'disable');
      this.patchRecord(ref, { enabled: false, state: 'disabled' });
      return this.status(ref);
    });
  }

  /** 重载：整插件 stop → 重新 load（不做模块热替换），也是 failed 的恢复通道 */
  reload(input: string): Promise<PluginView> {
    return this.withLock(async () => {
      const record = this.mustRecord(input);
      const ref = pluginRef(record);
      if (!record.enabled) throw new SpcError('PLUGIN_DISABLED', { pluginId: ref });
      await this.stopAndUnload(ref, 'reload');
      await this.loadAndStart(record);
      return this.status(ref);
    });
  }

  /** 卸载：数据目录与配置值保留（§12-3 倾向）；v2 起没有 reserved 例外 */
  uninstall(input: string): Promise<void> {
    return this.withLock(async () => {
      const ref = pluginRef(this.mustRecord(input));
      const file = loadRecords();
      // 被别的（已启用）插件依赖时不许卸载：先禁用/卸载依赖方
      this.assertNotInUse(ref, 'uninstall');
      await this.stopAndUnload(ref, 'uninstall');
      dropRecord(file, ref);
      saveRecords(file);
      this.needsReload.delete(ref);
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

  /**
   * 授权变更审计（`plugin.grant` / `plugin.revoke`）。
   * 只记**实际变了**的点（重复授予、撤回一个本来就没有的点都不留噪声）；`target` 是点名列表，
   * 属非敏感信息（点名的形状本就是插件作者写在清单里的东西）。
   */
  private auditAuthz(ref: string, method: 'plugin.grant' | 'plugin.revoke', changed: string[]): void {
    if (changed.length === 0) return;
    audit({
      ts: Date.now(),
      pluginId: ref,
      ref,
      method,
      target: [...changed].sort().join(','),
      paramsDigest: digestParams({ count: String(changed.length) }) ?? digest(ref),
      result: 'ok',
      durationMs: 0,
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
        pluginId: calleeRecord.id,
        ref: req.caller.ref,
        method: 'plugins.call',
        target: callId,
        paramsDigest: digest(JSON.stringify([req.calleeRef, req.path])),
        result: 'ok',
        callId,
        attempts,
        waitedMs,
        resultBytes: Buffer.byteLength(text),
        durationMs,
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
        pluginId: calleeRecord.id,
        ref: req.caller.ref,
        method: 'plugins.call',
        target: callId,
        paramsDigest: digest(JSON.stringify([req.calleeRef, req.path])),
        result: 'error',
        error: { code: shape?.code ?? 'INTERNAL', paramsDigest: digestParams(shape?.params) },
        callId,
        attempts,
        waitedMs,
        durationMs: Date.now() - started,
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
            pluginId: ref,
            method: 'lifecycle.shutdown-abandoned',
            paramsDigest: digestParams({ reason }) ?? digest(ref),
            result: 'error',
            error: { code: 'SHUTDOWN_BUDGET_EXHAUSTED' },
            durationMs: 0,
          });
          continue;
        }
        try {
          const limits = { ...base, stopTimeoutMs: Math.min(base.stopTimeoutMs, remaining) };
          await this.stopAndUnload(ref, reason, limits);
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
