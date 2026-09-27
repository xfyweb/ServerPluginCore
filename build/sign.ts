// 作者信封（docs/build-layer-design.md §2、§6）：`plugin.meta.json` + `plugin.author.sig`
//
// ⚠️ 两样东西**不许在构建层重写一遍** —— 否则"签的到底是什么字节"会有两份答案，而签名验不过是查不出原因的：
//   ① 被签字节 = `core/sources/verify.ts` 的 `metaSigningBytes()`（那个函数注释就写着"供构建工具使用"）；
//   ② meta 的形状 = 同文件的 `MetaDoc` / `META_SCHEMA` / 三个信封文件名常量。
//
// 落盘形态与 `core/__tests__/helpers/signed-plugin.ts` **逐字一致**（那是夹具侧的同一件事）：
//   · `plugin.meta.json` = **规范化字节原文**（不是 `JSON.stringify(…, 2)`，也**不加尾换行** —— 验签直接对文件字节做）；
//   · `plugin.author.sig` = **裸 64 字节**（不是 base64：验签那边读到 Buffer 后自己转）。
import { sign as edSign } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import {
  AUTHOR_SIG_FILE,
  META_FILE,
  META_SCHEMA,
  META_SIG_FILE,
  metaSigningBytes,
  sha256Hex,
  type MetaDoc,
} from '../core/sources/verify';
import type { Manifest } from '../sdk/types';
import { keyObjectOf, type AuthorKey } from './keys';

/** 信封三件套：**都不进 `files[]`**（否则「签名 → meta → 文件哈希 → 签名」成环，见 verify.ts 的注释） */
const ENVELOPE_FILES = new Set([META_FILE, META_SIG_FILE, AUTHOR_SIG_FILE]);

export interface PayloadFile {
  /** 相对产物目录的 POSIX 路径 */
  path: string;
  bytes: Buffer;
}

export function isEnvelopeFile(relPath: string): boolean {
  return ENVELOPE_FILES.has(relPath);
}

/** 产物目录里的**载荷**（信封文件不算；路径 posix、按 path 升序 —— 与签名覆盖范围一致） */
export function payloadFiles(dir: string): PayloadFile[] {
  const out: PayloadFile[] = [];
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur)) {
      const abs = join(cur, name);
      const rel = relative(dir, abs).split(sep).join(posix.sep);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (!isEnvelopeFile(rel)) out.push({ path: rel, bytes: readFileSync(abs) });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 造 meta 信封。
 *
 * 只搬 `verify.ts` 那个 `crossCheckManifest()` 会**逐字比对**的字段（`id` / `version` / `type` / `compat.minCore`）——
 * 多搬一个字段没有意义，少搬一个会让包在校验期被判 `META_MANIFEST_MISMATCH`。
 */
export function metaOf(opts: {
  manifest: Manifest;
  files: readonly PayloadFile[];
  authorPub: string;
  releasedAt: string;
}): MetaDoc {
  const { manifest } = opts;
  return {
    metaSchema: META_SCHEMA,
    id: manifest.id,
    version: { code: manifest.version.code, name: manifest.version.name },
    type: manifest.type ?? 'ability',
    ...(manifest.compat?.minCore !== undefined ? { compat: { minCore: manifest.compat.minCore } } : {}),
    authorPub: opts.authorPub,
    releasedAt: opts.releasedAt,
    files: opts.files.map((f) => ({ path: f.path, sha256: sha256Hex(f.bytes), size: f.bytes.length })),
  };
}

/**
 * 把信封写进产物目录：meta 原文 + 它的作者签名。
 * 返回签名字节数（供构建输出报一行），`bytes` 与写进文件的是**同一份**。
 */
export function writeEnvelope(dir: string, meta: MetaDoc, key: AuthorKey): { metaBytes: number; sigBytes: number } {
  const bytes = metaSigningBytes(meta); // ← 签名对象与落盘内容同源，不许各算一遍
  writeFileSync(join(dir, META_FILE), bytes);
  const sig = edSign(null, bytes, keyObjectOf(key));
  writeFileSync(join(dir, AUTHOR_SIG_FILE), sig);
  return { metaBytes: bytes.length, sigBytes: sig.length };
}

export type AuthorCheck =
  | { ok: true; namespace: string }
  | { ok: false; reason: 'workspace-unset' | 'id-namespace' | 'author-id'; expected: string; actual: string };

/**
 * **清单里的作者段 == 工作区作者 ID**（`build-layer-design.md` §10.4 末条，用户 2026-09-26 定的待办）。
 *
 * 判两处，都是"作者改配置/手改清单"会在发布前就暴露的地方：
 *   ① `manifest.id` 的命名空间段（`@<这里>/<名字>`）——脚手架就是照工作区作者拼出来的；
 *   ② `manifest.author.id` 的第一段（`<这里>@<源域名>`）—— 写了就必须一致（与 `AUTHOR_MISMATCH` 同一口径）。
 * 工作区没声明作者 ⇒ 报 `workspace-unset`，调用方翻成已有的 `AUTHOR_ID_REQUIRED`（不做默认值：身份不猜）。
 */
export function checkAuthor(manifest: Manifest, workspaceAuthor: string): AuthorCheck {
  if (workspaceAuthor === '') return { ok: false, reason: 'workspace-unset', expected: '', actual: '' };
  const namespace = manifest.id.replace(/^@/, '').split('/')[0] ?? '';
  if (namespace !== workspaceAuthor) {
    return { ok: false, reason: 'id-namespace', expected: workspaceAuthor, actual: namespace };
  }
  const authorId = manifest.author?.id;
  if (typeof authorId === 'string' && authorId.length > 0) {
    const seg = authorId.split('@')[0] ?? '';
    if (seg !== workspaceAuthor) return { ok: false, reason: 'author-id', expected: workspaceAuthor, actual: seg };
  }
  return { ok: true, namespace };
}
