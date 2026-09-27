// 包校验（docs/plugin-signature-design.md §2/§7.1）
//
// 有源安装/更新：用**该源的当前有效公钥**验 plugin.meta.sig → 验**作者签名**（plugin.author.sig）
//   → 逐项核对 files[] → 交叉校验 manifest。
// 本地安装不经过这里（没有市场可验），但**作者身份**同样要处理 —— 见 `loadLocalEnvelope()`：
// 本地包的信封是可选的（都没有 ⇒ 不记作者身份），但**给了就必须自洽**（fail-closed）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { PLUGIN_ID_RE } from '../../sdk/ids';
import { canonicalize, parseStrictJson } from './canonical';
import { decodePub, ed25519Verify } from './keys';
import type { SourceEntry } from './keyring';

/** 信封文件名（约定，不在元数据里声明路径）。三个都**不进 `files[]`** —— 否则「签名 → meta → 文件哈希 → 签名」成环 */
export const META_FILE = 'plugin.meta.json';
export const META_SIG_FILE = 'plugin.meta.sig';
export const AUTHOR_SIG_FILE = 'plugin.author.sig';

/** meta schema 版本（v4 = 2：新增 `authorPub`；未发布，不做兼容） */
export const META_SCHEMA = 2;

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
  /**
   * 作者公钥（base64 裸 32 字节）—— **身份，不是凭据**。
   * ⚠️ 判定时用**期望公钥**覆盖它（名册首见值 / 依赖声明的 `author.pub`）；它本身只是"被验的对象"与首见值。
   */
  authorPub?: string;
  releasedAt: string;
  files: MetaFileEntry[];
  build?: unknown;
}

export interface LoadedPackage {
  /** 被签对象的**原始字节**（验签直接对它做，不做重新序列化） */
  metaText: string;
  sig: Buffer;
  /** 作者签名（可选：本地包可能没有；有源包必须有） */
  authorSig?: Buffer;
  /** 载荷：相对路径（posix）→ 内容 */
  payload: Map<string, Buffer>;
}

export type VerifyCode =
  | 'PACKAGE_META_MISSING'
  | 'PACKAGE_META_MALFORMED'
  | 'PACKAGE_ENVELOPE_INCOMPLETE'
  | 'META_SIGNATURE_INVALID'
  | 'PACKAGE_AUTHOR_SIG_MISSING'
  | 'AUTHOR_SIGNATURE_INVALID'
  | 'PACKAGE_FILE_MISSING'
  | 'PACKAGE_FILE_MISMATCH'
  | 'PACKAGE_EXTRA_FILE'
  | 'DUPLICATE_ENTRY'
  | 'PATH_OUT_OF_SCOPE'
  | 'PLUGIN_ID_INVALID'
  | 'META_MANIFEST_MISMATCH'
  | 'AUTHOR_MISMATCH'
  | 'KEY_FORMAT_INVALID'
  | 'SOURCE_NOT_CONFIGURED'
  | 'SOURCE_DISABLED'
  | 'SOURCE_SUSPENDED';

export type VerifyResult =
  | { ok: true; meta: MetaDoc }
  | { ok: false; code: VerifyCode; params?: Record<string, string> };

/** 校验失败（含本地信封）的统一形状 */
export type EnvelopeError = { code: VerifyCode; params?: Record<string, string> };

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
  const authorSigPath = join(dir, AUTHOR_SIG_FILE);
  const authorSig = existsSync(authorSigPath) ? readFileSync(authorSigPath) : undefined;
  const payload = new Map<string, Buffer>();
  walk(dir, dir, payload);
  return { metaText, sig, authorSig, payload };
}

function walk(root: string, cur: string, out: Map<string, Buffer>): void {
  for (const name of readdirSync(cur)) {
    const abs = join(cur, name);
    const rel = relative(root, abs).split(sep).join(posix.sep);
    // 三个信封都不算载荷（它们本来也不该出现在 files[] 里）
    if (rel === META_FILE || rel === META_SIG_FILE || rel === AUTHOR_SIG_FILE) continue;
    if (statSync(abs).isDirectory()) walk(root, abs, out);
    else out.set(rel, readFileSync(abs));
  }
}

