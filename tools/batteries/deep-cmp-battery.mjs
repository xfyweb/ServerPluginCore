// A6/A7 差分电池：同一批输入分别喂给 shim 与宿主 Node，比"抛不抛 + error.code"。
// 用法（从仓库根）：node tools/batteries/deep-cmp-battery.mjs
// 判卷人是 Node 自己（本机 v24），所以结论不需要我判——只列分歧。
import { readFileSync } from 'node:fs';
import * as nodeAssert from 'node:assert';
import { SANDBOX_MODULES } from '../paths.mjs';

const src = readFileSync(SANDBOX_MODULES + '/node-assert.js', 'utf8');
const shim = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));

const errCode = (fn) => {
  try {
    fn();
    return 'PASS';
  } catch (e) {
    return 'THROW:' + (e && e.code ? e.code : e && e.name) + ':' + (e && e.operator ? e.operator : '-');
  }
};

// ---- 用例：每组返回 [a, b]（在宿主进程里建值，两个实现看到的是同一批对象）----
const obj = (o) => Object.assign({}, o);
const withProto = (proto, own) => Object.assign(Object.create(proto), own);
class A {
  constructor() {
    this.x = 1;
  }
}
class B {
  constructor() {
    this.x = 1;
  }
}
const err = (props) => Object.assign(new Error('boom'), props);

