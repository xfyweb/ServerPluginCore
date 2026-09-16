// node:assert 仿真——常用断言子集
//
// 依赖常拿它做参数校验（`assert(typeof x === 'string')` 之类），所以这一块的价值在"能跑通"，
// 而不是把 Node 的断言全抄一遍。
//
// **刻意与 Node 保持一致的语义**（不然后果是静默误判）：
//   · `deepStrictEqual` 用 Object.is 语义比基本值（于是 `NaN` 相等、`-0` 与 `+0` **不**相等）
//   · 原型必须一致；自有可枚举键**数量与集合**都要一致（`{a:1}` 与 `{a:1,b:undefined}` 不等）
//   · `equal` / `deepEqual` 是**宽松**比较，`strictEqual` / `deepStrictEqual` 才是严格
//   · 断言失败一律抛 `AssertionError`（带 `code: 'ERR_ASSERTION'`、`actual`/`expected`/`operator`）
//   · **具名导出与默认导出都要有**：`import assert from 'assert'`（可调用）与
//     `import { strictEqual } from 'assert'` 在生态里都常见
//
// **已知边界**：失败消息的**文案**与 Node 不完全一致（Node 的 diff 排版不追求复刻），
// 但 `code`/`operator`/`actual`/`expected` 对齐——靠 message 文本分支的代码很少，
// 靠这些字段分支的才是常态。`WeakMap`/`Proxy` 等冷门形态未覆盖。
//
// 内联约束：静态、无占位符；不碰宿主。

export class AssertionError extends Error {
  constructor(options) {
    const hasMessage = options && options.message !== undefined;
    super(hasMessage ? String(options.message) : 'Assertion failed');
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
    this.generatedMessage = !hasMessage;
    if (options) {
      this.actual = options.actual;
      this.expected = options.expected;
      this.operator = options.operator;
    }
  }
}

/** 内部抛错助手（公开的 `fail()` 是另一回事，见文件末） */
function failWith(message, actual, expected, operator) {
  // **message 传 Error 时原样抛出它**（Node 的 innerFail 行为）：
  // 包成 AssertionError 会让抛出类型与 code 全变，`if (e instanceof MyError)` 这类分支失效。
  // 一处在源头挡掉，所有断言（ok/equal/fail/…）就都有了这个语义。
  if (message instanceof Error) throw message;
  throw new AssertionError({ message, actual, expected, operator });
}

