// 审计（api-contract §8）：每个宿主 API 调用落一条，只增不改，插件不可达。
// 失败策略（决策记录）：
//   1) 启动时探测可写（写测试文件），失败 → 进程退出（fail-closed at startup）
//   2) 运行中写盘失败 → 内存缓冲暂存（容错，保证可用性）
//   3) 内存缓冲超上限（10MB）→ 进程退出（fail-closed at buffer-full）
// 记录内容只含机器可读的码与参数摘要：不落本地化文本（本地化只在 CLI / 面板渲染层）、
// 不落明文参数（路径等敏感值一律摘要）。控制台提示走 t()（运维可见文本）。
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** 结构化参数 → 摘要（审计用；无参数返回 undefined） */
export function digestParams(params?: Record<string, string>): string | undefined {
  if (!params || Object.keys(params).length === 0) return undefined;
  return digest(JSON.stringify(params));
}
