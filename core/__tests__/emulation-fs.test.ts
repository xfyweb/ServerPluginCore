// node:fs / node:fs/promises 仿真的对齐测试
//
// 判卷人有三个，各管一段（照 emulation-os-process.test.ts 的分工）：
//   1. **宿主 Node**：平台无关的面（值、错误 `code`/`syscall`、形状）逐条差分对跑——
//      两边跑**同一棵目录树**（各自一个根），跑完比结果；
//   2. **Linux 真值**（`tools/truth/data/fs-url-truth.json`，WSL node v22.22.1 实测）：`errno` 与错误
//      **文案**只在 Linux 上跟宿主比，其它平台直接断言录下来的 Linux 值——
//      这台开发机是 Windows，宿主的 errno（-4058）与文案完全不同，拿它当判卷人会得出错误结论；
//   3. **结构性断言**：凡是我们**有意与 Node 不同**的地方（越界 EACCES + spcCode、软链语义、
//      不支持的能力响亮的抛错），不跟宿主比，直接断言我们自己的判据（同 emulation-buffer 的"不池化"用例）。
//
// 宿主通道用**真的宿主 API**（`buildHostApi`）+ 一个假桥：假桥只做真桥做的三件事
// （参数按 VM 类型取、结果 JSON 化、失败回错误信封），宿主实现一行都不重写。
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants as HOST_FS_CONSTANTS, symlinkSync } from 'node:fs';
import * as hostFs from 'node:fs';
import hostFsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 审计隔离（本文件后半段会建真沙箱）：AUDIT_DIR 在模块加载时读环境变量，所以先设再动态 import
const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-fs-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;
after(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

const { buildHostApi } = await import('../../core/hostApi.ts');
const { buildEnvFacts } = await import('../../core/emulated-env.ts');
const { toErrorShape } = await import('../../core/errors.ts');

// shim 的加载方式与既有对齐测试一致：逐字节拷到临时目录（ESM），再按 file: 导入。
// 这样 TS 不会去检查纯 JS 的 shim，也能精确控制"哪些伴随文件在场"（node-fs.js 依赖
// node-buffer.js 与 node-url.js，`FileHandle` 还要 node-events.js，三个都得拷）。
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-shims-fs-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
const SHIM_SRC = join(process.cwd(), 'core', 'sandbox-modules');
for (const f of ['node-fs.js', 'node-fs-promises.js', 'node-buffer.js', 'node-url.js', 'node-events.js']) {
  copyFileSync(join(SHIM_SRC, f), join(SHIM_DIR, f));
}
after(() => rmSync(SHIM_DIR, { recursive: true, force: true }));

/** 沙箱侧根（= 插件数据目录）与"宿主侧根"（对照用的普通目录）——两边种同一棵树 */
const DATA_DIR = mkdtempSync(join(tmpdir(), 'spc-sandbox-'));
const HOST_DIR = mkdtempSync(join(tmpdir(), 'spc-host-'));
const OUTSIDE = mkdtempSync(join(tmpdir(), 'spc-outside-')); // 数据目录之外（越界用例用）
after(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(HOST_DIR, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

/**
 * 装假桥：与 `core/sandbox.ts` 的桥同语义。
 *
 * 关键细节（**真桥的行为，不能省**）：参数按 **VM 侧类型**取——字符串原样，
 * ArrayBuffer 变成 `Uint8Array`（真桥是 `Uint8Array.from(view.value)`）。漏了这一步，
 * 宿主实现收到的是 ArrayBuffer 而不是字节视图，会以 `ERR_INVALID_ARG_TYPE` 失败，
 * 而差分测试会把它误读成"shim 的 bug"（探针阶段真踩过）。
 * 权限点这里不做判定（真桥的权限判定由后面那条真沙箱用例覆盖），但**方法名必须真的存在**——
 * 写错方法名要在这一步就炸，而不是静默走 undefined。
 */
/**
 * 假桥要调的**宿主方法** —— 并把"声明了 `async: true`"的那一类接到**同步孪生**上。
 *
 * 为什么不能直接调 `method.fn`：真桥里 asyncify 让这类方法对 guest **看起来仍是同步的**
 * （"the VM's stack will be unwound while waiting … then restored"，见 `quickjs-emscripten-core` 的
 * `QuickJSAsyncContext.newAsyncifiedFunction` —— 插件拿到的就是**最终值**，不是 Promise），
 * 而纯 Node 的假桥复现不出那次挂起。所以这类方法在假桥里接到孪生方法（`fs.readTextAsync` → `fs.readText`）：
 * 本文件验的是 fs/promises 的**语义**（编码 / 错误映射 / 上限 / 与同步面一致），
 * 而"挂起能被驱动、真 I/O 不阻塞宿主"由真沙箱用例覆盖（`sandbox.test.ts` 里 fs.promises 那条）。
 *
 * ⚠️ 别顺手把 Promise 交出去：`JSON.stringify(Promise)` 是 `"{}"` ⇒ 插件读出来是 `undefined`
 * ——**静默错值**（本轮就踩了这条：`fsPromises.readFile` 返回 undefined，而 hostApi 侧一切正常）。
 *
 * 顺带守住"异步通道不许是绕过权限点的第二条路"：两条通道的 permission 与结果形状必须逐条相同。
 */
function fakeTarget(api: Record<string, any>, name: string): { name: string; method: any } {
  const method = api[name];
  if (!method) throw new Error(`假桥收到未知宿主方法：${name}`);
  if (method.async !== true) return { name, method };
  const twinName = name.replace(/Async$/, '');
  const twin = api[twinName];
  if (!twin) {
    throw new Error(`假桥：异步宿主方法 ${name} 没有同步孪生 ${twinName}，纯 Node 的假桥仿真不了它的挂起`);
  }
  if (twin.permission !== method.permission) {
    throw new Error(`假桥：${name} 与 ${twinName} 的权限点不同（${method.permission} vs ${twin.permission}）`);
  }
  if ((twin.binaryResult === true) !== (method.binaryResult === true)) {
    throw new Error(`假桥：${name} 与 ${twinName} 的结果形状不同（binaryResult 不一致）`);
  }
  return { name: twinName, method: twin };
}

function installBridge(dataDir: string): void {
  const api = buildHostApi({ pluginId: '@test/fs', dataDir });
  (globalThis as any).__spcEnv = JSON.stringify(buildEnvFacts(dataDir));
  (globalThis as any).__host = new Proxy(
    {},
    {
      get: (_t, name: string) => (...rawArgs: unknown[]) => {
        const { method } = fakeTarget(api as any, name);
        const args = rawArgs.map((a) => {
          if (typeof a === 'string') return a;
          if (a instanceof Uint8Array) return Uint8Array.from(a);
          if (a instanceof ArrayBuffer) return Uint8Array.from(new Uint8Array(a));
          return a;
        });
        try {
          const result = method.fn(...args);
          if (method.binaryResult) {
            if (!(result instanceof Uint8Array) && !(result instanceof ArrayBuffer)) {
              throw new Error(`binaryResult 方法没返回字节：${name}`);
            }
            return result instanceof Uint8Array ? exactBytes(result) : result;
          }
          return JSON.stringify(result ?? null);
        } catch (err) {
          const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
          return JSON.stringify({ __spcError: { code: shape.code, params: shape.params } });
        }
      },
    },
  );
}

/** 与 core/sandbox.ts 的 toExactBytes 同法：整块视图直接复用，否则切出区间（不能用 Buffer#slice） */
function exactBytes(view: Uint8Array): ArrayBuffer {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer as ArrayBuffer;
  }
  return new Uint8Array(view).buffer;
}

installBridge(DATA_DIR);
const fs = await import(pathToFileURL(join(SHIM_DIR, 'node-fs.js')).href);
const fsPromises = await import(pathToFileURL(join(SHIM_DIR, 'node-fs-promises.js')).href);
const urlModule = await import(pathToFileURL(join(SHIM_DIR, 'node-url.js')).href);

/** 两边种同一棵树 */
function seed(root: string): void {
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'hello');
  writeFileSync(join(root, 'sub', 'inner.txt'), 'inner');
  writeFileSync(join(root, 'bytes.bin'), Buffer.from([0, 1, 2, 0xfe]));
  writeFileSync(join(root, 'empty.txt'), '');
  if (process.platform !== 'win32') {
    // Windows 上建软链要管理员/开发者模式（Node 的 symlink 会退化成 junction），跳过——
    // 软链相关的语义在 Linux 上单独断言（见下面"有意不同"那一组）
    symlinkSync('a.txt', join(root, 'link.txt'));
  }
}
seed(DATA_DIR);
seed(HOST_DIR);

// ──────────────────────────── 差分脚手架 ────────────────────────────

interface Outcome {
  ok: boolean;
  value?: unknown;
  code?: string;
  errno?: number;
  syscall?: string;
  message?: string;
}

/**
 * 把结果归一成"可比较"的形状：
 *   · Buffer/Uint8Array → hex（两边的 Buffer 不是同一个类，`instanceof` 比不了）
 *   · Stats/Dirent → 只留**平台无关且稳定**的字段（`ino`/`dev`/`mode`/时间戳在 Windows 与 Linux 上本就不同）
 *   · 路径字符串 → 根换成占位符（两边的根不同）、Windows 的 `\\?\` 长路径前缀剥掉
 *   · 浮点（mtimeMs）留 3 位（两次 stat 的亚毫秒差不是我们要测的东西）
 */
function normalize(value: unknown, root: string): unknown {
  if (value === undefined) return undefined;
  if (ArrayBuffer.isView(value)) return `bytes:${Buffer.from(value as Uint8Array).toString('hex')}`;
  if (Array.isArray(value)) return value.map((v) => normalize(v, root));
  if (typeof value === 'string') {
    const noLongPath = value.startsWith('\\\\?\\') ? value.slice(4) : value;
    return noLongPath.split(root).join('<root>');
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && !Number.isInteger(value)) return Math.round(value * 1000) / 1000;
  if (value && typeof value === 'object') {
    const anyValue = value as any;
    if (typeof anyValue.isFile === 'function') {
      const kind = anyValue.isFile()
        ? 'file'
        : anyValue.isDirectory()
          ? 'dir'
          : anyValue.isSymbolicLink()
            ? 'link'
            : 'other';
      // Stats 有 size，Dirent 只有 name
      return 'size' in anyValue ? { kind, size: anyValue.size } : { name: String(anyValue.name), kind };
    }
  }
  return value;
}

function capture(fn: () => unknown, root: string): Outcome {
  try {
    return { ok: true, value: normalize(fn(), root) };
  } catch (err: any) {
    return {
      ok: false,
      code: err?.code ?? err?.name,
      errno: typeof err?.errno === 'number' ? err.errno : undefined,
      syscall: err?.syscall,
      // 错误文案里也有根路径，同样归一（两边根不同，不归一没法比）
      message: typeof err?.message === 'string' ? normalize(err.message, root) as string : undefined,
    };
  }
}

interface Case {
  name: string;
  /** 同一个动作跑两遍：`root` 是这一侧的作用域根 */
  run: (f: any, root: string) => unknown;
  /** true = 有意与 Node 不同：只跑我们这一侧 */
  oursOnly?: boolean;
  /** true = 只在 Linux 上跟宿主比（Windows 宿主的 errno/文案/权限模型不同） */
  linuxOnly?: boolean;
}

const cases: Case[] = [
  // ── 读 ──
  { name: 'readFileSync utf8', run: (f, r) => f.readFileSync(join(r, 'a.txt'), 'utf8') },
  { name: 'readFileSync 默认（Buffer）', run: (f, r) => f.readFileSync(join(r, 'a.txt')) },
  { name: 'readFileSync {encoding}', run: (f, r) => f.readFileSync(join(r, 'a.txt'), { encoding: 'utf8' }) },
  { name: 'readFileSync hex', run: (f, r) => f.readFileSync(join(r, 'bytes.bin'), 'hex') },
  { name: 'readFileSync base64', run: (f, r) => f.readFileSync(join(r, 'bytes.bin'), 'base64') },
  { name: 'readFileSync latin1', run: (f, r) => f.readFileSync(join(r, 'bytes.bin'), 'latin1') },
  { name: 'readFileSync {flag:r}', run: (f, r) => f.readFileSync(join(r, 'a.txt'), { encoding: 'utf8', flag: 'r' }) },
  { name: 'readFileSync 空文件', run: (f, r) => f.readFileSync(join(r, 'empty.txt'), 'utf8') },
  { name: 'readFileSync Buffer 路径', run: (f, r) => f.readFileSync(Buffer.from(join(r, 'a.txt')), 'utf8') },
  { name: 'readFileSync 不存在', run: (f, r) => f.readFileSync(join(r, 'nope.txt'), 'utf8') },
  { name: 'readFileSync 父目录不存在', run: (f, r) => f.readFileSync(join(r, 'no', 'such', 'x.txt')) },
  { name: 'readFileSync 目录', run: (f, r) => f.readFileSync(join(r, 'sub'), 'utf8') },
  { name: 'readFileSync 编码非法', run: (f, r) => f.readFileSync(join(r, 'a.txt'), 'zzz') },
  { name: 'readFileSync {encoding:buffer}', run: (f, r) => f.readFileSync(join(r, 'a.txt'), { encoding: 'buffer' }) },
  { name: 'readFileSync 旗标非法', run: (f, r) => f.readFileSync(join(r, 'a.txt'), { flag: 'zzz' }) },
  { name: 'readFileSync 无参数', run: (f) => f.readFileSync() },

  // ── 写 ──
  { name: 'writeFileSync 字符串', run: (f, r) => (f.writeFileSync(join(r, 'new.txt'), 'abc'), f.readFileSync(join(r, 'new.txt'), 'utf8')) },
  { name: 'writeFileSync Buffer', run: (f, r) => (f.writeFileSync(join(r, 'n2.bin'), Buffer.from([1, 2, 3])), f.readFileSync(join(r, 'n2.bin'), 'hex')) },
  { name: 'writeFileSync Uint8Array 视图（只写子区间）', run: (f, r) => { const u = new Uint8Array([9, 8, 7, 6]); f.writeFileSync(join(r, 'n3.bin'), u.subarray(1, 3)); return f.readFileSync(join(r, 'n3.bin'), 'hex'); } },
  { name: 'writeFileSync 裸 ArrayBuffer 被拒（Node 也是）', run: (f, r) => f.writeFileSync(join(r, 'n4.bin'), new Uint8Array([4, 5]).buffer) },
  { name: 'writeFileSync 编码', run: (f, r) => (f.writeFileSync(join(r, 'n5.txt'), 'hé', 'latin1'), f.readFileSync(join(r, 'n5.txt'), 'hex')) },
  { name: 'writeFileSync 覆盖', run: (f, r) => (f.writeFileSync(join(r, 'a.txt'), 'xy'), f.readFileSync(join(r, 'a.txt'), 'utf8')) },
  { name: 'writeFileSync {flag:a} 追加', run: (f, r) => (f.writeFileSync(join(r, 'app.txt'), 'a'), f.writeFileSync(join(r, 'app.txt'), 'b', { flag: 'a' }), f.readFileSync(join(r, 'app.txt'), 'utf8')) },
  { name: 'appendFileSync', run: (f, r) => (f.appendFileSync(join(r, 'app2.txt'), 'x'), f.appendFileSync(join(r, 'app2.txt'), 'y'), f.readFileSync(join(r, 'app2.txt'), 'utf8')) },
  { name: 'writeFileSync {flag:wx} 已存在', run: (f, r) => f.writeFileSync(join(r, 'a.txt'), 'z', { flag: 'wx' }) },
  { name: 'writeFileSync {flag:wx} 新文件', run: (f, r) => (f.writeFileSync(join(r, 'wx.txt'), 'z', { flag: 'wx' }), f.readFileSync(join(r, 'wx.txt'), 'utf8')) },
  { name: 'writeFileSync 旗标非法', run: (f, r) => f.writeFileSync(join(r, 'a.txt'), 'z', { flag: 'zzz' }) },
  { name: 'writeFileSync 编码非法', run: (f, r) => f.writeFileSync(join(r, 'a.txt'), 'z', { encoding: 'zzz' }) },
  { name: 'writeFileSync 数据类型错', run: (f, r) => f.writeFileSync(join(r, 'a.txt'), 42) },
  { name: 'writeFileSync 父目录不存在', run: (f, r) => f.writeFileSync(join(r, 'no', 'such', 'x.txt'), 'v') },

  // ── stat / lstat ──
  { name: 'statSync 文件', run: (f, r) => f.statSync(join(r, 'a.txt')) },
  { name: 'statSync 目录', run: (f, r) => f.statSync(join(r, 'sub')) },
  { name: 'statSync 不存在', run: (f, r) => f.statSync(join(r, 'nope.txt')) },
  { name: 'statSync {throwIfNoEntry:false}', run: (f, r) => f.statSync(join(r, 'nope.txt'), { throwIfNoEntry: false }) },
  { name: 'statSync 非对象 options 被忽略', run: (f, r) => f.statSync(join(r, 'a.txt'), 'zzz').size },
  { name: 'statSync 类型与 Date 形状', run: (f, r) => { const s = f.statSync(join(r, 'a.txt')); return [typeof s.size, typeof s.mtimeMs, s.atime instanceof Date, s.mtime instanceof Date, Number.isInteger(s.size)]; } },
  { name: 'statSync 自有键', run: (f, r) => Object.keys(f.statSync(join(r, 'a.txt'))) },
  { name: 'statSync 是文件/是目录', run: (f, r) => [f.statSync(join(r, 'a.txt')).isFile(), f.statSync(join(r, 'sub')).isDirectory()] },
  { name: 'lstatSync 普通文件', run: (f, r) => f.lstatSync(join(r, 'a.txt')) },
  { name: 'lstatSync 不存在', run: (f, r) => f.lstatSync(join(r, 'nope.txt')) },

  // ── readdir ──
  { name: 'readdirSync', run: (f, r) => f.readdirSync(join(r, 'sub')).sort() },
  { name: 'readdirSync {withFileTypes}', run: (f, r) => f.readdirSync(join(r, 'sub'), { withFileTypes: true }).map((d: any) => `${d.name}:${d.isFile() ? 'f' : d.isDirectory() ? 'd' : 'o'}`).sort() },
  { name: 'readdirSync buffer', run: (f, r) => f.readdirSync(join(r, 'sub'), 'buffer').map((b: any) => Buffer.from(b).toString('hex')).sort() },
  { name: 'readdirSync 不存在', run: (f, r) => f.readdirSync(join(r, 'nope')) },
  { name: 'readdirSync 是文件', run: (f, r) => f.readdirSync(join(r, 'a.txt')) },
  { name: 'readdirSync 空目录', run: (f, r) => { mkdirSync(join(r, 'empty-dir'), { recursive: true }); return f.readdirSync(join(r, 'empty-dir')); } },

  // ── mkdir / mkdtemp ──
  { name: 'mkdirSync 新目录', run: (f, r) => { f.mkdirSync(join(r, 'm1')); return f.statSync(join(r, 'm1')).isDirectory(); } },
  { name: 'mkdirSync 已存在', run: (f, r) => f.mkdirSync(join(r, 'sub')) },
  { name: 'mkdirSync 父目录不存在', run: (f, r) => f.mkdirSync(join(r, 'no', 'such')) },
  { name: 'mkdirSync {recursive:true} 深链', run: (f, r) => f.mkdirSync(join(r, 'm2', 'm3', 'm4'), { recursive: true }) },
  { name: 'mkdirSync {recursive:true} 已存在', run: (f, r) => f.mkdirSync(join(r, 'sub'), { recursive: true }) },
  { name: 'mkdirSync {recursive:true} 目标是文件', run: (f, r) => f.mkdirSync(join(r, 'a.txt'), { recursive: true }) },
  { name: 'mkdirSync 返回值（非 recursive）', run: (f, r) => f.mkdirSync(join(r, 'm5')) },
  { name: 'mkdtempSync 前缀', run: (f, r) => f.mkdtempSync(join(r, 'tmp-')).startsWith(join(r, 'tmp-')) },
  { name: 'mkdtempSync 父目录不存在', run: (f, r) => f.mkdtempSync(join(r, 'nodir', 'p-')) },

  // ── 删 / 改名 / 拷贝 ──
  { name: 'rmSync 文件', run: (f, r) => { f.writeFileSync(join(r, 'd1.txt'), 'x'); f.rmSync(join(r, 'd1.txt')); return f.existsSync(join(r, 'd1.txt')); } },
  { name: 'rmSync 不存在', run: (f, r) => f.rmSync(join(r, 'nope.txt')) },
  { name: 'rmSync 不存在 {force:true}', run: (f, r) => (f.rmSync(join(r, 'nope.txt'), { force: true }), 'no-throw') },
  { name: 'rmSync 目录（无 recursive）', run: (f, r) => { mkdirSync(join(r, 'd2'), { recursive: true }); return f.rmSync(join(r, 'd2')); } },
  { name: 'rmSync 目录 {recursive:true}', run: (f, r) => { mkdirSync(join(r, 'd3', 'd4'), { recursive: true }); f.rmSync(join(r, 'd3'), { recursive: true }); return f.existsSync(join(r, 'd3')); } },
  { name: 'rmdirSync 空目录', run: (f, r) => { mkdirSync(join(r, 'd5'), { recursive: true }); f.rmdirSync(join(r, 'd5')); return f.existsSync(join(r, 'd5')); } },
  { name: 'rmdirSync 不存在', run: (f, r) => f.rmdirSync(join(r, 'nope')) },
  { name: 'rmdirSync 非空', run: (f, r) => f.rmdirSync(join(r, 'sub')) },
  { name: 'rmdirSync 是文件', run: (f, r) => f.rmdirSync(join(r, 'a.txt')) },
  { name: 'unlinkSync 文件', run: (f, r) => { f.writeFileSync(join(r, 'd6.txt'), 'x'); f.unlinkSync(join(r, 'd6.txt')); return f.existsSync(join(r, 'd6.txt')); } },
  { name: 'unlinkSync 不存在', run: (f, r) => f.unlinkSync(join(r, 'nope.txt')) },
  // Windows 宿主对"unlink 目录"给 EPERM，Linux 给 EISDIR —— 我们的基线是 Linux（EISDIR 在下一条里断言）
  { name: 'unlinkSync 目录', linuxOnly: true, run: (f, r) => { mkdirSync(join(r, 'd7'), { recursive: true }); return f.unlinkSync(join(r, 'd7')); } },
  { name: 'renameSync', run: (f, r) => { f.writeFileSync(join(r, 'r1.txt'), 'v'); f.renameSync(join(r, 'r1.txt'), join(r, 'r2.txt')); return f.readFileSync(join(r, 'r2.txt'), 'utf8'); } },
  { name: 'renameSync 源不存在', run: (f, r) => f.renameSync(join(r, 'nope.txt'), join(r, 'z.txt')) },
  { name: 'renameSync 目标目录不存在', run: (f, r) => f.renameSync(join(r, 'a.txt'), join(r, 'no', 'z.txt')) },
  { name: 'copyFileSync', run: (f, r) => { f.copyFileSync(join(r, 'a.txt'), join(r, 'c1.txt')); return f.readFileSync(join(r, 'c1.txt'), 'utf8'); } },
  { name: 'copyFileSync 源不存在', run: (f, r) => f.copyFileSync(join(r, 'nope.txt'), join(r, 'c2.txt')) },
  { name: 'copyFileSync COPYFILE_EXCL 已存在', run: (f, r) => f.copyFileSync(join(r, 'a.txt'), join(r, 'a.txt'), HOST_FS_CONSTANTS.COPYFILE_EXCL) },
  { name: 'copyFileSync mode 是对象', run: (f, r) => f.copyFileSync(join(r, 'a.txt'), join(r, 'c3.txt'), { mode: 1 }) },

  // ── realpath / access / exists ──
  { name: 'realpathSync 已存在', run: (f, r) => f.realpathSync(join(r, 'a.txt')).length > 0 },
  { name: 'realpathSync 不存在', run: (f, r) => f.realpathSync(join(r, 'nope.txt')) },
  { name: 'realpathSync.native 存在', run: (f) => typeof f.realpathSync.native },
  { name: 'accessSync 存在', run: (f, r) => (f.accessSync(join(r, 'a.txt')), 'no-throw') },
  { name: 'accessSync 不存在', run: (f, r) => f.accessSync(join(r, 'nope.txt')) },
  { name: 'accessSync mode 不是数字', run: (f, r) => f.accessSync(join(r, 'a.txt'), '4') },
  { name: 'accessSync mode null', run: (f, r) => (f.accessSync(join(r, 'a.txt'), null), 'no-throw') },
  { name: 'existsSync 存在/不存在', run: (f, r) => [f.existsSync(join(r, 'a.txt')), f.existsSync(join(r, 'nope.txt'))] },
  // chmod：唯一做掉的元数据写（见 hostApi 的 fs.chmod 注释）。只比**权限位低位**（高位文件类型位两平台同）
  { name: 'chmodSync 改权限位（stat.mode 低位可见）', run: (f, r) => { const p = join(r, 'mode.txt'); f.writeFileSync(p, 'x'); f.chmodSync(p, 0o600); return (f.statSync(p).mode & 0o777).toString(8); } },
  { name: 'chmodSync 回调形态存在', run: (f, r) => { const p = join(r, 'mode2.txt'); f.writeFileSync(p, 'x'); return typeof f.chmod === 'function'; }, oursOnly: true },
  { name: 'existsSync 非法参数不抛', run: (f) => f.existsSync(undefined) },

  // ── 形状 / 常量（我们自己的判据，宿主上不一定同名同值）──
  { name: 'constants 键值（Linux 真值）', oursOnly: true, run: (f) => [f.constants.O_RDONLY, f.constants.F_OK, f.constants.COPYFILE_EXCL, f.constants.S_IFMT].join('/') },
  { name: '顶层 F_OK/R_OK/W_OK/X_OK', oursOnly: true, run: (f) => [f.F_OK, f.R_OK, f.W_OK, f.X_OK].join('/') },
  { name: 'Dirent 自有键与原型方法', oursOnly: true, run: (f, r) => { const d = f.readdirSync(join(r, 'sub'), { withFileTypes: true })[0]; return [Object.keys(d).sort().join(','), Object.getOwnPropertyNames(Object.getPrototypeOf(d)).sort().join(',')]; } },
  { name: 'Dirent.parentPath 是调用方传的路径', oursOnly: true, run: (f, r) => f.readdirSync(join(r, 'sub'), { withFileTypes: true })[0].parentPath === join(r, 'sub') },
  { name: 'Stats 无 toJSON（同 Node）', oursOnly: true, run: (f, r) => typeof f.statSync(join(r, 'a.txt')).toJSON },
];

describe('仿真 node:fs —— 与宿主 Node 差分对跑', () => {
  for (const c of cases) {
    const skip = c.linuxOnly === true && process.platform === 'win32' ? '该错误码在 Windows 宿主上是另一套（Linux 真值在"有意不同"一组里断言）' : false;
    it(c.name, { skip }, () => {
      const ours = capture(() => c.run(fs, DATA_DIR), DATA_DIR);
      if (c.oursOnly) {
        assert.equal(ours.ok, true, `${c.name}：我们这边不该失败（${ours.code} ${ours.message ?? ''}）`);
        return;
      }
      const theirs = capture(() => c.run(hostFs, HOST_DIR), HOST_DIR);
      assert.equal(
        ours.ok,
        theirs.ok,
        `${c.name}：成功/失败的结论不一致——我们 ${ours.ok ? 'ok' : ours.code}，宿主 ${theirs.ok ? 'ok' : theirs.code}`,
      );
      if (theirs.ok) {
        assert.deepEqual(ours.value, theirs.value, `${c.name}：返回值不一致`);
      } else {
        // code / syscall 是平台无关的，必须逐条一致
        assert.equal(ours.code, theirs.code, `${c.name}：错误码不一致`);
        assert.equal(ours.syscall, theirs.syscall, `${c.name}：syscall 不一致`);
        // errno 与文案是 **Linux 真值**：宿主不是 Linux 时只断言我们自己的值（见文件头判卷人 2）。
        // 参数校验类错误（Node 的 `ERR_*` 契约码）**本来就没有 errno**，别拿"应当是数字"去卡它们——
        // 例外是 `ERR_FS_EISDIR`：它是 Node 的 SystemError 形状，**带正的 errno 21**（WSL 实测）。
        const isErrnoError =
          typeof ours.code === 'string' && (!ours.code.startsWith('ERR_') || ours.code === 'ERR_FS_EISDIR');
        if (process.platform === 'linux') {
          assert.equal(ours.errno, theirs.errno, `${c.name}：errno 不一致`);
          assert.equal(ours.message, theirs.message, `${c.name}：message 不一致`);
        } else if (isErrnoError) {
          assert.equal(typeof ours.errno, 'number', `${c.name}：errno 应当是数字`);
        } else {
          assert.equal(ours.errno, undefined, `${c.name}：Node 契约码不该带 errno`);
        }
      }
    });
  }
});

// ──────────────────────────── 有意不同 / Linux 真值 ────────────────────────────

describe('仿真 node:fs —— 有意与 Node 不同的地方（结构性断言）', () => {
  it('errno 与文案用 **Linux 真值**（开发机是 Windows，宿主的 -4058/另一套文案不是判卷人）', () => {
    // 出处：tools/truth/data/fs-url-truth.json（WSL node v22.22.1 实测）
    const table: Array<[() => void, string, number, string]> = [
      [() => fs.readFileSync(join(DATA_DIR, 'nope.txt')), 'ENOENT', -2, 'no such file or directory'],
      [() => fs.readdirSync(join(DATA_DIR, 'a.txt')), 'ENOTDIR', -20, 'not a directory'],
      [() => fs.mkdirSync(join(DATA_DIR, 'sub')), 'EEXIST', -17, 'file already exists'],
      [() => fs.rmdirSync(join(DATA_DIR, 'sub')), 'ENOTEMPTY', -39, 'directory not empty'],
      [() => fs.unlinkSync(join(DATA_DIR, 'sub')), 'EISDIR', -21, 'illegal operation on a directory'],
      [() => fs.rmSync(join(DATA_DIR, 'big-dir-for-eisdir'), { recursive: true }), 'ENOENT', -2, 'no such file or directory'],
    ];
    for (const [run, code, errno, text] of table) {
      const out = capture(run, DATA_DIR);
      assert.equal(out.ok, false);
      assert.equal(out.code, code);
      assert.equal(out.errno, errno, `${code} 的 errno 应当是 Linux 真值 ${errno}`);
      assert.match(out.message ?? '', new RegExp(`^${code}: ${text}, `));
    }
    // `rmSync(目录)` 不给 recursive 时 Node 抛的是**非 errno** 的 SystemError（WSL 实测）
    const e: any = (() => {
      try {
        fs.rmSync(join(DATA_DIR, 'sub'));
      } catch (err) {
        return err;
      }
    })();
    assert.equal(e.name, 'SystemError');
    assert.equal(e.code, 'ERR_FS_EISDIR');
    assert.equal(e.errno, 21, 'ERR_FS_EISDIR 的 errno 是**正的** 21（与其它错误的负值约定不同）');
    assert.equal(e.syscall, 'rm');
    assert.equal(e.message, `Path is a directory: rm returned EISDIR (is a directory) ${join(DATA_DIR, 'sub')}`);
  });

  it('路径越界 → EACCES，且 spcCode 保留宿主原始码（对外像 POSIX，对内不丢信息）', () => {
    for (const p of ['../escape.txt', join(OUTSIDE, 'x.txt'), '../../etc/passwd']) {
      const err: any = (() => {
        try {
          fs.readFileSync(p);
        } catch (e) {
          return e;
        }
      })();
      assert.equal(err?.code, 'EACCES', `${p} 应当报 EACCES（拿到 ${err?.code}）`);
      assert.ok(
        err.spcCode === 'PATH_OUT_OF_SCOPE' || err.spcCode === 'PARENT_ESCAPE' || err.spcCode === 'SYMLINK_ESCAPE',
        `spcCode 应当说明越界原因（拿到 ${err.spcCode}）`,
      );
      assert.equal(err.path, p, 'err.path 应当是**调用方传的那个字符串**（Node 的语义）');
      assert.equal(err.params.path.length > 0, true, 'params 里带着收敛后的路径（排障用）');
    }
  });

  it('写路径越界同样 EACCES（父目录在作用域外也不行）', () => {
    const err: any = (() => {
      try {
        fs.writeFileSync(join(OUTSIDE, 'x.txt'), 'v');
      } catch (e) {
        return e;
      }
    })();
    assert.equal(err.code, 'EACCES');
    assert.equal(err.spcCode, 'PATH_OUT_OF_SCOPE');
  });

  it('软链：**解析成目标**（F2/F5 的必然结果），悬空软链给 ELOOP', { skip: process.platform === 'win32' ? '只在 Linux 上跑（Windows 建软链要特权）' : false }, () => {
    // 有意与 Node 不同：Node 的 unlink(软链) 删链接本身，我们的路径收敛（F2/F5）会把软链解析成目标。
    // 本批不支持创建软链，能出现的软链只有外部放进来的，所以这是"已知边界"。
    // **补偿能力**：`readdirSync(withFileTypes)` 的 Dirent 带 `kind`（不经过收敛），能认出软链：
    symlinkSync('a.txt', join(DATA_DIR, 'rmlink.txt'));
    const linkDirent = (fs.readdirSync(DATA_DIR, { withFileTypes: true }) as any[]).find((d) => d.name === 'rmlink.txt');
    assert.equal(linkDirent.isSymbolicLink(), true, 'Dirent 应当能认出软链（readdir 不做收敛）');
    fs.unlinkSync(join(DATA_DIR, 'rmlink.txt'));
    assert.equal(fs.existsSync(join(DATA_DIR, 'a.txt')), false, '我们的语义是删掉目标（已在文件头写明）');
    assert.equal(fs.existsSync(join(DATA_DIR, 'rmlink.txt')), false);
    symlinkSync('gone.txt', join(DATA_DIR, 'dangling.txt'));
    const err: any = (() => {
      try {
        fs.readFileSync(join(DATA_DIR, 'dangling.txt'));
      } catch (e) {
        return e;
      }
    })();
    assert.equal(err.code, 'ELOOP', `悬空软链应当 fail-closed 给 ELOOP（拿到 ${err.code}）`);
    assert.equal(err.spcCode, 'SYMLINK_DANGLING');
  });

  it('大小上限是硬的：读 1 MiB（超限 EFBIG，不是让 VM 爆内存）', () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 0x61);
    fs.writeFileSync(join(DATA_DIR, 'big.bin'), big);
    const err: any = (() => {
      try {
        fs.readFileSync(join(DATA_DIR, 'big.bin'));
      } catch (e) {
        return e;
      }
    })();
    assert.equal(err.code, 'EFBIG');
    assert.equal(err.spcCode, 'FILE_TOO_LARGE');
    assert.equal(fs.statSync(join(DATA_DIR, 'big.bin')).size, big.byteLength);
    fs.unlinkSync(join(DATA_DIR, 'big.bin'));
  });

  it('**同步 fd 面已支持**；回调 / 向量 / 流 / watch / 元数据面仍**响亮抛错**', () => {
    // 2026-09-21：同步 fd 面接上了真 OS 资源（句柄模型），所以它**不在**"抛错"名单里了。
    // 这条用例同时钉住两半：支持的那半是**函数且真的能用**（下面单独验），不支持的那半必须明确抛错。
    const supportedSyncFd = ['openSync', 'closeSync', 'readSync', 'writeSync', 'fstatSync', 'ftruncateSync', 'fsyncSync'];
    const supportedCallbackFd = ['open', 'close', 'read', 'write', 'fstat', 'ftruncate', 'fsync'];
    for (const name of [...supportedSyncFd, ...supportedCallbackFd]) {
      assert.equal(typeof (fs as any)[name], 'function', `${name} 应当是函数`);
      assert.equal(typeof (hostFs as any)[name], 'function', `对照：宿主上 ${name} 也在`);
    }
    // `fs.promises.open` 返回 FileHandle（不再抛错），但它的**流式/向量/元数据**那些方法仍在"明确抛错"名单里
    assert.equal(typeof (fsPromises as any).open, 'function');
    assert.equal(typeof (hostFsp as any).open, 'function', '对照：宿主上 fs/promises.open 也在');
    const stillStubbed = [
      'fdatasync', 'fdatasyncSync', 'readv', 'readvSync', 'writev', 'writevSync',
      'createReadStream', 'createWriteStream', 'watch', 'watchFile', 'unwatchFile',
      'symlinkSync', 'linkSync', 'readlinkSync', 'fchmodSync', 'chownSync', 'utimesSync',
      'opendirSync', 'statfsSync', 'cpSync', 'globSync', 'truncateSync',
    ];
    for (const name of stillStubbed) {
      assert.equal(typeof (fs as any)[name], 'function', `${name} 应当是函数（不能是 undefined）`);
      const err: any = (() => {
        try {
          (fs as any)[name]('x');
        } catch (e) {
          return e;
        }
      })();
      assert.equal(err?.code, 'ERR_NOT_SUPPORTED_IN_SANDBOX', `${name} 应当明确抛错（拿到 ${err?.code}）`);
      // 对照：宿主上它是真的可用的，所以这是**有意**的缺失（不是抄漏了）
      assert.equal(typeof (hostFs as any)[name], 'function', `对照：宿主上 ${name} 也在`);
    }
  });

  it('fd 面（同步）语义与宿主一致：写入/按位置读/追加/EOF/fstat/ftruncate/EBADF', () => {
    // 差分对象是**宿主 Node**（同一套操作喂两边比结果）—— 与其余 fs 用例同一路数。
    const runs: Array<{ ours: unknown; host: unknown }> = [];
    const both = (fn: (f: typeof fs, dir: string) => unknown) => {
      runs.push({ ours: fn(fs, DATA_DIR), host: fn(hostFs as unknown as typeof fs, HOST_DIR) });
    };
    both((f, dir) => {
      const p = join(dir, 'fd-a.txt');
      const fd = f.openSync(p, 'w');
      const n = f.writeSync(fd, 'hello');
      f.writeSync(fd, ' world');
      f.closeSync(fd);
      const rfd = f.openSync(p, 'r');
      const buf = Buffer.alloc(5);
      const read1 = f.readSync(rfd, buf, 0, 5, 0);
      const read2 = f.readSync(rfd, buf, 0, 5, 6);
      const eof = f.readSync(rfd, buf, 0, 5, 999);
      const size = f.fstatSync(rfd).size;
      f.closeSync(rfd);
      return { n, read1, read2, eof, size, first: buf.toString(), second: buf.toString() };
    });
    both((f, dir) => {
      // 追加旗标 + 位置为空（用当前偏移）+ ftruncate。
      // ⚠️ 截断要用**可写 fd**（'r+'）：Windows 上对**追加模式**的 fd 做 ftruncate 会 `EPERM`
      // （实测踩到 —— 那是真语义，不是仿真的锅）。
      const p = join(dir, 'fd-b.txt');
      const afd = f.openSync(p, 'a');
      f.writeSync(afd, 'abcdef');
      f.writeSync(afd, Buffer.from('XY'), 0, 2, 1);
      f.closeSync(afd);
      const rfd = f.openSync(p, 'r+');
      f.ftruncateSync(rfd, 5);
      const size = f.fstatSync(rfd).size;
      f.fsyncSync(rfd);
      f.closeSync(rfd);
      return { size, text: f.readFileSync(p, 'utf8') };
    });
    both((f, dir) => {
      // 错误面：只读 fd 上写 / 方向不符 / 关了再用 / 二次关 / 未知编号 / 非法旗标 / 越界参数。
      // 每条都**被 catch 住**再比（不然第一条例外就把用例掀了 —— 踩过）。
      const cap = (fn: () => unknown) => {
        try {
          fn();
          return 'no-throw';
        } catch (e: any) {
          return `${e.code}/${e.syscall ?? '-'}`;
        }
      };
      const rfd = f.openSync(join(dir, 'a.txt'), 'r');
      const wfd = f.openSync(join(dir, 'fd-c.txt'), 'w');
      const out = {
        writeOnReadOnly: cap(() => f.writeSync(rfd, 'x')),
        readOnWriteOnly: cap(() => f.readSync(wfd, Buffer.alloc(1), 0, 1, 0)),
        offsetOutOfRange: cap(() => f.readSync(rfd, Buffer.alloc(4), 3, 4, 0)),
        badFlag: cap(() => f.openSync(join(dir, 'fd-d.txt'), 'zzz')),
        missing: cap(() => f.openSync(join(dir, 'nope.txt'), 'r')),
        closeUnknown: cap(() => f.closeSync(999999)),
        closeTwice: cap(() => {
          f.closeSync(wfd);
          f.closeSync(wfd);
          return 'second-ok';
        }),
        readAfterClose: cap(() => f.readSync(rfd, Buffer.alloc(1), 0, 1, 0)),
      };
      f.closeSync(rfd);
      return out;
    });
    for (const pair of runs) {
      assert.deepEqual(pair.ours, pair.host, `fd 面与宿主不一致：${JSON.stringify(pair)}`);
    }
    // ⚠️ 有意不同（**不进差分**）：本仿真不做 BigIntStats ⇒ `{ bigint: true }` 明确抛错，宿主则能用。
    assert.equal(
      capture(() => fs.fstatSync(3, { bigint: true }), DATA_DIR).code,
      'ERR_NOT_SUPPORTED_IN_SANDBOX',
    );
  });

  it('回调式 fd 面：与宿主同形（error-first、回调异步触发、写到同一文件）', async () => {
    // 差分对象仍是宿主 Node：同一串回调操作喂两边，比**回调参数**与**文件结果**。
    // 回调面在沙箱里由 queueMicrotask 派发（Node 是线程池）—— 两边都保证"回调不在同一 tick"。
    const run = (f: typeof fs, dir: string) =>
      new Promise<unknown>((resolve, reject) => {
        const p = join(dir, 'cb-fd.txt');
        const seen: string[] = [];
        let sameTick = false;
        f.open(p, 'w', (err: any, fd: any) => {
          if (err) return reject(err);
          seen.push('open:' + typeof fd);
          if (!sameTick) seen.push('open-ASYNC');
          f.write(fd, 'hello', (err2: any, written: any) => {
            if (err2) return reject(err2);
            seen.push('write:' + written);
            f.close(fd, (err3: any) => {
              if (err3) return reject(err3);
              seen.push('close:' + (err3 === undefined || err3 === null));
              // 关了再用 ⇒ error-first 回调拿 EBADF（而不是抛）
              f.read(fd, Buffer.alloc(1), 0, 1, 0, (err4: any) => {
                seen.push('read-closed:' + (err4 && err4.code) + '/' + (err4 && err4.syscall));
                // 未知编号同理
                f.close(999999, (err5: any) => {
                  seen.push('close-unknown:' + (err5 && err5.code));
                  resolve({ seen, text: f.readFileSync(p, 'utf8') });
                });
              });
            });
          });
        });
        sameTick = true; // 到这一行说明上面那个回调**不是**同步触发的（Node 的硬保证）
      });
    const ours = await run(fs, DATA_DIR);
    const host = await run(hostFs as unknown as typeof fs, HOST_DIR);
    assert.deepEqual(ours, host, `回调 fd 面与宿主不一致：${JSON.stringify({ ours, host })}`);
  });

  it('FileHandle（fs.promises.open）：与宿主同形（重载 / 位置语义 / 关闭语义 / 错误码）', async () => {
    // 差分对象 = 宿主 Node 的 `fs/promises.open`。两边喂**同一串动作**，只比"可观察值"：
    // 返回对象的形状（null 原型 / 键 / buffer 长度）、字节数、文件内容、错误的 code+syscall。
    // ⚠️ 不比 fd 的**数值**（那是各自的编号空间）——只比类型与"关闭后是 -1"。
    // ⚠️ 浮点 length 的用例**不能**放进来：Node 自己会 abort（见下面"有意不同"那条），这里只放两边都不崩的面。
    const scenario = async (api: { fs: any; fsp: any }, dir: string) => {
      const r: Record<string, unknown> = {};
      const cap = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return 'NO-THROW';
        } catch (e: any) {
          return [e.code, e.syscall ?? '-'].join('/');
        }
      };
      const capClosed = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return 'NO-THROW';
        } catch (e: any) {
          return [e.code, e.syscall ?? '-', e.message].join('/');
        }
      };
      const res = (x: any) => ({
        keys: Object.keys(x).sort(),
        protoNull: Object.getPrototypeOf(x) === null,
        bytesRead: x.bytesRead,
        bytesWritten: x.bytesWritten,
        bufferLen: x.buffer ? x.buffer.byteLength : null,
        bufferType: typeof x.buffer,
      });

      // ── 读：三种重载 + 位置语义 ──
      const p = join(dir, 'fh-a.txt');
      api.fs.writeFileSync(p, '0123456789');
      const fh = await api.fsp.open(p, 'r+');
      r.fdType = typeof fh.fd;
      r.ctor = fh.constructor.name;
      r.ownKeys = Object.keys(fh).sort();
      r.closeType = typeof fh.close;
      r.extendable = (() => {
        fh.tag = 1;
        return fh.tag;
      })();
      const b8 = Buffer.alloc(8);
      r.readPositional = { ...res(await fh.read(b8, 1, 5, 0)), text: b8.toString('latin1') };
      r.readOptionsAlloc = res(await fh.read({ length: 3 }));
      r.readBufferOptions = res(await fh.read(Buffer.alloc(6), { offset: 2, length: 3, position: 0 }));
      r.readZeroLength = res(await fh.read(Buffer.alloc(4), 0, 0, 0));
      r.readNoArgs = res(await fh.read());
      r.readPastEof = res(await fh.read(Buffer.alloc(4), 0, 4, 999));
      r.readOffsetOnly = res(await fh.read(Buffer.alloc(4), 2));
      r.readInvalid = {
        lenTooBig: await cap(() => fh.read(Buffer.alloc(4), 3, 4, 0)),
        negOffset: await cap(() => fh.read(Buffer.alloc(4), -1, 1, 0)),
        floatOffset: await cap(() => fh.read(Buffer.alloc(4), 0.5, 1, 0)),
        stringOffset: await cap(() => fh.read(Buffer.alloc(4), '0', 2, 0)),
        badPosition: await cap(() => fh.read(Buffer.alloc(4), 0, 2, -3)),
        emptyBuffer: await cap(() => fh.read(Buffer.alloc(0), 0, 1)),
        stringAsOptions: await cap(() => fh.read('x')),
        badBufferInOptions: await cap(() => fh.read({ buffer: 'x' })),
      };
      await fh.close();

      // ── 写：字符串 / 字节两族重载 + **显式位置不动文件偏移** ──
      const pw = join(dir, 'fh-w.txt');
      api.fs.writeFileSync(pw, '0123456789');
      const fw = await api.fsp.open(pw, 'r+');
      r.writeString = res(await fw.write('XY'));
      r.afterWriteString = api.fs.readFileSync(pw, 'latin1');
      r.writeStringAtPos = res(await fw.write('ab', 4));
      r.afterWriteAtPos = api.fs.readFileSync(pw, 'latin1');
      r.writeStringNoPos = res(await fw.write('cd'));
      r.afterWriteNoPos = api.fs.readFileSync(pw, 'latin1');
      const b4 = Buffer.alloc(4).fill(0x67);
      r.writeBufferAtPos = res(await fw.write(Buffer.from('ef'), 0, 2, 8));
      r.writeBufferOptions = res(await fw.write(b4, { offset: 1, length: 2, position: 0 }));
      r.writeEmptyBuffer = res(await fw.write(Buffer.alloc(0)));
      r.writeEmptyString = res(await fw.write(''));
      r.afterAllWrites = api.fs.readFileSync(pw, 'latin1');
      r.writeInvalid = {
        number: await cap(() => fw.write(42)),
        offsetTooBig: await cap(() => fw.write(Buffer.alloc(4), 5, 1, 0)),
        lenTooBig: await cap(() => fw.write(Buffer.alloc(4), 0, 9, 0)),
        negLength: await cap(() => fw.write(Buffer.alloc(4), 0, -1, 0)),
        hexOdd: await cap(() => fw.write('abc', 0, 'hex')),
      };
      r.writeOnReadOnly = await cap(async () => {
        const ro = await api.fsp.open(p, 'r');
        try {
          return await ro.write('x');
        } finally {
          await ro.close();
        }
      });
      r.readOnWriteOnly = await cap(async () => {
        const wo = await api.fsp.open(join(dir, 'fh-wo.txt'), 'w');
        try {
          return await wo.read(Buffer.alloc(2), 0, 2, 0);
        } finally {
          await wo.close();
        }
      });
      await fw.close();

      // ── readFile / writeFile / appendFile（整文件面：都从**当前偏移**动）──
      const bufShape = (v: any) => ({
        // ⚠️ 不能比 `Buffer.isBuffer`：假桥里我们的 Buffer 来自拷贝出来的 `node-buffer.js`，
        // 与**宿主**的 Buffer 不是同一个类（真沙箱里才一致）。比"是不是 Uint8Array"与构造器名。
        isU8: v instanceof Uint8Array,
        ctor: v.constructor.name,
        len: v.byteLength,
        text: v.toString('latin1'),
      });
      const pr = join(dir, 'fh-rf.txt');
      api.fs.writeFileSync(pr, 'ABCDEFGH');
      const fr = await api.fsp.open(pr, 'r');
      r.readFile = bufShape(await fr.readFile());
      r.readFileSecond = bufShape(await fr.readFile()); // 已到 EOF ⇒ 空
      await fr.close();
      const fr2 = await api.fsp.open(pr, 'r');
      r.readFileEncoding = await fr2.readFile({ encoding: 'utf8' });
      r.readFileEncString = await fr2.readFile('utf8'); // options 直接给字符串
      r.readFileBadEncoding = await cap(() => fr2.readFile({ encoding: 'nope' }));
      r.readFileBufferSentinel = await cap(() => fr2.readFile({ encoding: 'buffer' }));
      r.readFileBadOptions = await cap(() => fr2.readFile(5));
      await fr2.close();
      const fr3 = await api.fsp.open(pr, 'r');
      r.readFilePartialThenRest = await (async () => {
        const head = await fr3.read(Buffer.alloc(3), 0, 3, null); // 推进偏移到 3
        const rest = await fr3.readFile();
        return { head: head.bytesRead, rest: rest.toString('latin1') };
      })();
      await fr3.close();

      const pwf = join(dir, 'fh-wf.txt');
      api.fs.writeFileSync(pwf, '0123456789');
      const fw2 = await api.fsp.open(pwf, 'r+');
      r.writeFileResult = String(await fw2.writeFile('XY'));
      r.afterWriteFile = api.fs.readFileSync(pwf, 'latin1');
      await fw2.read(Buffer.alloc(2), 0, 2, null); // 偏移推到 2
      await fw2.writeFile('ZZ');
      r.afterWriteFileOffset2 = api.fs.readFileSync(pwf, 'latin1');
      r.writeFileEmpty = String(await fw2.writeFile(''));
      r.writeFileBuffer = String(await fw2.writeFile(Buffer.from('QQ')));
      r.afterWriteFileBuffer = api.fs.readFileSync(pwf, 'latin1');
      r.writeFileInvalid = {
        number: await cap(() => fw2.writeFile(42)),
        badEncoding: await cap(() => fw2.writeFile('x', { encoding: 'nope' })),
        // 字节面也给非法编码：Node 的 `getOptions` **照样**校验（编码字段是 options 的形状契约）
        badEncodingOnBytes: await cap(() => fw2.writeFile(Buffer.from('QQ'), { encoding: 'nope' })),
        badFlush: await cap(() => fw2.writeFile('x', { flush: 'yes' })),
        booleanOptions: await cap(() => fw2.writeFile('x', true)),
        // Node 的 `getOptions` 对**函数** options 是"当没给"（`typeof options === 'function'` ⇒ 默认值）
        functionOptions: await cap(() => fw2.writeFile('f', () => {})),
        // `mode`/`flag` 在句柄面**不校验也不生效**（判卷人实测：`{mode:'x'}` 两边都不报错 —— 别照 v27 源码猜）
        modeIgnored: await cap(() => fw2.writeFile('m', { mode: 'x' })),
        // 裸 ArrayBuffer 不是合法 data（要视图）—— 两边同码
        arrayBufferData: await cap(() => fw2.writeFile(new Uint8Array(2).buffer)),
      };
      const pa = join(dir, 'fh-af.txt');
      api.fs.writeFileSync(pa, '0123456789');
      const fa = await api.fsp.open(pa, 'r+');
      await fa.appendFile('QQ');
      r.appendFileOnRplus = api.fs.readFileSync(pa, 'latin1'); // 'r+' 上 appendFile == writeFile（写当前位置）
      await fa.close();
      const fa2 = await api.fsp.open(pa, 'a');
      await fa2.appendFile('RR');
      r.appendFileOnAppend = api.fs.readFileSync(pa, 'latin1'); // 'a' 旗标才追加到末尾
      await fa2.close();

      // ── stat / truncate / sync ──
      const ps = join(dir, 'fh-s.txt');
      api.fs.writeFileSync(ps, '0123456789');
      const fsH = await api.fsp.open(ps, 'r+');
      const st = await fsH.stat();
      r.stat = { size: st.size, isFile: st.isFile(), ctor: st.constructor.name };
      await fsH.truncate(4);
      r.sizeAfterTruncate4 = api.fs.statSync(ps).size;
      await fsH.truncate(-5); // Node：负数**截断成 0**，不报错
      r.sizeAfterTruncateNeg = api.fs.statSync(ps).size;
      r.truncateInvalid = { float: await cap(() => fsH.truncate(1.5)), string: await cap(() => fsH.truncate('x')) };
      r.syncResult = String(await fsH.sync());
      await fsH.close();

      // ── 关闭语义（幂等 / 事件 / 关闭后一切操作）──
      const pc = join(dir, 'fh-c.txt');
      api.fs.writeFileSync(pc, 'abc');
      const fc = await api.fsp.open(pc, 'r+');
      const events: string[] = [];
      fc.on('close', () => events.push('close'));
      r.closeResult = String(await fc.close());
      r.closeEvents = events.slice();
      r.fdAfterClose = fc.fd;
      r.secondClose = await cap(() => fc.close());
      r.closeEventsAfterSecond = events.slice();
      r.afterClose = {
        read: await capClosed(() => fc.read(Buffer.alloc(2), 0, 2, 0)),
        write: await capClosed(() => fc.write('x')),
        stat: await capClosed(() => fc.stat()),
        truncate: await capClosed(() => fc.truncate(1)),
        sync: await capClosed(() => fc.sync()),
      };

      // ── open 的错误面 ──
      r.openErrors = {
        missing: await cap(() => api.fsp.open(join(dir, 'fh-nope.txt'), 'r')),
        badFlags: await cap(() => api.fsp.open(pc, 'zzz')),
        badMode: await cap(() => api.fsp.open(join(dir, 'fh-m.txt'), 'w', 'x')),
        badModeNegative: await cap(() => api.fsp.open(join(dir, 'fh-m2.txt'), 'w', -1)),
        badModeFloat: await cap(() => api.fsp.open(join(dir, 'fh-m3.txt'), 'w', 1.5)),
        octalModeOk: await cap(async () => {
          const h = await api.fsp.open(join(dir, 'fh-m4.txt'), 'w', '0600');
          await h.close();
        }),
        badPathType: await cap(() => api.fsp.open(42, 'r')),
        numericFlags: await cap(async () => {
          const h = await api.fsp.open(pc, HOST_FS_CONSTANTS.O_RDONLY);
          await h.close();
        }),
        noFlags: await cap(async () => {
          const h = await api.fsp.open(pc);
          await h.close();
        }),
      };
      return r;
    };

    const ours = await scenario({ fs, fsp: fsPromises }, DATA_DIR);
    const host = await scenario({ fs: hostFs, fsp: hostFsp }, HOST_DIR);
    // 先按键列出差异（整份 deepEqual 的输出太长，找不到重点）
    const differing = Object.keys({ ...ours, ...host }).filter((k) => JSON.stringify(ours[k]) !== JSON.stringify(host[k]));
    assert.deepEqual(
      differing.map((k) => [k, ours[k], host[k]]),
      [],
      'FileHandle 与宿主不一致的键（[键, 我们, 宿主]）',
    );
    assert.deepEqual(ours, host, `FileHandle 与宿主不一致：${JSON.stringify({ ours, host }, null, 1)}`);
  });

  it('FileHandle：`fd` 只读、两次 open 是两个不同对象（身份与 Node 一致）', async () => {
    const p = join(DATA_DIR, 'fh-id.txt');
    writeFileSync(p, 'abcd');
    const a = await fsPromises.open(p, 'r');
    const b = await fsPromises.open(p, 'r');
    assert.equal(a === b, false, '两次 open 必须是两个对象（Node 也如此：createReadStream/open 每次新对象）');
    assert.equal(typeof a.fd, 'number');
    assert.notEqual(a.fd, b.fd, '两个句柄必须是两个编号（每插件编号空间，关闭后不复用）');
    // `fd` 是原型上的 getter（没有 setter）：严格模式（ESM）下赋值抛 TypeError —— 与 Node 的访问器形状一致
    const before = a.fd;
    assert.throws(() => {
      (a as any).fd = 99;
    }, TypeError);
    assert.equal(a.fd, before);
    await a.close();
    await b.close();
  });

  it('FileHandle 的"有意不同"两处：浮点 length 不 abort、关闭后的错误文案照 Node', async () => {
    const p = join(DATA_DIR, 'fh-diff.txt');
    writeFileSync(p, 'abcdef');
    const fh = await fsPromises.open(p, 'r+');

    // ① 浮点 `length`：Node **自己会 abort 整个进程**（判卷人 v22.22.1 与宿主 v24 都是 exit 134，
    //    `Assertion failed: args[3]->IsInt32()`，栈顶 `node::fs::Read` —— 见 probe-filehandle.mjs 的 capChild 段），
    //    而**同步** `fs.readSync(fd, buf, 0, 2.5, 0)` 又不报错（读 2 字节）。同一件事两个面两种表现 ⇒
    //    我们统一给一条明确的 ERR_OUT_OF_RANGE：**不 abort、也不静默截断**（fail-closed）。
    await assert.rejects(
      () => (fh as any).read(Buffer.alloc(4), 0, 2.5, 0),
      (e: any) => e.code === 'ERR_OUT_OF_RANGE' && /must be an integer/.test(e.message),
      '浮点 length 必须明确报错（Node 在这里会 abort，我们不能跟着崩）',
    );

    // ② 关闭后再用：**保留 Node 的原文** `EBADF` + `syscall=方法名` + `message='file closed'`
    //   （Node 的 `fsCall` 就是这么造的，与 `fs.readSync` 那套 `bad file descriptor, read` 不是同一句）
    await fh.close();
    const after = await (async () => {
      try {
        await fh.read(Buffer.alloc(2), 0, 2, 0);
        return null;
      } catch (e: any) {
        return e;
      }
    })();
    assert.equal(after?.code, 'EBADF');
    assert.equal(after?.syscall, 'read');
    assert.equal(after?.message, 'file closed');

    // ③ 分块可迭代数据（`fh.writeFile(['a','b'])`）：Node 支持（判卷人实测 OK），**我们没有实现** ——
    //    不静默写入、也不假装成功，而是明确 ERR_NOT_SUPPORTED_IN_SANDBOX（fail-closed）。
    const fh2 = await fsPromises.open(join(DATA_DIR, 'fh-diff2.txt'), 'w');
    await assert.rejects(
      () => fh2.writeFile(['a', 'b']),
      (e: any) => e.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
      '可迭代数据必须明确报"没实现"，而不是静默少写',
    );
    await fh2.close();
  });

  it('FileHandle 上仍未实现的方法**明确抛错**（流式 / 向量 / 全文件 / 元数据）', async () => {
    const p = join(DATA_DIR, 'fh-stub.txt');
    writeFileSync(p, 'abc');
    const hp = join(HOST_DIR, 'fh-stub.txt');
    writeFileSync(hp, 'abc');
    const fh = await fsPromises.open(p, 'r+');
    const hostFh = await hostFsp.open(hp, 'r+'); // 对照：宿主上这些方法都在（所以缺失是**有意**的）
    // 形状照 Node 分工：这些在 Node 上返回 Promise ⇒ 我们**拒绝**（不是同步抛）
    const asyncStubs = ['datasync', 'chmod', 'chown', 'utimes', 'readv', 'writev'];
    // 这些在 Node 上就是同步方法 ⇒ 我们**同步抛**
    const syncStubs = ['getAsyncId', 'createReadStream', 'createWriteStream', 'readableWebStream', 'readLines'];
    for (const name of [...asyncStubs, ...syncStubs]) {
      assert.equal(typeof (fh as any)[name], 'function', `FileHandle#${name} 应当是函数（不能是 undefined）`);
      assert.equal(typeof (hostFh as any)[name], 'function', `对照：宿主上 FileHandle#${name} 也在`);
    }
    for (const name of asyncStubs) {
      await assert.rejects(
        () => Promise.resolve((fh as any)[name]()),
        (e: any) => e.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
        `FileHandle#${name}（Node 里是异步方法）应当拒绝`,
      );
    }
    for (const name of syncStubs) {
      assert.throws(
        () => (fh as any)[name](),
        (e: any) => e.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
        `FileHandle#${name}（Node 里是同步方法）应当同步抛`,
      );
    }
    await fh.close();
    await hostFh.close();
  });

  it('fd 上限用满后**失败的 open 不碰真资源**（"拿到了却没登记上"必须挡在取资源之前）', async () => {
    // 背景：`openFd`/`openFdAsync` 是"先真开、后登记"，`handles.open` 在上限用满时会抛 ——
    // 少了收尾，那个真描述符就永久泄漏（Linux 上能数 /proc/self/fd，Windows 上几乎看不见：
    // libuv 用 `FILE_SHARE_DELETE` 打开文件，"删掉占用的文件/删父目录"都照样成功 —— 本轮实测过，别拿它当判据）。
    // 所以**可观察的判据换成"注定失败时压根不碰真资源"**：`HandleTable.ensureCapacity` 预检把
    // "装不下"挡在 `openSync` 之前，于是 `'w'` 也不会把文件创建出来（Node 在 OS 层 EMFILE 时同样不创建）。
    // 判别点：去掉 `ensureCapacity('fd')` 预检 ⇒ 文件被创建出来 ⇒ 这条红。
    const dir = mkdtempSync(join(tmpdir(), 'spc-fd-leak-'));
    const api = buildHostApi({ pluginId: '@test/fd-leak', dataDir: dir }) as any;
    writeFileSync(join(dir, 'held.txt'), 'x');
    try {
      const held: number[] = [];
      for (let i = 0; i < 64; i++) held.push(api['fs.fdOpenRead'].fn('held.txt', JSON.stringify('r')).fd);
      assert.equal(held.length, 64);
      // 第 65 个（读面）：仍然被拒
      assert.throws(() => api['fs.fdOpenRead'].fn('held.txt', JSON.stringify('r')), (e: any) => e.code === 'HANDLE_LIMIT_EXCEEDED');
      // 第 65 个（写面，'w' 会创建文件）：被拒之后那个文件**不许存在**
      assert.throws(() => api['fs.fdOpenWrite'].fn('never-created.txt', JSON.stringify('w')), (e: any) => e.code === 'HANDLE_LIMIT_EXCEEDED');
      assert.equal(existsSync(join(dir, 'never-created.txt')), false, '被上限拒绝的 open 不该把文件创建出来（说明真 open 根本没发生）');
      // 异步面同一条：`fs.promises.open` 走的也是"先开、后登记"（异步方法 ⇒ 拒绝而不是同步抛）
      await assert.rejects(
        () => api['fs.fdOpenWriteAsync'].fn('never-created-2.txt', JSON.stringify('w')),
        (e: any) => e.code === 'HANDLE_LIMIT_EXCEEDED',
      );
      assert.equal(existsSync(join(dir, 'never-created-2.txt')), false, '异步面的被拒 open 同样不该创建文件');
      // 收尾：把 64 个真的关掉（临时目录才删得干净）
      for (const fd of held) api['fs.fdClose'].fn(JSON.stringify(fd));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      assert.equal(existsSync(dir), false, '临时目录应当能删干净（说明没有描述符残留）');
    }
  });

  it('BigIntStats 与 readdir recursive 也抛错（不静默降级）', () => {
    assert.equal(capture(() => fs.statSync(join(DATA_DIR, 'a.txt'), { bigint: true }), DATA_DIR).code, 'ERR_NOT_SUPPORTED_IN_SANDBOX');
    assert.equal(capture(() => fs.readdirSync(DATA_DIR, { recursive: true }), DATA_DIR).code, 'ERR_NOT_SUPPORTED_IN_SANDBOX');
    // 对照：宿主两个都支持
    assert.equal(typeof hostFs.statSync(join(HOST_DIR, 'a.txt'), { bigint: true }).mode, 'bigint');
    assert.ok(Array.isArray(hostFs.readdirSync(HOST_DIR, { recursive: true })));
  });

  it('URL 路径参数按 POSIX 文件 URL 解析（`pathToFileURL` 的仿真基线）', { skip: process.platform === 'win32' ? 'POSIX 文件 URL 只在 Linux 宿主上与真实路径对得上' : false }, () => {
    const asUrl = new urlModule.URL(pathToFileURL(join(DATA_DIR, 'a.txt')).href);
    assert.equal(fs.readFileSync(asUrl, 'utf8'), 'hello');
  });
});

