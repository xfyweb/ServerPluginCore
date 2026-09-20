// node:assert 仿真——常用断言子集
//
// 依赖常拿它做参数校验（`assert(typeof x === 'string')` 之类），所以这一块的价值在"能跑通"，
// 而不是把 Node 的断言全抄一遍。
//
// **刻意与 Node 保持一致的语义**（不然后果是静默误判）：
//   · `deepStrictEqual` 用 Object.is 语义比基本值（于是 `NaN` 相等、`-0` 与 `+0` **不**相等）
//   · 严格模式**先比 `constructor`**，只有 `constructor === undefined` 时才退回比原型
//     （comparisons.js:282）——于是 `Object.create({x:1},{a:1})` 与 `{a:1}` **相等**，
//     而 `new Foo()` 与 `{a:1}` 不等
//   · 自有可枚举键**数量与集合**都要一致（`{a:1}` 与 `{a:1,b:undefined}` 不等）；
//     严格模式连符号键一起比，宽松模式**不比**符号键（comparisons.js:506）
//   · 形态不同一律不等：函数只有"同一引用"才相等；`WeakMap`/`WeakSet`/`Promise` 没有
//     可比内容（comparisons.js:459）；宽松模式也**不**跨 tag（`deepEqual(new Date(0),{})` 失败）
//   · `equal` / `deepEqual` 是**宽松**比较，`strictEqual` / `deepStrictEqual` 才是严格
//   · 断言失败一律抛 `AssertionError`（带 `code: 'ERR_ASSERTION'`、`actual`/`expected`/`operator`）
//   · **具名导出与默认导出都要有**：`import assert from 'assert'`（可调用）与
//     `import { strictEqual } from 'assert'` 在生态里都常见
//
// **已知边界**：失败消息的**文案**与 Node 不完全一致（Node 的 diff 排版不追求复刻），
// 但 `code`/`operator`/`actual`/`expected` 对齐——靠 message 文本分支的代码很少，
// 靠这些字段分支的才是常态。深比较仍未覆盖：`KeyObject`/`CryptoKey` 的专门比较、
// Node 25+ 的 partial 模式（`partialDeepStrictEqual`）、`Proxy`，以及**伪造了 @@toStringTag
// 的假对象**（沙箱里没有这些内建；判到就按真身分派，不做内部槽校验）。
//
// 内联约束：静态、无占位符；不碰宿主。

