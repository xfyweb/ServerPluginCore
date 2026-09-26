// 作者密钥：`.spcdev/keys/author.key` 单文件 JSON（docs/build-layer-design.md §10.4）
//
// 形态：`{ schema, alg, seed, pub, fingerprint, createdAt }` —— **默认无 passphrase**
// （它保护的是"身份连续性"，不是数据机密性；将来要加就是加一个可选字段，只增不改）。
//
// 三条不许松的约束：
//   ① **私钥永不进包**（构建层只把它读进内存去签 `plugin.author.sig`）；
//   ② 载入时**必须自洽**：种子推出来的公钥要等于文件里写的 `pub`、指纹要等于 `fingerprint`
//      —— 不自洽就拒（fail-closed：一把对不上的钥等于身份错位，比"没钥"危险得多）；
//   ③ 覆盖是**破坏性**动作（换钥 = 换身份）⇒ 必须显式 `--force`。
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SpcError } from '../core/errors';
import { fingerprintOf } from '../core/sources/keys';
import type { Workspace } from './workspace';

export const AUTHOR_KEY_SCHEMA = 1;

export interface AuthorKey {
  schema: 1;
  alg: 'ed25519';
  /** 私钥种子（base64，32 字节）—— **绝不外传** */
  seed: string;
  /** 公钥（base64，裸 32 字节；与 `core/sources/keys.ts` 的约定一致） */
  pub: string;
  /** `sha256:` + 裸公钥哈希（展示 / 审计用；判身份比公钥） */
  fingerprint: string;
  createdAt: string;
}

/** base64 ↔ base64url（JWK 用后者，我们的约定用前者） */
const toB64 = (v: string): string => Buffer.from(v, 'base64url').toString('base64');
const toB64Url = (v: string): string => Buffer.from(v, 'base64').toString('base64url');

/**
 * Ed25519 私钥的 **PKCS#8 DER 前缀**（`302e020100300506032b657004220420` = 定长结构头 + 32 字节种子）。
 *
 * 为什么走 DER 而不是 JWK：我们要**从种子推出公钥**，而 Node 的 JWK 导入要求同时给 `x`（公钥）——
 * 那就成了"要公钥才能算出公钥"。DER 这条路只吃种子，正好。
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** 种子 → 私钥对象 */
function privateKeyOfSeed(seedB64: string): KeyObject {
  const seed = Buffer.from(seedB64, 'base64');
  if (seed.length !== 32) {
    throw new SpcError('AUTHOR_KEY_INVALID', { reason: 'seed-length', length: String(seed.length) });
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** 由种子推出公钥（**唯一的同一性判据**：载入时用它核对） */
export function pubOfSeed(seedB64: string): string {
  const jwk = createPublicKey(privateKeyOfSeed(seedB64)).export({ format: 'jwk' }) as { x: string };
  return toB64(jwk.x);
}

/** 造一把新钥（**只造对象，不落盘**） */
export function generateAuthorKey(now = new Date()): AuthorKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { d: string };
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const pub = toB64(pubJwk.x);
  return {
    schema: AUTHOR_KEY_SCHEMA,
    alg: 'ed25519',
    seed: toB64(priv.d),
    pub,
    fingerprint: fingerprintOf(pub),
    createdAt: now.toISOString(),
  };
}

/** 私钥对象（⑦b 的签名用它；`core/sources/keys.ts` 只有验签那一半） */
export function keyObjectOf(key: AuthorKey): KeyObject {
  return privateKeyOfSeed(key.seed);
}

/** 载入并核对自洽（形状 / 长度 / 种子→公钥 / 指纹） */
export function loadAuthorKey(file: string): AuthorKey {
  if (!existsSync(file)) throw new SpcError('AUTHOR_KEY_MISSING', { file });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SpcError('AUTHOR_KEY_INVALID', {
      file,
      reason: 'malformed-json',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const key = parsed as Partial<AuthorKey>;
  if (!key || typeof key !== 'object' || key.schema !== AUTHOR_KEY_SCHEMA || key.alg !== 'ed25519') {
    throw new SpcError('AUTHOR_KEY_INVALID', { file, reason: 'shape' });
  }
  if (typeof key.seed !== 'string' || typeof key.pub !== 'string') {
    throw new SpcError('AUTHOR_KEY_INVALID', { file, reason: 'fields' });
  }
  let derived: string;
  try {
    derived = pubOfSeed(key.seed);
  } catch {
    throw new SpcError('AUTHOR_KEY_INVALID', { file, reason: 'seed' });
  }
  if (derived !== key.pub) throw new SpcError('AUTHOR_KEY_INVALID', { file, reason: 'pub-mismatch' });
  const fingerprint = fingerprintOf(key.pub);
  if (key.fingerprint !== undefined && key.fingerprint !== fingerprint) {
    throw new SpcError('AUTHOR_KEY_INVALID', { file, reason: 'fingerprint-mismatch' });
  }
  return { ...(key as AuthorKey), fingerprint };
}

export interface SavedKey {
  keyPath: string;
  pubPath: string;
  fingerprint: string;
  /** `true` = 覆盖了原有密钥（换身份；只有 `--force` 才可能） */
  overwritten: boolean;
}

/**
 * 落盘：私钥 + 公钥。
 * ⚠️ 覆盖已有私钥 = **换作者身份**（已发布的包会变成"另一个作者的"）⇒ 非 `force` 一律拒。
 * 权限：`mode: 0o600` 在 POSIX 上生效；**Windows 上近似无效**（chmod 只切只读位）——
 * 那边靠目录 ACL，文档里写明了。
 */
export function saveAuthorKey(ws: Workspace, key: AuthorKey, opts: { force?: boolean } = {}): SavedKey {
  const overwritten = existsSync(ws.keyPath);
  if (overwritten && opts.force !== true) {
    throw new SpcError('AUTHOR_KEY_EXISTS', { file: ws.keyPath, fingerprint: key.fingerprint });
  }
  mkdirSync(dirname(ws.keyPath), { recursive: true });
  writeFileSync(ws.keyPath, `${JSON.stringify(key, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(ws.keyPath, 0o600);
  } catch {
    /* Windows / 特殊文件系统：尽力而为，文档里已说明 */
  }
  writeFileSync(ws.pubPath, `${key.pub}\n`, 'utf8');
  return { keyPath: ws.keyPath, pubPath: ws.pubPath, fingerprint: key.fingerprint, overwritten };
}
