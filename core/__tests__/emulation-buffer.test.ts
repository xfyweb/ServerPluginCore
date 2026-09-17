// node:buffer / node:string_decoder 仿真：**与宿主 Node 的差分对齐测试**
//
// 判卷人是 Node 自己：同一段输入分别喂给 shim 与宿主 `node:buffer` / `node:string_decoder`，
// 比"结果字节 / 字符串 / 抛出的 name+code"。这样对齐不靠我记忆里的 Node 语义，也不靠人判——
// 宿主说什么就是什么（AGENTS.md §4.1 的仿真层验收方式）。
//
// 为什么要"拷到临时目录再 import 路径"，而不是就地 data: URL 求值：
// `node-string_decoder.js` 要 `import './node-buffer.js'`（相对引用在 data: URL 里无法解析），
// 而我们要测的正是**真实产物字节**（沙箱 loader 服务的、构建层内联的都是这份）。做法同
// `sandbox-modules.test.ts` 顶部的 harness：逐字节拷 `node-*.js` + 写 `package.json`（`{"type":"module"}`）
// 让 `.js` 按 ESM 解析，再 `import(pathToFileURL(...))`。**不走沙箱 loader**（本文件测的是模块语义，
// 不是装载路径；装载与登记表冲突由父 agent 那边统一处理）。
//
// 桥：shim 只能从 `globalThis.__host` 取宿主能力，这里用**真实的宿主实现**（core/hostApi.ts 的 bytes 组）
// 加上**与 core/sandbox.ts 完全相同的宿主调用协议**（二进制参数必须 ArrayBuffer、结果 JSON 文本、
// 失败回错误信封）来喂它——所以测的不只是"我编解码算得对不对"，还有"我有没有按桥的规矩调"。
import { copyFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Buffer as HostBuffer } from 'node:buffer';
import { StringDecoder as HostStringDecoder } from 'node:string_decoder';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// 审计写隔离目录（`AUDIT_DIR` 在 audit.ts 模块加载时读环境变量）——本文件不跑沙箱、不落审计，
// 但 hostApi 的传递依赖里有 audit.ts，隔离一下免得将来某次改动把仓库的 .spc/audit 写大。
const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-emubuf-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;

/** shim 临时加载目录：逐字节拷贝产物 + `package.json` 标明 ESM */
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-emubuf-shims-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
const SHIM_SRC_DIR = fileURLToPath(new URL('../sandbox-modules/', import.meta.url));
for (const f of ['node-buffer.js', 'node-string_decoder.js']) {
  copyFileSync(join(SHIM_SRC_DIR, f), join(SHIM_DIR, f));
}
after(() => {
  rmSync(AUDIT_DIR, { recursive: true, force: true });
  rmSync(SHIM_DIR, { recursive: true, force: true });
});

/** 与 sandbox.ts 的 `toExactBytes` 同义：给沙箱的二进制必须是**恰好覆盖这些字节**的 ArrayBuffer */
function exactBytes(result: unknown): ArrayBuffer {
  assert.ok(result instanceof Uint8Array || result instanceof ArrayBuffer, 'binaryResult 必须真的返回字节');
  const view = result instanceof Uint8Array ? result : new Uint8Array(result);
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer as ArrayBuffer;
  return new Uint8Array(view).buffer;
}

/**
 * 宿主调用协议（core/sandbox.ts:405-509 的沙箱侧等价物）。
 *
 * 两条**必须**照着做、否则测不出真问题的地方：
 *   · 二进制参数只能是 `ArrayBuffer`——传视图给桥会以 "Couldn't allocate memory to get ArrayBuffer"
 *     失败（§3.2 坑 4）。这里直接 assert，让"shim 把视图递给桥"在测试里就炸；
 *   · 失败一律回**字符串信封** `{"__spcError":{code,params}}`（不用 vm.throw），
 *     所以 shim 必须自己把它还原/翻译成 Node 形状的错误。
 */
function makeHostChannel(hostApi: Record<string, any>, calls: string[]) {
  const call = (name: string, args: unknown[]): unknown => {
    const method = hostApi[name];
    const shaped = args.map((a) => {
      if (typeof a === 'string') return a;
      assert.ok(a instanceof ArrayBuffer, `桥的二进制参数必须是 ArrayBuffer，实际是 ${Object.prototype.toString.call(a)}`);
      return new Uint8Array(a);
    });
    calls.push(name);
    try {
      const result = method.fn(...shaped);
      return method.binaryResult ? exactBytes(result) : JSON.stringify(result ?? null);
    } catch (err: any) {
      const shape = err && typeof err.code === 'string' ? { code: err.code, params: err.params } : { code: 'INTERNAL' };
      return JSON.stringify({ __spcError: shape.params ? { code: shape.code, params: shape.params } : { code: shape.code } });
    }
  };
  return {
    'bytes.fromString': (text: unknown, enc: unknown) => call('bytes.fromString', [text, enc]),
    'bytes.toString': (data: unknown, enc: unknown) => call('bytes.toString', [data, enc]),
    'bytes.byteLength': (text: unknown, enc: unknown) => call('bytes.byteLength', [text, enc]),
  };
}

/** 规范化成"可比字符串"：字节 → hex；BigInt → `Nn`；抛错 → `THROW name:code` */
function canonical(value: unknown): string {
  const json = JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return v.toString() + 'n';
    if (v instanceof Uint8Array) return 'bytes:' + HostBuffer.from(v).toString('hex');
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    if (typeof v === 'number' && Object.is(v, -0)) return '-0';
    return v;
  });
  return json === undefined ? '<undefined>' : json;
}

function signature(fn: () => unknown): string {
  try {
    return 'OK ' + canonical(fn());
  } catch (err: any) {
    return 'THROW ' + (err && err.name) + ':' + (err && err.code);
  }
}

interface Subject {
  Buffer: any;
  StringDecoder: any;
  /** 宿主调用流水（断言"该过桥的过桥、不该过桥的别过桥"） */
  calls: string[];
}

// ── 用例表：每组都是"同一个函数跑两遍"，所以两边看到的输入完全相同 ──
// 返回 Uint8Array/Buffer/字符串/数组/数字都行，由 canonical 统一规范化。

type Case = [string, (M: Subject) => unknown];

