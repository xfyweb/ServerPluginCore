// `.spc`（标准 zip）的**安全解包** —— 这是**不可信输入**那一半：包可能来自市场、别人给的 U 盘、
// 或者被你手改过的文件。所以这里的每条判定都是 **fail-closed**（判不出来就拒）。
//
// 与 `verify.ts` 的分工（两道都要过，缺一不可）：
//   · **这里管容器层**：条目名安不安全、体积/条目数超没超、是不是符号链接/加密条目、有没有重名
//     ⇒ 判的是"**能不能安全落到磁盘上**"；
//   · **`verify.ts` 管内容层**：信封齐不齐、签名对不对、`meta` 与清单对不对得上、载荷哈希
//     ⇒ 判的是"**这个包是不是它自称的那个包**"。
//   ⚠️ 只做内容校验不做容器校验 = 把 zip 的攻击面（zip-slip / zip 炸弹 / 重名覆盖）直接放进来了。
//
// ⚠️ **不自研字节层**（`AGENTS.md` §2 依赖政策）：解析交给 `yauzl`，它自带 zip64、条目尺寸校验、
// 以及**解析期**的条目名校验。几道闸的实际分工（**是实测出来的，不是推测**）：
//   · **yauzl 先出手**（解析阶段就拒，连 `entry` 事件都不给）：
//     绝对路径 / 盘符（`C:x`）/ 任何含 `..` 段的路径 / 强加密
//     ⇒ 统一翻成 `PACKAGE_ARCHIVE_INVALID { file, reason }`，**reason 里带 yauzl 的原话与条目名**（信息没丢）。
//   · **我们判的**（yauzl 会放行的那些）：`.` 段、空段（`a//b.txt`）⇒ `PATH_OUT_OF_SCOPE { path }`；
//     重名条目 ⇒ `DUPLICATE_ENTRY`；**加密条目** ⇒ `PACKAGE_ENTRY_UNSUPPORTED`；符号链接 ⇒ 同码；
//     条目数/体积 ⇒ 三个 `PACKAGE_*`。
//   · **落盘前再兜一道**：`resolve()` 后的绝对路径必须仍在目标目录里（纯字符串判定之外的第二重）。
//   · ⚠️ **反斜杠会被 yauzl 规整成 `/`**（Windows 风格打包工具的常见写法）：`a\b.txt` 落成 `a/b.txt`。
//     不是漏洞（`..\x` 规整后照样被 `..` 规则拦下），但**行为要知道**——用例钉住了它。
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { openPromise, type Entry } from 'yauzl';
import { SpcError } from '../errors';
import { isSafePayloadPath } from './verify';

/**
 * 解包限额（**暂为常量**：设计上没有"包体上限"这一条，先给一组 fail-closed 的默认值，
 * 需要调再进 `config.ts`。数值按"插件包是几 MB 量级"取的，留了两个数量级余量）。
 */
export interface UnpackLimits {
  /** 条目数上限（含目录条目之外的普通文件） */
  maxEntries: number;
  /** 单个条目**解压后**的字节上限（防"压缩比炸弹"：头部声明 1 KB、实际解出 1 GB） */
  maxEntryBytes: number;
  /** 全部条目**解压后**的字节上限 */
  maxTotalBytes: number;
}

