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
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { constants as HOST_FS_CONSTANTS, symlinkSync } from 'node:fs';
import * as hostFs from 'node:fs';
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
// node-buffer.js 与 node-url.js，两个都得拷）。
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-shims-fs-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
const SHIM_SRC = join(process.cwd(), 'core', 'sandbox-modules');
for (const f of ['node-fs.js', 'node-fs-promises.js', 'node-buffer.js', 'node-url.js']) {
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

  it('fd 面 / 流 / watch / 元数据一律**响亮抛错**，不静默 undefined', () => {
    const names = [
      'open', 'openSync', 'closeSync', 'readSync', 'writeSync', 'fstatSync', 'fsyncSync',
      'createReadStream', 'createWriteStream', 'watch', 'watchFile', 'unwatchFile',
      'symlinkSync', 'linkSync', 'readlinkSync', 'fchmodSync', 'chownSync', 'utimesSync',
      'opendirSync', 'statfsSync', 'cpSync', 'globSync', 'truncateSync',
    ];
    for (const name of names) {
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
      assert.equal(typeof (hostFs as any)[name], 'function');
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