const FROM_CASES: Case[] = [
  ['from 字符串 utf8 默认', (M) => M.Buffer.from('hello 世界')],
  ['from 字符串 utf8 显式', (M) => M.Buffer.from('hello', 'utf8')],
  ['from 字符串 utf-8 别名', (M) => M.Buffer.from('héllo', 'utf-8')],
  ['from 字符串 UTF8 大写', (M) => M.Buffer.from('héllo', 'UTF8')],
  ['from 字符串 latin1', (M) => M.Buffer.from('héllo', 'latin1')],
  ['from 字符串 binary 别名', (M) => M.Buffer.from('héllo', 'binary')],
  ['from 字符串 ascii 高位', (M) => M.Buffer.from('héllo', 'ascii')],
  ['from 字符串 utf16le', (M) => M.Buffer.from('hello 世界', 'utf16le')],
  ['from 字符串 ucs2 别名', (M) => M.Buffer.from('hello', 'ucs2')],
  ['from 字符串 ucs-2 别名', (M) => M.Buffer.from('hello', 'ucs-2')],
  ['from 字符串 base64 标准', (M) => M.Buffer.from('aGVsbG8gd29ybGQ=', 'base64')],
  ['from 字符串 base64 宽松（无填充/空白/非法字符）', (M) => M.Buffer.from('aGVs bG8*_\n', 'base64')],
  ['from 字符串 base64url', (M) => M.Buffer.from('aGVsbG8td29ybGQ_', 'base64url')],
  ['from 字符串 hex', (M) => M.Buffer.from('48656c6c6f', 'hex')],
  ['from 字符串 hex 奇数长度', (M) => M.Buffer.from('48656', 'hex')],
  ['from 字符串 hex 非法字符', (M) => M.Buffer.from('zzzz', 'hex')],
  ['from 非字符串编码一律当 utf8（数字）', (M) => M.Buffer.from('abc', 123)],
  ['from 非字符串编码一律当 utf8（null）', (M) => M.Buffer.from('abc', null)],
  ['from 空字符串编码当 utf8', (M) => M.Buffer.from('abc', '')],
  ['from 未知编码', (M) => M.Buffer.from('abc', 'nope')],
  ['from 未知编码 + 空串也抛', (M) => M.Buffer.from('', 'nope')],
  ['from 空串', (M) => M.Buffer.from('')],
  ['from 孤立代理项', (M) => M.Buffer.from('a\ud800b')],
  ['from 代理对', (M) => M.Buffer.from('😀')],
  ['from 数组', (M) => M.Buffer.from([1, 2, 3])],
  ['from 数组（越界/非数）', (M) => M.Buffer.from([256, -1, 1.5, '2', null, undefined, NaN])],
  ['from array-like 对象', (M) => M.Buffer.from({ length: 3, 0: '1', 1: 2, 2: 300 })],
  ['from length 非数 → 空', (M) => M.Buffer.from({ length: '2', 0: 1, 1: 2 })],
  ['from length 为负 → 空', (M) => M.Buffer.from({ length: -1 })],
  ['from toJSON 往返', (M) => M.Buffer.from(M.Buffer.from([1, 2, 3]).toJSON())],
  ['from {type:Buffer,data} 直建', (M) => M.Buffer.from({ type: 'Buffer', data: [9, 8] })],
  ['from Uint8Array（复制）', (M) => M.Buffer.from(new Uint8Array([1, 2, 3]))],
  ['from Uint16Array（按元素截断）', (M) => M.Buffer.from(new Uint16Array([1, 256, 65535]))],
  ['from DataView → 空', (M) => M.Buffer.from(new DataView(new ArrayBuffer(4)))],
  ['from new String()', (M) => M.Buffer.from(new String('abc') as any)],
  ['from valueOf 返回字符串的对象', (M) => M.Buffer.from({ valueOf: () => 'xy' } as any)],
  ['from 数字 → 抛（与 Buffer(n) 不同）', (M) => M.Buffer.from(5 as any)],
  ['from null', (M) => M.Buffer.from(null as any)],
  ['from undefined', (M) => M.Buffer.from(undefined as any)],
  ['from 普通对象', (M) => M.Buffer.from({} as any)],
  ['from ArrayBuffer 共享 + 全量', (M) => M.Buffer.from(new Uint8Array([1, 2, 3, 4]).buffer)],
  ['from ArrayBuffer + offset + length', (M) => M.Buffer.from(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2)],
  ['from ArrayBuffer + offset 越界', (M) => M.Buffer.from(new ArrayBuffer(4), 5)],
  ['from ArrayBuffer + length 越界', (M) => M.Buffer.from(new ArrayBuffer(4), 1, 9)],
  ['from ArrayBuffer + length 0', (M) => M.Buffer.from(new Uint8Array([1, 2]).buffer, 1, 0)],
  ['from ArrayBuffer + offset NaN → 0', (M) => M.Buffer.from(new ArrayBuffer(2), NaN)],
  ['from Buffer（整份复制，忽略 offset/length）', (M) => M.Buffer.from(M.Buffer.from([1, 2, 3]), 1, 2)],
];

const ALLOC_CASES: Case[] = [
  ['alloc 零填', (M) => M.Buffer.alloc(4)],
  ['alloc 数值填', (M) => M.Buffer.alloc(4, 7)],
  ['alloc 0 填', (M) => M.Buffer.alloc(3, 0)],
  ['alloc 单字符填', (M) => M.Buffer.alloc(4, 'a')],
  ['alloc 多字符填（循环）', (M) => M.Buffer.alloc(5, 'ab')],
  ['alloc 多字节字符截断', (M) => M.Buffer.alloc(3, 'é')],
  ['alloc 视图填（原始字节循环）', (M) => M.Buffer.alloc(5, new Uint8Array([1, 2]))],
  ['alloc 空视图填 → 抛', (M) => M.Buffer.alloc(4, new Uint8Array(0))],
  ['alloc 未知编码填', (M) => M.Buffer.alloc(4, 'a', 'nope')],
  ['alloc 负数尺寸', (M) => M.Buffer.alloc(-1)],
  ['alloc 小数尺寸（引擎截断）', (M) => M.Buffer.alloc(1.5)],
  ['alloc 字符串尺寸', (M) => M.Buffer.alloc('3' as any)],
  ['alloc 无参', (M) => M.Buffer.alloc(undefined as any)],
  ['alloc 0', (M) => M.Buffer.alloc(0)],
  ['allocUnsafe 长度', (M) => M.Buffer.allocUnsafe(3).length],
  ['allocUnsafe 0', (M) => M.Buffer.allocUnsafe(0).length],
  ['allocUnsafe 负数', (M) => M.Buffer.allocUnsafe(-1)],
  ['allocUnsafeSlow 长度', (M) => M.Buffer.allocUnsafeSlow(3).length],
  ['allocUnsafeSlow 负数', (M) => M.Buffer.allocUnsafeSlow(-1)],
  ['new Buffer(数字)', (M) => new M.Buffer(2)],
  ['concat 自动长度', (M) => M.Buffer.concat([M.Buffer.from([1, 2]), M.Buffer.from([3])])],
  ['concat 空数组', (M) => M.Buffer.concat([])],
  ['concat 显式长度（长 → 补零）', (M) => M.Buffer.concat([M.Buffer.from([1, 2]), M.Buffer.from([3])], 7)],
  ['concat 显式长度（短 → 截断）', (M) => M.Buffer.concat([M.Buffer.from([1, 2]), M.Buffer.from([3])], 2)],
  ['concat 显式长度 0', (M) => M.Buffer.concat([M.Buffer.from([1, 2])], 0)],
  ['concat 负长度', (M) => M.Buffer.concat([M.Buffer.from([1])], -1)],
  ['concat 小数长度', (M) => M.Buffer.concat([M.Buffer.from([1])], 1.5)],
  ['concat 非数组', (M) => M.Buffer.concat('x' as any)],
  ['concat 元素非 Buffer', (M) => M.Buffer.concat([1] as any)],
  ['concat 元素是 Uint16Array → 抛', (M) => M.Buffer.concat([new Uint16Array([1, 2])] as any)],
  ['concat 元素是普通 Uint8Array（允许）', (M) => M.Buffer.concat([new Uint8Array([1, 2])] as any)],
  ['of', (M) => M.Buffer.of(1, 2, 3)],
];