export const DEFAULT_UNPACK_LIMITS: UnpackLimits = {
  maxEntries: 4096,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

export interface UnpackResult {
  /** 落盘的**文件**条目数（目录条目不算） */
  entries: number;
  /** 落盘的总字节（解压后） */
  bytes: number;
}

/** `(unix mode, 高 16 位)` → 是不是符号链接（zip 用 external attributes 表达 unix 权限/类型） */
function isSymlink(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000;
}

/** 加密条目（zip 的 general purpose bit 0）——我们不支持带密码的包，直接拒 */
function isEncrypted(entry: Entry): boolean {
  return (entry.generalPurposeBitFlag & 0x1) !== 0;
}

/**
 * 加密条目：**我们是拦下它的那一方**（yauzl 会把 `entry` 事件正常给你，直到读流时才报错）。
 * ⚠️ 造这种样本时注意：传统 PKZIP 加密会在数据前加 **12 字节头**，声明压缩尺寸要算上它 ——
 * 否则先撞的是"压缩/未压缩尺寸不符"（实测踩过：据此一度以为 yauzl 在解析期就拒了加密条目）。
 */

/**
 * 把一个 `.spc` 解到 `destDir`。
 *
 * **契约**：`destDir` 必须**不存在**（调用方给一个全新的暂存目录）—— 解包不做"合并进已有目录"，
 * 那正是重名覆盖类问题最喜欢的地方。任何一步失败 ⇒ **删掉整个 destDir**（不留半个解出来的包）。
 *
 * @throws SpcError  `PACKAGE_ARCHIVE_INVALID` / `PACKAGE_DEST_NOT_EMPTY` / `PATH_OUT_OF_SCOPE` /
 *                   `DUPLICATE_ENTRY` / `PACKAGE_ENTRY_UNSUPPORTED` / `PACKAGE_TOO_MANY_ENTRIES` /
 *                   `PACKAGE_ENTRY_TOO_LARGE` / `PACKAGE_TOO_LARGE`
 */
export async function unpackSpc(file: string, destDir: string, limits: UnpackLimits = DEFAULT_UNPACK_LIMITS): Promise<UnpackResult> {
  try {
    mkdirSync(destDir, { recursive: false });
  } catch {
    throw new SpcError('PACKAGE_DEST_NOT_EMPTY', { dir: destDir });
  }
  const root = resolve(destDir);

  let zip;
  try {
    zip = await openPromise(file, {
      lazyEntries: true,
      // ⚠️ **故意不开** yauzl 的 `strictFileNames`：它判的是同一套规则（反斜杠 / 绝对路径 / `..` 段），
      // 但抛出来是一句笼统的话 ⇒ 会被下面统一翻成 `PACKAGE_ARCHIVE_INVALID`，把 `path` 丢了。
      // 我们自己判 ⇒ 能给出 `PATH_OUT_OF_SCOPE { path }`（运维要知道**是哪个条目**）。
      // 它的规则我们一条没少：`isSafePayloadPath` 另外还拒空段与 `.`，落盘前再用 resolve() 兜一道。
      strictFileNames: false,
      // 头部声明的尺寸与实际解出的字节数不符就报错（截断、伪造尺寸都在这里被挡）
      validateEntrySizes: true,
    });
  } catch (e) {
    rmSync(destDir, { recursive: true, force: true });
    throw new SpcError('PACKAGE_ARCHIVE_INVALID', { file, reason: String((e as Error)?.message ?? e).slice(0, 120) });
  }

  const seen = new Set<string>();
  let entries = 0;
  let bytes = 0;
  try {
    await new Promise<void>((ok, fail) => {
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          try {
            const name = entry.fileName;
            // 目录条目：我们写文件时会按需建父目录，这里不落盘、也不计入文件数
            if (name.endsWith('/')) {
              zip.readEntry();
              return;
            }
            if (!isSafePayloadPath(name)) throw new SpcError('PATH_OUT_OF_SCOPE', { path: name });
            if (seen.has(name)) throw new SpcError('DUPLICATE_ENTRY', { path: name });
            seen.add(name);
            if (isEncrypted(entry)) throw new SpcError('PACKAGE_ENTRY_UNSUPPORTED', { path: name, kind: 'encrypted' });
            if (isSymlink(entry)) throw new SpcError('PACKAGE_ENTRY_UNSUPPORTED', { path: name, kind: 'symlink' });

            entries += 1;
            if (entries > limits.maxEntries) {
              throw new SpcError('PACKAGE_TOO_MANY_ENTRIES', { limit: String(limits.maxEntries), actual: String(entries) });
            }
            if (entry.uncompressedSize > limits.maxEntryBytes) {
              throw new SpcError('PACKAGE_ENTRY_TOO_LARGE', {
                path: name,
                limit: String(limits.maxEntryBytes),
                actual: String(entry.uncompressedSize),
              });
            }
            bytes += entry.uncompressedSize;
            if (bytes > limits.maxTotalBytes) {
              throw new SpcError('PACKAGE_TOO_LARGE', { limit: String(limits.maxTotalBytes), actual: String(bytes) });
            }

            // 纵深防御：即便上面两道都没拦住，落盘前再确认一次"目标确实在 destDir 里"
            // （isSafePayloadPath 是纯字符串层面，这里比的是**解析后**的绝对路径）
            const target = resolve(root, name);
            if (target !== root && !target.startsWith(root + sep)) throw new SpcError('PATH_OUT_OF_SCOPE', { path: name });
            mkdirSync(dirname(target), { recursive: true });

            const stream = await zip.openReadStreamPromise(entry);
            await new Promise<void>((done, err) => {
              const out = createWriteStream(target);
              stream.on('error', err);
              out.on('error', err);
              out.on('close', () => done());
              stream.pipe(out);
            });
            zip.readEntry();
          } catch (e) {
            fail(e as Error);
          }
        })();
      });
      zip.on('end', () => ok());
      zip.on('error', (e: Error) => fail(new SpcError('PACKAGE_ARCHIVE_INVALID', { file, reason: String(e.message).slice(0, 120) })));
      zip.readEntry();
    });
  } catch (e) {
    // 失败不留残迹：半个解出来的包比没有更危险（它会以"看起来像插件"的样子留在状态目录里）
    rmSync(destDir, { recursive: true, force: true });
    throw e;
  }
  return { entries, bytes };
}
