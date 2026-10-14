// 审计（api-contract §8）：每个宿主 API 调用与每个**管理动作**落一条，只增不改，插件不可达。
// 失败策略（决策记录）：
//   1) 启动时探测可写（写测试文件），失败 → 进程退出（fail-closed at startup）
//   2) 运行中写盘失败 → 内存缓冲暂存（容错，保证可用性）
//   3) 内存缓冲超上限（10MB）→ 进程退出（fail-closed at buffer-full）
// 记录内容只含机器可读的码与参数摘要：不落本地化文本（本地化只在 CLI / 面板渲染层）、
// 不落明文参数（路径等敏感值一律摘要）。控制台提示走 t()（运维可见文本）。
//
// ⚠️ **文件按天分**（2026-10-14 维护者拍板，原话："日志每天 gzip 一次；一天之内的日志不论怎么重启都同一个文件，
// 跨日就主动新建今日文件，旧的 gzip 打包"）：
//   · `audit/<YYYY-MM-DD>.jsonl` —— 当天的全部条目；**同一天内多次重启仍写同一个文件**；
//   · 跨日 ⇒ 新建当天文件，并把前一天那个 `.jsonl` **gzip** 成 `.jsonl.gz`（原文件删除）；
//   · 启动时补做：发现有"往日却没有 gz"的文件（午夜时进程不在）就顺手打包；
//   · 旧的单文件 `audit.jsonl`（v1 结构）**挪走**成 `legacy-v1.jsonl.gz`，读面不解析它（只留档）。
//
// **为什么不是"一个文件长到 100MB"**：实测本仓库的审计文件能涨到 100MB+，一次 `spc audit tail` 就得读它。
// 按天分 + 压缩之后：今天的文件小、历史是 gz（读面最多回看 7 天 / 解压 64MiB，两个上限都有）。
//
// **游标 = `"<日期>#<seq>"`**（如 `2026-10-14#10231`）：`seq` **在单个文件内**从 1 起、不回退也不跳号，
// 文件名带日期 ⇒ `(日期, seq)` 唯一。这样**不需要**把"全局序号"落盘（那是"崩溃后重号/漏号"的经典坑）。
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { auditDir } from './config';
import { t } from './i18n';

const viaCtx = new AsyncLocalStorage<AuditVia>();
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

export type AuditActorKind = 'plugin' | 'operator' | 'core';

/**
 * **通道**：这次动作是从哪儿发起的。
 *
 * `cli` = 管理通道（HTTP，`spc` 命令/面板）；`console` = 守护进程自己的 TTY 控制台（进程内调用）；
 * `internal` = 都不是（自动重启、收尾、核心内部动作）。多用户身份模型（P3）落地时，
 * `actor.user` 填 `userId`，通道不必再动。
 */
export type AuditVia = 'cli' | 'console' | 'internal';

/** **谁做的**（这次改的核心：以前只有"关于谁"，没有"谁"） */
export interface AuditActor {
  kind: AuditActorKind;
  /** 插件干的时候 = 该插件**完整引用**；操作者干的时候留空（P3 填用户） */
  ref?: string;
  /** 只有 `kind: 'operator'` 有通道 */
  via?: AuditVia;
  /** P3 的用户身份位（现在恒为 null/undefined） */
  user?: string | null;
}

/** **关于谁/什么**（以前挤在 `pluginId`/`target` 里，靠 method 家族猜） */
export type AuditSubjectKind = 'plugin' | 'origin' | 'point' | 'timer' | 'event' | 'self' | 'none';

export interface AuditSubject {
  kind: AuditSubjectKind;
  ref?: string;
}

/** 时间：执行时长与**挂起时长**分开（挂起是等宿主 Promise 的墙钟，见下面 `suspendedMs` 的说明） */
export interface AuditTiming {
  ms: number;
  suspendedMs?: number;
}

/** 串联信息：跨插件调用（`callId`）、事件（`eventId`）、以及投递重试的代价 */
export interface AuditCorr {
  callId?: string;
  eventId?: string;
  attempts?: number;
  waitedMs?: number;
}