const INSTANCE_CASES: Case[] = [
  ['toString 默认 utf8', (M) => M.Buffer.from('hello 世界').toString()],
  ['toString 畸形 utf8（替换字符粒度）', (M) => M.Buffer.from([0x61, 0xff, 0x62, 0xc3]).toString('utf8')],
  ['toString 过长编码', (M) => M.Buffer.from([0xc0, 0x80]).toString('utf8')],
  ['toString 代理项三字节', (M) => M.Buffer.from([0xed, 0xa0, 0x80]).toString('utf8')],
  ['toString hex', (M) => M.Buffer.from([0xde, 0xad]).toString('hex')],
  ['toString HEX 大写', (M) => M.Buffer.from([0xde, 0xad]).toString('HEX')],
  ['toString base64', (M) => M.Buffer.from('hello').toString('base64')],
  ['toString base64url', (M) => M.Buffer.from([0xfb, 0xff]).toString('base64url')],
  ['toString latin1', (M) => M.Buffer.from([0xe9, 0x41]).toString('latin1')],
  ['toString ascii 高位被屏蔽', (M) => M.Buffer.from([0xe9, 0x41]).toString('ascii')],
  ['toString utf16le', (M) => M.Buffer.from('ab').toString('utf16le')],
  ['toString ucs2 别名', (M) => M.Buffer.from('ab').toString('ucs2')],
  ['toString start/end', (M) => M.Buffer.from('hello world').toString('utf8', 6, 11)],
  ['toString start 负数 → 整块', (M) => M.Buffer.from('hello').toString('utf8', -3)],
  ['toString start 超界 → 空', (M) => M.Buffer.from('hello').toString('utf8', 9)],
  ['toString end 超界 → 到末尾', (M) => M.Buffer.from('hello').toString('utf8', 1, 99)],
  ['toString end < start → 空', (M) => M.Buffer.from('hello').toString('utf8', 4, 2)],
  ['toString start NaN', (M) => M.Buffer.from('hello').toString('utf8', NaN, 3)],
  ['toString end NaN → 空', (M) => M.Buffer.from('hello').toString('utf8', 0, NaN)],
  ['toString 小数 start/end', (M) => M.Buffer.from('hello').toString('utf8', 1.7, 4.9)],
  ['toString encoding=undefined 带区间', (M) => M.Buffer.from('hello').toString(undefined, 1, 3)],
  ['toString encoding=null → 抛', (M) => M.Buffer.from('hello').toString(null as any, 1, 3)],
  ['toString encoding=数字 → 抛', (M) => M.Buffer.from('hello').toString(123 as any)],
  ['toString encoding 是 toString 为 hex 的对象', (M) => M.Buffer.from('hello').toString({ toString: () => 'hex' } as any)],
  ['toString 未知编码', (M) => M.Buffer.from('hello').toString('nope')],
  ['toString 空串编码 → 抛（空串不是 isEncoding 认的名字）', (M) => M.Buffer.from('hello').toString('')],
  ['toString 空缓冲', (M) => M.Buffer.alloc(0).toString('hex')],
  ['toJSON', (M) => M.Buffer.from([1, 2]).toJSON()],
  ['toJSON 空', (M) => M.Buffer.alloc(0).toJSON()],
  ['JSON.stringify 走 toJSON', (M) => JSON.stringify(M.Buffer.from([1, 2]))],
  ['equals 相同内容', (M) => M.Buffer.from([1, 2]).equals(M.Buffer.from([1, 2]))],
  ['equals 不同长度', (M) => M.Buffer.from([1, 2]).equals(M.Buffer.from([1]))],
  ['equals Uint8Array', (M) => M.Buffer.from([1, 2]).equals(new Uint8Array([1, 2]))],
  ['equals 自身引用', (M) => {
    const b = M.Buffer.from([1, 2]);
    return b.equals(b);
  }],
  ['equals 非字节 → 抛', (M) => M.Buffer.from([1]).equals('x' as any)],
  ['equals Uint16Array → 抛', (M) => M.Buffer.from([1, 2]).equals(new Uint16Array([1, 2]) as any)],
  ['静态 compare 小于', (M) => M.Buffer.compare(M.Buffer.from([1, 2]), M.Buffer.from([1, 3]))],
  ['静态 compare 相等', (M) => M.Buffer.compare(M.Buffer.from([1, 2]), M.Buffer.from([1, 2]))],
  ['静态 compare 前缀', (M) => M.Buffer.compare(M.Buffer.from([1]), M.Buffer.from([1, 2]))],
  ['静态 compare 空', (M) => M.Buffer.compare(M.Buffer.alloc(0), M.Buffer.alloc(0))],
  ['静态 compare 参数类型', (M) => M.Buffer.compare('x' as any, M.Buffer.from([1]))],
  ['静态 compare 第二参类型', (M) => M.Buffer.compare(M.Buffer.from([1]), 'x' as any)],
  ['实例 compare 全区', (M) => M.Buffer.from([1, 2, 3]).compare(M.Buffer.from([1, 2, 4]))],
  ['实例 compare 带区间', (M) => M.Buffer.from([9, 1, 2, 9]).compare(M.Buffer.from([8, 1, 3, 8]), 1, 3, 1, 3)],
  ['实例 compare 空源区间', (M) => M.Buffer.from([1, 2]).compare(M.Buffer.from([2, 3]), 0, 2, 2, 1)],
  ['实例 compare 空目标区间', (M) => M.Buffer.from([1, 2]).compare(M.Buffer.from([2, 3]), 2, 1, 0, 1)],
  ['实例 compare targetStart 越界', (M) => M.Buffer.from([1]).compare(M.Buffer.from([1]), 5 as any)],
  ['实例 compare targetEnd 越界', (M) => M.Buffer.from([1]).compare(M.Buffer.from([1, 2]), 0, 5)],
  ['实例 compare 非字节目标', (M) => M.Buffer.from([1]).compare('x' as any)],
  ['copy 基本', (M) => {
    const t = M.Buffer.alloc(4);
    return [M.Buffer.from([1, 2, 3]).copy(t, 1), t];
  }],
  ['copy sourceStart 截断', (M) => {
    const t = M.Buffer.alloc(4);
    return [M.Buffer.from([1, 2, 3]).copy(t, 1, 1), t];
  }],
  ['copy sourceEnd', (M) => {
    const t = M.Buffer.alloc(4);
    return [M.Buffer.from([1, 2, 3]).copy(t, 1, 1, 2), t];
  }],
  ['copy sourceEnd 超界 → 截到源长', (M) => {
    const t = M.Buffer.alloc(4);
    return [M.Buffer.from([1, 2, 3]).copy(t, 1, 1, 9), t];
  }],
  ['copy sourceStart 超界 → 抛', (M) => M.Buffer.from([1, 2, 3]).copy(M.Buffer.alloc(4), 1, 5)],
  ['copy targetStart 负 → 抛', (M) => M.Buffer.from([1]).copy(M.Buffer.alloc(2), -1)],
  ['copy targetStart 越界 → 0', (M) => {
    const t = M.Buffer.alloc(2);
    return [M.Buffer.from([1, 2]).copy(t, 5), t];
  }],
  ['copy 小数 sourceStart', (M) => {
    const t = M.Buffer.alloc(4);
    return [M.Buffer.from([1, 2, 3]).copy(t, 1, 1.5), t];
  }],
  ['copy 到普通 Uint8Array', (M) => {
    const t = new Uint8Array(2);
    return [M.Buffer.from([1, 2]).copy(t), t];
  }],
  ['copy 目标非视图 → 抛', (M) => M.Buffer.from([1]).copy('x' as any)],
  ['copy 源与目标重叠（前移）', (M) => {
    const b = M.Buffer.from([1, 2, 3, 4, 5]);
    const n = b.copy(b, 1, 0, 4);
    return [n, b];
  }],
  ['fill 单字符', (M) => M.Buffer.alloc(4, 7).fill('a', 1, 3)],
  ['fill 多字符循环', (M) => M.Buffer.alloc(5, 7).fill('ab')],
  ['fill utf8 多字节循环', (M) => M.Buffer.alloc(4, 7).fill('é')],
  ['fill utf8 多字节截断', (M) => M.Buffer.alloc(3, 7).fill('é')],
  ['fill ucs2', (M) => M.Buffer.alloc(4, 7).fill('ሴ', 'ucs2')],
  ['fill hex（整串前缀 + 循环）', (M) => M.Buffer.alloc(5, 7).fill('abc', 'hex')],
  ['fill hex 前缀截断', (M) => M.Buffer.alloc(2, 7).fill('aabbcc', 'hex')],
  ['fill hex 非法 → 抛', (M) => M.Buffer.alloc(4, 7).fill('zz', 'hex')],
  ['fill base64', (M) => M.Buffer.alloc(8, 7).fill('aGVsbG8=', 'base64')],
  ['fill 空串 → 0', (M) => M.Buffer.alloc(4, 7).fill('')],
  ['fill 数值', (M) => M.Buffer.alloc(4, 7).fill(1, 1)],
  ['fill null → 0', (M) => M.Buffer.alloc(4, 7).fill(null as any)],
  ['fill undefined → 0', (M) => M.Buffer.alloc(4, 7).fill(undefined as any)],
  ['fill 视图模式', (M) => M.Buffer.alloc(4, 7).fill(new Uint8Array([1, 2]))],
  ['fill DataView 模式（原始字节）', (M) => M.Buffer.alloc(4, 7).fill(new DataView(new Uint8Array([1, 2]).buffer))],
  ['fill Uint16Array 模式（原始字节）', (M) => M.Buffer.alloc(4, 7).fill(new Uint16Array([0x0102]))],
  ['fill 子视图模式', (M) => M.Buffer.alloc(4, 7).fill(new Uint8Array([1, 2, 3]).subarray(1, 3))],
  ['fill offset 超过 end → 原样返回', (M) => M.Buffer.alloc(4, 7).fill(1, 5)],
  ['fill end 越界 → 抛', (M) => M.Buffer.alloc(4, 7).fill('a', 0, 9)],
  ['fill offset 负 → 抛', (M) => M.Buffer.alloc(4, 7).fill('a', -1)],
  ['fill offset 小数 → 抛', (M) => M.Buffer.alloc(4, 7).fill('a', 1.5)],
  ['fill 未知编码', (M) => M.Buffer.alloc(4, 7).fill('a', 'nope')],
  ['fill 编码是数字 → 抛', (M) => M.Buffer.alloc(4, 7).fill('a', 0, 4, 123 as any)],
  ['fill 编码 null → utf8', (M) => M.Buffer.alloc(4, 7).fill('a', 0, 4, null as any)],
  ['fill 返回值是自身', (M) => {
    const b = M.Buffer.alloc(2);
    return b.fill(1) === b;
  }],
  ['indexOf 数字针', (M) => M.Buffer.from([1, 2, 3, 2, 1]).indexOf(2)],
  ['indexOf 数字针 256 取模', (M) => M.Buffer.from([0, 1]).indexOf(256)],
  ['indexOf 数字针 -1 取模', (M) => M.Buffer.from([255]).indexOf(-1)],
  ['indexOf 数字针 小数', (M) => M.Buffer.from([1, 2]).indexOf(1.5)],
  ['indexOf 负偏移', (M) => M.Buffer.from([1, 2, 3, 2, 1]).indexOf(2, -2)],
  ['indexOf NaN 偏移', (M) => M.Buffer.from([1, 2, 1]).indexOf(1, NaN)],
  ['indexOf end 限制', (M) => M.Buffer.from([1, 2, 1]).indexOf(1, 0, 1)],
  ['indexOf 偏移为字符串（当编码）', (M) => M.Buffer.from('abcabc').indexOf('a', 'utf8')],
  ['indexOf 空缓冲 + 空针', (M) => M.Buffer.alloc(0).indexOf('')],
  ['lastIndexOf 数字针', (M) => M.Buffer.from([1, 2, 3, 2, 1]).lastIndexOf(2)],
  ['lastIndexOf 负偏移', (M) => M.Buffer.from([1, 2, 3, 2, 1]).lastIndexOf(2, -2)],
  ['lastIndexOf NaN 偏移', (M) => M.Buffer.from([1, 2, 1]).lastIndexOf(1, NaN)],
  ['lastIndexOf 极小负偏移（钳到 int32 下界）', (M) => M.Buffer.from([1, 2, 1]).lastIndexOf(1, -4294967297)],
  ['lastIndexOf 空针', (M) => M.Buffer.from([1, 2, 3]).lastIndexOf('')],
  ['lastIndexOf 空针 + 偏移', (M) => M.Buffer.from([1, 2, 3]).lastIndexOf('', 3)],
  ['indexOf 字符串针', (M) => M.Buffer.from('hello world').indexOf('o', 5)],
  ['lastIndexOf 字符串针', (M) => M.Buffer.from('hello world').lastIndexOf('o', 5)],
  ['indexOf 字符串针 + 编码 hex', (M) => M.Buffer.from([0xab, 0xcd]).indexOf('ABCD', 0, undefined, 'hex')],
  ['indexOf 字符串针 + 编码 base64', (M) => M.Buffer.from('hello').indexOf('aGVs', 0, undefined, 'base64')],
  ['indexOf 字符串针 + 编码 utf16le', (M) => M.Buffer.from('abc', 'utf16le').indexOf('b', 0, undefined, 'utf16le')],
  ['indexOf Buffer 针', (M) => M.Buffer.from([1, 2, 3, 2, 1]).indexOf(M.Buffer.from([3, 2]))],
  ['indexOf Buffer 针 + 重叠', (M) => M.Buffer.from([1, 1, 1]).indexOf(M.Buffer.from([1, 1]))],
  ['indexOf Buffer 针 + 未知编码（不抛）', (M) => M.Buffer.from([1, 2]).indexOf(M.Buffer.from([2]), 0, undefined, 'nope')],
  ['indexOf 字符串针 + 未知编码 → 抛', (M) => M.Buffer.from([1, 2]).indexOf('x', 0, undefined, 'nope')],
  ['indexOf Uint16Array 针 → 抛', (M) => M.Buffer.from([1, 2]).indexOf(new Uint16Array([1, 2]) as any)],
  ['lastIndexOf 起点恰在命中处', (M) => {
    const hay = M.Buffer.from([0, 1, 2, 3]);
    return hay.lastIndexOf(M.Buffer.from([1, 2]), 1);
  }],
  ['includes 数字', (M) => M.Buffer.from([1, 2, 1]).includes(2, 0, 2)],
  ['includes 字符串', (M) => M.Buffer.from('abc').includes('bc')],
  ['includes 空针', (M) => M.Buffer.from([1]).includes('')],
  ['subarray 共享区间', (M) => M.Buffer.from([1, 2, 3, 4]).subarray(1, 3)],
  ['subarray 负索引', (M) => M.Buffer.from([1, 2, 3, 4]).subarray(-2)],
  ['subarray 小数索引', (M) => M.Buffer.from([1, 2, 3, 4]).subarray(1.7, 3.2)],
  ['subarray NaN', (M) => M.Buffer.from([1, 2, 3, 4]).subarray(NaN, NaN)],
  ['subarray 超界', (M) => M.Buffer.from([1, 2, 3, 4]).subarray(9)],
  ['subarray end < start', (M) => M.Buffer.from([1, 2, 3, 4]).subarray(2, 1)],
  ['slice 与 subarray 同义（内容）', (M) => M.Buffer.from([1, 2, 3, 4]).slice(1, 3)],
  ['slice isBuffer', (M) => M.Buffer.isBuffer(M.Buffer.from([1, 2]).slice(0, 1))],
  ['slice.length（arity）', (M) => M.Buffer.prototype.slice.length],
  ['write 基本', (M) => {
    const b = M.Buffer.alloc(4);
    return [b.write('ab'), b];
  }],
  ['write 截断到缓冲尾', (M) => {
    const b = M.Buffer.alloc(4);
    return [b.write('abcdef'), b];
  }],
  ['write utf8 半个字符不写（0 字节）', (M) => {
    const b = M.Buffer.alloc(3);
    return [b.write('é', 0, 1), b];
  }],
  ['write utf8 字符边界回退', (M) => {
    const b = M.Buffer.alloc(4);
    return [b.write('aé', 0, 2), b];
  }],
  ['write latin1 不做边界回退', (M) => {
    const b = M.Buffer.alloc(3);
    return [b.write('é', 0, 1, 'latin1'), b];
  }],
  ['write ucs2 2 字节对齐', (M) => {
    const b = M.Buffer.alloc(3);
    return [b.write('ab', 0, 3, 'ucs2'), b];
  }],
  ['write hex 前缀截断', (M) => {
    const b = M.Buffer.alloc(4);
    return [b.write('aabbcc', 0, 3, 'hex'), b];
  }],
  ['write base64 前缀截断', (M) => {
    const b = M.Buffer.alloc(4);
    return [b.write('aGVsbG8=', 0, 3, 'base64'), b];
  }],
  ['write 偏移越界 → 抛', (M) => M.Buffer.alloc(4).write('x', 5)],
  ['write 长度越界 → 抛', (M) => M.Buffer.alloc(4).write('x', 0, 9)],
  ['write 长度参数是编码', (M) => {
    const b = M.Buffer.alloc(4);
    return [b.write('ab', 0, 'hex'), b];
  }],
  ['write 编码未知 → 抛', (M) => M.Buffer.alloc(4).write('x', 0, 2, 'nope')],
  ['write 非字符串 → 抛', (M) => M.Buffer.alloc(4).write(0x1234 as any)],
  ['write 孤立代理项当替换字符', (M) => {
    const b = M.Buffer.alloc(4);
    return [b.write('\ud800'), b];
  }],
  ['write 替换字符放不下就不写', (M) => {
    const b = M.Buffer.alloc(3);
    return [b.write('a\ud800', 0, 2), b];
  }],
  ['swap16', (M) => M.Buffer.from([1, 2, 3, 4]).swap16()],
  ['swap16 奇数长度 → 抛', (M) => M.Buffer.from([1]).swap16()],
  ['swap32', (M) => M.Buffer.from([1, 2, 3, 4]).swap32()],
  ['swap32 非 4 倍数 → 抛', (M) => M.Buffer.from([1, 2]).swap32()],
  ['swap64', (M) => M.Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap64()],
  ['swap64 非 8 倍数 → 抛', (M) => M.Buffer.from([1, 2, 3, 4]).swap64()],
  ['swap 返回自身', (M) => {
    const b = M.Buffer.from([1, 2]);
    return b.swap16() === b;
  }],
  ['toLocaleString 等同 toString', (M) => M.Buffer.from('ab').toLocaleString()],
];