export class AssertionError extends Error {
  constructor(options) {
    // Node 对 `new AssertionError()` / 传非对象**是抛错**（ERR_INVALID_ARG_TYPE），不是容忍：
    // 依赖里"自己造 AssertionError"的写法（测试工具、断言封装）靠这个错误发现自己写错了参数。
    // 少了这道检查，我们会安静地造出一个 message 为 'Assertion failed' 的错误——比抛错更难查。
    if (options === null || typeof options !== 'object') {
      const err = new TypeError('The "options" argument must be of type object. Received ' + (options === null ? 'null' : typeof options));
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    const hasMessage = options.message !== undefined;
    super(hasMessage ? String(options.message) : 'Assertion failed');
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
    this.generatedMessage = !hasMessage;
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
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
//
// 这一段是 `lib/internal/util/comparisons.js` 的**结构复刻**：入口守卫（`innerDeepEqual`）
// → 形态分派（`objectComparisonStart`）→ 自有可枚举键与集合内容（`keyCheck`）。
//
// 照抄 Node 的**分派顺序**不是洁癖，顺序本身携带语义：
//   · "先认数组、再认 tag" → 宽松模式下 `[1,2]` 与 `{0:1,1:2}` **不**相等
//   · "先比 constructor、只有它是 undefined 才比原型" → `Object.create({x:1},{a:1})` 与
//     `{a:1}` 相等，而 `new Foo()` 与 `{a:1}` 不等
//   · "认不出的形态（`WeakMap`/`Promise`/函数/另一个 tag）直接不等" → 不给"自有键都是空"
//     这种巧合留判等的余地

/** 比较模式：数值照抄 Node（comparisons.js:137-139），便于对着源码核对 */
const kLoose = 0;
const kStrict = 2;

/** 集合种类（Node comparisons.js:142-145）：keyCheck 之后要不要再比 Set/Map 的**内容** */
const kNoIterator = 0;
const kIsSet = 2;
const kIsMap = 3;

/**
 * Node comparisons.js:62-93 的 `wellKnownConstructors`。
 *
 * 严格模式的 constructor 判据**只对内建构造器生效**（见 objectComparisonStart），
 * 所以这张表漏一个内建，那个内建的对象就会掉进"比原型"分支——该等的判不等。
 *
 * 用 `globalThis[name]` 取名而不是直接写标识符：沙箱引擎可能缺其中某个
 * （`Buffer` 沙箱里就没有，`Float16Array` 是 ES2025 才进标准的），
 * 直接写标识符会在**模块求值期** ReferenceError——整个 assert 都装不起来，比判错更糟。
 */
const wellKnownConstructors = new Set();
for (const name of [
  'Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView',
  'Date', 'Error', 'Float16Array', 'Float32Array', 'Float64Array', 'Function', 'Int16Array',
  'Int32Array', 'Int8Array', 'Map', 'Number', 'Object', 'Promise', 'RegExp', 'Set', 'String',
  'Symbol', 'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakSet',
]) {
  const ctor = globalThis[name];
  if (typeof ctor === 'function') wellKnownConstructors.add(ctor);
}

function tagOf(v) {
  return Object.prototype.toString.call(v);
}

/**
 * `URL` 的识别（Node 用 `internal/url.isURL`）。
 *
 * 为什么要它：Node 对 URL 是**整体比较 `href`**（`comparisons.js:409-412`），
 * 而不是当普通对象逐键比。少了这条，`deepStrictEqual(new URL('https://a/'), new URL('https://b/'))`
 * 会**通过**（两个 URL 的自有键都是空的 symbol 属性）——那是**静默的判等错误**，
 * 比"少支持一个类型"危险得多。差分电池 `tools/batteries/deep-cmp-battery.mjs` 的 A6 组一直在报这条。
 *
 * 判据用 `@@toStringTag`（`URL.prototype[Symbol.toStringTag] === 'URL'`，跨 realm 稳定），
 * 不依赖 `instanceof`——后者的 realm 语义在宿主 realm 与沙箱 realm 之间会变。
 */
function isUrl(v) {
  return v !== null && typeof v === 'object' && v[Symbol.toStringTag] === 'URL' &&
    typeof v.href === 'string';
}

function hasOwn(o, key) {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/**
 * 自有可枚举键。
 *
 * `includeSymbols=false` 只给**宽松模式**用：Node 只在严格模式追加符号键
 * （comparisons.js:506-520），宽松模式下 `deepEqual({[s]:1}, {})` 在 Node 里是**通过**的。
 */
function ownEnumerableKeys(o, includeSymbols = true) {
  const keys = Reflect.ownKeys(o).filter((k) => Object.prototype.propertyIsEnumerable.call(o, k));
  return includeSymbols ? keys : keys.filter((k) => typeof k === 'string');
}

/** Node comparisons.js:270：@@toStringTag 不同就不是同一种东西 */
function hasUnequalTag(a, b) {
  return a[Symbol.toStringTag] !== b[Symbol.toStringTag];
}

/** Node comparisons.js:274：两边都声明了 @@toStringTag 就比它，否则比实际 tag */
function slowHasUnequalTag(tagA, a, b) {
  if (a[Symbol.toStringTag] !== undefined && b[Symbol.toStringTag] !== undefined) {
    return a[Symbol.toStringTag] !== b[Symbol.toStringTag];
  }
  return tagA !== tagOf(b);
}

function equalBytes(x, y) {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** 包装对象（`new Number(1)` 之类）的 tag 判据（Node comparisons.js:205 的入口条件） */
function isBoxedPrimitiveTag(tag) {
  return tag === '[object Number]' || tag === '[object String]' ||
    tag === '[object Boolean]' || tag === '[object Symbol]' || tag === '[object BigInt]';
}

/** ArrayBuffer 与 SharedArrayBuffer 共用的 tag 判据（Node 的 `isAnyArrayBuffer`） */
function isAnyArrayBufferTag(tag) {
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/**
 * Node comparisons.js:205 `isEqualBoxedPrimitive`：包装对象按**种类 + 解包值**比。
 * tag 不同就直接不等，否则 `new Number(1)` 与 `new String('1')` 会靠 valueOf 的宽松相等混过去。
 */
function isEqualBoxedPrimitive(a, b) {
  if (tagOf(a) !== tagOf(b)) return false;
  return Object.is(a.valueOf(), b.valueOf());
}

/**
 * Node comparisons.js:231 `isEnumerableOrIdentical`。
 *
 * `b` 上是**可枚举自有**属性时故意不在这里比：那个值归 keyCheck 的自有键比较管，
 * 这里再比一遍会掩盖"只有一边可枚举"的差异（`Object.assign(err,{cause:1})` 与
 * `new Error('x',{cause:1})` 的 cause 可枚举性不同，不该因此判等）。
 */
function isEnumerableOrIdentical(a, b, prop, mode, memo) {
  if (Object.prototype.propertyIsEnumerable.call(b, prop)) return true;
  return deepCompare(a[prop], b[prop], mode, memo);
}

/**
 * Node comparisons.js:281 `objectComparisonStart`：形态分派。
 *
 * 每个分支只做"这一类该怎么比"的判断，**自有可枚举键统一留到最后 keyCheck**——
 * 这是 Node 的写法，也是"TypedArray/Date/Set 的附加属性"能被比到的原因：
 * 老实现提前 return，附加属性根本没机会参与比较。
 */
function objectComparisonStart(a, b, mode, memo) {
  // 严格模式：**先比 constructor**（Node:282-291）
  if (mode === kStrict) {
    const ctorA = a.constructor;
    // 两类判据：① 继承到的 constructor 是内建；② constructor 不是 undefined 且**不是自有**属性。
    // 只有都不满足（constructor 是 undefined，或自有的 constructor 是个普通函数）才退回比原型。
    // 少了"先比 constructor"这一步，`Object.create({x:1},{a:1})` 会因为原型不同被判不等，
    // 而 Node 认为它等于 `{a:1}`（它继承到的 constructor 就是 Object）。
    if (wellKnownConstructors.has(ctorA) || (ctorA !== undefined && !hasOwn(a, 'constructor'))) {
      if (ctorA !== b.constructor) return false;
    } else if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
      return false;
    }
  }

  const tagA = tagOf(a);

  if (Array.isArray(a)) {
    // 宽松模式**也**要求双方都是数组（Node:293）：不查的话 `deepEqual([1,2],{0:1,1:2})` 判等
    if (!Array.isArray(b) || a.length !== b.length || hasUnequalTag(a, b)) return false;
    return keyCheck(a, b, mode, memo, kNoIterator);
  }

  // 普通对象：没有 @@toStringTag 且 tag 就是 Object（Node:310）
  if (a[Symbol.toStringTag] === undefined && tagA === '[object Object]') {
    // 宽松模式也**不跨 tag**（Node:312）：少了这行 `deepEqual(new Date(0), {})` 会判等
    if (slowHasUnequalTag(tagA, a, b)) return false;
    return keyCheck(a, b, mode, memo, kNoIterator);
  }

  if (tagA === '[object Set]') {
    if (tagOf(b) !== '[object Set]' || a.size !== b.size || hasUnequalTag(a, b)) return false;
    return keyCheck(a, b, mode, memo, kIsSet);
  }

  if (tagA === '[object Map]') {
    if (tagOf(b) !== '[object Map]' || a.size !== b.size || hasUnequalTag(a, b)) return false;
    return keyCheck(a, b, mode, memo, kIsMap);
  }

  if (ArrayBuffer.isView(a)) {
    // 视图种类要一致（Node:331）：`Uint8Array([1,2])` 与 `Int8Array([1,2])` 字节相同但**不**等
    if (!ArrayBuffer.isView(b) || tagOf(b) !== tagA) return false;
    if (!equalBytes(
      new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
      new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
    )) return false;
    // 字节比完还要比**附加属性**（Node:350-356）——老实现从这里 return true，
    // 于是 `x.foo = 1` 的 TypedArray 与干净的 TypedArray 被判等。
    return keyCheck(a, b, mode, memo, kNoIterator);
  }

  if (isUrl(a)) {
    // Node comparisons.js:409-412：**只比 href**（不比附加属性、也不进 keyCheck）
    if (!isUrl(b) || a.href !== b.href) return false;
    return true;
  }

  if (tagA === '[object Date]') {
    if (tagOf(b) !== '[object Date]' || hasUnequalTag(a, b)) return false;
    const timeA = a.getTime();
    const timeB = b.getTime();
    // Node:364：**无效日期（NaN）互相相等**。写成 `Object.is(timeA,timeB)` 会让
    // `new Date(NaN)` 与 `new Date(0)` 判不等，而 Node 判等（时间比不出来就继续比附加属性）。
    if (timeA !== timeB && (timeA === timeA || timeB === timeB)) return false;
  } else if (tagA === '[object RegExp]') {
    // Node:148 `areSimilarRegExps`：source / flags / **lastIndex** 三个都要一致。
    // 漏 lastIndex 时"带 g 跑过一次"的正则与新的看似相等——那是状态差异，不是值差异。
    if (tagOf(b) !== '[object RegExp]' || a.source !== b.source ||
        a.flags !== b.flags || a.lastIndex !== b.lastIndex || hasUnequalTag(a, b)) {
      return false;
    }
  } else if (isAnyArrayBufferTag(tagA)) {
    if (tagOf(b) !== tagA || hasUnequalTag(a, b)) return false;
    if (!equalBytes(new Uint8Array(a), new Uint8Array(b))) return false;
  } else if (slowHasUnequalTag(tagA, a, b) || Array.isArray(b) || ArrayBuffer.isView(b) ||
             tagOf(b) === '[object Set]' || tagOf(b) === '[object Map]' ||
             tagOf(b) === '[object Date]' || tagOf(b) === '[object RegExp]' ||
             isAnyArrayBufferTag(tagOf(b))) {
    // Node:382：一边是特化形态、另一边不是 → 直接不等（宽松模式同样不给"自有键相同"的机会）
    return false;
  } else if (a instanceof Error) {
    // Node:391-404：Error 比 message / name / cause / errors，**不看 stack**（它天然不同）。
    // `cause` 默认是**不可枚举**的自有属性，光靠 keyCheck 比不到它——必须在这里显式比。
    if (!(b instanceof Error) ||
        !isEnumerableOrIdentical(a, b, 'message', mode, memo) ||
        !isEnumerableOrIdentical(a, b, 'name', mode, memo) ||
        !isEnumerableOrIdentical(a, b, 'cause', mode, memo) ||
        !isEnumerableOrIdentical(a, b, 'errors', mode, memo)) {
      return false;
    }
    // Node:401-404：`cause` 的**存在性**也要一致——`new Error('x',{cause:undefined})`
    // 与 `new Error('x')` 在 Node 里不相等；只比值的话这两个都是 undefined，会被判等（假等）。
    if (hasOwn(b, 'cause') !== hasOwn(a, 'cause')) return false;
  } else if (isBoxedPrimitiveTag(tagA)) {
    if (!isEqualBoxedPrimitive(a, b)) return false;
  } else if (isBoxedPrimitiveTag(tagOf(b)) || b instanceof Error ||
             tagA === '[object WeakMap]' || tagA === '[object WeakSet]' || tagA === '[object Promise]') {
    // Node:459：这几种**没有可比较的内容**（WeakMap/WeakSet 不可枚举、Promise 是内部状态），
    // 一律不等。少了这条，两个空 WeakMap 会因为"自有可枚举键都是空的"被判等。
    return false;
  }

  return keyCheck(a, b, mode, memo, kNoIterator);
}

/**
 * Node comparisons.js:483 `keyCheck`：自有可枚举键的**数量与集合**、以及逐个值。
 *
 * Set/Map 的内容比较也挂在这里（Node 就是这么摆的）：于是"内容相等"与"附加属性相等"
 * 必须**同时**满足——只比内容会让 `s.foo = 1` 的 Set 与干净的 Set 判等。
 */
function keyCheck(a, b, mode, memo, iterationType) {
  const keysA = ownEnumerableKeys(a, mode === kStrict);
  const keysB = ownEnumerableKeys(b, mode === kStrict);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!keysB.includes(k)) return false;
    if (!deepCompare(a[k], b[k], mode, memo)) return false;
  }
  if (iterationType === kIsSet) return setEquiv(a, b, mode, memo);
  if (iterationType === kIsMap) return mapEquiv(a, b, mode, memo);
  return true;
}

/**
 * Set 内容比较（Node comparisons.js:757 `setEquiv` 的语义）：等势 + 双射匹配。
 * 朴素配对而不是 Node 的游标算法——两者在"元素两两配对"这一点上等价，而这里的规模是断言参数。
 */
function setEquiv(a, b, mode, memo) {
  const bValues = [...b.values()];
  const used = new Set();
  for (const v of a.values()) {
    let matched = false;
    for (let i = 0; i < bValues.length; i++) {
      if (used.has(i)) continue;
      if (deepCompare(v, bValues[i], mode, memo)) {
        used.add(i);
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

/** Map 内容比较（Node comparisons.js:896 `mapEquiv`）：键与值都要配对成功，键不能重复使用 */
function mapEquiv(a, b, mode, memo) {
  const bEntries = [...b.entries()];
  const used = new Set();
  for (const [k, v] of a.entries()) {
    let matched = false;
    for (let i = 0; i < bEntries.length; i++) {
      if (used.has(i)) continue;
      if (deepCompare(k, bEntries[i][0], mode, memo) && deepCompare(v, bEntries[i][1], mode, memo)) {
        used.add(i);
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

/**
 * 深比较内核（严格/宽松共用）：对应 Node comparisons.js:237 `innerDeepEqual`。
 * 两者的差别只在"入口守卫 + 要不要比 constructor/原型/tag"，值比较是同一套。
 */
function deepCompare(a, b, mode, memo) {
  // Node:239：同一引用恒等；`-0` 与 `+0` 只在严格模式下不等
  if (a === b) return a !== 0 || Object.is(a, b) || mode === kLoose;

  if (mode === kStrict) {
    // Node:245：NaN 相等（`Object.is` 那条已经盖住同引用，这里负责跨对象位置的 NaN）
    // eslint-disable-next-line no-self-compare
    if (typeof a === 'number') return a !== a && b !== b;
    // Node:250：非对象一律不等——**函数也在这里被挡掉**（typeof 是 'function'）。
    // 少了这条，两个不同的函数会因为"自有可枚举键都是空的"被判等。
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  } else {
    // Node:256：宽松模式只有"双方都是对象"才往下走；函数/基本值只按 `==` 与 NaN 比
    if (a === null || typeof a !== 'object') {
      // eslint-disable-next-line eqeqeq, no-self-compare
      return (b === null || typeof b !== 'object') && (a == b || (a !== a && b !== b));
    }
    if (b === null || typeof b !== 'object') return false;
  }

  // 循环引用：只在**当前这条递归链**上记"正在比的对"（Node handleCycles 的 set 语义）。
  // 比完必须摘掉：Set/Map 配对里已经判失败的那对若留在记忆里，后面的比对会直接拿它当
  // "相等"（假等）——`new Set([{k:u,n:1},{k:u,n:2}])` vs `new Set([{k:v,n:2},{k:u,n:1}])` 就是这种。
  memo = memo || new Map();
  let seen = memo.get(a);
  if (seen === undefined) {
    seen = new Set();
    memo.set(a, seen);
  }
  if (seen.has(b)) return true;
  seen.add(b);
  const result = objectComparisonStart(a, b, mode, memo);
  seen.delete(b);
  if (seen.size === 0) memo.delete(a);
  return result;
}

/** 严格深比较（deepStrictEqual 的内核） */
function isDeepStrictEqual(a, b) {
  return deepCompare(a, b, kStrict, undefined);
}

/** 宽松深比较（deepEqual 的内核） */
function isDeepEqual(a, b) {
  return deepCompare(a, b, kLoose, undefined);
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
