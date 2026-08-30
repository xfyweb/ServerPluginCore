// 审计（api-contract §8）：每个宿主 API 调用落一条，只增不改，插件不可达。
// 失败策略（决策记录）：
//   1) 启动时探测可写（写测试文件），失败 → 进程退出（fail-closed at startup）
//   2) 运行中写盘失败 → 内存缓冲暂存（容错，保证可用性）
//   3) 内存缓冲超上限（10MB）→ 进程退出（fail-closed at buffer-full）
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult } from './permissions/check';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const AUDIT_DIR = join(__dirname, '..', '.spc');
export const AUDIT_FILE = join(AUDIT_DIR, 'audit.jsonl');

const BUFFER_LIMIT_BYTES = 10 * 1024 * 1024;
let buffer: string[] = [];
let bufferBytes = 0;

export interface AuditEntry {
  ts: number;
  pluginId: string;
  method: string;
  /** 参数摘要（防敏感信息落明文） */
  paramsDigest: string;
  result: 'ok' | 'denied' | 'error';
  permission: CheckResult;
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
      `[audit] 审计目录不可写（${AUDIT_DIR}）：${err instanceof Error ? err.message : String(err)}`,
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
      console.error(
        `[audit] 审计缓冲超限（>${BUFFER_LIMIT_BYTES} bytes），审计链路失效，进程退出。`,
      );
      process.exit(1);
    }
  }
}

/** 参数摘要：sha256 前 16 位（防敏感信息落明文） */
export function digest(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
