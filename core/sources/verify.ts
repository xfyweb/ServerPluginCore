// 包校验（docs/plugin-signature-design.md §7.1）
//
// 有源安装/更新：用**该源的当前有效公钥**验 plugin.meta.sig → 逐项核对 files[] → 交叉校验 manifest。
// 本地安装不经过这里（不验签 ⇒ unanchored ⇒ 无更新渠道）。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { canonicalize, parseStrictJson } from './canonical';
import { ed25519Verify } from './keys';
import type { SourceEntry } from './keyring';

/** 信封文件名（约定，不在元数据里声明路径） */
export const META_FILE = 'plugin.meta.json';
export const META_SIG_FILE = 'plugin.meta.sig';

export interface MetaFileEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface MetaDoc {
  metaSchema: number;
  id: string;
  version: { code: number; name: string };
  type?: string;
  compat?: { minCore: string };
  releasedAt: string;
  files: MetaFileEntry[];
  build?: unknown;
}

export interface LoadedPackage {
  /** 被签对象的**原始字节**（验签直接对它做，不做重新序列化） */
  metaText: string;
  sig: Buffer;
  /** 载荷：相对路径（posix）→ 内容 */
  payload: Map<string, Buffer>;
}

export type VerifyCode =
  | 'PACKAGE_META_MISSING'
  | 'PACKAGE_META_MALFORMED'
  | 'META_SIGNATURE_INVALID'
  | 'PACKAGE_FILE_MISSING'
  | 'PACKAGE_FILE_MISMATCH'
  | 'PACKAGE_EXTRA_FILE'
  | 'DUPLICATE_ENTRY'
  | 'PATH_OUT_OF_SCOPE'
  | 'PLUGIN_ID_INVALID'
  | 'META_MANIFEST_MISMATCH'
  | 'AUTHOR_MISMATCH'
  | 'SOURCE_NOT_CONFIGURED'
  | 'SOURCE_DISABLED'
  | 'SOURCE_SUSPENDED';

export type VerifyResult =
  | { ok: true; meta: MetaDoc }
  | { ok: false; code: VerifyCode; params?: Record<string, string> };

const ID_PATTERN = /^@[a-z0-9][a-z0-9_-]{0,62}\/[a-z0-9][a-z0-9_-]{0,62}$/;

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 从目录装载分发单元（zip 容器由 P4 的 registry 客户端负责解包） */
export function loadPackageDir(dir: string): LoadedPackage {
  const metaPath = join(dir, META_FILE);
  const sigPath = join(dir, META_SIG_FILE);
  let metaText: string;
  let sig: Buffer;
  try {
    metaText = readFileSync(metaPath, 'utf8');
    sig = readFileSync(sigPath);
  } catch {
    throw new Error('PACKAGE_META_MISSING');
  }
  const payload = new Map<string, Buffer>();
  walk(dir, dir, payload);
  return { metaText, sig, payload };
}

function walk(root: string, cur: string, out: Map<string, Buffer>): void {
  for (const name of readdirSync(cur)) {
    const abs = join(cur, name);
    const rel = relative(root, abs).split(sep).join(posix.sep);
    if (rel === META_FILE || rel === META_SIG_FILE) continue;
    if (statSync(abs).isDirectory()) walk(root, abs, out);
    else out.set(rel, readFileSync(abs));
  }
}

