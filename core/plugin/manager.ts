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
import type { PluginType } from '../../sdk/types';
import { audit, digest, digestParams } from '../audit';
import { loadConfig, pluginDataDir, type PluginLimits, type SpcConfig } from '../config';
import { SpcError, toErrorShape } from '../errors';
import { isValidGrantPoint } from '../permissions/check';
import { registry } from '../permissions/registry';
import { capabilities } from './capabilities';
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
  saveRecords,
  upsertRecord,
  type PluginErrorRecord,
  type PluginRecord,
  type PluginState,
} from './records';

/** 对外视图（CLI / HTTP / 面板共用同一份；不含沙箱句柄） */
export interface PluginView {
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
  origin: string | null;
  /** 授权/配置变更后是否需要 reload 才生效 */
  reloadRequired: boolean;
}

export interface InstallOptions {
  grants?: string[];
  /** 安装后是否立即装载（默认 true：安装清单即授权，见 intent-capture §8.1） */
  start?: boolean;
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
      dataDir: pluginDataDir(record.id),
      configPath: record.configPath,
      origin: record.origin,
      reloadRequired: this.needsReload.has(record.id),
    };
  }

  list(): PluginView[] {
    return loadRecords().plugins.map((r) => this.toView(r));
  }

  status(id: string): PluginView {
    const record = findRecord(loadRecords(), id);
    if (!record) throw new SpcError('PLUGIN_NOT_FOUND', { pluginId: id });
    return this.toView(record);
  }

  // ---- 记录写入（唯一入口，保证 state 与记录不脱节）----

  private patchRecord(id: string, patch: Partial<PluginRecord>): PluginRecord {
    const file = loadRecords();
    const record = findRecord(file, id);
    if (!record) throw new SpcError('PLUGIN_NOT_FOUND', { pluginId: id });
    Object.assign(record, patch);
    saveRecords(file);
    return record;
  }

  private setState(id: string, state: PluginState, error?: PluginErrorRecord | null): void {
    this.patchRecord(id, { state, ...(error === undefined ? {} : { lastError: error }) });
  }

  // ---- 依赖图：装载顺序 + 反向依赖保护 ----
  //
  // 语义（plugin-lifecycle-design §5）：
  //   · **依赖必须已装载**，不只是"已启用"——依赖没跑起来，依赖方不许起（否则它会跑在一个
  //     它本不该能进入的状态里）；未安装/未启用 → MISSING，已启用但没在跑 → NOT_LOADED。
  //   · **装载顺序依赖优先**（拓扑排序），环上的插件直接判失败而不是互相报"依赖缺失"。
  //   · **反向保护**：被已启用插件依赖时，不许卸载／禁用。

  /** 直接依赖的插件 id。清单读不出来时返回空并告警——一个坏插件不该阻塞别人的管理操作 */
  private directDeps(record: PluginRecord): string[] {
    try {
      return (readManifestFromDir(record.dir).dependencies?.plugins ?? []).map((d) => d.id);
    } catch (err) {
      console.warn(
        `[plugin] ${record.id} 清单不可读，依赖关系未知：${toErrorShape(err)?.code ?? 'INTERNAL'}`,
      );
      return [];
    }
  }

  /** 依赖是否就绪；不就绪时给出**原因**，让装载期能报准确的码 */
  private dependencyStatus = (
    id: string,
  ): { ok: true } | { ok: false; reason: 'missing' | 'not-loaded'; state?: string } => {
    const record = findRecord(loadRecords(), id);
    if (!record || !record.enabled) return { ok: false, reason: 'missing' };
    if (!this.loaded.has(id)) return { ok: false, reason: 'not-loaded', state: record.state };
    return { ok: true };
  };

  /**
   * 哪些**正在运行**的插件依赖它 —— 反向保护的判据。
   *
   * 为什么看"运行态"而不是记录里的 `enabled`：
   * 保护要防的是"依赖方正在跑、依赖却被抽走"这件事。谁没在跑，就没有谁的运行会被悄悄打断。
   * 于是维护模式（不装载任何插件）**天然**没有阻拦——不需要"跳过检查"的开关：
   * 维护模式是**启动形态**（启不启动插件），不是**校验开关**（检查要不要执行）；
   * 检查在任何形态下都照常执行，只是在不装载的形态下它没有对象可拦。
   */
  private activeDependents(id: string): string[] {
    const file = loadRecords();
    const users: string[] = [];
    for (const loadedId of this.loaded.keys()) {
      if (loadedId === id) continue;
      const record = findRecord(file, loadedId);
      if (record && this.directDeps(record).includes(id)) users.push(loadedId);
    }
    return users.sort();
  }

  /** 被运行中的插件依赖时拒绝卸载／禁用：否则它会毫无察觉地失去依赖 */
  private assertNotInUse(id: string, action: 'uninstall' | 'disable'): void {
    const dependents = this.activeDependents(id);
    if (dependents.length > 0) {
      throw new SpcError('PLUGIN_IN_USE', {
        pluginId: id,
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
    const byId = new Map(records.map((r) => [r.id, r]));
    const state = new Map<string, 'visiting' | 'done'>();
    const order: PluginRecord[] = [];
    const cyclic = new Set<string>();
    const stack: string[] = [];

    const visit = (id: string): void => {
      const st = state.get(id);
      if (st === 'done') return;
      if (st === 'visiting') {
        // 回边：栈上从该 id 起（含）的都在环里
        const from = stack.indexOf(id);
        if (from !== -1) for (const member of stack.slice(from)) cyclic.add(member);
        return;
      }
      const record = byId.get(id);
      if (!record) return; // 依赖不在本次装载集合里 → 交给装载期报 MISSING / NOT_LOADED
      state.set(id, 'visiting');
      stack.push(id);
      for (const dep of this.directDeps(record)) visit(dep);
      stack.pop();
      state.set(id, 'done');
      order.push(record);
    };

    for (const r of records) visit(r.id);
    return { order, cyclic };
  }

  // ---- 装载 / 卸载 ----

  private async loadAndStart(record: PluginRecord, opts: { isRestart?: boolean } = {}): Promise<void> {
    const id = record.id;
    // 重入保护：同一插件已在装载中/已装载 → 先干净卸载再装。
    // 没有这一条，"重装同一个插件"或"startAll 撞上已有句柄"就会叠加能力登记 + 泄漏沙箱。
    if (this.loaded.has(id)) {
      await this.stopAndUnload(id, 'reload');
    }
    this.setState(id, 'loading');
    let run: RunningPlugin | undefined;
    try {
      run = await loadPlugin(record, {
        limits: this.limits(),
        dependencyStatus: this.dependencyStatus,
        logger: (level, message) => console[level](`[${id}] ${message}`),
      });
      this.loaded.set(id, run);
      // 能力清单落记录（撤销依据 + 展示 + 审计追溯）
      this.setState(id, 'running', null);
      this.patchRecord(id, {
        capabilities: run.capabilities,
        // 一次成功 running 后清零连续失败计数（§2）
        ...(opts.isRestart ? {} : {}),
        restartAttempts: 0,
      });
      this.needsReload.delete(id);
    } catch (err) {
      const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
      const pluginError: PluginErrorRecord = {
        code: shape.code,
        params: shape.params,
        at: Date.now(),
      };
      this.setState(id, 'failed', pluginError);
      this.loaded.delete(id);
      await this.scheduleRestartIfConfigured(id, pluginError);
      throw new SpcError(shape.code, shape.params);
    }
  }

  private async stopAndUnload(id: string, reason: StopReason): Promise<void> {
    const run = this.loaded.get(id);
    const record = findRecord(loadRecords(), id);
    if (!run) {
      if (record) {
        // 没装载：能力登记也该是空的（保险：清一次保证幂等）
        capabilities.revoke(id);
        this.patchRecord(id, { capabilities: [] });
      }
      return;
    }
    this.setState(id, 'stopping');
    await unloadPlugin(run, reason, this.limits());
    this.loaded.delete(id);
    this.patchRecord(id, { capabilities: [] });
  }

  /** 失败重启策略（§2）：默认 manual —— 只落 failed，等管理员 reload */
  private async scheduleRestartIfConfigured(id: string, error: PluginErrorRecord): Promise<void> {
    const cfg = this.config().plugin;
    if (cfg.failedRestart !== 'auto') return;

    const file = loadRecords();
    const record = findRecord(file, id);
    if (!record) return;
    const attempts = record.restartAttempts + 1;
    this.patchRecord(id, { restartAttempts: attempts });

    if (attempts > cfg.maxRestartAttempts) {
      audit({
        ts: Date.now(),
        pluginId: id,
        method: 'lifecycle.restart',
        target: id,
        paramsDigest: digestParams({ attempts: String(attempts), decision: 'give-up' }) ?? digest(id),
        result: 'error',
        error: { code: error.code },
        durationMs: 0,
      });
      return;
    }

    audit({
      ts: Date.now(),
      pluginId: id,
      method: 'lifecycle.restart',
      target: id,
      paramsDigest:
        digestParams({ attempts: String(attempts), backoffMs: String(cfg.restartBackoffMs) }) ?? digest(id),
      result: 'ok',
      durationMs: 0,
    });

    const timer = setTimeout(() => {
      this.restartTimers.delete(timer);
      void this.withLock(async () => {
        const rec = findRecord(loadRecords(), id);
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
   * 本地安装 ⇒ origin/signedBy/verifiedMeta 全 null（unanchored，无更新渠道）。
   */
  install(dir: string, opts: InstallOptions = {}): Promise<PluginView> {
    return this.withLock(async () => {
      const manifest = readManifestFromDir(dir);
      const file = loadRecords();
      const existing = findRecord(file, manifest.id);
      const record = newRecord(manifest, dir, {
        grants: opts.grants ?? existing?.grants ?? [],
        origin: existing?.origin ?? null,
        signedBy: existing?.signedBy ?? null,
      });
      // 重新安装保留原 installedAt（"装了什么"的时间不该被覆盖）
      if (existing) record.installedAt = existing.installedAt;
      record.enabled = opts.start === false ? (existing?.enabled ?? false) : true;
      upsertRecord(file, record);
      saveRecords(file);

      if (record.enabled) {
        await this.loadAndStart(record);
      }
      return this.status(record.id);
    });
  }

  enable(id: string): Promise<PluginView> {
    return this.withLock(async () => {
      const record = this.patchRecord(id, { enabled: true, state: 'installed', lastError: null });
      if (!this.loaded.has(id)) {
        await this.loadAndStart(record);
      }
      return this.status(id);
    });
  }

  disable(id: string): Promise<PluginView> {
    return this.withLock(async () => {
      // 禁用同样会让依赖方失去依赖（`dependencyStatus` 要求"已启用且已装载"）→ 一并设防
      this.assertNotInUse(id, 'disable');
      await this.stopAndUnload(id, 'disable');
      this.patchRecord(id, { enabled: false, state: 'disabled' });
      return this.status(id);
    });
  }

  /** 重载：整插件 stop → 重新 load（不做模块热替换），也是 failed 的恢复通道 */
  reload(id: string): Promise<PluginView> {
    return this.withLock(async () => {
      const record = findRecord(loadRecords(), id);
      if (!record) throw new SpcError('PLUGIN_NOT_FOUND', { pluginId: id });
      if (!record.enabled) throw new SpcError('PLUGIN_DISABLED', { pluginId: id });
      await this.stopAndUnload(id, 'reload');
      await this.loadAndStart(record);
      return this.status(id);
    });
  }

  /** 卸载：数据目录与配置值保留（§12-3 倾向）；v2 起没有 reserved 例外 */
  uninstall(id: string): Promise<void> {
    return this.withLock(async () => {
      const file = loadRecords();
      const record = findRecord(file, id);
      if (!record) throw new SpcError('PLUGIN_NOT_FOUND', { pluginId: id });
      // 被别的（已启用）插件依赖时不许卸载：先禁用/卸载依赖方
      this.assertNotInUse(id, 'uninstall');
      await this.stopAndUnload(id, 'uninstall');
      dropRecord(file, id);
      saveRecords(file);
      this.needsReload.delete(id);
    });
  }

  /** 逐点授予（精确权限点，拒绝通配；点必须已登记且被插件声明） */
  grant(id: string, points: string[]): PluginView {
    if (points.length === 0) {
      throw new SpcError('INVALID_ARGS', { reason: 'no-permission-point-given' });
    }
    const record = findRecord(loadRecords(), id);
    if (!record) throw new SpcError('PLUGIN_NOT_FOUND', { pluginId: id });
    const manifest = readRecordManifest(record);
    const declared = manifest.permissions.map((p) => p.name);
    for (const point of points) {
      if (!isValidGrantPoint(point)) {
        // 单独一个码：管理员最常犯的错就是写 `kv.*`，而"权限被拒绝"听起来像是插件的问题
        throw new SpcError('GRANT_WILDCARD', { permission: point });
      }
      if (!registry.get(point)) {
        throw new SpcError('UNKNOWN_POINT', { permission: point });
      }
      // 授予"插件没申请的点"没有意义，而且通常是打错字——直接拒，并给出正确提示
      if (!declared.some((d) => d === point || d === '*' || (d.endsWith('.*') && point.startsWith(d.slice(0, -1))))) {
        throw new SpcError('NOT_DECLARED', { permission: point });
      }
    }
    const grants = [...new Set([...record.grants, ...points])].sort();
    this.patchRecord(id, { grants });
    // 沙箱持有的是装载时的授予快照 → 运行中的插件需要 reload 才生效
    if (this.loaded.has(id)) this.needsReload.add(id);
    return this.status(id);
  }

  revoke(id: string, points: string[]): PluginView {
    const record = findRecord(loadRecords(), id);
    if (!record) throw new SpcError('PLUGIN_NOT_FOUND', { pluginId: id });
    const remove = new Set(points);
    this.patchRecord(id, { grants: record.grants.filter((g) => !remove.has(g)) });
    if (this.loaded.has(id)) this.needsReload.add(id);
    return this.status(id);
  }

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

      const pending = file.plugins.filter((r) => r.enabled && !this.loaded.has(r.id));
      const { order, cyclic } = this.resolveLoadOrder(pending);

      for (const id of cyclic) {
        const error: PluginErrorRecord = { code: 'PLUGIN_DEPENDENCY_CYCLE', at: Date.now() };
        this.setState(id, 'failed', error);
        console.warn(`[plugin] ${id} 处在依赖环上，跳过装载（环成员：${[...cyclic].join(', ')}）`);
      }

      for (const record of order) {
        if (cyclic.has(record.id) || this.loaded.has(record.id)) continue;
        try {
          await this.loadAndStart(record);
        } catch (err) {
          const shape = toErrorShape(err);
          console.warn(`[plugin] ${record.id} 装载失败：${shape?.code ?? 'PLUGIN_LOAD_FAILED'}（继续装载下一个）`);
        }
      }
      return this.list();
    });
  }

  stopAll(reason: StopReason = 'shutdown'): Promise<void> {
    return this.withLock(async () => {
      for (const timer of this.restartTimers) clearTimeout(timer);
      this.restartTimers.clear();
      for (const id of [...this.loaded.keys()]) {
        try {
          await this.stopAndUnload(id, reason);
          const record = findRecord(loadRecords(), id);
          this.patchRecord(id, { state: record?.enabled ? 'stopped' : 'disabled' });
        } catch (err) {
          const shape = toErrorShape(err);
          console.warn(`[plugin] ${id} 卸载异常：${shape?.code ?? 'INTERNAL'}`);
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
