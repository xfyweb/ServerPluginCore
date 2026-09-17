// node:util / node:util/types 仿真的对齐测试
//
// 判卷人有两个（与 os/process 那份同一套路）：
//   1. **宿主 Node**——凡是我们声称与 Node 一致的面（format 的指令语义、types 的判定、
//      TextEncoder/TextDecoder 的字节、错误码）都拿它逐条比；
//   2. **文档化的边界**——凡是我们有意不同的面（inspect 只保证结构不保证排版、TextDecoder 只支持三个
//      标签族、流式解码不支持）就断言"我们这边是这样"，并在用例里写明为什么。
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as nodeUtil from 'node:util';
import nodeUtilTypes from 'node:util/types';

const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-shims-util-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
const SHIM_SRC = join(process.cwd(), 'core', 'sandbox-modules');
for (const f of ['node-util.js', 'node-util-types.js', 'node-assert.js', 'node-constants.js']) {
  copyFileSync(join(SHIM_SRC, f), join(SHIM_DIR, f));
}
after(() => rmSync(SHIM_DIR, { recursive: true, force: true }));

/** 编解码走宿主通道：测试里给一个"就是宿主 Node"的最小实现（真实沙箱里由桥提供） */
const hostCalls: string[] = [];
(globalThis as any).__host = {
  'bytes.fromString': (text: string, enc: string) => {
    hostCalls.push(`fromString:${enc}`);
    const buf = Buffer.from(text, enc as BufferEncoding);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  'bytes.toString': (ab: ArrayBuffer, enc: string) => {
    hostCalls.push(`toString:${enc}`);
    return JSON.stringify(Buffer.from(new Uint8Array(ab)).toString(enc as BufferEncoding));
  },
};

const utilShim = await import(pathToFileURL(join(SHIM_DIR, 'node-util.js')).href);
const typesShim = await import(pathToFileURL(join(SHIM_DIR, 'node-util-types.js')).href);

describe('仿真 node:util —— format 的指令语义与宿主一致', () => {
  /** 同一批输入喂两边，比字符串（format 是纯文本，可以逐字符比） */
  const cases: [string, unknown[]][] = [
    ['无参', []],
    ['纯字符串', ['hello']],
    ['%s 数字', ['%s', 42]],
    ['%s 对象（走 inspect）', ['%s', { a: 1 }]],
    ['%d 数字', ['%d', 42]],
    ['%d 字符串数字', ['%d', '42']],
    ['%d 非数字 → NaN', ['%d', 'abc']],
    ['%i 截断小数', ['%i', 3.9]],
    ['%f 浮点', ['%f', '3.5']],
    ['%j JSON', ['%j', { a: [1, 2] }]],
    ['%j 循环 → [Circular]', ['%j', (() => { const o: any = {}; o.self = o; return o; })()]],
    ['%% 原样', ['100%%']],
    ['指令多于参数 → 原样留下', ['%s %s %s', 'a']],
    ['参数多于指令 → 追加在末尾', ['%s', 'a', 'b', 'c']],
    ['首参非字符串 → 全部 inspect', [42, 'x', { a: 1 }]],
    ['%c 丢弃（无颜色）', ['a%cb', 'color:red']],
  ];

  it('逐条与宿主 node:util.format 相同', () => {
    for (const [label, args] of cases) {
      assert.equal(
        (utilShim.format as any)(...args),
        (nodeUtil.format as any)(...args),
        `${label} 与宿主不一致`,
      );
    }
  });

  it('formatWithOptions 的 inspect 选项真的透传（depth 生效）', () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const shallow = utilShim.formatWithOptions({ depth: 0 }, '%O', deep);
    const deeper = utilShim.formatWithOptions({ depth: 3 }, '%O', deep);
    assert.notEqual(shallow, deeper, 'depth 选项没有生效');
    assert.ok(shallow.length < deeper.length);
  });
});