/** 路径安全：必须相对、不得含 `..`、不得以 / 开头（复用 safe-path 的语义，但这里是纯字符串层面） */
export function isSafePayloadPath(p: string): boolean {
  if (p.length === 0 || p.startsWith('/') || p.includes('\\')) return false;
  return !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/**
 * 校验有源包。
 * @param pkg    已装载的分发单元
 * @param source keyring 条目（必须 enabled、未暂停、且已获得公钥）
 */
export function verifyPackage(pkg: LoadedPackage, source: SourceEntry): VerifyResult {
  // 0) 源可用性
  if (!source.enabled) return { ok: false, code: 'SOURCE_DISABLED', params: { origin: source.origin } };
  if (source.suspended) {
    return { ok: false, code: 'SOURCE_SUSPENDED', params: { origin: source.origin, reason: source.suspended.reason } };
  }
  if (!source.pub) return { ok: false, code: 'SOURCE_NOT_CONFIGURED', params: { origin: source.origin, reason: 'pub-missing' } };

  // 1) 元数据语法（严格 JSON：重复键 / 浮点 / 注释一律拒绝）
  let parsed: unknown;
  try {
    parsed = parseStrictJson(pkg.metaText);
  } catch {
    return { ok: false, code: 'PACKAGE_META_MALFORMED' };
  }
  const meta = parsed as MetaDoc;
  if (!meta || typeof meta !== 'object' || meta.metaSchema !== 1 || !Array.isArray(meta.files)) {
    return { ok: false, code: 'PACKAGE_META_MALFORMED' };
  }
  if (typeof meta.id !== 'string' || !ID_PATTERN.test(meta.id)) {
    return { ok: false, code: 'PLUGIN_ID_INVALID', params: { id: String(meta.id) } };
  }

  // 2) 验签（对原始字节；用本源的当前有效公钥）
  if (!ed25519Verify(source.pub, Buffer.from(pkg.metaText, 'utf8'), pkg.sig.toString('base64'))) {
    return { ok: false, code: 'META_SIGNATURE_INVALID', params: { origin: source.origin } };
  }

  // 3) 载荷清单
  const seen = new Set<string>();
  for (const f of meta.files) {
    const path = f?.path;
    if (typeof path !== 'string' || !isSafePayloadPath(path)) {
      return { ok: false, code: 'PATH_OUT_OF_SCOPE', params: { path: String(path) } };
    }
    if (seen.has(path)) return { ok: false, code: 'DUPLICATE_ENTRY', params: { path } };
    seen.add(path);
    const buf = pkg.payload.get(path);
    if (!buf) return { ok: false, code: 'PACKAGE_FILE_MISSING', params: { path } };
    if (buf.length !== f.size || sha256Hex(buf) !== f.sha256) {
      return { ok: false, code: 'PACKAGE_FILE_MISMATCH', params: { path } };
    }
  }
  for (const path of pkg.payload.keys()) {
    if (!seen.has(path)) return { ok: false, code: 'PACKAGE_EXTRA_FILE', params: { path } };
  }

  // 4) 交叉校验 manifest（meta 里的冗余字段必须与之一致）
  const manifestBuf = pkg.payload.get('manifest.json');
  if (!manifestBuf) return { ok: false, code: 'META_MANIFEST_MISMATCH', params: { reason: 'manifest-missing' } };
  let manifest: Record<string, unknown>;
  try {
    manifest = parseStrictJson(manifestBuf.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'META_MANIFEST_MISMATCH', params: { reason: 'manifest-malformed' } };
  }
  const mVersion = manifest.version as { code?: unknown; name?: unknown } | undefined;
  const mCompat = manifest.compat as { minCore?: unknown } | undefined;
  const mismatch =
    manifest.id !== meta.id ||
    mVersion?.code !== meta.version?.code ||
    mVersion?.name !== meta.version?.name ||
    (manifest.type ?? 'ability') !== (meta.type ?? 'ability') ||
    (mCompat?.minCore ?? undefined) !== (meta.compat?.minCore ?? undefined);
  if (mismatch) return { ok: false, code: 'META_MANIFEST_MISMATCH' };

  // 5) 作者一致性（author.id 可选；填写就必须与 id 命名空间和源域名一致）
  const authorId = (manifest.author as { id?: unknown } | undefined)?.id;
  if (typeof authorId === 'string') {
    const [user, domain] = authorId.split('@');
    const ns = meta.id.slice(1, meta.id.indexOf('/'));
    if (user !== ns || domain !== source.origin) {
      return { ok: false, code: 'AUTHOR_MISMATCH', params: { author: authorId, origin: source.origin } };
    }
  }

  return { ok: true, meta };
}

/** 供构建工具使用：把 meta 序列化为规范字节（签名对象） */
export function metaSigningBytes(meta: MetaDoc): Buffer {
  return Buffer.from(canonicalize(meta), 'utf8');
}
