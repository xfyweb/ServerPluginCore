// 每插件的句柄表（对象身份的**唯一真相**）：随机 UUID + per-plugin 表
//
// 【2026-09-20 拍板，见 `_audit/docs/hostref-design-notes.md` §4/§8】句柄统一为「随机 UUID + per-plugin 表」，
// **不用**引擎那边的 `HostRef`（`newHostRef`）：
//   · **没有 dup ⇒ 没有"漏 dup 就 abort 进程"**这类失效模式（HostRef 的收尾纪律是重成本）；
//   · 随机串同样拿到"不可伪造"；**刻意不用自增整数** —— 将来若允许跨插件交接句柄，
//     自增 id 等于把"猜得到的能力"送出去（能力泄漏），随机串不会；
//   · 插件可见协议**不变**：句柄在桥上来回就是一段不透明字符串，解析只发生在这张表里。
//
// 为什么"per-plugin 表"是安全属性而不是实现细节：**别的插件的句柄在我们这张表里根本查不到**
// ⇒ "借用/伪造别家句柄"这条攻击面不存在（不是靠校验挡，是结构上不可达）。查不到一律 fail-closed。
//
// 这类句柄的**生命周期**有三种收口，缺一不可：
//   ① 正常释放（如 `hash.digest()` 之后由仿真层调 `crypto.hashRelease`）；
//   ② 到上限就拒绝（`HANDLE_LIMIT_EXCEEDED`，fail-closed）—— 否则插件可以用"只开不关"耗尽宿主内存；
//   ③ **卸载时强制回收**（`releaseAll`）—— 插件没释放的真资源不许跨生命周期活着，并留一条审计。
import { randomUUID } from 'node:crypto';
import { SpcError } from '../errors';

/** 句柄事件（审计用；表本身不写审计，保持纯逻辑可单测） */
export interface HandleEvent {
  type: 'open' | 'close' | 'limit' | 'release';
  kind: string;
  /** 句柄 id（UUID）。给审计当 `target` 用：它不是机密，是排障时的关联键 */
  id: string;
}

/** 一条句柄记录 */
export interface HandleRecord<T = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly pluginId: string;
  readonly openedAt: number;
  /**
   * 句柄背后的**宿主对象**（真资源本体，如一个 `crypto.Hash`）。
   * 表不解释它，只负责"拿着"；释放语义一律由 `release` 决定（丢引用 / close(fd) / clearInterval…）。
   */
  readonly resource: T;
  /**
   * 真资源释放函数。**只许表调**（API 层一律走 `closeById`）：
   * 谁都能自己 release 的话，"幂等 + 只释放一次"就没有保证，重复 close 一个 fd 会关掉别人的文件。
   */
  readonly release: () => void;
}

export interface HandleTableOptions {
  pluginId: string;
  /**
   * 按 kind 的同时存活上限（缺省 = 不限）。到顶 ⇒ `HANDLE_LIMIT_EXCEEDED`。
   * 为什么要按 kind 分开：不同 kind 的"贵"不在一个量级（一个 watch 比一个摘要状态贵得多）。
   */
  maxPerKind?: Readonly<Record<string, number>>;
  onEvent?: (event: HandleEvent) => void;
}

export class HandleTable<T = unknown> {
  readonly pluginId: string;
  private readonly maxPerKind: Readonly<Record<string, number>>;
  private readonly onEvent: ((event: HandleEvent) => void) | undefined;
  /** 活着的句柄（关闭即移除：不留墓碑 —— 见文件头"三种收口"，终态语义由仿真层按 Node 合成） */
  private readonly live = new Map<string, HandleRecord<T>>();

  constructor(options: HandleTableOptions) {
    this.pluginId = options.pluginId;
    this.maxPerKind = options.maxPerKind ?? {};
    this.onEvent = options.onEvent;
  }