/** 路径安全：必须相对、不得含 `..`、不得以 / 开头（复用 safe-path 的语义，但这里是纯字符串层面） */
export function isSafePayloadPath(p: string): boolean {
  if (p.length === 0 || p.startsWith('/') || p.includes('\\')) return false;
  return !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/** meta 的语法与必填字段（市场路径与本地路径共用这一段） */
function parseMeta(metaText: string): { ok: true; meta: MetaDoc } | ({ ok: false } & EnvelopeError) {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(metaText);
  } catch {
    return { ok: false, code: 'PACKAGE_META_MALFORMED' };
  }
  const meta = parsed as MetaDoc;
  if (!meta || typeof meta !== 'object' || meta.metaSchema !== META_SCHEMA || !Array.isArray(meta.files)) {
    return { ok: false, code: 'PACKAGE_META_MALFORMED', params: { reason: 'metaSchema' } };
  }
  if (typeof meta.id !== 'string' || !PLUGIN_ID_RE.test(meta.id)) {
    return { ok: false, code: 'PLUGIN_ID_INVALID', params: { id: String(meta.id) } };
  }
  // v4：`authorPub` 必填 —— 没有它就没有"身份"可言（构建层强制签名 ⇒ 正常包不会缺）
  if (typeof meta.authorPub !== 'string') {
    return { ok: false, code: 'PACKAGE_META_MALFORMED', params: { reason: 'authorPub' } };
  }
  try {
    decodePub(meta.authorPub);
  } catch {
    return { ok: false, code: 'KEY_FORMAT_INVALID', params: { reason: 'authorPub' } };
  }
  return { ok: true, meta };
}

/**
 * 作者签名校验（§3bis）：`plugin.author.sig` 对**同一份 meta 字节**的签名。
 *
 * @param expectedPub **期望公钥**：有期望值时必须传它（名册首见值 / 依赖声明的 `author.pub`）；
 *                    首见（TOFU）时传 `meta.authorPub` —— 那一次它才是"被记下来的对象"。
 *                    ⛔ 绝不无条件信包内自述，那等于自签自证。
 */
export function verifyAuthorSignature(metaText: string, authorSig: Buffer, expectedPub: string): boolean {
  return ed25519Verify(expectedPub, Buffer.from(metaText, 'utf8'), authorSig.toString('base64'));
}

/**
 * 校验有源包。
 * @param pkg    已装载的分发单元
 * @param source keyring 条目（必须 enabled、未暂停、且已获得公钥）
 * @param opts   `expectAuthorPub`：宿主已知的期望作者公钥（名册/记录里的值）。
 *               传了它就必须**同时**满足：`meta.authorPub` 与它一致 + 签名由它验过。
 */
export function verifyPackage(
  pkg: LoadedPackage,
  source: SourceEntry,
  opts: { expectAuthorPub?: string } = {},
): VerifyResult {
  // 0) 源可用性
  if (!source.enabled) return { ok: false, code: 'SOURCE_DISABLED', params: { origin: source.origin } };
  if (source.suspended) {
    return { ok: false, code: 'SOURCE_SUSPENDED', params: { origin: source.origin, reason: source.suspended.reason } };
  }
  if (!source.pub) return { ok: false, code: 'SOURCE_NOT_CONFIGURED', params: { origin: source.origin, reason: 'pub-missing' } };

  // 1) 元数据语法（严格 JSON：重复键 / 浮点 / 注释一律拒绝）+ 必填字段
  const parsedMeta = parseMeta(pkg.metaText);
  if (!parsedMeta.ok) return parsedMeta;
  const meta = parsedMeta.meta;

  // 2) 市场验签（对原始字节；用本源的当前有效公钥）
  if (!ed25519Verify(source.pub, Buffer.from(pkg.metaText, 'utf8'), pkg.sig.toString('base64'))) {
    return { ok: false, code: 'META_SIGNATURE_INVALID', params: { origin: source.origin } };
  }

  // 3) 作者签名（v4）：有源包**必须**有它 —— 没有它"连续性"就无从谈起
  if (!pkg.authorSig) {
    return { ok: false, code: 'PACKAGE_AUTHOR_SIG_MISSING', params: { file: AUTHOR_SIG_FILE } };
  }
  if (opts.expectAuthorPub !== undefined && meta.authorPub !== opts.expectAuthorPub) {
    // meta 自述的钥与宿主记忆不符 ⇒ 换钥：管理员裁决，不在这一层放行
    return { ok: false, code: 'AUTHOR_SIGNATURE_INVALID', params: { reason: 'authorPub-mismatch' } };
  }
  if (!verifyAuthorSignature(pkg.metaText, pkg.authorSig, opts.expectAuthorPub ?? meta.authorPub!)) {
    return { ok: false, code: 'AUTHOR_SIGNATURE_INVALID', params: { reason: 'signature' } };
  }

  // 4) 载荷清单
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

  // 5) 交叉校验 manifest（meta 里的冗余字段必须与之一致）
  const cross = crossCheckManifest(meta, pkg.payload);
  if (!cross.ok) return { ok: false, code: 'META_MANIFEST_MISMATCH', params: { reason: cross.reason } };

  // 6) 作者一致性（author.id 可选；填写就必须与 id 命名空间和源域名一致）
  const authorId = (cross.manifest.author as { id?: unknown } | undefined)?.id;
  if (typeof authorId === 'string') {
    const [user, domain] = authorId.split('@');
    const ns = meta.id.slice(1, meta.id.indexOf('/'));
    if (user !== ns || domain !== source.origin) {
      return { ok: false, code: 'AUTHOR_MISMATCH', params: { author: authorId, origin: source.origin } };
    }
  }

  return { ok: true, meta };
}

