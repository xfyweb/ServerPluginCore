// 审计（api-contract §8）：每个宿主 API 调用落一条，只增不改，插件不可达。
// 失败策略（决策记录）：
//   1) 启动时探测可写（写测试文件），失败 → 进程退出（fail-closed at startup）
//   2) 运行中写盘失败 → 内存缓冲暂存（容错，保证可用性）
//   3) 内存缓冲超上限（10MB）→ 进程退出（fail-closed at buffer-full）
// 记录内容只含机器可读的码与参数摘要：不落本地化文本（本地化只在 CLI / 面板渲染层）、
// 不落明文参数（路径等敏感值一律摘要）。控制台提示走 t()（运维可见文本）。
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, openSync, readSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditDir } from './config';
import { t } from './i18n';

/**
 * 审计目录：默认 `<STATE_DIR>/audit`（config.ts 是状态目录的唯一事实源）；
 * SPC_AUDIT_DIR 仍是覆盖项（测试用隔离目录，避免污染仓库）。
 * 注意这是**模块级常量**：必须在动态 import 之前设好环境变量——已有的测试都按这个约定写。
 */
export const AUDIT_DIR = auditDir();
export const AUDIT_FILE = join(AUDIT_DIR, 'audit.jsonl');

const BUFFER_LIMIT_BYTES = 10 * 1024 * 1024;
let buffer: string[] = [];
let bufferBytes = 0;

/** 判定记录（机器可读；判定参数只留摘要） */
export interface AuditDecision {
  decision: 'allow' | 'deny';
  /** 判定码（CheckCode，如 UNKNOWN_POINT / NOT_DECLARED / TIER_DENIED） */
  code: string;
  /** 判定参数摘要（可能含路径等敏感值，不落明文） */
  paramsDigest?: string;
}

/** 错误记录（宿主错误码；错误参数只留摘要） */
export interface AuditError {
  /** 宿主错误码（SpcError.code；未分类错误记 INTERNAL） */
  code: string;
  paramsDigest?: string;
}

export interface AuditEntry {
  ts: number;
  pluginId: string;
  /**
   * **完整引用** `<origin>/<id>`（v4）。
   *
   * 为什么要它：身份是 `(origin, id)` —— 同 id 不同来源是**两个插件**，只记裸 `pluginId` 时，
   * 两条审计读起来分不清是谁（沙箱/宿主 API 这一层拿到的也只有一个 id）。
   * **只增不改**：`pluginId` 保留原样（历史条目、既有展示与测试都还按它读）。
   */
  ref?: string;
  method: string;
  /** 机器可读目标（如 exec 模板对应的权限点 `exec.template.nginx.reload`）；非敏感，便于排障与统计 */
  target?: string;
  /** 入参摘要（防敏感信息落明文） */
  paramsDigest: string;
  result: 'ok' | 'denied' | 'error';
  /** 权限判定记录；生命周期类条目（如 lifecycle.load）无判定，可省略 */
  permission?: AuditDecision;
  /** result=error 时携带宿主错误码 */
  error?: AuditError;
  /** 结果序列化字节数（exec 的命令输出量体现在这里；受模板 maxOutputBytes 约束） */
  resultBytes?: number;
  /**
   * 本阶段里**等宿主 Promise 花掉的墙钟**（挂起时长；只有钩子/定时器这类"可能挂起"的阶段才给）。
   *
   * 为什么要单独记：挂起期间解释器没在跑（`spawnSync` 那样），所以它**既不吃 CPU 预算、也不落中断**，
   * `durationMs` 里却实实在在含着这段时间。少了这个字段，事后审计看到"init 花了 3 秒"时无法区分
   * "插件自己算了 3 秒"与"宿主 I/O 等了 3 秒"——而这两件事的处置完全不同。
   */
  suspendedMs?: number;
  /**
   * **跨插件调用的串联 id**（`plugins.call`，2026-09-25）。
   *
   * 一次 A→B 的调用会在审计里留下多条：A 那条宿主调用、B 那条"被调"条目、以及 B 内部因此产生的
   * 每一次宿主调用（fs/kv/…）。它们分属**两个插件**，光看 `ref` 串不起来 —— `callId` 就是那根线
   * （与事件面的 `eventId` 同构）。**只增不改**：不带 `callId` 的条目语义不变。
   */
  callId?: string;
  /**
   * 本次投递尝试了几次（`PLUGIN_BUSY` 有界重试；只有 `plugins.call` 会带）。
   * 1 = 一次就通。为什么要记：调用方看到的"成功"背后可能等了 300ms，"有没有被对方的忙拖慢"
   * 只有这个字段答得上来。
   */
  attempts?: number;
  /** 重试累计等待的墙钟（毫秒，只有 `plugins.call` 会带） */
  waitedMs?: number;
  durationMs: number;
}