  /**
   * 登记一条句柄并返回记录（`record.id` 就是给插件看的那段不透明字符串）。
   *
   * `release` 由调用方提供：它必须**幂等**（表保证只调一次，但真资源释放函数自己再兜一层更稳）。
   *
   * `options.id`（**只有 fd 面该用**）：文件描述符在 Node 里是**数字**（`fs.openSync` 返回 number，
   * 插件会拿它做比较/算术/`typeof`），所以那一面必须交出数字编号。两条纪律：
   *   ① 编号由**每个插件自己的计数器**发（从 `3` 起，同 Node），且**关闭后不复用** —— Node 自己会复用数字，
   *      于是"关了再用"在 Node 上可能悄悄操作到**另一个文件**（判卷人实测：`readSync` 关后仍返回 1）；
   *      我们选**确定性 EBADF**（fail-closed，也正是 Node 文档的语义）；
   *   ② 隔离仍由 **per-plugin 表**保证（别家的编号在本表里查不到）。
   * UUID 那套留给**不透明句柄**（如流式摘要）—— 那里没有"必须像 Node"的形状约束。
   */
  open(kind: string, resource: T, release: () => void, options?: { id?: string }): HandleRecord<T> {
    const limit = this.maxPerKind[kind];
    if (limit !== undefined && this.count(kind) >= limit) {
      // fail-closed：到上限就拒（与 timers 的 TIMER_LIMIT_EXCEEDED 同一形状：码 + kind + limit）
      this.onEvent?.({ type: 'limit', kind, id: '' });
      throw new SpcError('HANDLE_LIMIT_EXCEEDED', {
        pluginId: this.pluginId,
        kind,
        limit: String(limit),
      });
    }
    const id = options?.id ?? randomUUID();
    if (this.live.has(id)) {
      // 同 id 重复登记 = 调用方的 bug（fd 计数器回绕 / UUID 撞了）；宁可炸，也不要覆盖真资源
      throw new SpcError('INTERNAL', { reason: 'handle-id-collision', kind });
    }
    const record: HandleRecord<T> = {
      id,
      kind,
      pluginId: this.pluginId,
      openedAt: Date.now(),
      resource,
      release,
    };
    this.live.set(record.id, record);
    this.onEvent?.({ type: 'open', kind, id: record.id });
    return record;
  }

  /**
   * 解析一个**插件送来的**句柄：不是我们的、kind 不对、或压根不存在 ⇒ `INVALID_ARGS`（fail-closed）。
   *
   * 为什么不区分"伪造"与"写错"：对宿主来说它们是同一件事（这段字符串不在表里）；
   * 而且**别家插件的 id 天然查不到**（per-plugin 表），所以这里不需要、也拿不到"这是谁的句柄"。
   */
  require(kind: string, id: unknown): HandleRecord<T> {
    const record = typeof id === 'string' ? this.live.get(id) : undefined;
    if (record === undefined || record.kind !== kind) {
      throw new SpcError('INVALID_ARGS', {
        reason: 'unknown-handle',
        kind,
        pluginId: this.pluginId,
      });
    }
    return record;
  }

  /**
   * 非抛错版查找（`require` 的兄弟）：给"查不到要报**别的码**"的场合用 ——
   * 例：fd 面的 `close`，Node 对"不存在的编号"报的是 `EBADF` 而不是参数错误。
   */
  peek(kind: string, id: unknown): HandleRecord<T> | undefined {
    const record = typeof id === 'string' ? this.live.get(id) : undefined;
    return record !== undefined && record.kind === kind ? record : undefined;
  }

  /**
   * 按 id 释放（幂等）：已释放/不存在都返回 `false`，不抛。
   *
   * 为什么不抛：这是**内部**收口路径（仿真层在 `digest()` 之后调用），Node 侧没有对应 API
   * 可对齐；插件可见的"终态再用"语义（如 `ERR_CRYPTO_HASH_FINALIZED`）由仿真层按 Node 合成。
   */
  closeById(id: string): boolean {
    const record = this.live.get(id);
    if (record === undefined) return false;
    this.live.delete(id);
    try {
      record.release();
    } finally {
      this.onEvent?.({ type: 'close', kind: record.kind, id });
    }
    return true;
  }

  /** 该 kind 当前活着的句柄数（上限判定与测试用） */
  count(kind: string): number {
    let n = 0;
    for (const record of this.live.values()) if (record.kind === kind) n++;
    return n;
  }

  /**
   * **卸载时的强制回收**：把还活着的全部释放（幂等）。
   *
   * 返回被强制释放的 id 列表（调用方据此落审计）：这些是插件**没自己释放**的资源，
   * 也就是"泄漏"——记录它们是排障的第一手线索（哪个 kind、多少条）。
   */
  releaseAll(): string[] {
    const leaked = [...this.live.keys()];
    for (const id of leaked) {
      const record = this.live.get(id)!;
      this.live.delete(id);
      try {
        record.release();
      } catch {
        // 卸载路径吞掉释放异常：一条资源释放失败不该让整个卸载崩（与 sandbox 的卸载钩子同一策略）
      } finally {
        this.onEvent?.({ type: 'release', kind: record.kind, id });
      }
    }
    return leaked;
  }
}