describe('仿真 node:util —— inspect 的结构子集（不追求排版，但结构不许骗人）', () => {
  const cases: [string, unknown, (out: string) => void][] = [
    ['Map 不能印成空对象', new Map([['a', 1]]), (o) => assert.match(o, /Map\(1\)/)],
    ['Set 带条数', new Set([1, 2]), (o) => assert.match(o, /Set\(2\)/)],
    ['Date 是 ISO', new Date(0), (o) => assert.equal(o, '1970-01-01T00:00:00.000Z')],
    ['RegExp 原样', /a/gi, (o) => assert.equal(o, '/a/gi')],
    ['函数带名字', function foo() {}, (o) => assert.equal(o, '[Function: foo]')],
    ['boxed 标记类型', new Number(1), (o) => assert.match(o, /\[Number: 1\]/)],
    ['TypedArray 带类型与长度', new Uint8Array([1, 2]), (o) => assert.match(o, /Uint8Array\(2\)/)],
    ['Error 带消息', new TypeError('boom'), (o) => assert.match(o, /TypeError: boom/)],
    ['循环引用打标（不爆栈）', (() => { const o: any = {}; o.self = o; return o; })(), (o) => assert.match(o, /\[Circular \*1\]/)],
    // 深度省略：默认 depth=2，四层嵌套才会出现省略标记（宿主同样打 `[Object]`）
    ['深度超限显式省略', { a: { b: { c: { d: 1 } } } }, (o) => assert.match(o, /\[Object\]/)],
    ['稀疏数组标空槽', [1, , 3], (o) => assert.match(o, /<1 empty item>/)],
    ['Symbol 原样', Symbol('s'), (o) => assert.match(o, /Symbol\(s\)/)],
    ['bigint 带 n', 10n, (o) => assert.equal(o, '10n')],
    ['-0 与 0 区分', -0, (o) => assert.equal(o, '-0')],
  ];

  it('逐条的结构断言成立', () => {
    for (const [label, value, check] of cases) {
      check(utilShim.inspect(value));
      // 宿主也过一遍，确认我们的断言描述的是 Node 同类行为（而不是自说自话）
      check(nodeUtil.inspect(value));
      assert.ok(label.length > 0);
    }
  });

  it('`util.inspect.custom` 被调用（生态里大量使用）', () => {
    const custom = Symbol.for('nodejs.util.inspect.custom');
    class Box {
      [custom]() {
        return '<Box>';
      }
    }
    assert.equal(utilShim.inspect(new Box()), '<Box>');
    assert.equal(nodeUtil.inspect(new Box()), '<Box>');
    assert.equal(utilShim.inspect.custom, custom);
  });

  it('默认选项可改（inspect.defaultOptions）', () => {
    const prev = utilShim.inspect.defaultOptions.depth;
    try {
      utilShim.inspect.defaultOptions.depth = 0;
      assert.match(utilShim.inspect({ a: { b: 1 } }), /\[Object\]/);
    } finally {
      utilShim.inspect.defaultOptions.depth = prev;
    }
  });
});

