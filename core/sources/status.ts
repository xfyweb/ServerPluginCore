// 密钥状态文档与链式轮换验证（docs/plugin-signature-design.md §6.1）
//
// 固定路径：GET https://{origin}/.well-known/spc-key-status
// 每个节点由"前驱私钥"对本节点签名（旧签新）；被签对象 = 去掉 sig 后的规范化 JSON **加 origin**。
// 吊销记录（revoked[]）**不验签、不参与任何判定**（§6.1.1），只随结果返回供展示与审计。
import { canonicalize, parseStrictJson } from './canonical';
import { assertFingerprint, ed25519Verify, fingerprintOf } from './keys';
import type { HighWater } from './keyring';

export const KEY_STATUS_PATH = '/.well-known/spc-key-status';
export const STATUS_TIMEOUT_MS = 3000;

export interface KeyNode {
  fingerprint: string;
  pub: string;
  /** 签发**本节点**的公钥指纹；根节点为 null（信任起点，无签名） */
  signedBy: string | null;
  sig?: string;
  retiredAt?: string | null;
}

export interface RevokedKey {
  fingerprint: string;
  revokedAt: string;
  /** 原因码：PRIVATE_KEY_LEAK | SUPERSEDED | POLICY | RETIRED（仅展示） */
  reason: string;
}

export interface KeyStatusDoc {
  statusSchema: number;
  origin: string;
  rotatedAt: string;
  current: string;
  keys: KeyNode[];
  revoked?: RevokedKey[];
}

export type StatusCode =
  | 'NO_ROTATION'
  | 'KEY_STATUS_MALFORMED'
  | 'KEY_CHAIN_INVALID'
  | 'KEY_ROTATION_UNVERIFIABLE'
  | 'KEY_STATUS_ROLLBACK';

export type RotationResult =
  | { ok: true; current: { fingerprint: string; pub: string }; highWater: HighWater }
  | { ok: false; code: StatusCode; params?: Record<string, string> };

/** 节点被签对象：去掉 sig，注入 origin，再规范化 */
export function signableNodePayload(node: KeyNode, origin: string): string {
  const { sig: _sig, ...rest } = node;
  return canonicalize({ ...rest, origin });
}

/** 解析并做结构校验（不验链）：失败 → KEY_STATUS_MALFORMED */
export function parseKeyStatus(text: string, origin: string): { ok: true; doc: KeyStatusDoc } | { ok: false; code: StatusCode } {
  let raw: unknown;
  try {
    raw = parseStrictJson(text);
  } catch {
    return { ok: false, code: 'KEY_STATUS_MALFORMED' };
  }
  const doc = raw as Partial<KeyStatusDoc>;
  if (
    !doc ||
    typeof doc !== 'object' ||
    doc.statusSchema !== 1 ||
    typeof doc.origin !== 'string' ||
    typeof doc.rotatedAt !== 'string' ||
    typeof doc.current !== 'string' ||
    !Array.isArray(doc.keys) ||
    doc.keys.length === 0
  ) {
    return { ok: false, code: 'KEY_STATUS_MALFORMED' };
  }
  if (doc.origin !== origin) {
    return { ok: false, code: 'KEY_STATUS_MALFORMED' };
  }
  for (const node of doc.keys) {
    if (typeof node?.fingerprint !== 'string' || typeof node?.pub !== 'string') {
      return { ok: false, code: 'KEY_STATUS_MALFORMED' };
    }
  }
  return { ok: true, doc: doc as KeyStatusDoc };
}

/**
 * 链式轮换验证（§6.1 验证流程）：
 *   1 结构与 pub/fingerprint 自洽
 *   2 本端信任节点必须仍在 keys[] 中（否则暂停：KEY_ROTATION_UNVERIFIABLE）
 *   3 从本端节点逐跳验签名到 current
 *   4 防回滚：rotatedAt 不得早于本地高水位
 * 注意：吊销记录不参与以上任何一步。
 */