type CrossCheck = { ok: true; manifest: Record<string, unknown> } | { ok: false; reason: string };

/**
 * meta 冗余字段 ↔ manifest 的一致性。
 * 一致时**把解析好的 manifest 一起交回**（后续的作者一致性校验要用，避免再解析一次）。
 */
function crossCheckManifest(meta: MetaDoc, payload: Map<string, Buffer>): CrossCheck {
  const manifestBuf = payload.get('manifest.json');
  if (!manifestBuf) return { ok: false, reason: 'manifest-missing' };
  let manifest: Record<string, unknown>;
  try {
    manifest = parseStrictJson(manifestBuf.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'manifest-malformed' };
  }
  const mVersion = manifest.version as { code?: unknown; name?: unknown } | undefined;
  const mCompat = manifest.compat as { minCore?: unknown } | undefined;
  const mismatch =
    manifest.id !== meta.id ||
    mVersion?.code !== meta.version?.code ||
    mVersion?.name !== meta.version?.name ||
    (manifest.type ?? 'ability') !== (meta.type ?? 'ability') ||
    (mCompat?.minCore ?? undefined) !== (meta.compat?.minCore ?? undefined);
  return mismatch ? { ok: false, reason: 'fields' } : { ok: true, manifest };
}

/**
 * 本地包的信封（可选）：`plugin.meta.json` + `plugin.author.sig`。
 *
 * **规则（fail-closed）**：要么两个都不在（⇒ 不记作者身份，`authorFingerprint = null`），
 * 要么两个都在且自洽 —— 只给一个说明包不完整，拒装。
 *
 * 本地没有市场可验，所以这里只做：语法 + 必填字段 + **作者签名自洽**（用 `meta.authorPub` 验）
 * + 与 manifest 的交叉校验 + 载荷哈希。"这个作者是谁"要靠**宿主侧记忆**（名册）判，不靠包内自述。
 */
export function loadLocalEnvelope(
  dir: string,
): { kind: 'none' } | { kind: 'ok'; authorPub: string; meta: MetaDoc } | ({ kind: 'error' } & EnvelopeError) {
  const metaPath = join(dir, META_FILE);
  const sigPath = join(dir, AUTHOR_SIG_FILE);
  const hasMeta = existsSync(metaPath);
  const hasSig = existsSync(sigPath);
  if (!hasMeta && !hasSig) return { kind: 'none' };
  if (hasMeta !== hasSig) {
    // 只给一半 = 包不完整（不是"没有信封"）
    return { kind: 'error', code: 'PACKAGE_ENVELOPE_INCOMPLETE', params: { file: hasMeta ? AUTHOR_SIG_FILE : META_FILE } };
  }

  const metaText = readFileSync(metaPath, 'utf8');
  const parsedMeta = parseMeta(metaText);
  if (!parsedMeta.ok) return { kind: 'error', code: parsedMeta.code, params: parsedMeta.params };

  const authorSig = readFileSync(sigPath);
  if (!verifyAuthorSignature(metaText, authorSig, parsedMeta.meta.authorPub!)) {
    return { kind: 'error', code: 'AUTHOR_SIGNATURE_INVALID', params: { reason: 'signature' } };
  }

  const payload = new Map<string, Buffer>();
  walk(dir, dir, payload);
  // 载荷哈希：本地包没有别的完整性锚，这一层是白送的（作者签名覆盖 files[]）
  for (const f of parsedMeta.meta.files) {
    const buf = payload.get(f.path);
    if (!buf) return { kind: 'error', code: 'PACKAGE_FILE_MISSING', params: { path: f.path } };
    if (buf.length !== f.size || sha256Hex(buf) !== f.sha256) {
      return { kind: 'error', code: 'PACKAGE_FILE_MISMATCH', params: { path: f.path } };
    }
  }
  const cross = crossCheckManifest(parsedMeta.meta, payload);
  if (!cross.ok) return { kind: 'error', code: 'META_MANIFEST_MISMATCH', params: { reason: cross.reason } };

  return { kind: 'ok', authorPub: parsedMeta.meta.authorPub!, meta: parsedMeta.meta };
}

/** 供构建工具使用：把 meta 序列化为规范字节（签名对象） */
export function metaSigningBytes(meta: MetaDoc): Buffer {
  return Buffer.from(canonicalize(meta), 'utf8');
}
