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

export function ok(value, message) {
  if (!value) failWith(message, false, true, '==');
}

export function strictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) failWith(message, actual, expected, 'strictEqual');
}

export function notStrictEqual(actual, expected, message) {
  if (Object.is(actual, expected)) failWith(message, actual, expected, 'notStrictEqual');
}

export function equal(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual != expected) failWith(message, actual, expected, '==');
}

export function notEqual(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual == expected) failWith(message, actual, expected, '!=');
}

export function deepStrictEqual(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected)) failWith(message, actual, expected, 'deepStrictEqual');
}

export function notDeepStrictEqual(actual, expected, message) {
  if (isDeepStrictEqual(actual, expected)) failWith(message, actual, expected, 'notDeepStrictEqual');
}

export function deepEqual(actual, expected, message) {
  if (!isDeepEqual(actual, expected)) failWith(message, actual, expected, 'deepEqual');
}

export function notDeepEqual(actual, expected, message) {
  if (isDeepEqual(actual, expected)) failWith(message, actual, expected, 'notDeepEqual');
}

/** 把 throws/rejects 的第二个参数（可选的 error 说明）编译成判定函数 */
function expectedErrorMatcher(expected) {
  if (expected === undefined) return () => true;
  if (typeof expected === 'function') {
    // 构造器还是校验函数？Node 用"是否 Error 的子类"来区分
    if (expected === Error || expected.prototype instanceof Error) return (e) => e instanceof expected;
    return (e) => !!expected(e);
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
  try {
    fn();
  } catch (e) {
    if (expected === undefined || expectedErrorMatcher(expected)(e)) failWith(message, e, undefined, 'doesNotThrow');
  }
}

export async function rejects(fn, expected, message) {
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
  try {
    await (typeof fn === 'function' ? fn() : fn);
  } catch (e) {
    if (expected === undefined || expectedErrorMatcher(expected)(e)) failWith(message, e, undefined, 'doesNotReject');
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
  throw new AssertionError({ message: message === undefined ? 'Failed' : String(message), operator: 'fail' });
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
