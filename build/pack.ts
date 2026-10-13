// `spcdev pack`：把**产物目录**打成 `.spc`（标准 zip）。设计见 `docs/build-layer-design.md` §10.6。
//
// 口径（别擅自改）：
//   · 容器 = **标准 zip**（2026-09-11 定）；**校验不依赖容器字节** ⇒ 容器字节（mtime / 条目顺序 / 压缩参数）
//     一律**不在**确定性承诺内（承诺只管**载荷**，§2.1）。
//   · **不自研字节层**（2026-10-12 定）：写入用 `yazl`、读取用 `yauzl`。理由：解开 `.spc` 的那一半在 daemon 里
//     处理的是别人给的包 ⇒ **不可信输入**；自研 zip 解析是"一辈子的解析器和兼容坑"（`AGENTS.md` §2 依赖政策）。
//   · 载荷 = `spcdev build` 的产物目录（清单与载荷同级）；**信封三件套也随包**（它们是包的一部分，不算载荷）
//     —— 落盘形态与 `build/sign.ts` / `core/sources/verify.ts` 同源，这里不重写第二份。
//
// 顺手做的两件（**白拿，不是承诺**，别升级成承诺）：
//   ① 条目 mtime 固定成常量、mode 固定成 0644 ⇒ **同一份载荷打两次包，字节一致**（跨平台也一致）；
//   ② 条目按路径升序写入。
// ⚠️ 复核者按 §2.1 只核**载荷**：容器字节变了不影响校验（`build/__tests__/pack.test.ts` 用 yauzl 解回来逐字节比）。
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { ZipFile } from 'yazl';
import { SpcError } from '../core/errors';
import { AUTHOR_SIG_FILE, META_FILE, sha256Hex, type MetaDoc } from '../core/sources/verify';

/** 固定 mtime（1980-01-01 00:00:00Z，zip 能表达的最小合法时间）⇒ 同一份载荷两次打包字节一致 */
const FIXED_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
/** 固定权限位（别用磁盘上的 mode：Windows 上没有 exec 位，跨平台会给出不同字节） */
const FIXED_MODE = 0o644;

export interface PackResult {
  /** 写出的 `.spc` 绝对路径 */
  file: string;
  bytes: number;
  /** 条目数（载荷 + 信封） */
  entries: number;
}

/** 产物目录里的**全部**文件（含信封），路径 posix、按路径升序 —— zip 里的条目名就是这个 */
function allFiles(dir: string): { path: string; abs: string }[] {
  const out: { path: string; abs: string }[] = [];
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur)) {
      const abs = join(cur, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push({ path: relative(dir, abs).split(sep).join(posix.sep), abs });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 把 `dist/` 打成 `.spc`。
 *
 * 打包前**三道检查**（都是 fail-closed：宁可拦住，也别让人装进一个"改过的"包）：
 *   ① 产物目录在不在（不在 ⇒ `PACK_DIST_MISSING`：先跑 `spcdev build`）；
 *   ② 信封三件套齐不齐（缺 ⇒ `PACK_ENVELOPE_MISSING`）；
 *   ③ **信封有没有覆盖住当前载荷**（`files[]` 的 path/sha256/size 与磁盘逐条比；不符 ⇒ `PACK_ENVELOPE_MISMATCH`）
 *      —— 这道挡的是"build 之后手改了 dist 再打包"：那样签名与内容已经对不上，装下去只会验签失败。
 */
export async function packPlugin(opts: { distDir: string; file: string }): Promise<PackResult> {
  const { distDir } = opts;
  const manifestFile = join(distDir, 'manifest.json');
  if (!existsSync(manifestFile)) throw new SpcError('PACK_DIST_MISSING', { dir: distDir });

  const metaFile = join(distDir, META_FILE);
  const sigFile = join(distDir, AUTHOR_SIG_FILE);
  if (!existsSync(metaFile) || !existsSync(sigFile)) {
    throw new SpcError('PACK_ENVELOPE_MISSING', { dir: distDir, meta: META_FILE, sig: AUTHOR_SIG_FILE });
  }

  const files = allFiles(distDir);
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as MetaDoc;
  const declared = new Map(meta.files.map((f) => [f.path, f]));
  for (const f of files) {
    if (f.path === META_FILE || f.path === AUTHOR_SIG_FILE) continue; // 信封自己不进 files[]
    const want = declared.get(f.path);
    if (want === undefined) throw new SpcError('PACK_ENVELOPE_MISMATCH', { path: f.path, why: '信封里没有这个文件' });
    const bytes = readFileSync(f.abs);
    if (bytes.length !== want.size || sha256Hex(bytes) !== want.sha256) {
      throw new SpcError('PACK_ENVELOPE_MISMATCH', { path: f.path, why: '内容与信封里的哈希不符' });
    }
  }

  const file = resolve(opts.file);
  // 输出目录可能还不存在（默认的 `release/` 第一次打包时就是新建的）⇒ 建出来
  mkdirSync(dirname(file), { recursive: true });
  const zip = new ZipFile();
  for (const f of files) {
    zip.addFile(f.abs, f.path, { mtime: FIXED_MTIME, mode: FIXED_MODE, compress: true });
  }
  const bytes = await new Promise<number>((ok, fail) => {
    const out = createWriteStream(file);
    let n = 0;
    out.on('data', () => {});
    zip.outputStream.on('data', (chunk: Buffer) => {
      n += chunk.length;
    });
    zip.outputStream.on('error', fail);
    out.on('error', fail);
    out.on('close', () => ok(n));
    zip.outputStream.pipe(out);
    zip.end();
  });
  return { file, bytes, entries: files.length };
}

/**
 * 默认输出：`<插件目录>/release/<插件名>-<版本>.spc`。
 *
 * 为什么不丢在插件根目录（2026-10-13 维护者手工验收指出"一点不好找"）：根目录已经挤着 `manifest.json` /
 * `main.ts` / `dist/`（构建产物）/ `.spcdev/`（工具态，含私钥）；发布物再混进去就更难找了。
 * `release/` 的语义直白：**这里放要发出去的东西**。插件名取 id 里 `/` 之后那段（来源/命名空间不进文件名）。
 */
export function defaultPackFile(pluginDir: string, id: string, versionName: string): string {
  const name = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return join(pluginDir, 'release', `${name}-${versionName}.spc`);
}