const NUMERIC_CASES: Case[] = [
  ['readUInt8/BE/LE 组合', (M) => {
    const b = M.Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    return [b.readUInt8(0), b.readUInt16LE(0), b.readUInt16BE(0), b.readUInt32LE(0), b.readUInt32BE(0)];
  }],
  ['readUIntLE/BE 非 2 的幂字节数', (M) => {
    const b = M.Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    return [b.readUIntLE(0, 3), b.readUIntLE(0, 5), b.readUIntLE(0, 6), b.readUIntBE(0, 3), b.readUIntBE(0, 5), b.readUIntBE(0, 6)];
  }],
  ['readUIntLE byteLength 越界', (M) => M.Buffer.alloc(8).readUIntLE(0, 7)],
  ['readUIntLE byteLength 缺省', (M) => M.Buffer.alloc(8).readUIntLE(0, undefined as any)],
  ['readUIntLE byteLength 0', (M) => M.Buffer.alloc(8).readUIntLE(0, 0)],
  ['readUIntLE offset 缺省', (M) => M.Buffer.alloc(8).readUIntLE(undefined as any, 2)],
  ['readInt 全系列', (M) => {
    const b = M.Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    return [b.readInt8(0), b.readInt16LE(0), b.readInt16BE(0), b.readInt32LE(0), b.readInt32BE(0), b.readIntLE(0, 3), b.readIntLE(0, 5), b.readIntLE(0, 6), b.readIntBE(0, 3), b.readIntBE(0, 5), b.readIntBE(0, 6)];
  }],
  ['readInt8 边界', (M) => M.Buffer.from([0x7f, 0x80, 0xff]).readInt8(1)],
  ['readBigUInt64LE/BE', (M) => {
    const b = M.Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    return [b.readBigUInt64LE(0), b.readBigUInt64BE(0), b.readBigInt64LE(0), b.readBigInt64BE(0)];
  }],
  ['readBigUint64 别名', (M) => M.Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).readBigUint64LE(0)],
  ['readFloat/Double LE/BE', (M) => {
    const b = M.Buffer.from([0x00, 0x00, 0xc0, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f]);
    return [b.readFloatLE(0), b.readFloatBE(0), b.readDoubleLE(4), b.readDoubleBE(4)];
  }],
  ['read 偏移越界（各宽度）', (M) => {
    const b = M.Buffer.alloc(8);
    return [b.readUInt8(9), b.readUInt16LE(7), b.readUInt32LE(5), b.readDoubleLE(1), b.readBigUInt64LE(1)];
  }],
  ['read 负偏移', (M) => M.Buffer.alloc(8).readUInt8(-1)],
  ['read 小数偏移', (M) => M.Buffer.alloc(8).readUInt8(1.5)],
  ['read NaN 偏移', (M) => M.Buffer.alloc(8).readUInt8(NaN)],
  ['read 字符串偏移', (M) => M.Buffer.alloc(8).readUInt8('0' as any)],
  ['writeUInt8 边界', (M) => {
    const b = M.Buffer.alloc(2);
    b.writeUInt8(255, 0);
    return b;
  }],
  ['writeUInt8 越界值', (M) => M.Buffer.alloc(2).writeUInt8(256)],
  ['writeUInt8 负值', (M) => M.Buffer.alloc(2).writeUInt8(-1)],
  ['writeUInt8 字符串值（ToNumber→0）', (M) => {
    const b = M.Buffer.alloc(2);
    return [b.writeUInt8('a' as any), b];
  }],
  ['writeUInt8 小数值（截断）', (M) => {
    const b = M.Buffer.alloc(2);
    return [b.writeUInt8(1.5), b];
  }],
  ['writeUInt8 NaN 值', (M) => {
    const b = M.Buffer.alloc(2);
    return [b.writeUInt8(NaN), b];
  }],
  ['writeUInt8 偏移越界', (M) => M.Buffer.alloc(2).writeUInt8(1, 9)],
  ['writeUInt8 字符串偏移', (M) => M.Buffer.alloc(2).writeUInt8(1, '0' as any)],
  ['writeUInt 系列 LE/BE', (M) => {
    const b = M.Buffer.alloc(8);
    b.writeUInt16LE(0x0201, 0);
    b.writeUInt16BE(0x0304, 2);
    b.writeUInt32LE(0x08070605, 4);
    return b;
  }],
  ['writeUInt32LE 值越界', (M) => M.Buffer.alloc(4).writeUInt32LE(0x0102030405)],
  ['writeUIntLE 非 2 的幂', (M) => {
    const b = M.Buffer.alloc(8);
    const n = b.writeUIntLE(0x123456789a, 0, 5);
    return [n, b];
  }],
  ['writeUIntLE byteLength 越界', (M) => M.Buffer.alloc(8).writeUIntLE(1, 0, 7)],
  ['writeInt 系列', (M) => {
    const b = M.Buffer.alloc(8);
    b.writeInt8(-1, 0);
    b.writeInt16LE(-2, 1);
    b.writeInt32BE(-3, 4);
    return b;
  }],
  ['writeInt8 越界', (M) => M.Buffer.alloc(2).writeInt8(-129)],
  ['writeBigUInt64LE/BE', (M) => {
    const b = M.Buffer.alloc(16);
    b.writeBigUInt64LE(0x0102030405060708n, 0);
    b.writeBigInt64BE(-2n, 8);
    return b;
  }],
  ['writeBigUInt64 非 BigInt → TypeError（无 code）', (M) => M.Buffer.alloc(8).writeBigUInt64LE('x' as any)],
  ['writeBigUInt64 越界', (M) => M.Buffer.alloc(8).writeBigUInt64LE(-1n)],
  ['writeBigUInt64 偏移越界', (M) => M.Buffer.alloc(4).writeBigUInt64LE(1n)],
  ['writeBigUint64 别名', (M) => {
    const b = M.Buffer.alloc(8);
    b.writeBigUint64BE(1n);
    return b;
  }],
  ['writeFloat/Double', (M) => {
    const b = M.Buffer.alloc(12);
    b.writeFloatLE(1.5, 0);
    b.writeFloatBE(-1.5, 4);
    b.writeDoubleLE(1.5, 4);
    return b;
  }],
  ['writeDouble 偏移越界', (M) => M.Buffer.alloc(8).writeDoubleLE(1.5, 5)],
];

