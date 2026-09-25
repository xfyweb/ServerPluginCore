// 测试用：给夹具插件写**作者信封**（`plugin.meta.json` + `plugin.author.sig`）
//
// 为什么需要它：v4 起依赖声明里的 `author.pub` **必填**，而"被依赖方"必须有**可验证的作者身份**
// （`record.authorFingerprint` 来自安装时读到的信封）—— 没有信封的夹具满足不了任何依赖声明。
// 真实世界由构建层强制签名（每个包都有信封），所以这里只是把同一件事在夹具里做一遍。
//
// 密钥**现场生成**（`generateKeyPairSync('ed25519')`），不往仓库塞固定私钥：
// 测试里没有任何东西需要"跨运行稳定的指纹"。
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { parseStrictJson } from '../../sources/canonical';
import { fingerprintOf } from '../../sources/keys';
import {
  AUTHOR_SIG_FILE,
  META_FILE,
  META_SCHEMA,
  META_SIG_FILE,
  metaSigningBytes,
  sha256Hex,
  type MetaDoc,
} from '../../sources/verify';

export interface TestKey {
  /** base64 裸 32 字节公钥 */
  pub: string;
  priv: KeyObject;
  fingerprint: string;
}

export function newTestKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const pub = Buffer.from(jwk.x, 'base64url').toString('base64');
  return { pub, priv: privateKey, fingerprint: fingerprintOf(pub) };
}

function walkFiles(root: string, cur: string, out: string[]): void {
  for (const name of readdirSync(cur)) {
    const abs = join(cur, name);
    const rel = relative(root, abs).split(sep).join(posix.sep);
    if (rel === META_FILE || rel === META_SIG_FILE || rel === AUTHOR_SIG_FILE) continue;
    if (statSync(abs).isDirectory()) walkFiles(root, abs, out);
    else out.push(rel);
  }
}

/**
 * 给一个**已经写好 manifest.json 的插件目录**补上作者信封。
 * `files[]` 由目录实际内容算出（与被签对象一致），并用 `key` 对 meta 字节签名。
 */
export function signPluginDir(dir: string, key: TestKey): { pub: string; fingerprint: string } {
  const manifest = parseStrictJson(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    id: string;
    version: { code: number; name: string };
    type?: string;
    compat?: { minCore: string };
  };
  const paths: string[] = [];
  walkFiles(dir, dir, paths);
  const meta: MetaDoc = {
    metaSchema: META_SCHEMA,
    id: manifest.id,
    version: { code: manifest.version.code, name: manifest.version.name },
    type: manifest.type ?? 'ability',
    ...(manifest.compat ? { compat: { minCore: manifest.compat.minCore } } : {}),
    authorPub: key.pub,
    releasedAt: '2026-09-25T00:00:00Z',
    files: paths.sort().map((p) => {
      const buf = readFileSync(join(dir, p));
      return { path: p, sha256: sha256Hex(buf), size: buf.length };
    }),
  };
  const bytes = metaSigningBytes(meta);
  writeFileSync(join(dir, META_FILE), bytes);
  writeFileSync(join(dir, AUTHOR_SIG_FILE), edSign(null, bytes, key.priv));
  return { pub: key.pub, fingerprint: key.fingerprint };
}
