// 公钥指纹与 ed25519 验签（docs/plugin-signature-design.md §4）
//
// 指纹算法全系统统一（必须钉死，否则互操作必炸）：
//   fingerprint = "sha256:" + hex_lower(SHA-256(裸 32 字节 Ed25519 公钥))
// 凡同时出现 pub 与 fingerprint 的地方，验方必须先校验 fingerprint == sha256(decode(pub))。
import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import { SpcError } from '../errors';

/** Ed25519 SPKI DER 前缀（RFC 8410）：302a300506032b6570032100 ‖ 32 字节裸公钥 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const ED25519_PUBKEY_BYTES = 32;

/** base64 → 裸公钥字节（长度必须是 32） */
export function decodePub(pubB64: string): Buffer {
  const raw = Buffer.from(pubB64, 'base64');
  if (raw.length !== ED25519_PUBKEY_BYTES) {
    throw new SpcError('KEY_FORMAT_INVALID', { reason: `公钥长度应为 32 字节，实际 ${raw.length}` });
  }
  return raw;
}

/** 公钥指纹：对裸 32 字节求 SHA-256（不是对 base64 文本、也不是对 SPKI DER） */
export function fingerprintOf(pubB64: string): string {
  return `sha256:${createHash('sha256').update(decodePub(pubB64)).digest('hex')}`;
}

/**
 * 指纹的**缩略形式**（`sha256:ff23be1a`）——给人看的那种。
 *
 * 为什么要有它：完整指纹是 64 位十六进制，**运维基本不看**（撞名时他们多半是"换一个人的同款"，
 * 或者只用官方市场、根本没有重名）。所以默认输出里不摆它，需要时给前 8 位够核对，
 * **完整值只在真做身份决策的地方**（换钥 / 来源锚 / keygen）或 `--json` 里给。
 */
export function shortFingerprint(fp: string, len = 8): string {
  const sep = fp.indexOf(':');
  const alg = sep === -1 ? '' : fp.slice(0, sep + 1);
  const hex = sep === -1 ? fp : fp.slice(sep + 1);
  return `${alg}${hex.slice(0, len)}`;
}

/** 校验 pub 与 fingerprint 自洽（§4 硬性要求） */
export function assertFingerprint(pubB64: string, fingerprint: string): void {
  if (fingerprintOf(pubB64) !== fingerprint) {
    throw new SpcError('KEY_FINGERPRINT_MISMATCH', { fingerprint });
  }
}

/** 裸公钥 → KeyObject */
export function publicKeyFromRaw(pubB64: string): KeyObject {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, decodePub(pubB64)]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** ed25519 验签：data 为被签的原始字节 */
export function ed25519Verify(pubB64: string, data: Uint8Array, sigB64: string): boolean {
  try {
    return edVerify(null, data, publicKeyFromRaw(pubB64), Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}