const MISC_CASES: Case[] = [
  ['isBuffer 真 Buffer', (M) => M.Buffer.isBuffer(M.Buffer.from([1]))],
  ['isBuffer 普通 Uint8Array', (M) => M.Buffer.isBuffer(new Uint8Array(1))],
  ['isBuffer 非字节值', (M) => M.Buffer.isBuffer('x' as any)],
  ['instanceof Uint8Array', (M) => M.Buffer.from([1]) instanceof Uint8Array],
  ['isEncoding 全表', (M) => {
    const list = ['utf8', 'utf-8', 'UTF8', 'utf16le', 'ucs2', 'ucs-2', 'latin1', 'binary', 'ascii', 'base64', 'base64url', 'hex', 'HEX', '', 'nope', undefined, null, 123];
    return list.map((e) => (typeof e === 'string' ? e : String(e)) + '=' + M.Buffer.isEncoding(e as any));
  }],
  ['byteLength 字符串 utf8', (M) => M.Buffer.byteLength('héllo 世界')],
  ['byteLength 各编码', (M) => ['utf8', 'latin1', 'ascii', 'ucs2', 'utf16le', 'base64', 'base64url', 'hex'].map((e) => M.Buffer.byteLength('héllo', e))],
  ['byteLength base64/hex 的取整规则', (M) => [M.Buffer.byteLength('abc', 'base64'), M.Buffer.byteLength('abcd', 'base64'), M.Buffer.byteLength('abcde', 'hex'), M.Buffer.byteLength('a', 'hex')]],
  ['byteLength 未知编码 → 按 utf8（不抛）', (M) => M.Buffer.byteLength('héllo', 'nope')],
  ['byteLength 非字符串编码', (M) => M.Buffer.byteLength('abcd', 123 as any)],
  ['byteLength 视图/ArrayBuffer', (M) => [M.Buffer.byteLength(new Uint8Array(3)), M.Buffer.byteLength(new Uint16Array(3)), M.Buffer.byteLength(new ArrayBuffer(3))]],
  ['byteLength 非字符串非字节 → 抛', (M) => M.Buffer.byteLength(123 as any)],
  ['byteLength 空串', (M) => M.Buffer.byteLength('')],
  ['entries/keys/values', (M) => {
    const b = M.Buffer.from([7, 8]);
    return [b.entries().next().value, b.keys().next().value, b.values().next().value];
  }],
  ['Symbol.iterator（展开）', (M) => [...M.Buffer.from([7, 8])]],
  ['Object.keys 是索引', (M) => Object.keys(M.Buffer.from([7, 8]))],
  ['索引读写', (M) => {
    const b = M.Buffer.alloc(2);
    b[0] = 300;
    return b;
  }],
  ['set 复制', (M) => {
    const b = M.Buffer.alloc(4);
    b.set([1, 2], 1);
    return b;
  }],
];