/**
 * **管理动作的闭集明文细节**（2026-10-14 拍板：管理动作的 `detail` 允许码值明文）。
 *
 * 为什么要有它：管理动作的参数**本身就是记录**（"从哪个源装的、播种/撤回了哪些权限点、别名改成什么"），
 * 只留摘要就读不回来 —— 而插件调用的参数照旧**只留摘要**（路径、业务数据都可能敏感）。
 * 规矩：值只能是**码/标识/计数**这类非敏感量；**路径、URL 里的凭据、业务数据一律不许进来**。
 */
export type AuditDetail = Record<string, string | number | boolean | string[]>;

export interface AuditEntry {
  ts: number;
  /** **谁**做的 */
  actor: AuditActor;
  /** 关于**谁/什么**；纯内部动作可以不给 */
  subject?: AuditSubject;
  method: string;
  /** 入参摘要（防敏感信息落明文；插件调用一律只留它） */
  paramsDigest: string;
  result: 'ok' | 'denied' | 'error';
  /** 权限判定记录；生命周期类条目（如 lifecycle.load）无判定，可省略 */
  permission?: AuditDecision;
  /** result=error 时携带宿主错误码 */
  error?: AuditError;
  /** 结果序列化字节数（exec 的命令输出量体现在这里；受模板 maxOutputBytes 约束） */
  resultBytes?: number;
  timing: AuditTiming;
  corr?: AuditCorr;
  /** 管理动作的闭集明文（见 `AuditDetail`）；插件调用不带 */
  detail?: AuditDetail;
}

/** 插件自己干的（沙箱 / 宿主 API 调用）：`ref` = 该插件的完整引用 */
export function pluginActor(ref: string): AuditActor {
  return { kind: 'plugin', ref };
}

/** 管理动作：`via` 取当前通道（`runAsChannel` 包的），没包过就是 `internal` */
export function operatorActor(via: AuditVia = currentChannel()): AuditActor {
  return { kind: 'operator', via };
}

/** 核心自己干的（停机收尾、自动重启、强制回收） */
export function coreActor(): AuditActor {
  return { kind: 'core' };
}

/**
 * 在一个**通道**里执行：HTTP 路由整段包 `'cli'`、TTY 控制台每条命令包 `'console'`，
 * 于是里面产生的管理动作条目自动带上正确的 `via`（不用给每个方法加参数、也不会漏）。
 */
export function runAsChannel<T>(via: AuditVia, fn: () => T): T {
  return viaCtx.run(via, fn);
}

/**
 * 把**当前异步上下文**标成某个通道（HTTP 路由进来就标 `cli`、TTY 控制台每条命令标 `console`）。
 *
 * 为什么用 `enterWith` 而不是包一层 `runAsChannel`：HTTP 处理函数是**一段已有的长回调**，
 * 包一层要整体缩进（改动面大、review 也难看）；而"这个请求来自哪个通道"本来就是**请求级**的事实，
 * `enterWith` 正是这个语义（离开该异步上下文即失效）。
 */
export function enterChannel(via: AuditVia): void {
  viaCtx.enterWith(via);
}

/** 当前通道（没包过 ⇒ `internal`：自动重启/收尾这类不是人发起的动作） */
export function currentChannel(): AuditVia {
  return viaCtx.getStore() ?? 'internal';
}

/** 落盘时的信封：结构版本 + 文件内序号（`AuditEntry` 只描述内容，这两个由写入层统一加） */
export interface AuditRecord extends AuditEntry {
  /** 结构版本：v2 = 带本字段与 `seq`（v1 是旧的单文件格式，没有这两个字段；迁移时挪成 `legacy-v1.jsonl.gz` 留档） */
  v: 2;
  /** **文件内**序号：从 1 起、不回退不跳号（游标 = `"<日期>#<seq>"`） */
  seq: number;
}

// ---------------- 文件方案（按天分 + 跨日 gzip） ----------------

export const AUDIT_DIR = auditDir();
/** 旧的单文件（v1 结构）；迁移时挪走成 `legacy-v1.jsonl.gz` */
export const LEGACY_FILE = join(AUDIT_DIR, 'audit.jsonl');
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_GZ = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;

/** 本地日期 `YYYY-MM-DD`（**本地**：运维说的"今天"是本地今天；审计按天分就该按本地日切） */
function dayOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 某一天的明文审计文件路径 */
export function auditFileFor(day: string): string {
  return join(AUDIT_DIR, `${day}.jsonl`);
}

