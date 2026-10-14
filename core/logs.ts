// 插件日志的**聚合器**（ROADMAP P2-4 的前半）：沙箱里的 `console.*` 与 `ctx.logger.*` 都汇到这里。
//
// 三条口径（都是有意的）：
//   · **内存有界**：全局条数上限 + 单条字符上限（超出截断并标 `truncated`）。插件能无限打日志，
//     而"插件写日志把核心拖垮"是这里唯一要防的事 —— 有界是**唯一**防线（落盘是审计的活，不是日志的）。
//   · **游标用 `seq` 而不是时间戳**：同一毫秒里可以有多条，按时间戳续读会**漏**。`seq` 单调递增、不回退。
//   · **来源记完整引用**（`<origin>/<id>`）：身份是 `(origin, id)`，同 id 不同来源是两个插件。
//
// 定位：**排障用**，重启即清（进程内）。要留痕的是审计（`core/audit.ts` 落 JSONL），两者别混。
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 等级由低到高：`--level warn` 这类过滤按"**至少**这个等级"（排障时想要的是"警告以上"） */
export const LOG_LEVEL_ORDER: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LogEntry {
  /** 单调递增的游标（1 起）。客户端拿它续读，别用时间戳 */
  seq: number;
  ts: number;
  /** 插件的**完整引用** `<origin>/<id>` */
  ref: string;
  level: LogLevel;
  text: string;
  /** 超长被截断（`text` 只是前 `LOG_MAX_TEXT` 个字符） */
  truncated: boolean;
}

export interface LogQuery {
  /** 只看这个插件（**完整引用**；守护进程在查之前已经用 manager 解析过裸 id 与歧义） */
  ref?: string;
  /** 至少这个等级 */
  level?: LogLevel;
  /** 最多返回多少条（从**最新**往回取，返回时按时间正序） */
  limit?: number;
  /** 只看 `seq > since` 的（续读游标；缺省 = 从头能留多少给多少） */
  since?: number;
}

export interface LogQueryResult {
  entries: LogEntry[];
  /** 下一次续读该带的 `since`（= 当前最大 seq；没有新条目时**原样回显**，客户端不会丢位置） */
  nextSeq: number;
  /** 因为上限被淘汰掉的条数（>0 说明查询窗口之前有缺口，调用方该说出来） */
  dropped: number;
}

export const LOG_MAX_ENTRIES = 2000;
export const LOG_MAX_TEXT = 4096;

function levelIndex(level: LogLevel): number {
  return LOG_LEVEL_ORDER.indexOf(level);
}

export class LogRing {
  private readonly entries: LogEntry[] = [];
  private seq = 0;
  private droppedCount = 0;

  constructor(
    private readonly maxEntries: number = LOG_MAX_ENTRIES,
    private readonly maxText: number = LOG_MAX_TEXT,
  ) {}

  /** 收一条。`ts` 可注入（用例里要确定的时间线） */
  append(input: { ref: string; level: LogLevel; text: string; ts?: number }): LogEntry {
    const raw = input.text;
    const truncated = raw.length > this.maxText;
    this.seq += 1;
    const entry: LogEntry = {
      seq: this.seq,
      ts: input.ts ?? Date.now(),
      ref: input.ref,
      level: input.level,
      text: truncated ? raw.slice(0, this.maxText) : raw,
      truncated,
    };
    this.entries.push(entry);
    // 淘汰最旧的：内存有界，代价是"太早的日志读不到了"（`dropped` 会把这件事说出来）
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
      this.droppedCount += 1;
    }
    return entry;
  }

  /** 当前最大游标（没写过就是 0） */
  get lastSeq(): number {
    return this.seq;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  size(): number {
    return this.entries.length;
  }

  query(opts: LogQuery = {}): LogQueryResult {
    const limit = opts.limit === undefined ? this.entries.length : Math.max(0, opts.limit);
    const minLevel = opts.level === undefined ? -1 : levelIndex(opts.level);
    const picked: LogEntry[] = [];
    // 从最新往回取（`limit` 的意思是"最近 N 条"），取够再翻正
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const e = this.entries[i]!;
      if (opts.since !== undefined && e.seq <= opts.since) break;
      if (opts.ref !== undefined && e.ref !== opts.ref) continue;
      if (minLevel >= 0 && levelIndex(e.level) < minLevel) continue;
      picked.push(e);
      if (picked.length >= limit) break;
    }
    picked.reverse();
    return { entries: picked, nextSeq: this.seq, dropped: this.droppedCount };
  }
}

/** 守护进程用的单例（与 `manager` / `registry` / `capabilities` 同一模式） */
export const logs = new LogRing();

/** 等级字符串 → 合法等级（认不出返回 undefined：调用方按"没给过滤"处理，别猜） */
export function asLogLevel(raw: string): LogLevel | undefined {
  return (LOG_LEVEL_ORDER as readonly string[]).includes(raw) ? (raw as LogLevel) : undefined;
}

/**
 * 等级 → **宿主 console 的方法名**。
 *
 * ⚠️ `info` 要映射到 `console.log`（**不是** `console.info`）：这是历史行为，也是所有运维直觉
 * —— 插件里写 `console.log` 就该出现在宿主 stdout 的普通行里。2026-10-14 把 console 接进聚合器时
 * 顺手写成 `console[level]`，于是 `console.log` 变成了 `console.info` ⇒ **54 条捕获宿主 console.log
 * 的真沙箱用例全红**（它们收到的是一串空集合）。这类"看着等价"的映射改动就是会这么疼。
 */
export function hostLogMethod(level: LogLevel): 'log' | 'warn' | 'error' {
  return level === 'info' || level === 'debug' ? 'log' : level === 'warn' ? 'warn' : 'error';
}