const DECODER_CASES: Case[] = [
  ['构造器 默认/别名/未知', (M) => {
    const out: unknown[] = [];
    for (const enc of [undefined, null, '', 'utf8', 'UTF-8', 'ucs2', 'ucs-2', 'utf16le', 'UTF-16LE', 'latin1', 'binary', 'ascii', 'base64', 'base64url', 'hex', 'HEX', 'nope', 123]) {
      try {
        out.push(String(enc) + '=' + new M.StringDecoder(enc as any).encoding);
      } catch (err: any) {
        out.push(String(enc) + '=THROW:' + err.code);
      }
    }
    return out;
  }],
  ['write 字符串原样返回', (M) => new M.StringDecoder('utf8').write('abc' as any)],
  ['write 非视图 → 抛', (M) => new M.StringDecoder('utf8').write(new Uint8Array([1]).buffer as any)],
  ['write 数字 → 抛', (M) => new M.StringDecoder('utf8').write(123 as any)],
  ['write null → 抛', (M) => new M.StringDecoder('utf8').write(null as any)],
  ['write Uint8Array', (M) => new M.StringDecoder('utf8').write(new Uint8Array([0x61, 0x62]))],
  ['write DataView（带偏移）', (M) => {
    const ab = new Uint8Array([0x7a, 0x41, 0x42]).buffer;
    return new M.StringDecoder('utf8').write(new DataView(ab, 1, 2));
  }],
  ['write Uint16Array（原始字节）', (M) => new M.StringDecoder('utf8').write(new Uint16Array([0x0041, 0x0042]))],
  // ── 它存在的唯一理由：跨 chunk 切断一个多字节字符 ──
  ['utf8 三段切开的 €', (M) => {
    const d = new M.StringDecoder('utf8');
    return [d.write(M.Buffer.from([0xe2])), d.write(M.Buffer.from([0x82])), d.write(M.Buffer.from([0xac]))];
  }],
  ['utf8 两段切开的 €', (M) => {
    const d = new M.StringDecoder('utf8');
    return [d.write(M.Buffer.from([0xe2, 0x82])), d.write(M.Buffer.from([0xac, 0x41]))];
  }],
  ['utf8 两段切开的 emoji（4 字节）', (M) => {
    const d = new M.StringDecoder('utf8');
    return [d.write(M.Buffer.from([0xf0, 0x9f])), d.write(M.Buffer.from([0x98, 0x80]))];
  }],
  ['utf8 前一块以 ASCII 结尾 + 后一块多字节', (M) => {
    const d = new M.StringDecoder('utf8');
    return [d.write(M.Buffer.from([0x41, 0xe2])), d.write(M.Buffer.from([0x82, 0xac]))];
  }],
  ['utf8 半个字符后跟非续接字节', (M) => {
    const d = new M.StringDecoder('utf8');
    return [d.write(M.Buffer.from([0xe2, 0x82])), d.write(M.Buffer.from([0x41])), d.end()];
  }],
  ['utf8 单字节非法（ff）立即出替换字符', (M) => new M.StringDecoder('utf8').write(M.Buffer.from([0xff]))],
  ['utf8 续接字节打头（80）', (M) => new M.StringDecoder('utf8').write(M.Buffer.from([0x80]))],
  ['utf8 连续续接字节 >= 4', (M) => new M.StringDecoder('utf8').write(M.Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80]))],
  ['utf8 过长编码 c0 80（留载后 flush）', (M) => {
    const d = new M.StringDecoder('utf8');
    return [d.write(M.Buffer.from([0xc0, 0x80])), d.lastNeed, d.lastTotal, d.end()];
  }],
  ['utf8 e0 80 留一个字节', (M) => {
    const d = new M.StringDecoder('utf8');
    return [d.write(M.Buffer.from([0xe0, 0x80])), d.lastNeed, d.lastTotal, d.end()];
  }],
  ['utf8 f5 80 前导超范围', (M) => {
    const d = new M.StringDecoder('utf8');
    return [d.write(M.Buffer.from([0xf5, 0x80])), d.lastNeed, d.lastTotal];
  }],
  ['utf8 f8 前导非法', (M) => {
    const d = new M.StringDecoder('utf8');
    return [d.write(M.Buffer.from([0xf8, 0x80, 0x80, 0x80, 0x80])), d.lastNeed, d.lastTotal];
  }],
  ['utf8 代理项三字节（非法）', (M) => new M.StringDecoder('utf8').write(M.Buffer.from([0xed, 0xa0, 0x80]))],
  ['utf8 坏字节之后再截断', (M) => {
    const d = new M.StringDecoder('utf8');
    return [d.write(M.Buffer.from([0x61, 0xff])), d.lastNeed, d.write(M.Buffer.from([0xe2])), d.lastNeed, d.end()];
  }],
  ['utf8 空块', (M) => {
    const d = new M.StringDecoder('utf8');
    return [d.write(M.Buffer.alloc(0)), d.lastNeed, d.end()];
  }],
  ['lastNeed/lastTotal/lastChar（2/3 字节）', (M) => {
    const d = new M.StringDecoder('utf8');
    d.write(M.Buffer.from([0xe2, 0x82]));
    return [d.lastNeed, d.lastTotal, d.lastChar.length, d.lastChar.constructor.name, M.Buffer.from(d.lastChar).toString('hex')];
  }],
  ['lastChar 完成后归零但槽不清空', (M) => {
    const d = new M.StringDecoder('utf8');
    d.write(M.Buffer.from([0xe2]));
    const before = M.Buffer.from(d.lastChar).toString('hex');
    d.end();
    return [before, M.Buffer.from(d.lastChar).toString('hex'), d.lastNeed, d.lastTotal];
  }],
  ['end() 冲掉半个字符 → 替换字符', (M) => {
    const d = new M.StringDecoder('utf8');
    d.write(M.Buffer.from([0xe2, 0x82]));
    return d.end();
  }],
  ['end(buf) 先 write 再 flush', (M) => new M.StringDecoder('utf8').end(M.Buffer.from([0xe2, 0x82]))],
  ['end(null) → 抛', (M) => new M.StringDecoder('utf8').end(null as any)],
  ['end(\'str\') 原样返回', (M) => new M.StringDecoder('utf8').end('ab' as any)],
  ['end() 后可复用', (M) => {
    const d = new M.StringDecoder('utf8');
    d.write(M.Buffer.from([0xe2]));
    d.end();
    return [d.lastNeed, d.write(M.Buffer.from([0x41]))];
  }],
  ['utf16le 半个码元', (M) => {
    const d = new M.StringDecoder('utf16le');
    return [d.write(M.Buffer.from([0x61])), d.lastNeed, d.lastTotal, d.write(M.Buffer.from([0x00]))];
  }],
  ['utf16le 三段（3 字节）', (M) => {
    const d = new M.StringDecoder('utf16le');
    return [d.write(M.Buffer.from([0x61, 0x00, 0x62])), d.lastNeed, d.lastTotal, M.Buffer.from(d.lastChar).toString('hex'), d.end()];
  }],
  ['utf16le 切断代理对', (M) => {
    const d = new M.StringDecoder('utf16le');
    const buf = M.Buffer.from('😀', 'utf16le');
    return [d.write(buf.subarray(0, 2)), d.lastNeed, d.lastTotal, d.write(buf.subarray(2))];
  }],
  ['utf16le end() 丢掉单个尾字节', (M) => {
    const d = new M.StringDecoder('utf16le');
    d.write(M.Buffer.from([0x61]));
    return d.end();
  }],
  ['latin1 无状态', (M) => new M.StringDecoder('latin1').write(M.Buffer.from([0xe9, 0x41]))],
  ['ascii 屏蔽高位', (M) => new M.StringDecoder('ascii').write(M.Buffer.from([0xe9, 0x41]))],
  ['hex 是"编码"不是"解码"', (M) => new M.StringDecoder('hex').write(M.Buffer.from([0x61, 0x62, 0x63]))],
  ['hex 跨块无状态', (M) => {
    const d = new M.StringDecoder('hex');
    return [d.write(M.Buffer.from('ab')), d.lastNeed, d.lastTotal, d.write(M.Buffer.from('cd'))];
  }],
  ['base64 是"编码"不是"解码"', (M) => new M.StringDecoder('base64').write(M.Buffer.from('aGk='))],
  ['base64 留 3 字节组', (M) => {
    const d = new M.StringDecoder('base64');
    return [d.write(M.Buffer.from('aGVsb')), d.lastNeed, d.lastTotal, M.Buffer.from(d.lastChar).toString('hex')];
  }],
  ['base64 跨块补齐', (M) => {
    const d = new M.StringDecoder('base64');
    return [d.write(M.Buffer.from('aG')), d.lastNeed, d.lastTotal, d.write(M.Buffer.from('Vs')), d.end()];
  }],
  ['base64url 同理', (M) => {
    const d = new M.StringDecoder('base64url');
    return [d.write(M.Buffer.from('aG')), d.lastNeed, d.end()];
  }],
  ['流式读取与整体解码等价（分块不改结果）', (M) => {
    const text = '流式解码：hello 世界 😀 café';
    const bytes = M.Buffer.from(text, 'utf8');
    const d = new M.StringDecoder('utf8');
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) out += d.write(bytes.subarray(i, Math.min(i + 3, bytes.length)));
    out += d.end();
    return [out === text, out];
  }],
  ['两实例互不干扰', (M) => {
    const a = new M.StringDecoder('utf8');
    const b = new M.StringDecoder('utf8');
    a.write(M.Buffer.from([0xe2]));
    return [a.lastNeed, b.lastNeed, b.lastTotal];
  }],
  ['encoding 是自有可枚举属性', (M) => Object.keys(new M.StringDecoder('utf8'))],
  ['lastChar 不是自有属性（原型 getter）', (M) => Object.prototype.hasOwnProperty.call(new M.StringDecoder('utf8'), 'lastChar')],
  ['prototype 形状', (M) => [typeof M.StringDecoder.prototype.write, typeof M.StringDecoder.prototype.end, M.StringDecoder.name]],
];