const CASES = [
  // ── A7：原型 / 构造器 ──
  ['A7 不同原型的同形对象', () => [withProto({ z: 9 }, { a: 1 }), { a: 1 }]],
  ['A7 Object.create(null) vs {}', () => [Object.create(null), {}]],
  ['A7 两个不同类实例（同自有属性）', () => [new A(), new B()]],
  ['A7 同类实例', () => [new A(), new A()]],
  ['A7 类实例 vs 同形字面量', () => [new A(), { x: 1 }]],
  ['A7 Object.create(Object.prototype) vs {}', () => [Object.create(Object.prototype), {}]],
  ['A7 自定义 toStringTag', () => [withProto({ [Symbol.toStringTag]: 'X' }, {}), {}]],
  ['A7 boxed Number vs 原始值', () => [new Number(1), 1]],
  ['A7 两个 boxed Number', () => [new Number(1), new Number(1)]],
  ['A7 boxed String vs String 对象', () => [new String('a'), Object('a')]],

  // ── A6：不该相等的 ──
  ['A6 两个 WeakMap', () => [new WeakMap(), new WeakMap()]],
  ['A6 两个 WeakSet', () => [new WeakSet(), new WeakSet()]],
  ['A6 两个 Promise', () => [Promise.resolve(1), Promise.resolve(1)]],
  ['A6 同名不同函数', () => [function f() {}, function f() {}]],
  ['A6 箭头函数 vs 普通函数', () => [() => 1, function () { return 1; }]],
  ['A6 同引用函数', () => [Math.max, Math.max]],
  ['A6 Error 附带自有属性', () => [err({ extra: 1 }), new Error('boom')]],
  ['A6 Error 的 cause 不同', () => [err({ cause: new Error('a') }), err({ cause: new Error('b') })]],
  ['A6 Error 的 cause 相同', () => [err({ cause: new Error('a') }), err({ cause: new Error('a') })]],
  ['A6 TypedArray 附加属性', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([1, 2]);
    a.tag = 'x';
    return [a, b];
  }],
  ['A6 数组附加属性', () => [Object.assign([1], { tag: 1 }), [1]]],
  ['A6 Buffer vs Uint8Array', () => [Buffer.from([1, 2]), new Uint8Array([1, 2])]],
  ['A6 稀疏数组 vs undefined 元素', () => [[1, , 3], [1, undefined, 3]]],
  ['A6 数组长度不同（尾部 hole）', () => [[1, 2, ,], [1, 2]]],
  ['A6 Map key 为对象时按值匹配?', () => [new Map([[{ a: 1 }, 1]]), new Map([[{ a: 1 }, 1]])]],
  ['A6 Set 元素为对象', () => [new Set([{ a: 1 }]), new Set([{ a: 1 }])]],
  ['A6 两个不同 URL', () => [new URL('https://a.example/'), new URL('https://b.example/')]],

  // ── A6：宽松模式跨 tag ──
  ['A6 宽松 1 vs "1"', () => [1, '1']],
  ['A6 宽松 [1] vs ["1"]', () => [[1], ['1']]],
  ['A6 宽松 Date vs number', () => [new Date(0), 0]],
  ['A6 宽松 true vs 1', () => [true, 1]],
  ['A6 宽松 null vs undefined', () => [null, undefined]],
  ['A6 宽松 /a/ vs 字符串 "a"', () => [/a/, 'a']],
  ['A6 宽松 boxed vs 原始', () => [new Number(1), 1]],

  // ── 主干（本来就应该一致，防止这次重写把主干弄坏）──
  ['主干 日期相等', () => [new Date(0), new Date(0)]],
  ['主干 日期不等', () => [new Date(0), new Date(1)]],
  ['主干 正则相等', () => [/a/gi, /a/gi]],
  ['主干 正则 lastIndex 不同', () => {
    const a = /a/g;
    const b = /a/g;
    a.lastIndex = 2;
    return [a, b];
  }],
  ['主干 Map 值深比', () => [new Map([['k', { a: 1 }]]), new Map([['k', { a: 1 }]])]],
  ['主干 Set 深比', () => [new Set([1, 2]), new Set([2, 1])]],
  ['主干 Set 长度不同', () => [new Set([1]), new Set([1, 2])]],
  ['主干 ArrayBuffer', () => [new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer]],
  ['主干 DataView 偏移不同', () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    return [new DataView(buf, 0, 2), new DataView(buf, 2, 2)];
  }],
  ['主干 循环引用相等', () => {
    const a = { x: 1 };
    a.self = a;
    const b = { x: 1 };
    b.self = b;
    return [a, b];
  }],
  ['主干 循环引用不等', () => {
    const a = { x: 1 };
    a.self = a;
    const b = { x: 2 };
    b.self = b;
    return [a, b];
  }],
  ['主干 getter 值相同', () => [
    { get v() { return 1; } },
    { get v() { return 1; } },
  ]],
  ['主干 getter 值不同', () => [
    { get v() { return 1; } },
    { get v() { return 2; } },
  ]],
  ['主干 不可枚举属性被忽略', () => [
    Object.defineProperty({ a: 1 }, 'h', { value: 1, enumerable: false }),
    { a: 1 },
  ]],
  ['主干 symbol 键（严格比）', () => {
    const s = Symbol('s');
    return [{ [s]: 1 }, { [s]: 1 }];
  }],
  ['主干 不同 symbol 键', () => [{ [Symbol('s')]: 1 }, { [Symbol('s')]: 1 }]],
  ['主干 NaN', () => [NaN, NaN]],
  ['主干 -0 vs +0', () => [-0, 0]],
  ['主干 0n vs -0n', () => [0n, -0n]],
  ['主干 嵌套深比', () => [{ a: [{ b: [1, { c: 2 }] }] }, { a: [{ b: [1, { c: 2 }] }] }]],
  ['主干 一侧多键', () => [{ a: 1, b: 2 }, { a: 1 }]],
  ['主干 null 原型两侧相同', () => [Object.assign(Object.create(null), { a: 1 }), Object.assign(Object.create(null), { a: 1 })]],

  // ── 补充：别的"内部槽"类型与边界（这些在 QuickJS 里也可能出现，必须一起钉住）──
  ['补充 symbol 值不同', () => [{ s: Symbol('a') }, { s: Symbol('a') }]],
  ['补充 symbol 值同引用', () => {
    const s = Symbol('a');
    return [{ s }, { s }];
  }],
  ['补充 不同 Error 子类', () => [new TypeError('x'), new RangeError('x')]],
  ['补充 同类 Error 不同 message', () => [new TypeError('x'), new TypeError('y')]],
  ['补充 生成器对象', () => [(function* () {})(), (function* () {})()]],
  ['补充 arguments vs 数组', () => [(function () { return arguments; })(1, 2), [1, 2]]],
  ['补充 Promise vs 对象', () => [Promise.resolve(1), {}]],
  ['补充 Map vs Set', () => [new Map(), new Set()]],
  ['补充 boxed Symbol', () => [Object(Symbol('a')), Object(Symbol('a'))]],
  ['补充 冻结与否不影响', () => [Object.freeze({ a: 1 }), { a: 1 }]],
  ['补充 稀疏两侧同样空洞', () => [[1, , 3], [1, , 3]]],
  ['补充 嵌套 Map 键深比', () => [
    new Map([[{ k: 1 }, { v: 1 }]]),
    new Map([[{ k: 1 }, { v: 1 }]]),
  ]],
];

const OPS = [
  ['deepStrictEqual', (impl, a, b) => impl.deepStrictEqual(a, b)],
  ['deepEqual', (impl, a, b) => impl.deepEqual(a, b)],
  ['notDeepStrictEqual', (impl, a, b) => impl.notDeepStrictEqual(a, b)],
];

let bad = 0;
for (const [label, make] of CASES) {
  for (const [op, run] of OPS) {
    let pair;
    try {
      pair = make();
    } catch (e) {
      console.log(`SKIP ${label} (${e.message})`);
      break;
    }
    const [a, b] = pair;
    const got = errCode(() => run(shim, a, b));
    const want = errCode(() => run(nodeAssert, a, b));
    if (got !== want) {
      bad++;
      console.log(`✖ ${label} · ${op}\n    shim=${got}\n    node=${want}`);
    }
  }
}
console.log(`\n用例 ${CASES.length} 组 × ${OPS.length} 操作，分歧 ${bad} 处`);
process.exit(bad ? 1 : 0);