describe('仿真 node:util —— types / 纯函数', () => {
  it('types 的判定与宿主 node:util/types 逐条一致', () => {
    const samples: [string, unknown][] = [
      ['数组', [1, 2]],
      ['日期', new Date()],
      ['正则', /a/],
      ['Map', new Map()],
      ['Set', new Set()],
      ['WeakMap', new WeakMap()],
      ['WeakSet', new WeakSet()],
      ['Promise', Promise.resolve()],
      ['ArrayBuffer', new ArrayBuffer(2)],
      ['Uint8Array', new Uint8Array(2)],
      ['DataView', new DataView(new ArrayBuffer(2))],
      ['装箱数字', new Number(1)],
      ['装箱字符串', new String('a')],
      ['原生错误', new Error('x')],
      ['生成器函数', function* g() {}],
      ['生成器对象', (function* g() {})()],
      ['arguments', (function () { return arguments; })()],
      ['null', null],
      ['数字', 1],
    ];
    const names = Object.keys(nodeUtilTypes).filter((k) => typeof (nodeUtilTypes as any)[k] === 'function');
    assert.ok(names.length >= 30, `宿主 types 面太窄：${names.length}`);
    for (const [label, value] of samples) {
      for (const name of names) {
        if (name === 'isProxy') continue; // 我们在沙箱里明确抛错（见下面的用例）
        assert.equal(
          (typesShim as any)[name](value),
          (nodeUtilTypes as any)[name](value),
          `${name}(${label}) 与宿主不一致`,
        );
      }
    }
  });

  it('types 的导出面与宿主一致（少一个名字 = 少一条可用判定）', () => {
    const ours = Object.keys(typesShim).filter((k) => k !== 'default' && k !== '__esModule').sort();
    const theirs = Object.keys(nodeUtilTypes).filter((k) => k !== 'default' && k !== '__esModule').sort();
    assert.deepEqual(ours, theirs);
    // 默认导出就是 types 对象本身（Node 里 `require('util/types')` 拿到的是它）
    assert.equal(typesShim.default.isDate, typesShim.isDate);
  });

  it('isProxy 在沙箱里明确抛错（QuickJS 不暴露内部槽，判不出来就别猜）', () => {
    assert.throws(
      () => typesShim.isProxy({}),
      (err: any) => err.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
    );
    assert.equal(nodeUtilTypes.isProxy({}), false); // 宿主上它是可用的 → 我们是有意缺失
  });

  it('inherits 与宿主行为一致（含参数校验）', () => {
    for (const impl of [utilShim, nodeUtil]) {
      function Base() {}
      Base.prototype.hi = () => 'hi';
      function Derived() {}
      impl.inherits(Derived, Base);
      const d = new (Derived as any)();
      assert.equal(d.hi(), 'hi');
      assert.equal((Derived as any).super_, Base);
      assert.throws(() => (impl.inherits as any)(null, Base), (e: any) => e.code === 'ERR_INVALID_ARG_TYPE');
      assert.throws(() => (impl.inherits as any)(Base, undefined), (e: any) => e.code === 'ERR_INVALID_ARG_TYPE');
    }
  });

  it('promisify：回调风格 → Promise；`.custom` 优先；非函数抛 ERR_INVALID_ARG_TYPE', async () => {
    const cbStyle = (a: number, cb: (err: unknown, v?: number) => void) => cb(null, a * 2);
    const p = utilShim.promisify(cbStyle);
    assert.equal(await p(21), 42);
    const failing = (cb: (err: unknown) => void) => cb(new Error('nope'));
    await assert.rejects(() => utilShim.promisify(failing)(), /nope/);

    const custom = Object.assign(() => {}, { [utilShim.promisify.custom]: () => Promise.resolve('custom') });
    assert.equal(await utilShim.promisify(custom)(), 'custom');

    assert.throws(() => utilShim.promisify(42 as any), (e: any) => e.code === 'ERR_INVALID_ARG_TYPE');
    // 与宿主一致：Node 的 promisify 也是这三条语义
    assert.equal(await nodeUtil.promisify(cbStyle)(21), 42);
  });

  it('callbackify：Promise → 回调风格（回调是异步触发的）', async () => {
    const asyncFn = async (a: number) => a + 1;
    const cbStyle = utilShim.callbackify(asyncFn);
    const got = await new Promise((resolve, reject) => cbStyle(1, (err: unknown, v: unknown) => (err ? reject(err) : resolve(v))));
    assert.equal(got, 2);
    const failing = utilShim.callbackify(async () => {
      throw new Error('bad');
    });
    const err = await new Promise((resolve) => failing((e: unknown) => resolve(e)));
    assert.match((err as Error).message, /bad/);
    assert.throws(() => cbStyle(1, 'not-a-function' as any), (e: any) => e.code === 'ERR_INVALID_ARG_TYPE');
  });

  it('deprecate：只警告一次，且调用透传返回值', () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(' '));
    try {
      const fn = utilShim.deprecate((x: number) => x * 3, 'use newFn instead', 'DEP0001');
      assert.equal(fn(2), 6);
      assert.equal(fn(3), 9);
    } finally {
      console.warn = orig;
    }
    assert.equal(warnings.length, 1, '每个包装函数只该警告一次');
    assert.match(warnings[0], /use newFn instead.*DEP0001/);
    assert.throws(() => utilShim.deprecate(1 as any, 'x'), (e: any) => e.code === 'ERR_INVALID_ARG_TYPE');
  });

  it('debuglog 默认 no-op，`.enabled` 打开后才输出', () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    try {
      const log = utilShim.debuglog('spc');
      log('quiet');
      assert.deepEqual(lines, []);
      log.enabled = true;
      log('loud %d', 1);
    } finally {
      console.error = orig;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^spc loud 1$/);
  });

  it('isDeepStrictEqual 复用 assert 的深比较（不重复实现一遍）', () => {
    assert.equal(utilShim.isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] }), true);
    assert.equal(utilShim.isDeepStrictEqual({ a: 1 }, { a: 2 }), false);
    assert.equal(utilShim.isDeepStrictEqual(NaN, NaN), nodeUtil.isDeepStrictEqual(NaN, NaN));
    assert.equal(utilShim.isDeepStrictEqual(new WeakMap(), new WeakMap()), nodeUtil.isDeepStrictEqual(new WeakMap(), new WeakMap()));
  });

  it('getSystemErrorName：收**负数** errno（Node 的约定），给的是 **Linux 真值**', () => {
    // ⚠️ 这一条**不能拿本机宿主当判卷人**：宿主是 Windows 时 Node 的 errno 表是 Windows 的，
    // `getSystemErrorName(-2)` 会返回字符串 'Unknown system error -2'；而我们的基线是 Linux/POSIX
    // （与 node-constants.js 的 235 个键同一来源）。所以这里断言的是 Linux 真值，Linux 上再与宿主对照。
    const linuxTruth: [number, string][] = [
      [-2, 'ENOENT'],
      [-13, 'EACCES'],
      [-17, 'EEXIST'],
      [-28, 'ENOSPC'],
      [-110, 'ETIMEDOUT'],
    ];
    for (const [errno, name] of linuxTruth) {
      assert.equal(utilShim.getSystemErrorName(errno), name, `errno ${errno}`);
      if (process.platform === 'linux') {
        assert.equal(utilShim.getSystemErrorName(errno), nodeUtil.getSystemErrorName(errno));
      }
    }
    // 正数 / 未知码 / 非数字：三种拒绝都要有码（照 Node）
    assert.throws(() => utilShim.getSystemErrorName(2), (e: any) => e.code === 'ERR_OUT_OF_RANGE');
    assert.throws(() => nodeUtil.getSystemErrorName(2), (e: any) => e.code === 'ERR_OUT_OF_RANGE');
    assert.throws(() => utilShim.getSystemErrorName(-999999), (e: any) => e.code === 'ERR_OUT_OF_RANGE');
    assert.throws(() => utilShim.getSystemErrorName('2' as any), (e: any) => e.code === 'ERR_INVALID_ARG_TYPE');
  });
});