const ALL_TABLES: Array<[string, Case[]]> = [
  ['Buffer.from', FROM_CASES],
  ['Buffer.alloc / allocUnsafe / concat', ALLOC_CASES],
  ['实例方法与编码（含 slice/subarray/fill/indexOf/write/swap）', INSTANCE_CASES],
  ['数值读写（含 BigInt / 浮点 / 越界）', NUMERIC_CASES],
  ['模块面与迭代', MISC_CASES],
  ['StringDecoder', DECODER_CASES],
];

describe('emulation: node:buffer / node:string_decoder 与宿主 Node 差分对齐', async () => {
  const { hostApi } = await import('../hostApi');
  const shimCalls: string[] = [];
  (globalThis as any).__host = makeHostChannel(hostApi as unknown as Record<string, any>, shimCalls);
  const bufferShim = await import(pathToFileURL(join(SHIM_DIR, 'node-buffer.js')).href);
  const decoderShim = await import(pathToFileURL(join(SHIM_DIR, 'node-string_decoder.js')).href);

  const shim: Subject = { Buffer: bufferShim.Buffer, StringDecoder: decoderShim.StringDecoder, calls: shimCalls };
  const host: Subject = { Buffer: HostBuffer, StringDecoder: HostStringDecoder, calls: [] };

  let caseCount = 0;
  for (const [group, cases] of ALL_TABLES) {
    describe(group, () => {
      for (const [name, fn] of cases) {
        caseCount++;
        it(name, () => {
          const expected = signature(() => fn(host));
          const actual = signature(() => fn(shim));
          assert.equal(actual, expected, `shim 与宿主分歧：\n  shim: ${actual}\n  host: ${expected}`);
        });
      }
    });
  }

  it('差分用例总数（判别力下限）', () => {
    assert.ok(caseCount >= 150, `差分用例应有足够覆盖面，当前只有 ${caseCount} 条`);
  });

  // ── 结构性断言：这些不是"和 Node 比"，而是"我们有意这么定"的守门测试 ──

  it('slice 是共享内存（不是 Uint8Array 的复制语义）', () => {
    const b = bufferShim.Buffer.from([1, 2, 3, 4]);
    const s = b.slice(1, 3);
    s[0] = 99;
    assert.equal(b[1], 99, 'slice 改了原缓冲 → 说明是共享的');
    b[2] = 77;
    assert.equal(s[1], 77, '原缓冲改了 slice → 双向共享');
    assert.equal(s.buffer, b.buffer);
  });

  it('subarray 同样是共享内存', () => {
    const b = bufferShim.Buffer.from([1, 2, 3, 4]);
    const s = b.subarray(1, 3);
    s[0] = 42;
    assert.equal(b[1], 42);
  });

  /**
   * `parent` / `offset` 这两个遗留属性：**我们有意与宿主不同**，所以不进差分表。
   *
   * Node 上它们总是存在，只是含义取决于是否池化：
   *   · 池化（`from(array)`/`from(string)`/`allocUnsafe`）→ `parent` 是那块 8 KB 池，`offset` 是池内偏移；
   *   · 非池化（`alloc`/`allocUnsafeSlow`）→ `parent` 是自己的 ArrayBuffer，`offset` 是 0。
   * 我们**不做池化**（池化会让 `slice().buffer` 把同池里别人的字节一起交出去，桥侧踩过这个坑，
   * 见 module-emulation-design §3.2.2 坑 1），所以永远落在"非池化"那一档。
   * 这条断言的作用是**守住"没有池化"**：一旦有人为了性能引入池，`offset` 会变成非 0 而立刻红。
   */
  it('不池化：parent 恒指向自己的 ArrayBuffer、offset 恒 0（有意与宿主不同）', () => {
    const b = bufferShim.Buffer.from([1, 2]);
    assert.equal(b.parent, b.buffer, 'parent 应当就是自己的 ArrayBuffer');
    assert.equal(b.offset, 0, 'offset 恒 0 —— 非 0 就说明引入池化了');
    assert.equal(b.byteOffset, 0);
    assert.equal(b.buffer.byteLength, 2, '底层 ArrayBuffer 不该是一大块池');
    // 视图要保留偏移：这时 parent 仍是同一块 ArrayBuffer，但 offset/byteOffset 非 0
    const view = b.subarray(1);
    assert.equal(view.parent, b.buffer);
    assert.equal(view.offset, 1);
    assert.equal(view.byteOffset, 1);
  });

  it('from(arrayBuffer) 共享、from(typedArray) 复制内容', () => {
    const ab = new Uint8Array([1, 2, 3, 4]).buffer;
    const shared = bufferShim.Buffer.from(ab);
    shared[0] = 9;
    assert.equal(new Uint8Array(ab)[0], 9, 'from(arrayBuffer) 必须共享底层内存');
    const src = new Uint8Array([1, 2, 3]);
    const copied = bufferShim.Buffer.from(src);
    copied[0] = 7;
    assert.equal(src[0], 1, 'from(typedArray) 必须是复制');
    assert.notEqual(copied.buffer, src.buffer);
  });

  it('不池化：buffer 只覆盖自己的字节，allocUnsafe 也是独立的零初始化内存', () => {
    const a = bufferShim.Buffer.from('abc');
    const b = bufferShim.Buffer.allocUnsafe(5);
    assert.equal(a.buffer.byteLength, a.length, '池化会让 buffer 远大于 length（§3.2 坑 1）');
    assert.equal(b.buffer.byteLength, b.length);
    assert.notEqual(a.buffer, b.buffer);
    assert.deepEqual([...b], [0, 0, 0, 0, 0], 'allocUnsafe 在本仿真里是安全的（有意与 Node 不同）');
    const big = bufferShim.Buffer.allocUnsafe(9000);
    assert.equal(big.buffer.byteLength, 9000, '超过池大小也不该出现别人的字节');
  });

  it('poolSize 是常量，不参与分配', () => {
    assert.equal(bufferShim.Buffer.poolSize, 8192);
    const b = bufferShim.Buffer.allocUnsafe(4);
    assert.equal(b.buffer.byteLength, 4, '池化常量不该影响实际分配');
  });

  it('SlowBuffer 明确抛 ERR_NOT_SUPPORTED_IN_SANDBOX（不静默 undefined）', () => {
    assert.equal(typeof bufferShim.SlowBuffer, 'function');
    assert.throws(
      () => bufferShim.SlowBuffer(4),
      (err: any) => err.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
    );
    assert.throws(() => bufferShim.Buffer.SlowBuffer(4), (err: any) => err.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX');
  });

  it('宿主码 ENCODING_UNKNOWN 被翻译成 ERR_UNKNOWN_ENCODING，且保留 spcCode', () => {
    // 直接给桥塞一个"沙箱侧以为是合法编码、宿主侧不认"的回答：翻译层必须独立成立——
    // 少了它，将来两边编码表不一致时插件拿到的是 ENCODING_UNKNOWN（不是 Node 的码，依赖不会分支）
    const saved = (globalThis as any).__host;
    (globalThis as any).__host = {
      'bytes.fromString': () => JSON.stringify({ __spcError: { code: 'ENCODING_UNKNOWN', params: { encoding: 'utf8' } } }),
      'bytes.toString': () => JSON.stringify({ __spcError: { code: 'ENCODING_UNKNOWN', params: { encoding: 'utf8' } } }),
      'bytes.byteLength': () => JSON.stringify({ __spcError: { code: 'ENCODING_UNKNOWN', params: { encoding: 'utf8' } } }),
    };
    try {
      assert.throws(
        () => bufferShim.Buffer.from('x', 'utf8'),
        (err: any) => err.code === 'ERR_UNKNOWN_ENCODING' && err.spcCode === 'ENCODING_UNKNOWN' && err.name === 'TypeError',
      );
      assert.throws(() => bufferShim.Buffer.from('x').toString('utf8'), (err: any) => err.spcCode === 'ENCODING_UNKNOWN');
    } finally {
      (globalThis as any).__host = saved;
    }
  });

  it('编码校验在沙箱侧完成：错编码不制造宿主调用（审计噪音）', () => {
    const before = shimCalls.length;
    assert.throws(() => bufferShim.Buffer.from('x', 'nope'), (err: any) => err.code === 'ERR_UNKNOWN_ENCODING');
    assert.throws(() => bufferShim.Buffer.alloc(2).toString('nope'), (err: any) => err.code === 'ERR_UNKNOWN_ENCODING');
    assert.equal(shimCalls.length, before, '未知编码应在沙箱里就拦下，不该过桥');
  });

  it('不碰宿主的面：isBuffer / equals / compare / toJSON / slice 一次桥都不过', () => {
    const before = shimCalls.length;
    const b = bufferShim.Buffer.from('abc'); // 这一条是要过桥的（编码）
    const afterEncode = shimCalls.length;
    assert.equal(afterEncode, before + 1, 'from(string) 恰好一次 bytes.fromString');
    // 注意：下面比对的样本必须走**数组**构造 —— `Buffer.from('abd')` 也是一次编码，会多一次过桥
    b.equals(bufferShim.Buffer.from([97, 98, 100]));
    b.slice(0, 1).toJSON();
    bufferShim.Buffer.compare(b, b);
    bufferShim.Buffer.isBuffer(b);
    b.readUInt8(0);
    b.swap16.call(bufferShim.Buffer.from([1, 2]));
    assert.equal(shimCalls.length, afterEncode, '纯沙箱操作不该产生宿主调用');
  });

  it('toString 是每次一过桥，且只传区间字节', () => {
    const b = bufferShim.Buffer.from('hello world');
    const before = shimCalls.length;
    assert.equal(b.toString('utf8', 6, 11), 'world');
    assert.equal(shimCalls.length, before + 1);
  });

  it('shim 静态可内联：不 import node:*、无构建期占位符', () => {
    for (const f of ['node-buffer.js', 'node-string_decoder.js']) {
      const src = readFileSync(join(SHIM_DIR, f), 'utf8');
      assert.ok(!/from\s+['"]node:/.test(src), `${f} 不得 import node:*`);
      assert.ok(!/__SPC_[A-Z_]+__/.test(src), `${f} 不得有构建期占位符`);
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) {
        assert.ok(/^\.\/node-.*\.js$/.test(spec), `${f} 只允许相对 import ./node-*.js，实际有 ${spec}`);
      }
    }
  });
});