// ──────────────────────────── 回调与 promises 面 ────────────────────────────

describe('仿真 node:fs —— 回调风格与 promises 面', () => {
  it('回调**异步触发**（Node 的保证：依赖的时序假设建立在这上面）', async () => {
    // 用**自己造的文件**：差分表里前面的用例会改 `a.txt` 的内容，共用文件会让这条用例随执行顺序红/绿
    writeFileSync(join(DATA_DIR, 'callback.txt'), 'hello');
    let after = false;
    const seen: string[] = [];
    await new Promise<void>((resolve) => {
      fs.readFile(join(DATA_DIR, 'callback.txt'), 'utf8', (err: any, data: any) => {
        seen.push(after ? 'after-sync' : 'before-sync');
        seen.push(String(err) + '/' + data);
        resolve();
      });
      after = true; // 回调必须**晚于**同步代码
    });
    assert.deepEqual(seen, ['after-sync', 'null/hello']);
  });

  it('回调的错误路径：err 在第一个参数，成功时 data 在第二个', async () => {
    const err: any = await new Promise((resolve) => {
      fs.readFile(join(DATA_DIR, 'nope.txt'), (e: any) => resolve(e));
    });
    assert.equal(err.code, 'ENOENT');
    assert.equal(err.syscall, 'open');
    const [statErr, stats] = await new Promise<any>((resolve) => {
      fs.stat(join(DATA_DIR, 'a.txt'), (e: any, s: any) => resolve([e, s]));
    });
    assert.equal(statErr, null);
    assert.equal(stats.isFile(), true);
  });

  it('fs.exists(path, cb) 只回一个布尔（没有 err 位）', async () => {
    const args = await new Promise<any[]>((resolve) => {
      fs.exists(join(DATA_DIR, 'a.txt'), (...a: any[]) => resolve(a));
    });
    assert.deepEqual(args, [true]);
  });

  it('回调不是函数 → 同步抛 ERR_INVALID_ARG_TYPE', () => {
    assert.equal(capture(() => fs.readFile(join(DATA_DIR, 'a.txt'), 'utf8', 'not-a-fn'), DATA_DIR).code, 'ERR_INVALID_ARG_TYPE');
  });

  it('promises 面与同步面结果一致；失败是**拒绝**而不是抛出', async () => {
    assert.equal(await fsPromises.readFile(join(DATA_DIR, 'a.txt'), 'utf8'), fs.readFileSync(join(DATA_DIR, 'a.txt'), 'utf8'));
    assert.equal((await fsPromises.stat(join(DATA_DIR, 'a.txt'))).size, fs.statSync(join(DATA_DIR, 'a.txt')).size);
    assert.deepEqual((await fsPromises.readdir(DATA_DIR)).sort(), fs.readdirSync(DATA_DIR).sort());
    await assert.rejects(
      () => fsPromises.readFile(join(DATA_DIR, 'nope.txt')),
      (err: any) => err.code === 'ENOENT' && err.syscall === 'open',
    );
    // 承诺面自己就能走完一轮：mkdir + writeFile + readFile + rm
    await fsPromises.mkdir(join(DATA_DIR, 'p1', 'p2'), { recursive: true });
    await fsPromises.writeFile(join(DATA_DIR, 'p1', 'p2', 'x.txt'), 'v');
    assert.equal(await fsPromises.readFile(join(DATA_DIR, 'p1', 'p2', 'x.txt'), 'utf8'), 'v');
    await fsPromises.rm(join(DATA_DIR, 'p1'), { recursive: true });
    assert.equal(fs.existsSync(join(DATA_DIR, 'p1')), false);
  });

  it('fs/promises 与 fs.promises 是**同一个对象**，函数面覆盖 v22.22.1 那一份', async () => {
    assert.equal(fsPromises.default, fs.promises, 'fs.promises 与 fs/promises 的默认导出必须是同一个对象');
    const ourFns = Object.keys(fsPromises)
      .filter((k) => k !== 'default' && k !== 'constants')
      .sort();
    // 判卷人是**仿真版本**（22.22.1，出自 tools/truth/data/fs-url-truth.json 的 WSL 运行值），不是本机宿主：
    // 这台开发机的宿主是 v24，多出 `mkdtempDisposable` 之类 22 里没有的名字——拿它当判卷人会得出错误结论。
    const V22_FSP_FNS = [
      'access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'glob', 'lchmod', 'lchown', 'link',
      'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readFile', 'readdir', 'readlink',
      'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs', 'symlink', 'truncate', 'unlink', 'utimes',
      'watch', 'writeFile',
    ];
    assert.deepEqual(ourFns, V22_FSP_FNS);
    // 常量也在（Node 的 `fs/promises.constants` 是不可枚举的，所以上面按名字比）
    assert.equal(fsPromises.constants.S_IFMT, 0o170000);
  });

  it('fs 的导出面覆盖 v22.22.1 的每一个名字（少一个就是"插件里 undefined"）', () => {
    // 出处同上：`Object.keys(require('node:fs'))` 在 WSL node v22.22.1 上的运行值。
    // 唯一**有意**不实现的是 `_toUnixTimestamp`（Node 的内部导出，不在最小集里）。
    const V22_FS_KEYS = [
      'Dir', 'Dirent', 'F_OK', 'FileReadStream', 'FileWriteStream', 'R_OK', 'ReadStream', 'Stats', 'W_OK',
      'WriteStream', 'X_OK', 'access', 'accessSync', 'appendFile', 'appendFileSync', 'chmod', 'chmodSync',
      'chown', 'chownSync', 'close', 'closeSync', 'constants', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
      'createReadStream', 'createWriteStream', 'default', 'exists', 'existsSync', 'fchmod', 'fchmodSync',
      'fchown', 'fchownSync', 'fdatasync', 'fdatasyncSync', 'fstat', 'fstatSync', 'fsync', 'fsyncSync',
      'ftruncate', 'ftruncateSync', 'futimes', 'futimesSync', 'glob', 'globSync', 'lchmod', 'lchmodSync',
      'lchown', 'lchownSync', 'link', 'linkSync', 'lstat', 'lstatSync', 'lutimes', 'lutimesSync', 'mkdir',
      'mkdirSync', 'mkdtemp', 'mkdtempSync', 'open', 'openAsBlob', 'openSync', 'opendir', 'opendirSync',
      'promises', 'read', 'readFile', 'readFileSync', 'readSync', 'readdir', 'readdirSync', 'readlink',
      'readlinkSync', 'readv', 'readvSync', 'realpath', 'realpathSync', 'rename', 'renameSync', 'rm',
      'rmSync', 'rmdir', 'rmdirSync', 'stat', 'statSync', 'statfs', 'statfsSync', 'symlink', 'symlinkSync',
      'truncate', 'truncateSync', 'unlink', 'unlinkSync', 'unwatchFile', 'utimes', 'utimesSync', 'watch',
      'watchFile', 'write', 'writeFile', 'writeFileSync', 'writeSync', 'writev', 'writevSync',
    ];
    const missing = V22_FS_KEYS.filter((k) => !(k in fs));
    assert.deepEqual(missing, []);
  });
});