/** 启动探测：审计目录不可写 → 退出（fail-closed at startup） */
export function initAudit(): void {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    const probe = join(AUDIT_DIR, '.probe');
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe);
  } catch (err) {
    console.error(
      `[audit] ${t('audit.dir.not_writable', { dir: AUDIT_DIR })}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

export function audit(entry: AuditEntry): void {
  const line = JSON.stringify(entry);
  try {
    appendFileSync(AUDIT_FILE, line + '\n', 'utf8');
  } catch {
    // 运行中写盘失败 → 内存缓冲（容错）
    buffer.push(line);
    bufferBytes += Buffer.byteLength(line);
    if (bufferBytes > BUFFER_LIMIT_BYTES) {
      console.error(`[audit] ${t('audit.buffer.overflow', { limit: BUFFER_LIMIT_BYTES })}`);
      process.exit(1);
    }
  }
}

/** 参数摘要：sha256 前 16 位（防敏感信息落明文） */
export function digest(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * 把"写盘失败时攒在内存里的"条目再写一次 —— **停机前必须调**：进程一退，缓冲就没了。
 *
 * 为什么之前没有它是个洞：`audit()` 写失败会进缓冲，但没有任何地方把它排空 ——
 * 也就是说"审计写不进去"这件事在**运行期**是静默的，直到进程退出才发现账丢了。
 *
 * @returns 写成功的条数；仍写不进去时返回**负数**（= 还留在缓冲里的条数）
 */
export function flushAudit(): number {
  if (buffer.length === 0) return 0;
  const pending = buffer;
  buffer = [];
  bufferBytes = 0;
  try {
    appendFileSync(AUDIT_FILE, pending.join('\n') + '\n', 'utf8');
    return pending.length;
  } catch {
    // 还是写不进去：**放回缓冲**（并累加字节数），让调用方知道账还在手里
    buffer = pending.concat(buffer);
    for (const line of pending) bufferBytes += Buffer.byteLength(line);
    return -pending.length;
  }
}

/** 结构化参数 → 摘要（审计用；无参数返回 undefined） */
export function digestParams(params?: Record<string, string>): string | undefined {
  if (!params || Object.keys(params).length === 0) return undefined;
  return digest(JSON.stringify(params));
}

/**
 * **尾部读**审计：只读文件末尾一段，返回最近的条目（供 `spc audit tail` 那条读面用）。
 *
 * 为什么是"尾部读"而不是"整个文件读进来"：审计文件只增不减（本仓库实测能涨到 100 MB+），
 * 而读面每次请求都吞整个文件的话，一次 `audit tail` 就能把守护进程的内存顶上去。
 * 这里最多读 `maxBytes`（默认 1 MiB）——**从末尾往前**取；因为是从中间截的，第一行可能是半条
 * （除非刚好读到文件开头），丢掉它并计进 `skipped`。
 *
 * **游标是字节偏移**（`since` 入 / `nextOffset` 出）：审计文件**只追加**，所以偏移是稳定游标
 * ——`spc audit tail -f` 靠它续读。**不能用时间戳**：同一毫秒可以有多条，按时间戳续读要么漏要么重。
 * 客户端落后太多（`since` 早于窗口起点）时会从窗口起点读，并置 `truncatedFile = true` 让它说出来。
 *
 * 过滤器都是"与"关系；坏行（解析不了）也计 `skipped`，**不让一条坏行把整个读面打哑**。
 */
export function readAuditTail(opts: {
  limit?: number;
  plugin?: string;
  method?: string;
  result?: 'ok' | 'denied' | 'error';
  maxBytes?: number;
  /** 续读游标：只读**这个字节偏移之后**的内容（缺省 = 读末尾窗口） */
  since?: number;
} = {}): { entries: AuditEntry[]; skipped: number; truncatedFile: boolean; nextOffset: number } {
  const limit = Math.max(1, opts.limit ?? 50);
  const maxBytes = Math.max(1024, opts.maxBytes ?? 1024 * 1024);
  let fd: number | undefined;
  try {
    const size = statSync(AUDIT_FILE).size;
    // 窗口起点：有游标就从游标读（但仍不超过 maxBytes 的窗口），否则读末尾窗口
    const floor = Math.max(0, size - maxBytes);
    const start = opts.since === undefined ? floor : Math.max(opts.since, floor);
    // "丢过东西"= 我们要么没从文件开头读（缺省模式），要么没从客户端要的位置读（游标落后）
    const truncatedFile = start > (opts.since ?? 0);
    const len = size - start;
    if (len <= 0) return { entries: [], skipped: 0, truncatedFile: false, nextOffset: size };
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(AUDIT_FILE, 'r');
    readSync(fd, buf, 0, len, start);

    // 按**字节**切行（不先整体 toString：多字节字符被窗口切断时不会污染其它行）
    let cursor = 0;
    let skipped = 0;
    // ⚠️ 只有当**起点被推后了**（缺省模式的末尾窗口，或客户端游标落后于窗口）时，窗口第一行才是半条。
    // 客户端给的游标正好落在行边界时，第一行是**完整行** —— 那时丢它就是把数据丢了（2026-10-14 实测踩到：
    // `since=<上一条之后>` 续读时少给了一条）。
    const partialFirst = start > (opts.since ?? 0);
    if (partialFirst) {
      const firstNl = buf.indexOf(0x0a);
      if (firstNl === -1) return { entries: [], skipped: 1, truncatedFile, nextOffset: start };
      cursor = firstNl + 1;
      skipped += 1;
    }
    const picked: AuditEntry[] = [];
    for (;;) {
      const nl = buf.indexOf(0x0a, cursor);
      if (nl === -1) break; // 结尾没有换行 ⇒ 是写了一半的半条，**不消费**（游标停在它之前）
      const line = buf.subarray(cursor, nl).toString('utf8').trim();
      cursor = nl + 1;
      if (line === '') continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        skipped += 1;
        continue;
      }
      if (opts.plugin !== undefined && (entry.ref ?? entry.pluginId) !== opts.plugin) continue;
      if (opts.method !== undefined && entry.method !== opts.method) continue;
      if (opts.result !== undefined && entry.result !== opts.result) continue;
      picked.push(entry);
      // 只留最近 limit 条（从头开始丢），与"tail -n"的语义一致
      if (picked.length > limit) picked.shift();
    }
    return { entries: picked, skipped, truncatedFile, nextOffset: start + cursor };
  } catch {
    // 文件不存在（还没写过审计）⇒ 空结果，不是错误
    return { entries: [], skipped: 0, truncatedFile: false, nextOffset: opts.since ?? 0 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