export function verifyRotation(
  doc: KeyStatusDoc,
  trusted: { fingerprint: string; pub: string },
  highWater?: HighWater,
): RotationResult {
  const keys = doc.keys;

  // 1) 自洽性（每个节点：指纹 == sha256(裸公钥)；signedBy 必须指向前一个节点）
  for (let i = 0; i < keys.length; i++) {
    const node = keys[i];
    try {
      assertFingerprint(node.pub, node.fingerprint);
    } catch {
      return { ok: false, code: 'KEY_CHAIN_INVALID', params: { fingerprint: node.fingerprint } };
    }
    const expected = i === 0 ? null : keys[i - 1].fingerprint;
    if ((node.signedBy ?? null) !== expected) {
      return { ok: false, code: 'KEY_CHAIN_INVALID', params: { fingerprint: node.fingerprint } };
    }
  }
  const last = keys[keys.length - 1];
  if (doc.current !== last.fingerprint) {
    return { ok: false, code: 'KEY_CHAIN_INVALID', params: { current: doc.current } };
  }

  // 2) 本端信任节点必须在链上
  const startIndex = keys.findIndex((k) => k.fingerprint === trusted.fingerprint);
  if (startIndex < 0) {
    return {
      ok: false,
      code: 'KEY_ROTATION_UNVERIFIABLE',
      params: { fingerprint: trusted.fingerprint },
    };
  }
  if (keys[startIndex].pub !== trusted.pub) {
    return { ok: false, code: 'KEY_CHAIN_INVALID', params: { fingerprint: trusted.fingerprint } };
  }

  // 3) 逐跳验签名
  for (let i = startIndex; i + 1 < keys.length; i++) {
    const prev = keys[i];
    const next = keys[i + 1];
    if (!next.sig || !ed25519Verify(prev.pub, Buffer.from(signableNodePayload(next, doc.origin), 'utf8'), next.sig)) {
      return { ok: false, code: 'KEY_CHAIN_INVALID', params: { fingerprint: next.fingerprint } };
    }
  }

  // 4) 防回滚（否则回放旧文档即可把 current 退回已退役密钥）
  if (highWater && Date.parse(doc.rotatedAt) < Date.parse(highWater.rotatedAt)) {
    return { ok: false, code: 'KEY_STATUS_ROLLBACK', params: { rotatedAt: doc.rotatedAt } };
  }

  // 吊销记录：仅累计用于展示/审计（并集），不参与任何判定
  const revoked = new Set<string>(highWater?.revoked ?? []);
  for (const r of doc.revoked ?? []) {
    if (typeof r?.fingerprint === 'string') revoked.add(r.fingerprint);
  }

  return {
    ok: true,
    current: { fingerprint: last.fingerprint, pub: last.pub },
    highWater: { rotatedAt: doc.rotatedAt, fingerprint: last.fingerprint, revoked: [...revoked] },
  };
}

/** 拉取状态文档：网络失败 / 404 视为"无轮换"（用本地缓存密钥继续）；结构非法则视为异常 */
export async function fetchKeyStatus(
  origin: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true; doc: KeyStatusDoc } | { ok: false; code: StatusCode }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? STATUS_TIMEOUT_MS);
  try {
    const res = await doFetch(`https://${origin}${KEY_STATUS_PATH}`, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) return { ok: false, code: 'NO_ROTATION' };
    if (!res.ok) return { ok: false, code: 'NO_ROTATION' };
    return parseKeyStatus(await res.text(), origin);
  } catch {
    // 网络不可达 / 超时：不阻塞，用本地缓存密钥继续
    return { ok: false, code: 'NO_ROTATION' };
  } finally {
    clearTimeout(timer);
  }
}

/** 供测试与构建工具使用：计算某节点应由前驱签出的字节 */
export function nodePayloadForSigning(node: KeyNode, origin: string): string {
  return signableNodePayload(node, origin);
}