function describe(value) {
  try {
    if (typeof value === 'string') return "'" + value + "'";
    if (typeof value === 'function') return '[Function: ' + (value.name || 'anonymous') + ']';
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

// ── 深比较 ──

function isObjectLike(v) {
  return v !== null && (typeof v === 'object' || typeof v === 'function');
}

function tagOf(v) {
  return Object.prototype.toString.call(v);
}

function ownEnumerableKeys(o) {
  return Reflect.ownKeys(o).filter((k) => Object.prototype.propertyIsEnumerable.call(o, k));
}

function equalBytes(x, y) {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** 严格深比较（deepStrictEqual 的内核） */
function isDeepStrictEqual(a, b, memo) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (!isObjectLike(a) || !isObjectLike(b)) return false;

  const tagA = tagOf(a);
  if (tagA !== tagOf(b)) return false;

  // 循环引用：只比"正在比的那一对"
  memo = memo || new Map();
  const seen = memo.get(a);
  if (seen && seen.has(b)) return true;
  if (!seen) memo.set(a, new Set([b]));
  else seen.add(b);

  // 原型必须一致（deepStrictEqual 与 deepEqual 的分界之一）
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  switch (tagA) {
    case '[object Date]':
      return Object.is(a.getTime(), b.getTime());
    case '[object RegExp]':
      return a.source === b.source && a.flags === b.flags;
    case '[object Error]':
    case '[object DOMException]':
      return a.name === b.name && a.message === b.message;
    case '[object Number]':
    case '[object String]':
    case '[object Boolean]':
    case '[object Symbol]':
    case '[object BigInt]':
      return Object.is(a.valueOf(), b.valueOf());
    case '[object ArrayBuffer]':
      return equalBytes(new Uint8Array(a), new Uint8Array(b));
  }

  if (ArrayBuffer.isView(a)) {
    return equalBytes(
      new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
      new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
    );
  }

  if (tagA === '[object Map]') {
    if (a.size !== b.size) return false;
    const bEntries = [...b.entries()];
    const used = new Set();
    for (const [k, v] of a.entries()) {
      let matched = false;
      for (let i = 0; i < bEntries.length; i++) {
        if (used.has(i)) continue;
        if (isDeepStrictEqual(k, bEntries[i][0], memo) && isDeepStrictEqual(v, bEntries[i][1], memo)) {
          used.add(i);
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    return true;
  }

  if (tagA === '[object Set]') {
    if (a.size !== b.size) return false;
    const bValues = [...b.values()];
    const used = new Set();
    for (const v of a.values()) {
      let matched = false;
      for (let i = 0; i < bValues.length; i++) {
        if (used.has(i)) continue;
        if (isDeepStrictEqual(v, bValues[i], memo)) {
          used.add(i);
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    return true;
  }

  const keysA = ownEnumerableKeys(a);
  const keysB = ownEnumerableKeys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!keysB.includes(k)) return false;
    if (!isDeepStrictEqual(a[k], b[k], memo)) return false;
  }
  return true;
}

/** 宽松深比较（deepEqual 的内核）：不查原型、不查类型标签 */
function isDeepEqual(a, b, memo) {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (!isObjectLike(a) || !isObjectLike(b)) return a == b; // eslint-disable-line eqeqeq
  memo = memo || new Map();
  const seen = memo.get(a);
  if (seen && seen.has(b)) return true;
  if (!seen) memo.set(a, new Set([b]));
  else seen.add(b);
  const keysA = ownEnumerableKeys(a);
  const keysB = ownEnumerableKeys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!keysB.includes(k)) return false;
    if (!isDeepEqual(a[k], b[k], memo)) return false;
  }
  return true;
}

// ── 公开断言 ──

/**
 * 二元断言的**缺参**检查。
 * 漏写一个参数时 Node 抛 `ERR_MISSING_ARGS`；不查的话 `notXxx(x)` 会**静默通过**
 * ——"断言失效"比"断言失败"危险得多，所以每条二元断言都要先过这一关。
 * 用 `arguments.length` 而不是判 undefined：显式传 `undefined` 是合法的比较值。
 */
function requireArgs(count) {
  if (count < 2) {
    const err = new TypeError('The "actual" and "expected" arguments must be specified');
    err.code = 'ERR_MISSING_ARGS';
    throw err;
  }
}

export function ok(value, message) {
  // `actual` 放**原值**：Node 的 `ok(0)` 给的是 `actual: 0` 而不是 `false`，
  // 于是靠 `err.actual` 分支的调用方分得清"值是 0"与"值缺席"。
  if (!value) failWith(message, value, true, '==');
}

export function strictEqual(actual, expected, message) {
  requireArgs(arguments.length);
  if (!Object.is(actual, expected)) failWith(message, actual, expected, 'strictEqual');
}

export function notStrictEqual(actual, expected, message) {
  requireArgs(arguments.length);
  if (Object.is(actual, expected)) failWith(message, actual, expected, 'notStrictEqual');
}

export function equal(actual, expected, message) {
  requireArgs(arguments.length);
  // **NaN 是特例**：`equal(NaN, NaN)` 在 Node 里**通过**（尽管 `NaN == NaN` 为 false），
  // 而 `notEqual(NaN, NaN)` 反而失败。照搬 `==` 会把这两个判定都弄反。
  // eslint-disable-next-line eqeqeq
  if (actual != expected && (!Number.isNaN(actual) || !Number.isNaN(expected))) {
    failWith(message, actual, expected, '==');
  }
}

export function notEqual(actual, expected, message) {
  requireArgs(arguments.length);
  // eslint-disable-next-line eqeqeq
  if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
    failWith(message, actual, expected, '!=');
  }
}

export function deepStrictEqual(actual, expected, message) {
  requireArgs(arguments.length);
  if (!isDeepStrictEqual(actual, expected)) failWith(message, actual, expected, 'deepStrictEqual');
}

export function notDeepStrictEqual(actual, expected, message) {
  requireArgs(arguments.length);
  if (isDeepStrictEqual(actual, expected)) failWith(message, actual, expected, 'notDeepStrictEqual');
}

export function deepEqual(actual, expected, message) {
  requireArgs(arguments.length);
  if (!isDeepEqual(actual, expected)) failWith(message, actual, expected, 'deepEqual');
}

export function notDeepEqual(actual, expected, message) {
  requireArgs(arguments.length);
  if (isDeepEqual(actual, expected)) failWith(message, actual, expected, 'notDeepEqual');
}

/** 把 throws/rejects 的第二个参数（可选的 error 说明）编译成判定函数 */
function expectedErrorMatcher(expected) {
  if (expected === undefined) return () => true;
  if (typeof expected === 'function') {
    // 三条判据**都要**，少一条就会在某个形态上崩或误判：
    //   · 类 / 有原型的构造器 → 用 `instanceof`；
    //   · 类但没命中 → 直接不匹配（**不能退化成调用它**：类当函数调会抛 TypeError）；
    //   · 普通函数（含**箭头函数**，它没有 `prototype`）→ 当校验函数调，Node 要求**严格返回 `true`**。
    // 顺序上先看 `hasProto`：对箭头函数做 `instanceof` 本身就会抛 TypeError。
    const src = Function.prototype.toString.call(expected);
    const isClass = src.startsWith('class');
    const hasProto = expected.prototype !== undefined && expected.prototype !== null;
    return (e) => {
      if (hasProto && e instanceof expected) return true;
      if (isClass) return false;
      return expected(e) === true;
    };
  }
  if (expected instanceof RegExp) return (e) => expected.test(String(e && e.message));
  if (typeof expected === 'object' && expected !== null) {
    return (e) => {
      for (const k of ownEnumerableKeys(expected)) {
        if (k === 'message' && expected.message instanceof RegExp) {
          if (!expected.message.test(String(e && e.message))) return false;
        } else if (!isDeepStrictEqual(e && e[k], expected[k])) {
          return false;
        }
      }
      return true;
    };
  }
  failWith('The "error" argument must be a RegExp, function, or object', expected, undefined, 'throws');
  return () => true;
}

export function throws(fn, expected, message) {
  if (typeof fn !== 'function') failWith('The "fn" argument must be of type function', fn, undefined, 'throws');
  // 字符串第二参是 **message**，不是 expected（Node 的 expectsError 就这么处理）。
  // 不认这一条的话，`assert.throws(fn, 'should throw')` 这种常见写法会被判失败——反向漏判。
  if (typeof expected === 'string') {
    message = expected;
    expected = undefined;
  }
  const matches = expectedErrorMatcher(expected);
  let caught;
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  if (!threw) failWith(message, undefined, expected, 'throws');
  if (!matches(caught)) failWith(message, caught, expected, 'throws');
}

export function doesNotThrow(fn, expected, message) {
  if (typeof fn !== 'function') failWith('The "fn" argument must be of type function', fn, undefined, 'doesNotThrow');
  if (typeof expected === 'string') {
    message = expected;
    expected = undefined;
  }
  try {
    fn();
  } catch (e) {
    if (!expected || expectedErrorMatcher(expected)(e)) {
      failWith(message, e, expected, 'doesNotThrow');
    }
    // **不匹配 → 原错误继续抛**。这是 Node 的 expectsNoError 行为，也是这条断言唯一的用处：
    // 吞掉它等于把真实故障藏起来（"我检查过了没问题"，其实是有问题、只是长得不一样）。
    throw e;
  }
}

export async function rejects(fn, expected, message) {
  if (typeof expected === 'string') {
    message = expected;
    expected = undefined;
  }
  const matches = expectedErrorMatcher(expected);
  let caught;
  let threw = false;
  try {
    await (typeof fn === 'function' ? fn() : fn);
  } catch (e) {
    threw = true;
    caught = e;
  }
  if (!threw) failWith(message, undefined, expected, 'rejects');
  if (!matches(caught)) failWith(message, caught, expected, 'rejects');
}

export async function doesNotReject(fn, expected, message) {
  if (typeof expected === 'string') {
    message = expected;
    expected = undefined;
  }
  try {
    await (typeof fn === 'function' ? fn() : fn);
  } catch (e) {
    if (!expected || expectedErrorMatcher(expected)(e)) {
      failWith(message, e, expected, 'doesNotReject');
    }
    throw e; // 同上：不匹配就让它继续冒泡
  }
}

export function ifError(value) {
  // 实测（对齐测试）：Node 这里**始终抛 AssertionError**（operator='ifError'），
  // 而不是把原错误直接抛出去。想当然写成 re-throw 会让靠 code 分支的调用方走错路。
  if (value !== null && value !== undefined) {
    failWith('ifError got unwanted exception: ' + describe(value), value, null, 'ifError');
  }
}

function assertRegExp(regExp, operator) {
  if (!(regExp instanceof RegExp)) failWith('The "regExp" argument must be a RegExp', regExp, undefined, operator);
}

function assertString(value) {
  if (typeof value !== 'string') {
    const err = new TypeError('The "string" argument must be of type string. Received ' + typeof value);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
}

export function match(value, regExp, message) {
  assertRegExp(regExp, 'match');
  assertString(value);
  if (!regExp.test(value)) failWith(message, value, regExp, 'match');
}

export function doesNotMatch(value, regExp, message) {
  assertRegExp(regExp, 'doesNotMatch');
  assertString(value);
  if (regExp.test(value)) failWith(message, value, regExp, 'doesNotMatch');
}

export function fail(message) {
  // 走 failWith：于是 `fail(new Error('orig'))` 会**原样抛出那个 Error**（Node 行为），
  // 而不是包成 AssertionError —— 包了的话类型与 code 都变，靠 `instanceof` 分支的调用方失效。
  failWith(message === undefined ? 'Failed' : message, undefined, undefined, 'fail');
}

// ── 默认导出：本身可调用，且挂满成员（与 Node 一致） ──

function assert(value, message) {
  ok(value, message);
}

const API = {
  ok,
  equal,
  notEqual,
  strictEqual,
  notStrictEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  ifError,
  match,
  doesNotMatch,
  fail,
  AssertionError,
};
Object.assign(assert, API);

/** `assert/strict`：宽松方法被严格方法覆盖 */
const assertStrict = function (value, message) {
  ok(value, message);
};
Object.assign(assertStrict, API, {
  equal: strictEqual,
  notEqual: notStrictEqual,
  deepEqual: deepStrictEqual,
  notDeepEqual: notDeepStrictEqual,
});
assertStrict.strict = assertStrict;
assert.strict = assertStrict;

export { assertStrict as strict };
export default assert;