/** 今天的审计文件路径（用例/工具都用它，别写死 `audit.jsonl` —— 那是 v1 的名字） */
export function currentAuditFile(): string {
  return auditFileFor(dayOf(Date.now()));
}

let openDay: string | null = null;
let seq = 0;

/** 读某天文件里最后一条的 `seq`（同日重启要接着数，不能从 1 重来 —— 否则游标会重号） */
function lastSeqOf(file: string): number {
  if (!existsSync(file)) return 0;
  const size = statSync(file).size;
  const window = Math.min(size, 256 * 1024);
  const buf = Buffer.allocUnsafe(window);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, window, size - window);
  } finally {
    closeSync(fd);
  }
  // 从后往前找最后一条**完整**行（第一行可能是被窗口截断的，忽略）
  const text = buf.toString('utf8');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (window < size && i === 0) break; // 截断处那行不可信
    try {
      const parsed = JSON.parse(line) as { seq?: unknown };
      if (typeof parsed.seq === 'number') return parsed.seq;
    } catch {
      /* 半行/坏行：继续往前找 */
    }
  }
  return 0;
}

/** 把某天的明文文件 gzip 打包并删原文件（幂等：已经打过包就不动） */
function archiveDay(day: string): void {
  const file = auditFileFor(day);
  if (!existsSync(file)) return;
  const gz = `${file}.gz`;
  try {
    writeFileSync(gz, gzipSync(readFileSync(file)));
    rmSync(file);
  } catch (err) {
    // 打包失败**不能让审计停摆**：留着明文文件，下次再试（下次启动/跨日还会走到这里）
    console.error(`[audit] ${t('audit.archive.fail', { file })}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 列出目录里所有按天文件（新→旧），`allowPlain` 关掉时就只看 gz（回看历史用） */
function listDayFiles(): { day: string; file: string; gz: boolean }[] {
  let names: string[] = [];
  try {
    names = readdirSync(AUDIT_DIR);
  } catch {
    return [];
  }
  const out: { day: string; file: string; gz: boolean }[] = [];
  for (const name of names) {
    const plain = DAY_FILE.exec(name);
    if (plain) {
      out.push({ day: plain[1]!, file: join(AUDIT_DIR, name), gz: false });
      continue;
    }
    const gz = DAY_GZ.exec(name);
    if (gz) out.push({ day: gz[1]!, file: join(AUDIT_DIR, name), gz: true });
  }
  return out.sort((a, b) => (a.day === b.day ? (a.gz ? 1 : -1) : a.day < b.day ? 1 : -1));
}

/** 跨日处理：给往日文件打包 + 打开今天的文件（写路径与午夜定时器都调它，幂等） */
export function rollAuditDay(now = Date.now()): void {
  const today = dayOf(now);
  // ① 往日的明文文件一律打包（含"午夜时进程不在"留下的那些）
  for (const f of listDayFiles()) {
    if (!f.gz && f.day !== today) archiveDay(f.day);
  }
  // ② 今天的文件：已打开就不动（**同一天内多次重启仍是同一个文件** ✅）；没打开就接着数 seq
  if (openDay !== today) {
    openDay = today;
    seq = lastSeqOf(auditFileFor(today));
    // **主动把今天的文件建出来**（维护者的要求："跨日就主动新建今日文件"）——
    // 不建的话文件要等第一次写入才出现，"今天有没有审计"这件事就得靠猜。
    try {
      appendFileSync(auditFileFor(today), '', 'utf8');
    } catch {
      /* 建不出来不致命：写入时还会再试，失败会进内存缓冲并出声 */
    }
  }
}

/** 每晚本地午夜把跨日处理跑一次（整夜空闲的守护进程也得换文件）；返回停止函数（测试/停机用） */
export function scheduleAuditMidnight(): () => void {
  const next = new Date();
  next.setHours(24, 0, 5, 0); // 00:00:05 —— 留 5 秒余量，避开"刚好 23:59:59.999 算成明天"
  const timer = setTimeout(() => {
    rollAuditDay();
    scheduleAuditMidnight(); // 递归排下一次（一天一次，成本可忽略）
  }, Math.max(1000, next.getTime() - Date.now()));
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** 启动探测：审计目录不可写 → 退出（fail-closed at startup）；顺带做迁移与跨日补打包 */
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
  // 旧的单文件（v1）挪走：读面不解析它，只留档（历史不丢，读面只维护一套代码）
  if (existsSync(LEGACY_FILE)) {
    try {
      // ⚠️ **不许覆盖已有的留档**：同一个状态目录可能迁移不止一次（先被一次测试跑迁移过、
      // 之后旧代码的进程又往旧路径写了新内容）—— 无条件写 `legacy-v1.jsonl.gz` 会把上一次的留档抹掉，
      // 而本地历史只有这一份，抹了就没了。冲突时退到带日期/序号的档名。
      let archive = join(AUDIT_DIR, 'legacy-v1.jsonl.gz');
      if (existsSync(archive)) {
        const day = dayOf(Date.now());
        archive = join(AUDIT_DIR, `legacy-v1-${day}.jsonl.gz`);
        for (let n = 2; existsSync(archive); n += 1) {
          archive = join(AUDIT_DIR, `legacy-v1-${day}-${n}.jsonl.gz`);
        }
      }
      const legacy = join(AUDIT_DIR, 'legacy-v1.jsonl');
      renameSync(LEGACY_FILE, legacy);
      writeFileSync(archive, gzipSync(readFileSync(legacy)));
      rmSync(legacy);
    } catch (err) {
      console.error(`[audit] legacy: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  rollAuditDay();
}

export function audit(entry: AuditEntry): void {
  const day = dayOf(entry.ts);
  if (openDay !== day) rollAuditDay(entry.ts);
  seq += 1;
  const record: AuditRecord = { v: 2, seq, ...entry };
  const line = JSON.stringify(record);
  try {
    appendFileSync(auditFileFor(day), line + '\n', 'utf8');
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
    appendFileSync(auditFileFor(openDay ?? dayOf(Date.now())), pending.join('\n') + '\n', 'utf8');
    return pending.length;
  } catch {
    // 还是写不进去：**放回缓冲**（并累加字节数），让调用方知道账还在手里
    buffer = pending.concat(buffer);
    for (const line of pending) bufferBytes += Buffer.byteLength(line);
    return -pending.length;
  }
}

/** 结构化参数 → 摘要（审计用；无参数返回 undefined） */
export function digestParams(params?: Record<string, unknown>): string | undefined {
  if (!params || Object.keys(params).length === 0) return undefined;
  return digest(JSON.stringify(params));
}

// ---------------- 读面（尾部读 + 游标 + 跨日回看） ----------------

/** 游标：`"<日期>#<seq>"`（人也能照着念；解析不出来就当没给） */
export function parseCursor(cursor: string | undefined): { day: string; seq: number } | null {
  if (cursor === undefined) return null;
  const m = /^(\d{4}-\d{2}-\d{2})#(\d+)$/.exec(cursor.trim());
  if (!m) return null;
  return { day: m[1]!, seq: Number(m[2]!) };
}

export interface AuditReadOptions {
  limit?: number;
  /** 只看这个插件：**匹配 `actor.ref` 或 `subject.ref`** —— "它干的"与"关于它的"都算（排障时两种都要） */
  plugin?: string;
  method?: string;
  result?: 'ok' | 'denied' | 'error';
  /** 只看这类发起者（plugin / operator / core） */
  actor?: AuditActorKind;
  /** 只看这个通道（cli / console / internal） */
  via?: AuditVia;
  /** 续读游标 `"<日期>#<seq>"`（`spc audit tail -f` 用它） */
  since?: string;
  /** 单个文件最多读多少字节（默认 1 MiB） */
  maxBytesPerFile?: number;
  /** 最多回看几天（默认 7） */
  maxLookbackDays?: number;
  /** 解压总量上限（默认 64 MiB）—— gz 是要整个解压的，必须有上限 */
  maxLookbackBytes?: number;
}

export interface AuditReadResult {
  entries: AuditEntry[];
  /** 坏行/半行计数（不让一条坏数据把读面打哑） */
  skipped: number;
  /** 续读游标（下一次 `since` 用它；没有新条目时**原样回显**，客户端不会丢位置） */
  nextCursor: string;
  /** 已经回看到边界（更早的条目没读）——调用方要说出来，否则"审计里没有"会被误读成"没发生" */
  lookbackExhausted: boolean;
  /** 窗口跳过了一些条目（文件太大，单次只读了尾部一段） */
  windowSkipped: boolean;
}

export function readAuditTail(opts: AuditReadOptions = {}): AuditReadResult {
  const limit = Math.max(1, opts.limit ?? 50);
  const maxBytesPerFile = Math.max(1024, opts.maxBytesPerFile ?? 1024 * 1024);
  const maxDays = Math.max(1, opts.maxLookbackDays ?? 7);
  const maxBytes = Math.max(64 * 1024, opts.maxLookbackBytes ?? 64 * 1024 * 1024);
  const since = parseCursor(opts.since);
  const today = dayOf(Date.now());

  const files = listDayFiles().filter((f) => !f.gz || true); // 明文与 gz 都读（明文 = 今天/刚滚过的那天）
  let skipped = 0;
  let windowSkipped = false;
  let budget = maxBytes;
  let daysScanned = 0;
  let lookbackExhausted = false;
  const picked: AuditEntry[] = [];
  let nextCursor = opts.since ?? `${today}#0`;

  for (const f of files) {
    if (since !== null && f.day < since.day) {
      lookbackExhausted = true; // 更早的日期不用看了（游标之前的都读过了）
      break;
    }
    if (daysScanned >= maxDays) {
      lookbackExhausted = true;
      break;
    }
    if (picked.length >= limit) break;
    let text: string;
    let truncatedHead = false;
    try {
      if (f.gz) {
        const raw = readFileSync(f.file);
        if (raw.length > budget) {
          lookbackExhausted = true;
          break;
        }
        budget -= raw.length;
        text = gunzipSync(raw).toString('utf8');
      } else {
        const size = statSync(f.file).size;
        const start = Math.max(0, size - maxBytesPerFile);
        truncatedHead = start > 0;
        const buf = Buffer.allocUnsafe(size - start);
        const fd = openSync(f.file, 'r');
        try {
          readSync(fd, buf, 0, buf.length, start);
        } finally {
          closeSync(fd);
        }
        text = buf.toString('utf8');
        if (truncatedHead) windowSkipped = true;
      }
    } catch {
      skipped += 1;
      continue;
    }
    daysScanned += 1;

    const lines = text.split('\n');
    // 明文的尾部窗口：第一行可能是半条
    if (truncatedHead && lines.length > 1) {
      lines.shift();
      skipped += 1;
    }
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!.trim();
      if (line === '') continue;
      let rec: AuditRecord;
      try {
        rec = JSON.parse(line) as AuditRecord;
      } catch {
        skipped += 1;
        continue;
      }
      // 游标：同一天只取 seq 更大的；更早的日期全取
      if (since !== null && f.day === since.day && typeof rec.seq === 'number' && rec.seq <= since.seq) continue;
      // "关于这个插件"= 它干的（actor）或关于它的（subject）—— 只匹配一边都查不全
      if (opts.plugin !== undefined && rec.actor?.ref !== opts.plugin && rec.subject?.ref !== opts.plugin) {
        continue;
      }
      if (opts.actor !== undefined && rec.actor?.kind !== opts.actor) continue;
      if (opts.via !== undefined && rec.actor?.via !== opts.via) continue;
      if (opts.method !== undefined && rec.method !== opts.method) continue;
      if (opts.result !== undefined && rec.result !== opts.result) continue;
      picked.push(rec);
      if (picked.length >= limit) break;
    }
    // 记录游标：取这一档里"最新"的位置（第一条文件的最新 seq）
    if (nextCursor === (opts.since ?? `${today}#0`)) {
      const maxSeq = picked.reduce((m, e) => Math.max(m, (e as AuditRecord).seq ?? 0), 0);
      if (maxSeq > 0) nextCursor = `${f.day}#${maxSeq}`;
    }
  }

  picked.reverse(); // 从新往旧收集的 ⇒ 翻正（给人看的是时间正序）
  return { entries: picked, skipped, nextCursor, lookbackExhausted, windowSkipped };
}