// ──────────────────────────── 真沙箱冒烟 ────────────────────────────

describe('仿真 node:fs —— 真实 QuickJS 沙箱里跑通（真桥 + 权限判定）', async () => {
  const { createSandbox } = await import('../../core/sandbox.ts');
  const SMOKE_DIR = mkdtempSync(join(tmpdir(), 'spc-smoke-fs-'));
  after(() => rmSync(SMOKE_DIR, { recursive: true, force: true }));

  /** 在真沙箱里跑一段插件代码（`init` 钩子），回捞 console.log */
  async function runInSandbox(code: string, permissions: string[]): Promise<string> {
    const api = buildHostApi({ pluginId: '@spc-test/fs', dataDir: SMOKE_DIR });
    const sandbox = await createSandbox(api, {
      pluginId: '@spc-test/fs',
      permissions,
      facts: { version: { code: 1, name: 'test' }, dataDir: SMOKE_DIR, manifest: {}, config: {} },
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule('@spc-test/fs', code);
      // 异步动作写在 `init` 钩子里：**模块顶层 await（TLA）不被支持**（QuickJS 对 TLA 模块返回的是
      // promise 而不是命名空间，导出取不到），沙箱会明确拒绝——这也是真实插件的写法（钩子异步）。
      await sandbox.callHook('init', 5_000);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    return logs.join('\n');
  }

  // 这条必须走真沙箱：宿主进程里的差分测试证明不了"沙箱里真的没有缺全局"、
  // 也证明不了引导层的注入与**权限判定**在真桥上成立（这个项目踩过 queueMicrotask 的坑）。
  it('fd 面在真沙箱里成立：逐位置读写 / 上限 fail-closed / 卸载强制关掉真 fd', async () => {
    // 这条验的是**句柄模型的真资源那一半**：fd 是 OS 资源，"只 open 不 close" 真会泄漏，
    // 所以三种收口都要在真桥后面成立（正常关闭 / 到上限拒绝 / 卸载强回收 + 审计）。
    const bridge: { releaseHandles?: () => void } = {};
    const api = buildHostApi({ pluginId: '@spc-test/fd', dataDir: SMOKE_DIR, bridge });
    const sandbox = await createSandbox(api, {
      pluginId: '@spc-test/fd',
      permissions: ['fs.read.data', 'fs.write.data'],
      bridge,
      facts: { version: { code: 1, name: 'test' }, dataDir: SMOKE_DIR, manifest: {}, config: {} },
    });
    // 卸载强回收的**探针**：包一层看它有没有被调（真正的释放语义由 handles.test.ts 单测钉住）
    let releaseCalls = 0;
    const origRelease = bridge.releaseHandles;
    bridge.releaseHandles = () => {
      releaseCalls++;
      origRelease?.();
    };
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule(
        '@spc-test/fd',
        `
import fs from 'node:fs';
export function init() {
  const fd = fs.openSync('fd.txt', 'w');
  console.log('FD ' + (typeof fd === 'number'));
  fs.writeSync(fd, 'abcdef');
  // 位置写用 **Buffer 重载**（字符串重载的 writeSync(fd, str, position, encoding) 第 4 参是 encoding，
  // 传数字会像 Node 一样报 ERR_INVALID_ARG_VALUE —— 仿真是对的，别在这里写错）
  fs.writeSync(fd, Buffer.from('XY'), 0, 2, 1);
  fs.closeSync(fd);
  const rfd = fs.openSync('fd.txt', 'r');
  const b = Buffer.alloc(4);
  const n = fs.readSync(rfd, b, 0, 4, 2); // 从位置 2 读 4 字节
  console.log('READ ' + n + '/' + b.toString() + '/' + Buffer.isBuffer(b));
  console.log('SIZE ' + fs.fstatSync(rfd).size);
  fs.closeSync(rfd);
  try { fs.readSync(rfd, b, 0, 1, 0); } catch (e) { console.log('CLOSED ' + e.code + '/' + e.syscall); }
  // 上限：同时活着的 fd 上限 64（每插件独立）⇒ 第 65 个必须被拒（fail-closed）
  let opened = 0;
  let limitCode = 'none';
  try { for (let i = 0; i < 80; i++) { fs.openSync('many-' + i + '.txt', 'w'); opened++; } }
  catch (e) { limitCode = e.code; }
  console.log('LIMIT ' + opened + ' ' + limitCode);
}
`,
      );
      await sandbox.callHook('init', 10_000);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    const out = logs.join('\n');
    assert.match(out, /FD true/, `实际日志：${out}`);
    // 'abcdef' 的 1..2 被 'XY' 覆盖 ⇒ 'aXYdef'；从位置 2 读 4 字节 ⇒ 'Ydef'
    assert.match(out, /READ 4\/Ydef\/true/, `实际日志：${out}`);
    assert.match(out, /SIZE 6/, `实际日志：${out}`);
    assert.match(out, /CLOSED EBADF\/read/, `实际日志：${out}`);
    // 上限用满 ⇒ 对外像 Node 的 `EMFILE`（too many open files）；宿主码 `HANDLE_LIMIT_EXCEEDED`
    // 留在 `err.spcCode` 里（判过 spcCode，这里只看对外形状）
    assert.match(out, /LIMIT 64 EMFILE/, `实际日志：${out}`);
    // 卸载：句柄表被强制回收（那 64 个没人关的 fd 全靠这一步），并落一条审计
    assert.equal(releaseCalls, 1, 'dispose 应当调用一次桥上的句柄回收');
    const forced = readFileSync(join(AUDIT_DIR, 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { pluginId?: string; method?: string })
      .filter((e) => e.pluginId === '@spc-test/fd' && e.method?.startsWith('handles.'))
      .map((e) => e.method!);
    for (const expected of ['handles.open', 'handles.close', 'handles.limit', 'handles.forced-release']) {
      assert.ok(forced.includes(expected), `审计缺少 ${expected}（实际：${[...new Set(forced)].join(',')}）`);
    }
  });

  it('FileHandle 在真沙箱里成立：await 走的真异步通道 / 关闭语义 / 上限 EMFILE / 卸载强回收', async () => {
    // 这条必须走真沙箱：`fh.read`/`fh.write` 在宿主侧声明了 `async: true`，**挂起只在真 VM 里发生**
    // （纯 Node 假桥复现不出 asyncify 的挂起，那边只验语义）。判别点：去掉 `fs.fdReadAsync` 的
    // `async: true` ⇒ 宿主调用不再挂起、桥的同步守卫抛 `async-host-method-not-supported` ⇒ 这条必红。
    const bridge: { releaseHandles?: () => void } = {};
    const api = buildHostApi({ pluginId: '@spc-test/fh', dataDir: SMOKE_DIR, bridge });
    writeFileSync(join(SMOKE_DIR, 'fh-many.txt'), 'x');
    const sandbox = await createSandbox(api, {
      pluginId: '@spc-test/fh',
      permissions: ['fs.read.data', 'fs.write.data'],
      bridge,
      facts: { version: { code: 1, name: 'test' }, dataDir: SMOKE_DIR, manifest: {}, config: {} },
    });
    let releaseCalls = 0;
    const origRelease = bridge.releaseHandles;
    bridge.releaseHandles = () => {
      releaseCalls++;
      origRelease?.();
    };
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule(
        '@spc-test/fh',
        `
import fsp from 'node:fs/promises';
export async function init() {
  const fh = await fsp.open('fh.txt', 'w');
  console.log('FD ' + (typeof fh.fd === 'number') + '/' + fh.constructor.name);
  const w = await fh.write('abcdef');
  console.log('W ' + w.bytesWritten + '/' + typeof w.buffer + '/' + (Object.getPrototypeOf(w) === null));
  await fh.close();
  // ⚠️ 用 'r+' 而不是 'r'：Windows 上对**只读**句柄做 fsync 是 EPERM（真语义，踩过一次）
  const rh = await fsp.open('fh.txt', 'r+');
  const b = Buffer.alloc(4);
  const r = await rh.read(b, 0, 4, 2);
  console.log('R ' + r.bytesRead + '/' + b.toString('latin1'));
  // 位置缺省 = 当前偏移（NULL-POS-CONSUMES 指的是"缺省位置会推进偏移"）
  const b2 = Buffer.alloc(2);
  await rh.read(b2, 0, 2, null);
  const st = await rh.stat();
  const sync = await rh.sync();
  await rh.truncate(5);
  const size2 = (await rh.stat()).size;
  console.log('S2 ' + st.size + '/' + String(sync) + '/' + size2);
  const ev = [];
  rh.on('close', () => ev.push('close'));
  await rh.close();
  const again = await rh.close();
  console.log('CLOSE ' + rh.fd + '/' + ev.length + '/' + String(again));
  try { await rh.read(Buffer.alloc(1), 0, 1, 0); } catch (e) { console.log('AFTER ' + e.code + '/' + e.syscall + '/' + e.message); }
  // 上限：同时活着的句柄 64（每插件独立）⇒ 第 65 个必须被拒（fail-closed，对外 EMFILE）
  const held = [];
  let lim = 'none';
  try { for (let i = 0; i < 65; i++) held.push(await fsp.open('fh-many.txt', 'r')); }
  catch (e) { lim = e.code; }
  console.log('LIMIT ' + held.length + ' ' + lim);
}
`,
      );
      await sandbox.callHook('init', 30_000);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    const out = logs.join('\n');
    assert.match(out, /FD true\/FileHandle/, `实际日志：${out}`);
    assert.match(out, /W 6\/string\/true/, `实际日志：${out}`);
    assert.match(out, /R 4\/cdef/, `实际日志：${out}`);
    assert.match(out, /S2 6\/undefined\/5/, `实际日志：${out}`);
    assert.match(out, /CLOSE -1\/1\/undefined/, `实际日志：${out}`);
    // 关闭后再用：**Node 的原文**（`fsCall` 造的 `EBADF` + 方法名 + 'file closed'）
    assert.match(out, /AFTER EBADF\/read\/file closed/, `实际日志：${out}`);
    assert.match(out, /LIMIT 64 EMFILE/, `实际日志：${out}`);
    assert.equal(releaseCalls, 1, 'dispose 应当调用一次桥上的句柄回收');
    const audit = readFileSync(join(AUDIT_DIR, 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { pluginId?: string; method?: string })
      .filter((e) => e.pluginId === '@spc-test/fh' && e.method?.startsWith('handles.'))
      .map((e) => e.method!);
    for (const expected of ['handles.open', 'handles.close', 'handles.limit', 'handles.forced-release']) {
      assert.ok(audit.includes(expected), `审计缺少 ${expected}（实际：${[...new Set(audit)].join(',')}）`);
    }
  });

  it('写入/读取/列目录/stat/promises/清理全链路在沙箱里成立', async () => {
    // 权限只声明 fs.*：**用 node:fs 不该额外依赖 `bytes.*`**（设计 §6 的映射表就是这么写的）——
    // 这一条同时是那个不变量的回归（文本读写的编解码在宿主侧跟读取一起做，不走 bytes 组）。
    const out = await runInSandbox(
      `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
export async function init() {
  fs.mkdirSync('data/deep', { recursive: true });
  fs.writeFileSync('data/x.txt', 'hi');
  fs.appendFileSync('data/x.txt', '!');
  console.log('READ ' + fs.readFileSync('data/x.txt', 'utf8'));
  console.log('BUF ' + (fs.readFileSync('data/x.txt') instanceof Uint8Array));
  console.log('STAT ' + fs.statSync('data/x.txt').isFile() + '/' + fs.statSync('data/x.txt').size);
  console.log('DIR ' + fs.readdirSync('data').sort().join(','));
  console.log('DIRE ' + fs.readdirSync('data', { withFileTypes: true }).map((d) => d.name + ':' + d.isDirectory()).sort().join(','));
  console.log('TMP ' + fs.mkdtempSync('data/t-').startsWith('data/t-'));
  const st = await fsp.stat('data/x.txt');
  console.log('ASYNC ' + st.size + '/' + (await fsp.readFile('data/x.txt', 'utf8')));
  try { fs.readFileSync('../escape.txt'); } catch (e) { console.log('ESC ' + e.code + '/' + e.spcCode); }
  try { fs.readFileSync('nope.txt'); } catch (e) { console.log('ENO ' + e.code + '/' + e.errno + '/' + e.syscall); }
  try { fs.watch('data', () => {}); } catch (e) { console.log('WATCH ' + e.code); }
  fs.rmSync('data', { recursive: true });
  console.log('RM ' + fs.existsSync('data'));
}
`,
      ['fs.read.data', 'fs.write.data'],
    );
    const lines = out.split('\n');
    assert.equal(lines[0], 'READ hi!');
    assert.equal(lines[1], 'BUF true');
    assert.equal(lines[2], 'STAT true/3');
    assert.equal(lines[3], 'DIR deep,x.txt');
    assert.equal(lines[4], 'DIRE deep:true,x.txt:false');
    assert.equal(lines[5], 'TMP true');
    assert.equal(lines[6], 'ASYNC 3/hi!');
    // 越界：宿主 PATH_OUT_OF_SCOPE → 插件面 EACCES（§7 的翻译），原始码留在 spcCode
    assert.equal(lines[7], 'ESC EACCES/PATH_OUT_OF_SCOPE');
    // Linux 真值的 errno（-2）与 syscall（open）在**沙箱里**也成立
    assert.equal(lines[8], 'ENO ENOENT/-2/open');
    assert.equal(lines[9], 'WATCH ERR_NOT_SUPPORTED_IN_SANDBOX');
    assert.equal(lines[10], 'RM false');
  });

  it('`fs.*.data` 是 **self/auto：未声明也能读**（v4 免声明）；越界仍然被路径收敛拦住', async () => {
    // 前提变更（第四批 B）：这条用例以前断言"未声明 → EACCES/PERMISSION_DENIED"。
    // 现在 `scope: self`（= `grant: auto`）的点**免声明**，所以第一步会真的去读文件：
    // 文件不存在 ⇒ Node 形状的 ENOENT（说明"权限这关已经过了，是文件系统在回答"）。
    // 第二步仍然要拦住越界——**免声明不等于免收敛**，路径作用域与权限是两套闸。
    const out = await runInSandbox(
      `
import fs from 'node:fs';
export function init() {
  try { fs.readFileSync('a.txt'); } catch (e) { console.log('NOPERM ' + e.code + '/' + e.spcCode + '/' + e.syscall); }
  try { fs.readFileSync('../x.txt'); } catch (e) { console.log('ESC ' + e.code + '/' + e.spcCode); }
}
`,
      [],
    );
    const [noPerm, esc] = out.split('\n');
    assert.equal(noPerm, 'NOPERM ENOENT/ENOENT/open');
    assert.match(esc, /^ESC \w+\/\w+$/);
    assert.ok(!esc.includes('PERMISSION_DENIED'), `免声明之后不该再是权限拒绝：${esc}`);
  });
});