describe('仿真 node:util —— TextEncoder / TextDecoder（宿主代工）', () => {
  it('TextEncoder：字节与宿主逐字节一致（含代理对与孤立代理项）', () => {
    for (const s of ['', 'abc', 'héllo→世界', '😀', 'a\uD800b']) {
      const mine = utilShim.TextEncoder ? new utilShim.TextEncoder().encode(s) : null;
      const theirs = new nodeUtil.TextEncoder().encode(s);
      assert.deepEqual(Array.from(mine), Array.from(theirs), `TextEncoder(${JSON.stringify(s)})`);
    }
    assert.equal(new utilShim.TextEncoder().encoding, 'utf-8');
  });

  it('TextEncoder.encodeInto：写入目标数组并报 read/written', () => {
    const dest = new Uint8Array(4);
    const res = new utilShim.TextEncoder().encodeInto('abc', dest);
    assert.deepEqual(Array.from(dest), [97, 98, 99, 0]);
    assert.deepEqual(res, { read: 3, written: 3 });
    const nodeDest = new Uint8Array(4);
    assert.deepEqual(new nodeUtil.TextEncoder().encodeInto('abc', nodeDest), res);
  });

  it('TextDecoder：utf-8 / utf-16le / latin1 解码与宿主一致，BOM 默认去掉', () => {
    const samples: [string, number[]][] = [
      ['utf-8', [0x68, 0x69]],
      ['utf-16le', [0x68, 0x00, 0x69, 0x00]],
      ['latin1', [0x68, 0xe9]],
    ];
    for (const [label, bytes] of samples) {
      const mine = new utilShim.TextDecoder(label).decode(new Uint8Array(bytes));
      const theirs = new nodeUtil.TextDecoder(label).decode(new Uint8Array(bytes));
      assert.equal(mine, theirs, `${label} 解码不一致`);
    }
    // BOM：默认去掉，ignoreBOM 时保留
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    assert.equal(new utilShim.TextDecoder('utf-8').decode(bom), 'a');
    assert.equal(new utilShim.TextDecoder('utf-8', { ignoreBOM: true }).decode(bom), '\uFEFFa');
    assert.equal(new utilShim.TextDecoder('utf-8').encoding, 'utf-8');
    assert.equal(new utilShim.TextDecoder('UTF-16LE').encoding, 'utf-16le');
  });

  it('fatal:true 时非法序列抛 ERR_ENCODING_INVALID_ENCODED_DATA（回环判据）', () => {
    const bad = new Uint8Array([0x61, 0xed, 0xa0, 0x80, 0x62]); // WTF-8 的孤立代理项
    const lenient = new utilShim.TextDecoder('utf-8').decode(bad);
    assert.match(lenient, /\uFFFD/);
    assert.throws(
      () => new utilShim.TextDecoder('utf-8', { fatal: true }).decode(bad),
      (e: any) => e.code === 'ERR_ENCODING_INVALID_ENCODED_DATA',
    );
    // 宿主同样拒绝（码名不同：Node 用 ERR_ENCODING_INVALID_ENCODED_DATA 一致）
    assert.throws(() => new nodeUtil.TextDecoder('utf-8', { fatal: true }).decode(bad));
  });

  it('**只支持三个标签族**：其余合法标签明确抛 ERR_ENCODING_NOT_SUPPORTED（不给近似值）', () => {
    for (const label of ['windows-1252', 'ascii', 'utf-16be', 'shift_jis']) {
      assert.throws(
        () => new utilShim.TextDecoder(label),
        (e: any) => e.code === 'ERR_ENCODING_NOT_SUPPORTED',
        `${label} 应当明确抛错`,
      );
      // 宿主上是支持的 → 这是我们有意的缺失，不是抄漏了
      assert.doesNotThrow(() => new nodeUtil.TextDecoder(label));
    }
    assert.throws(() => new utilShim.TextDecoder('nope'), (e: any) => e.code === 'ERR_ENCODING_NOT_SUPPORTED');
  });

  it('流式解码（stream:true）明确抛错：那是 node:string_decoder 的活', () => {
    assert.throws(
      () => new utilShim.TextDecoder('utf-8').decode(new Uint8Array([0x61]), { stream: true }),
      (e: any) => e.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
    );
  });

  it('编解码确实走了宿主通道（不是沙箱内自实现）', () => {
    hostCalls.length = 0;
    new utilShim.TextEncoder().encode('x');
    assert.deepEqual(hostCalls, ['fromString:utf8']);
    hostCalls.length = 0;
    new utilShim.TextDecoder('utf-8').decode(new Uint8Array([0x78]));
    assert.deepEqual(hostCalls, ['toString:utf8']);
  });
});

describe('仿真 node:util —— 明确不做的面', () => {
  it('抛 ERR_NOT_SUPPORTED_IN_SANDBOX 而不是静默给近似值', () => {
    const names = [
      'styleText', 'MIMEType', 'aborted', 'transferableAbortSignal', 'transferableAbortController',
      'getCallSites', 'parseArgs', 'toUSVString', 'getSystemErrorMessage',
    ];
    for (const name of names) {
      assert.equal(typeof utilShim[name], 'function', `${name} 应当是函数`);
      assert.throws(() => utilShim[name](), (e: any) => e.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX', `${name}`);
      assert.equal(typeof (nodeUtil as any)[name], 'function', `${name} 在宿主上存在 → 我们是有意缺失`);
    }
  });
});
