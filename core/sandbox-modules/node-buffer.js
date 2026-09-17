// node:buffer 仿真 —— **最小集**（设计 module-emulation-design §3.2.2 已定的范围）
//
// 分工（照 §3.2.2 的分工表，不是这里自己发明的）：
//   · 字节存储 / 索引 / 迭代 / subarray / slice / set / copy / 数值读写  → **沙箱原生**
//     （QuickJS 支持类型化数组子类化；`class Buffer extends Uint8Array` 后 `instanceof` 正常）
//   · 字符串 ↔ 字节（utf8 / utf16le / latin1 / ascii / base64 / base64url / hex）→ **宿主代工**
//     （`globalThis.__host['bytes.*']`，见 host-api.js 的 bytes 组）
//
// **为什么编解码必须代工**（三条，按重要性）：
//   1) 保真——难点从来不是主流程，而是**畸形输入**：孤立代理项、非法 base64、过长/截断的 utf8 各给几个
//      替换字符。自己写必然逐条漂移；宿主就是 Node，天然一致；
//   2) QuickJS **没有 TextEncoder/TextDecoder**，沙箱内只能逐字节手写（§3.2 实测 ≈2.6 MB/s）；
//   3) 存储必须留在沙箱——字节若放宿主（不透明 id），`buf[i]` 就要逐字节跨界。
// 注意：编码名的**归一化表**留在沙箱（node/lib/internal/util.js:258 `normalizeEncoding` 的逐字复刻）。
// 那是"名字映射"，不是编解码；`Buffer.isEncoding` 是同步谓词，不可能每次跨界问宿主。
//
// ══ 已知边界（写在这里，免得被当成 bug）══
//   1. **不实现池化**。Node 的 `Buffer.from`（小对象）与 `allocUnsafe` 走 8 KB 池，`slice().buffer`
//      会暴露**同池里别人的字节**（§3.2 坑 1；本项目在桥侧踩过一次，8192 字节里混着 source map）。
//      这里 `allocUnsafe` 直接 `new Uint8Array(n)`（V8/QuickJS 给的仍是零初始化内存）：
//      **安全优先**。可观测差异只有一个：`b.buffer.byteLength === b.length` 恒成立，Node 上不成立
//      （池化时 `buf.buffer.byteLength` 是整块池）。因此"靠 `buf.buffer` 反推别人的数据"这类代码
//      在这里拿不到东西——那正是我们要的。
//   2. `Buffer.poolSize` **只作为常量报出**（8192），不参与任何分配。这个数 Node 自己也在改：
//      本机宿主 v24.20.0 实测是 65536，本地 node/lib/buffer.js:186（v27）是 `64 * 1024`。
//      保留 8192 是本模块的口径选择（对外只承诺"它是个常量"，不承诺数值参与行为）。
//   3. `SlowBuffer` 已废弃，这里**明确抛 `ERR_NOT_SUPPORTED_IN_SANDBOX`**，不做静默 undefined——
//      否则生态里的引用会变成 "SlowBuffer is not a function"，查不出所以然（fail-closed 取向）。
//   4. `Buffer(n)` / `Buffer(str)`（不带 `new`）不支持：`class` 构造器不能当函数调。
//      Node 上那是 DEP0005 的废弃路径，`new Buffer(n)` 照常可用。
//   5. 不在最小集：`transcode` / `buffer.constants` / `Blob` / `File` / `atob` / `btoa` /
//      `isUtf8` / `isAscii` / `Buffer.copyBytesFrom` / `INSPECT_MAX_BYTES` / `kMaxLength` 导出，
//      以及 `buf.inspect`（沙箱里的展示格式不该由仿真层定）。
//   6. **孤立代理项经桥会失真**：字符串通道是 UTF-8（§3.2 末尾那条固有限制），沙箱里的
//      `Buffer.from('\uD800')` 与 Node 直接编码可能不同。这是桥的性质，不是本文件能修的；
//      同一个模块在测试进程里（不经过桥）与 Node 完全一致。
//
// 内联约束：静态、无占位符、不 import 任何 `node:*`；能力只在运行时从 `globalThis.__host` 取。

/** 与宿主 Node 一致的上限：v24 起 `validateOffset`/`validateNumber` 的上界是 MAX_SAFE_INTEGER */
const MAX_LENGTH = 9007199254740991; // Number.MAX_SAFE_INTEGER
/**
 * `Buffer.poolSize` —— **仅是常量**（见文件头边界 2）。本机宿主 v24.20.0 实测 65536，
 * 但绝大多数依赖只在"它存在且是数字"这个层面用它（比如自己实现池化时选块大小）。
 */
const POOL_SIZE = 8192;

// ──────────────────────────── 宿主代工通道 ────────────────────────────

/**
 * 二进制参数**必须是 ArrayBuffer**：桥只认 ArrayBuffer，不认 TypedArray 视图，
 * 传视图过去会以 "Couldn't allocate memory to get ArrayBuffer" 失败（§3.2 坑 4，报错读起来像 OOM）。
 * 所以这里做 host-api.js `__toAB` 的同一件事：整块视图复用底层 buffer（不拷贝），否则切出区间。
 */
function toExactArrayBuffer(view) {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/**
 * 桥的**错误信封**还原。
 *
 * 为什么这里要自己写一遍（host-api.js 的 `__unwrap` 做的是同一件事）：
 * `globalThis.__host` 是**裸桥**——`@host/api` 的 `__wrap`/`__json` 系列是另一个模块里的**沙箱侧包装**，
 * `node:buffer` 拿到的是桥本身，所以"信封还原 + JSON 解码"两步都得自己做。
 * 少一步的后果是实测出来的（§3.2 坑 2）：宿主对返回值一律 `JSON.stringify`，
 * `bytes.toString` 回来的是**带引号的 JSON 文本**——不 parse 就把 `"hi"`（含引号）交给插件。
 *
 * 判定收紧为"只有键信封"（同 host-api.js）：单键 + `__spcError` 对象 + code 是字符串才算错误，
 * 免得插件数据里出现 `__spcError` 字样时被误判。
 */
function unwrapHostResult(raw) {
  if (typeof raw !== 'string' || raw.indexOf('__spcError') === -1) return raw;
  let env = null;
  try {
    env = JSON.parse(raw);
  } catch {
    return raw; // 不是 JSON（普通字符串结果），原样返回
  }
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const keys = Object.keys(env);
    if (keys.length === 1 && keys[0] === '__spcError' && env.__spcError && typeof env.__spcError.code === 'string') {
      const err = new Error(env.__spcError.code);
      err.code = env.__spcError.code;
      if (env.__spcError.params) err.params = env.__spcError.params;
      throw err;
    }
  }
  return raw;
}

/**
 * 宿主编码错误 → Node 形状。
 *
 * 宿主侧（core/hostApi.ts 的 `assertEncoding`）抛的是平台契约码 `ENCODING_UNKNOWN`，
 * 但 Node 在这条路上抛的是 `ERR_UNKNOWN_ENCODING`。依赖普遍按 Node 的码分支（§7 的 errno 翻译模式：
 * 对外像 Node，对内仍是我们的码），所以这里翻译，并把宿主码留在 `err.spcCode` 供排障与审计关联。
 *
 * 防御性：编码名在沙箱侧已按 Node 的表校验过（能到宿主说明两边表不一致），但这层不能省——
 * 少了它，宿主新增/改名编码时插件拿到的是 `ENCODING_UNKNOWN`，与 Node 生态的预期不符。
 */
function translateBridgeError(err, encoding) {
  if (err && err.code === 'ENCODING_UNKNOWN') {
    const e = new TypeError('Unknown encoding: ' + encoding);
    e.code = 'ERR_UNKNOWN_ENCODING';
    e.spcCode = 'ENCODING_UNKNOWN';
    return e;
  }
  return err;
}

/** 桥坏了（声明二进制却回字符串）要**响亮地**失败，不能把垃圾当字节交给插件 */
function bridgeContractError(what) {
  const e = new Error('sandbox bridge contract violation: ' + what);
  e.code = 'INTERNAL';
  return e;
}

/** 字符串 → 字节（宿主）。返回的是宿主回传的字节视图（一次拷贝，与沙箱内存无关）。 */
function hostEncode(text, canonicalEncoding) {
  let raw;
  try {
    raw = unwrapHostResult(globalThis.__host['bytes.fromString'](text, canonicalEncoding));
  } catch (err) {
    throw translateBridgeError(err, canonicalEncoding);
  }
  // 契约：`ArrayBuffer` = 数据 / 字符串 = 错误信封（信封已在上面还原成异常）
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return raw;
  throw bridgeContractError('bytes.fromString returned ' + Object.prototype.toString.call(raw));
}

/** 字节 → 字符串（宿主）。view 可以是任意 Uint8Array 视图（内部会切成 ArrayBuffer）。 */
function hostDecode(view, canonicalEncoding) {
  let raw;
  try {
    raw = unwrapHostResult(globalThis.__host['bytes.toString'](toExactArrayBuffer(view), canonicalEncoding));
  } catch (err) {
    throw translateBridgeError(err, canonicalEncoding);
  }
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** 字符串按某编码编码后的字节数（宿主算，不需要先编码出来） */
function hostByteLength(text, canonicalEncoding) {
  let raw;
  try {
    raw = unwrapHostResult(globalThis.__host['bytes.byteLength'](text, canonicalEncoding));
  } catch (err) {
    throw translateBridgeError(err, canonicalEncoding);
  }
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ──────────────────────────── 错误（Node 形状）────────────────────────────

/**
 * `Received ...` 的写法照 node/lib/internal/errors.js:1009 `determineSpecificType` 复刻。
 * 为什么值得复刻：这些文案会被依赖写进日志、被测试断言，形状对不上时很难判断"是我错了还是环境不对"。
 */
function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'bigint') return 'type bigint (' + value + 'n)';
  if (type === 'number') {
    if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
    if (value !== value) return 'type number (NaN)';
    if (value === Infinity) return 'type number (Infinity)';
    if (value === -Infinity) return 'type number (-Infinity)';
    return 'type number (' + value + ')';
  }
  if (type === 'boolean') return value ? 'type boolean (true)' : 'type boolean (false)';
  if (type === 'symbol') return 'type symbol (' + String(value) + ')';
  if (type === 'function') return 'function ' + value.name;
  if (type === 'object') {
    // constructor 是插件可控的：可能不是对象、name 也可能不是字符串——两次读取之间还可能被 getter 换掉
    const name = value.constructor && value.constructor.name;
    if (typeof name === 'string' && name !== '') return 'an instance of ' + name;
    return 'an instance of Object';
  }
  if (type === 'string') {
    const shown = value.length > 28 ? value.slice(0, 25) + '...' : value;
    return shown.indexOf("'") === -1 ? "type string ('" + shown + "')" : 'type string (' + JSON.stringify(shown) + ')';
  }
  return 'type ' + type;
}

/** 大数加千位分隔（node/lib/internal/errors.js 的 addNumericalSeparator） */
function addNumericalSeparator(val) {
  let res = '';
  let i = val.length;
  const start = val[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) res = '_' + val.slice(i - 3, i) + res;
  return val.slice(0, i) + res;
}

/** `ERR_OUT_OF_RANGE` 的 `Received ...`（与 determineSpecificType 不同：这里用 inspect 口径） */
function formatRangeInput(input) {
  if (typeof input === 'bigint') {
    let s = String(input);
    if (input > 4294967296n || input < -4294967296n) s = addNumericalSeparator(s);
    return s + 'n';
  }
  if (typeof input === 'number') {
    if (Number.isInteger(input) && Math.abs(input) > 4294967296) return addNumericalSeparator(String(input));
    return String(input);
  }
  if (typeof input === 'string') return "'" + input + "'";
  return determineSpecificType(input);
}

/** `ERR_INVALID_ARG_VALUE` 的 `Received ...`（Node 走 util.inspect，这里只做够用的近似） */
function formatInvalidValue(value) {
  if (typeof value === 'string') return "'" + value + "'";
  if (value instanceof Uint8Array) {
    // 不调 Buffer.prototype.toString：错误文案不该再去过一次桥（桥失败时连错都报不出来）
    if (value.constructor === Buffer) {
      let hex = '';
      for (let i = 0; i < value.length && i < 50; i++) hex += (value[i] < 16 ? '0' : '') + value[i].toString(16);
      return '<Buffer' + (hex === '' ? ' ' : ' ' + hex) + '>';
    }
    return 'Uint8Array(' + value.length + ')';
  }
  return determineSpecificType(value);
}

const K_TYPES = ['string', 'number', 'boolean', 'object', 'function', 'symbol', 'bigint', 'undefined'];

function invalidArgType(name, expected, actual) {
  const list = Array.isArray(expected) ? expected : [expected];
  const types = [];
  const instances = [];
  const other = [];
  for (const value of list) {
    if (K_TYPES.indexOf(value) !== -1) types.push(value);
    else if (/^[A-Z]/.test(value)) instances.push(value);
    else other.push(value);
  }
  // `object` 与实例并存时，把它挪到实例侧（否则文案会自相矛盾：node/lib/internal/errors.js:1456）
  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push('Object');
    }
  }
  let msg = 'The ';
  msg += name.endsWith(' argument') ? name + ' ' : '"' + name + '" ' + (name.indexOf('.') !== -1 ? 'property' : 'argument') + ' ';
  msg += 'must be ';
  if (types.length > 0) {
    msg += (types.length > 1 ? 'one of type ' : 'of type ') + types.join(' or ');
    if (instances.length > 0 || other.length > 0) msg += ' or ';
  }
  if (instances.length > 0) {
    msg += 'an instance of ' + instances.join(' or ');
    if (other.length > 0) msg += ' or ';
  }
  if (other.length > 0) {
    if (other.length > 1) msg += 'one of ' + other.join(' or ');
    else msg += (other[0][0] === other[0][0].toLowerCase() ? '' : 'an ') + other[0];
  }
  msg += '. Received ' + determineSpecificType(actual);
  const e = new TypeError(msg);
  e.code = 'ERR_INVALID_ARG_TYPE';
  return e;
}

function outOfRange(name, range, input) {
  const e = new RangeError(
    'The value of "' + name + '" is out of range. It must be ' + range + '. Received ' + formatRangeInput(input),
  );
  e.code = 'ERR_OUT_OF_RANGE';
  return e;
}

function invalidArgValue(name, value, reason) {
  const e = new TypeError("The argument '" + name + "' " + (reason === undefined ? 'is invalid' : reason) + '. Received ' + formatInvalidValue(value));
  e.code = 'ERR_INVALID_ARG_VALUE';
  return e;
}

/** 无 name 时 Node 的文案是 "Attempt to access memory outside buffer bounds" */
function bufferOutOfBounds(name) {
  const e = new RangeError(name === undefined ? 'Attempt to access memory outside buffer bounds' : '"' + name + '" is outside of buffer bounds');
  e.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
  return e;
}

function unknownEncoding(encoding) {
  const e = new TypeError('Unknown encoding: ' + encoding);
  e.code = 'ERR_UNKNOWN_ENCODING';
  return e;
}

function invalidBufferSize(size) {
  const e = new RangeError('Buffer size must be a multiple of ' + size);
  e.code = 'ERR_INVALID_BUFFER_SIZE';
  return e;
}

// ──────────────────────────── 校验（校验顺序也要照 Node）────────────────────────────

function validateNumber(value, name, min, max) {
  if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
  if ((min !== undefined && value < min) || (max !== undefined && value > max) || ((min !== undefined || max !== undefined) && value !== value)) {
    throw outOfRange(
      name,
      (min !== undefined ? '>= ' + min : '') + (min !== undefined && max !== undefined ? ' && ' : '') + (max !== undefined ? '<= ' + max : ''),
      value,
    );
  }
}

function validateInteger(value, name, min, max) {
  if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
  if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
  if (value < min || value > max) throw outOfRange(name, '>= ' + min + ' && <= ' + max, value);
}

/** Node 的 validateOffset = validateInteger，默认上界 kMaxLength（v24 起是 MAX_SAFE_INTEGER） */
function validateOffset(value, name, min, max) {
  validateInteger(value, name, min === undefined ? 0 : min, max === undefined ? MAX_LENGTH : max);
}

function validateString(value, name) {
  if (typeof value !== 'string') throw invalidArgType(name, 'string', value);
}

/**
 * 编码名归一化 —— **纯名字表**，逐字复刻 node/lib/internal/util.js:258 `normalizeEncoding`。
 *
 * 注意它**不做 ToString**：非字符串（数字/对象/符号）走 `enc.length` → undefined → 落空。
 * 这一点与 `getEncodingOps`（buffer.js:857，先 `encoding += ''`）不同，两个入口的行为差异
 * 在 Node 上真实存在（`Buffer.from('a', 123)` 是 utf8，而 `buf.toString(123)` 抛错），所以这里两个都留。
 */
function normalizeEncoding(enc) {
  if (enc === undefined || enc === null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  switch (enc.length) {
    case 4:
      if (enc === 'UTF8') return 'utf8';
      if (enc === 'ucs2' || enc === 'UCS2') return 'utf16le';
      enc = String.prototype.toLowerCase.call(enc);
      if (enc === 'utf8') return 'utf8';
      if (enc === 'ucs2') return 'utf16le';
      break;
    case 3:
      if (enc === 'hex' || enc === 'HEX' || String.prototype.toLowerCase.call(enc) === 'hex') return 'hex';
      break;
    case 5:
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      if (enc === 'UTF-8') return 'utf8';
      if (enc === 'ASCII') return 'ascii';
      if (enc === 'UCS-2') return 'utf16le';
      enc = String.prototype.toLowerCase.call(enc);
      if (enc === 'utf-8') return 'utf8';
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      break;
    case 6:
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      if (enc === 'BASE64') return 'base64';
      if (enc === 'LATIN1' || enc === 'BINARY') return 'latin1';
      enc = String.prototype.toLowerCase.call(enc);
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      break;
    case 7:
      if (enc === 'utf16le' || enc === 'UTF16LE' || String.prototype.toLowerCase.call(enc) === 'utf16le') return 'utf16le';
      break;
    case 8:
      if (enc === 'utf-16le' || enc === 'UTF-16LE' || String.prototype.toLowerCase.call(enc) === 'utf-16le') return 'utf16le';
      break;
    case 9:
      if (enc === 'base64url' || enc === 'BASE64URL' || String.prototype.toLowerCase.call(enc) === 'base64url') return 'base64url';
      break;
    default:
      if (enc === '') return 'utf8';
  }
  return undefined;
}

/** `getEncodingOps` 那一侧：先把编码 ToString 再查表（`buf.toString(123)` 抛错的来源） */
function normalizeEncodingOf(enc) {
  const name = enc + '';
  // ⚠️ 两个表在**空串**上不一致，这不是笔误：`normalizeEncoding('')` 是 'utf8'（util.js 的 default 分支），
  // 而 `getEncodingOps('')` 的 switch 根本没有 length 0 的分支 → undefined → `toString('')` 抛
  // ERR_UNKNOWN_ENCODING。实测过分歧，照抄。
  if (name === '') return undefined;
  return normalizeEncoding(name);
}

// ──────────────────────────── 字节比较 / 搜索 ────────────────────────────

/** Node 用原生 memcmp：先比公共前缀，再比长度 */
function compareBytes(a, b) {
  const len = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function compareOffset(self, target, targetStart, sourceStart, targetEnd, sourceEnd) {
  const sourceLength = sourceEnd - sourceStart;
  const targetLength = targetEnd - targetStart;
  const len = sourceLength < targetLength ? sourceLength : targetLength;
  for (let i = 0; i < len; i++) {
    const a = self[sourceStart + i];
    const b = target[targetStart + i];
    if (a !== b) return a < b ? -1 : 1;
  }
  if (sourceLength === targetLength) return 0;
  return sourceLength < targetLength ? -1 : 1;
}

/**
 * `IndexOfOffset`（node/src/node_buffer.cc:1010）—— 负偏移、越界偏移的收敛全在这里，
 * 也是最容易"看起来对、边角全错"的一段，所以逐条照抄而不是自己想一套 clamp。
 */
function indexOfOffset(length, offset, needleLength, isForward) {
  if (offset < 0) {
    if (offset + length >= 0) return length + offset; // 负偏移从尾部倒数
    if (isForward || needleLength === 0) return 0; // 起点在缓冲区之前：搜整块
    return -1; // lastIndexOf 且起点在之前：不可能命中
  }
  if (offset + needleLength <= length) return offset;
  if (needleLength === 0) return length; // 越界但空针：指向末尾
  if (isForward) return -1;
  return length - 1;
}

/**
 * 底层字节搜索（`nbytes::SearchString`，deps/nbytes/include/nbytes.h 的移植）。
 *
 * 两个方向不是"同一个循环换一下方向"：Node 的**反向**搜索是把 haystack 与 needle 都**反转**后
 * 做正向搜索，起点 `relative_start_index = (haystack_length - needle_length) - start_index`
 * ⇒ 语义是"**起点 ≤ start_index** 的最后一个匹配"。少了这条，`lastIndexOf(needle, i)` 会漏掉
 * 恰好从 i 开始的匹配（那是最常见的一次调用）。
 */
function searchBytes(haystack, needle, from, searchEnd, forward, unit) {
  const u = unit === undefined ? 1 : unit;
  if (needle.length === 0) return from;
  if (forward) {
    const last = searchEnd - needle.length;
    for (let i = from; i <= last; i += u) {
      let k = 0;
      while (k < needle.length && haystack[i + k] === needle[k]) k++;
      if (k === needle.length) return i;
    }
    return -1;
  }
  // 反向：候选**起点**从 from 递减到 0，取第一个命中（即起点最大的那个）
  for (let i = from; i >= 0; i -= u) {
    let k = 0;
    while (k < needle.length && haystack[i + k] === needle[k]) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

/**
 * indexOf/lastIndexOf/includes 的共同实现（node/src/node_buffer.cc:1028 IndexOfString
 * 与 :1160 IndexOfBuffer 的移植）。`enc` 只影响两件事：UCS2 按 2 字节对齐搜索、字符串针按该编码编码。
 */
function bidirectionalIndexOf(buffer, val, byteOffset, end, encoding, dir) {
  if (typeof byteOffset === 'string') {
    encoding = byteOffset;
    byteOffset = undefined;
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff;
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000;
  }
  byteOffset = +byteOffset;
  if (byteOffset !== byteOffset) byteOffset = dir ? 0 : buffer.length;

  if (typeof val === 'number') {
    const byte = val >>> 0;
    return indexOfNumber(buffer, byte & 255, byteOffset, dir, end);
  }

  let canonical;
  if (encoding === undefined) canonical = 'utf8';
  else canonical = normalizeEncodingOf(encoding);

  if (typeof val === 'string') {
    if (canonical === undefined) throw unknownEncoding(encoding);
    return indexOfBuffer(buffer, hostEncode(val, canonical), byteOffset, dir, end, canonical === 'utf16le');
  }
  if (val instanceof Uint8Array) {
    // 未知编码 + Buffer 针：Node 不抛错，按字节搜（buffer.js:1145-1148）
    return indexOfBuffer(buffer, bytesOf(val), byteOffset, dir, end, canonical === 'utf16le');
  }
  throw invalidArgType('value', ['number', 'string', 'Buffer', 'Uint8Array'], val);
}

/** 数字针：`IndexOfNumberImpl`（node_buffer.cc:1248）的移植——单字节搜索，语义比字符串针简单 */
function indexOfNumber(buffer, byte, byteOffset, dir, end) {
  const length = buffer.length;
  const optOffset = indexOfOffset(length, byteOffset, 1, dir);
  if (optOffset <= -1 || length === 0) return -1;
  const searchEnd = clampEnd(end, length);
  if (dir) {
    if (optOffset >= searchEnd) return -1;
    for (let i = optOffset; i < searchEnd; i++) if (buffer[i] === byte) return i;
    return -1;
  }
  const backwardEnd = Math.min(optOffset + 1, searchEnd);
  if (backwardEnd === 0) return -1;
  for (let i = backwardEnd - 1; i >= 0; i--) if (buffer[i] === byte) return i;
  return -1;
}

/** `search_end = min(max(end, 0), length)` —— end 是 JS 侧给的数（默认 `this.length`） */
function clampEnd(end, length) {
  const n = +end;
  if (n !== n) return length; // NaN：Node 侧是 int32 转换的未定义行为，这里取"整块"这个安全解
  return Math.min(Math.max(Math.trunc(n), 0), length);
}

function indexOfBuffer(buffer, needle, byteOffset, dir, end, ucs2) {
  const length = ucs2 ? buffer.length & ~1 : buffer.length;
  const needleLength = needle.length;
  let searchEnd = clampEnd(end, length);
  if (ucs2) searchEnd &= ~1;
  const optOffset = indexOfOffset(length, byteOffset, needleLength, dir);
  if (needleLength === 0) return Math.min(optOffset, searchEnd); // 空针：与 String#indexOf 一致（但夹到 searchEnd）
  if (optOffset <= -1) return -1;
  let offset = optOffset;
  if (!dir && offset >= searchEnd) {
    if (searchEnd === 0) return -1;
    offset = searchEnd - 1;
  } else if (dir && offset >= searchEnd) {
    return -1;
  }
  if ((dir && needleLength + offset > searchEnd) || needleLength > searchEnd) return -1;
  if (length === 0) return -1;
  if (ucs2) {
    if (searchEnd < 2 || needleLength < 2) return -1;
    // UCS2 按 2 字节**单元**比较：针的奇数字节被丢掉（Node 是 needle_length / 2）
    const evenNeedle = needleLength & ~1;
    const r = searchBytes(buffer, needle.subarray(0, evenNeedle), (offset >> 1) << 1, searchEnd, dir, 2);
    return r >= searchEnd || r === -1 ? -1 : r;
  }
  const r = searchBytes(buffer, needle, offset, searchEnd, dir, 1);
  return r >= searchEnd || r === -1 ? -1 : r;
}

/** 任意视图 → **字节视图**（Uint16Array/DataView 的 `[i]` 不是字节，比较/搜索必须按字节） */
function bytesOf(view) {
  if (view instanceof Uint8Array) return view;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

// ──────────────────────────── Buffer ────────────────────────────

/**
 * `class Buffer extends Uint8Array`：QuickJS 支持类型化数组子类化，`instanceof Buffer` / `instanceof Uint8Array`
 * 都正常，`length` / `buf[i]` / 迭代 / `set` / `sort` 等全部走引擎原生实现（§3.2.2 分工表）。
 *
 * 构造器只服务内部（`subarray` 的 species 构造、`alloc`、`from(arrayBuffer)` 三条路）与
 * `new Buffer(n)` 这条遗留写法；公开入口是 `Buffer.from/alloc/...`（参数校验都在那边，错误更贴 Node）。
 */
class Buffer extends Uint8Array {
  constructor(arg, byteOffset, length) {
    if (typeof arg === 'number') {
      validateNumber(arg, 'size', 0, MAX_LENGTH);
      super(arg);
      return;
    }
    if (arg instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && arg instanceof SharedArrayBuffer)) {
      super(arg, byteOffset, length);
      return;
    }
    if (arg instanceof Uint8Array) {
      // 复制内容（Node: fromArrayLike 的 TypedArray 分支）；注意 Uint16Array 也走这里，
      // 元素个数即长度、`set` 逐元素截断，与 Node 一致
      super(arg.length);
      this.set(arg);
      return;
    }
    if (Array.isArray(arg)) {
      super(arg.length);
      this.set(arg);
      return;
    }
    super(0);
  }

  // ── 遗留别名（Node 是 enumerable getter，这里同形；生态里偶有 `buf.parent` 判池化）──
  get parent() {
    return this instanceof Buffer ? this.buffer : undefined;
  }

  get offset() {
    return this instanceof Buffer ? this.byteOffset : undefined;
  }

  /**
   * ⚠️ **`slice` 与 `Uint8Array.prototype.slice` 同名不同义**：Node 的 `Buffer.prototype.slice`
   * 是**共享内存**的（语义等同 `subarray`），而 `Uint8Array.prototype.slice` 是复制。
   * 少了这个覆盖，`buf.slice()` 会静默变成"复制"——依赖靠切片改原缓冲的代码会**静默失效**，
   * 而且没有任何报错。这是 §3.2 坑 1 的同一条语义，桥侧也踩过（那边是反过来：误用 `slice()` 导致共享）。
   */
  slice(start, end) {
    return this.subarray(start, end);
  }

  /**
   * `subarray` 的收敛规则照 node/lib/buffer.js:1319 `adjustOffset`：负数从尾部算、NaN 当 0、
   * 超界截到长度。**与 `Uint8Array.prototype.subarray` 不同**（那边负数允许、超界也截断，但 NaN 处理不同），
   * 所以必须自己实现，不能靠继承。
   */
  subarray(start, end) {
    const srcLength = this.length;
    start = adjustOffset(start, srcLength);
    end = end !== undefined ? adjustOffset(end, srcLength) : srcLength;
    const newLength = end > start ? end - start : 0;
    return new Buffer(this.buffer, this.byteOffset + start, newLength);
  }

  /** 共享内存的另一个入口（Node 没有重载 `set` 的语义变化，但显式写出来免得被误当成复制） */
  copy(target, targetStart, sourceStart, sourceEnd) {
    if (!ArrayBuffer.isView(target)) throw invalidArgType('target', ['Buffer', 'Uint8Array'], target);
    if (targetStart === undefined) {
      targetStart = 0;
    } else {
      targetStart = Number.isInteger(targetStart) ? targetStart : toInteger(targetStart, 0);
      if (targetStart < 0) throw outOfRange('targetStart', '>= 0', targetStart);
    }
    if (sourceStart === undefined) {
      sourceStart = 0;
    } else {
      sourceStart = Number.isInteger(sourceStart) ? sourceStart : toInteger(sourceStart, 0);
      if (sourceStart < 0 || sourceStart > this.length) throw outOfRange('sourceStart', '>= 0 && <= ' + this.length, sourceStart);
    }
    if (sourceEnd === undefined) {
      sourceEnd = this.length;
    } else {
      sourceEnd = Number.isInteger(sourceEnd) ? sourceEnd : toInteger(sourceEnd, 0);
      if (sourceEnd < 0) throw outOfRange('sourceEnd', '>= 0', sourceEnd);
    }
    if (targetStart >= target.length || sourceStart >= sourceEnd) return 0;
    if (sourceEnd - sourceStart > target.length - targetStart) sourceEnd = sourceStart + target.length - targetStart;
    let nb = sourceEnd - sourceStart;
    const sourceLen = this.length - sourceStart;
    if (nb > sourceLen) nb = sourceLen;
    if (nb <= 0) return 0;
    // Node 的原生 `_copy` 是 **memmove** 语义（重叠时等价于先拷到临时缓冲再写回）。
    // 少了这个判断，`buf.copy(buf, 1, 0, 4)` 这种"自身右移"会逐字节自我覆盖成 [1,1,1,1,1]
    // （实测 Node 是 [1,1,2,3,4]）——依赖拿它做原地前移/去重时会静默得到垃圾。
    const sharesBuffer = target.buffer === this.buffer;
    const targetAbs = target.byteOffset + targetStart;
    const sourceAbs = this.byteOffset + sourceStart;
    if (sharesBuffer && targetAbs > sourceAbs && targetAbs < sourceAbs + nb) {
      for (let i = nb - 1; i >= 0; i--) target[targetStart + i] = this[sourceStart + i];
      return nb;
    }
    for (let i = 0; i < nb; i++) target[targetStart + i] = this[sourceStart + i];
    return nb;
  }

  /**
   * `toString(encoding, start, end)` —— 字节切片仍在沙箱（原生 `subarray`），
   * 只有"字节 → 字符串"这一步过桥。切片语义照 buffer.js:971（注意它的 clamp 与 `subarray` **不同**：
   * `start>=len` 直接给空串、NaN → 0、`end` 用 `Math.trunc`）。
   */
  toString(encoding, start, end) {
    if (arguments.length === 0) return hostDecode(this, 'utf8');
    const bufferLength = this.length;
    if (start <= 0) start = 0;
    else if (start >= bufferLength) return '';
    else start = Math.trunc(start) || 0;
    if (end === undefined || end > bufferLength) end = bufferLength;
    else end = Math.trunc(end) || 0;
    if (end <= start) return '';
    if (encoding === undefined) return hostDecode(this.subarray(start, end), 'utf8');
    const canonical = normalizeEncodingOf(encoding);
    if (canonical === undefined) throw unknownEncoding(encoding);
    return hostDecode(this.subarray(start, end), canonical);
  }

  toJSON() {
    const data = new Array(this.length);
    for (let i = 0; i < this.length; i++) data[i] = this[i];
    return { type: 'Buffer', data: data };
  }

  equals(otherBuffer) {
    if (!(otherBuffer instanceof Uint8Array)) throw invalidArgType('otherBuffer', ['Buffer', 'Uint8Array'], otherBuffer);
    if (this === otherBuffer) return true;
    if (this.length !== otherBuffer.length) return false;
    return compareBytes(this, bytesOf(otherBuffer)) === 0;
  }

  compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {
    if (!(target instanceof Uint8Array)) throw invalidArgType('target', ['Buffer', 'Uint8Array'], target);
    if (arguments.length === 1) return compareBytes(this, bytesOf(target));
    if (targetStart === undefined) targetStart = 0;
    else validateOffset(targetStart, 'targetStart');
    if (targetEnd === undefined) targetEnd = target.length;
    else validateOffset(targetEnd, 'targetEnd', 0, target.length);
    if (sourceStart === undefined) sourceStart = 0;
    else validateOffset(sourceStart, 'sourceStart');
    if (sourceEnd === undefined) sourceEnd = this.length;
    else validateOffset(sourceEnd, 'sourceEnd', 0, this.length);
    if (sourceStart >= sourceEnd) return targetStart >= targetEnd ? 0 : -1;
    if (targetStart >= targetEnd) return 1;
    return compareOffset(this, bytesOf(target), targetStart, sourceStart, targetEnd, sourceEnd);
  }

  indexOf(val, offset, end, encoding) {
    if (typeof end === 'string') {
      encoding = end;
      end = this.length;
    } else if (end === undefined) {
      end = this.length;
    }
    return bidirectionalIndexOf(this, val, offset, end, encoding, true);
  }

  lastIndexOf(val, offset, end, encoding) {
    if (typeof end === 'string') {
      encoding = end;
      end = this.length;
    } else if (end === undefined) {
      end = this.length;
    }
    return bidirectionalIndexOf(this, val, offset, end, encoding, false);
  }

  includes(val, offset, end, encoding) {
    if (typeof end === 'string') {
      encoding = end;
      end = this.length;
    } else if (end === undefined) {
      end = this.length;
    }
    return bidirectionalIndexOf(this, val, offset, end, encoding, true) !== -1;
  }

  /**
   * `fill` —— 三条路（node/lib/buffer.js:1194 `_fill` + node/src/node_buffer.cc Fill）：
   *   · 视图（**任意** ArrayBufferView，含 DataView）：原始字节当**模式**循环填；
   *   · 字符串：按编码编码成字节，再当模式循环填；
   *   · 其它（含数字/null/对象）：走 `TypedArray.prototype.fill`（ToNumber → ToUint8，Node 是 memset(value & 255)）。
   * 模式的截断规则：先按编码结果**前缀**截到区间长度，再循环（Node 的 C++ 就是这么写的，
   * 所以 `alloc(3).fill('aabbcc','hex')` 是 `aabbcc` 而不是把 'aa' 循环三次）。
   */
  fill(value, offset, end, encoding) {
    let pattern = null;
    if (typeof value === 'string') {
      if (offset === undefined || typeof offset === 'string') {
        encoding = offset;
        offset = 0;
        end = this.length;
      } else if (typeof end === 'string') {
        encoding = end;
        end = this.length;
      }
      const canonical = normalizeEncoding(encoding);
      if (canonical === undefined) {
        // 顺序照 Node：先 validateString（数字编码 → ERR_INVALID_ARG_TYPE），再 ERR_UNKNOWN_ENCODING
        validateString(encoding, 'encoding');
        throw unknownEncoding(encoding);
      }
      if (value.length === 0) {
        value = 0; // Node: 空串按 0 填
      } else {
        pattern = hostEncode(value, canonical);
      }
    } else if (ArrayBuffer.isView(value)) {
      pattern = bytesOf(value);
      encoding = undefined;
    } else {
      encoding = undefined;
    }

    if (offset === undefined) {
      offset = 0;
      end = this.length;
    } else {
      validateOffset(offset, 'offset');
      if (end === undefined) {
        end = this.length;
      } else {
        validateOffset(end, 'end', 0, this.length);
      }
      if (offset >= end) return this; // 空区间：Node 直接返回（不校验 value 的编码可用性之后的步骤）
    }

    if (pattern === null) {
      // 数值路径沿用原生 fill（等价 memset(value & 255)，NaN/undefined/null 都落 0）
      if (offset > end || end - offset + offset > this.length) throw bufferOutOfBounds();
      Uint8Array.prototype.fill.call(this, value, offset, end);
      return this;
    }
    return repeatFill(this, pattern, value, offset, end);
  }

  /**
   * `write(string, offset, length, encoding)` —— 编码走宿主，但**多字节边界要自己对齐**：
   * Node 的原生写只写**完整字符**（utf8 不在字符中间截断、utf16le 按 2 字节对齐），
   * 而宿主的 `bytes.fromString` 只能整串编码。所以整串编码后按编码族回退到边界
   * （见 fitEncodedLength）——少了这一步，`buf.write('é',0,1)` 会写进半个字符（Node 写 0 字节）。
   */
  write(string, offset, length, encoding) {
    if (typeof string !== 'string') {
      const e = new TypeError('argument must be a string');
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
    const bufferLength = this.length;
    let forceUtf8 = false;
    // `write(str)` 这条路 Node **固定走 utf8**（buffer.js:1270 直接 return utf8Write）：
    // 于是 `write(s, undefined, undefined, 'hex')` 在 Node 上写的是 utf8 字节。照抄，别"顺手修正"。
    if (offset === undefined) {
      offset = 0;
      length = bufferLength;
      forceUtf8 = true;
    } else if (length === undefined && typeof offset === 'string') {
      encoding = offset;
      length = bufferLength;
      offset = 0;
    } else {
      validateOffset(offset, 'offset', 0, bufferLength);
      const remaining = bufferLength - offset;
      if (length === undefined) {
        length = remaining;
      } else if (typeof length === 'string') {
        encoding = length;
        length = remaining;
      } else {
        validateOffset(length, 'length', 0, bufferLength);
        if (length > remaining) length = remaining;
      }
    }
    let canonical;
    if (forceUtf8 || !encoding || encoding === 'utf8') canonical = 'utf8';
    else if (encoding === 'ascii') canonical = 'ascii';
    else {
      canonical = normalizeEncodingOf(encoding);
      if (canonical === undefined) throw unknownEncoding(encoding);
    }
    const encoded = hostEncode(string, canonical);
    let n = encoded.length;
    if (n > length) n = fitEncodedLength(encoded, length, canonical);
    for (let i = 0; i < n; i++) this[offset + i] = encoded[i];
    return n;
  }

  /** `swap*` 只做字节重排，纯沙箱（§7 无依赖）；长度不整除时 Node 抛 ERR_INVALID_BUFFER_SIZE */
  swap16() {
    if (this.length % 2 !== 0) throw invalidBufferSize('16-bits');
    for (let i = 0; i < this.length; i += 2) swapBytes(this, i, i + 1);
    return this;
  }

  swap32() {
    if (this.length % 4 !== 0) throw invalidBufferSize('32-bits');
    for (let i = 0; i < this.length; i += 4) {
      swapBytes(this, i, i + 3);
      swapBytes(this, i + 1, i + 2);
    }
    return this;
  }

  swap64() {
    if (this.length % 8 !== 0) throw invalidBufferSize('64-bits');
    for (let i = 0; i < this.length; i += 8) {
      swapBytes(this, i, i + 7);
      swapBytes(this, i + 1, i + 6);
      swapBytes(this, i + 2, i + 5);
      swapBytes(this, i + 3, i + 4);
    }
    return this;
  }
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString;

/** `slice.length === 2` 这类 arity 细节：依赖会做 `fn.length` 探测，所以别用剩余参数 */
function swapBytes(b, n, m) {
  const i = b[n];
  b[n] = b[m];
  b[m] = i;
}

/** `toInteger(n, defaultVal)`：node/lib/buffer.js:242 —— 非有限/NaN 用默认值，否则向下取整 */
function toInteger(n, defaultVal) {
  n = +n;
  if (n === n && n >= -9007199254740991 && n <= 9007199254740991) return n % 1 === 0 ? n : Math.floor(n);
  return defaultVal;
}

/** node/lib/buffer.js:1319 `adjustOffset`（`subarray`/`slice` 的收敛规则） */
function adjustOffset(offset, length) {
  offset = Math.trunc(offset);
  if (offset === 0) return 0;
  if (offset < 0) {
    offset += length;
    return offset > 0 ? offset : 0;
  }
  if (offset < length) return offset;
  return offset !== offset ? 0 : length;
}

/**
 * Node 的原生写只写完整字符，这里把"整串编码结果"回退到该编码的字符边界：
 *   · utf8：往前退过续接字节（10xxxxxx）到最后一个完整字符的末尾；
 *   · utf16le：按 2 字节对齐（Node 的 WriteUCS2 只写整字符）；
 *   · latin1/ascii/hex/base64/base64url：1 字节 = 1 单位，直接截断（Node 也是前缀）。
 */
function fitEncodedLength(bytes, max, canonical) {
  if (canonical === 'utf16le') return max & ~1;
  if (canonical === 'utf8') {
    let cut = max;
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
    return cut;
  }
  return max;
}

/** 模式循环填充：先写一份前缀（截到区间长），再**翻倍复制**——Node 的 Fill 就是这么补的 */
function repeatFill(buf, pattern, original, offset, end) {
  const fillLength = end - offset;
  if (pattern.length === 0) throw invalidArgValue('value', original);
  if (pattern.length >= fillLength) {
    for (let i = 0; i < fillLength; i++) buf[offset + i] = pattern[i];
    return buf;
  }
  let inThere = pattern.length;
  for (let i = 0; i < inThere; i++) buf[offset + i] = pattern[i];
  let ptr = offset + inThere;
  while (inThere < fillLength - inThere) {
    for (let i = 0; i < inThere; i++) buf[ptr + i] = buf[offset + i];
    ptr += inThere;
    inThere *= 2;
  }
  if (inThere < fillLength) {
    for (let i = 0; i < fillLength - inThere; i++) buf[ptr + i] = buf[offset + i];
  }
  return buf;
}

// ──────────────────────────── 静态方法 ────────────────────────────

/**
 * `Buffer.from` —— 分支顺序照 node/lib/buffer.js:348：
 * string → ArrayBuffer → `valueOf()` 可化的对象 → array-like/Buffer → `Symbol.toPrimitive` → 抛错。
 * 注意：`from(arrayBuffer)` **共享**内存、`from(typedArray/Uint8Array/Buffer)` **复制内容**，
 * 这是 Node 明确承诺的语义，别"顺手统一"。
 */
Buffer.from = function from(value, encodingOrOffset, length) {
  if (typeof value === 'string') return fromString(value, encodingOrOffset);
  if (typeof value === 'object' && value !== null) {
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      return fromArrayBuffer(value, encodingOrOffset, length);
    }
    const valueOf = value.valueOf && value.valueOf();
    if (valueOf !== null && valueOf !== undefined && valueOf !== value && (typeof valueOf === 'string' || typeof valueOf === 'object')) {
      return from(valueOf, encodingOrOffset, length);
    }
    const b = fromObject(value);
    if (b) return b;
    if (typeof value[Symbol.toPrimitive] === 'function') {
      const primitive = value[Symbol.toPrimitive]('string');
      if (typeof primitive === 'string') return fromString(primitive, encodingOrOffset);
    }
  }
  throw invalidArgType('first argument', ['string', 'Buffer', 'ArrayBuffer', 'Array', 'Array-like Object'], value);
};

/** 字符串 → Buffer：编码校验照 Node（非字符串编码**当 utf8**，不是抛错），空串短路不走桥 */
function fromString(string, encoding) {
  let canonical;
  if (!encoding || encoding === 'utf8' || typeof encoding !== 'string') {
    canonical = 'utf8';
  } else {
    canonical = normalizeEncoding(encoding);
    if (canonical === undefined) throw unknownEncoding(encoding);
  }
  if (string.length === 0) return new Buffer(0);
  const encoded = hostEncode(string, canonical);
  const buf = new Buffer(encoded.length);
  buf.set(encoded);
  return buf;
}

/** `from(arrayBuffer)`：**共享**底层内存；越界校验照 buffer.js:595（负数交给类型化数组构造器报 RangeError） */
function fromArrayBuffer(obj, byteOffset, length) {
  if (byteOffset === undefined) {
    byteOffset = 0;
  } else {
    byteOffset = +byteOffset;
    if (byteOffset !== byteOffset) byteOffset = 0;
  }
  const maxLength = obj.byteLength - byteOffset;
  if (maxLength < 0) throw bufferOutOfBounds('offset');
  if (length !== undefined) {
    length = +length;
    if (length > 0) {
      if (length > maxLength) throw bufferOutOfBounds('length');
    } else {
      length = 0;
    }
  }
  return new Buffer(obj, byteOffset, length);
}

function fromArrayLike(obj) {
  const length = obj.length;
  if (length <= 0) return new Buffer(0);
  const buf = new Buffer(length);
  buf.set(obj); // 逐元素 ToUint8：与 Node 的 TypedArrayPrototypeSet 一致
  return buf;
}

function fromObject(obj) {
  if (obj.length !== undefined || isAnyArrayBuffer(obj.buffer)) {
    if (typeof obj.length !== 'number') return new Buffer(0); // DataView / {length:'2'} → 空
    return fromArrayLike(obj);
  }
  if (obj.type === 'Buffer' && Array.isArray(obj.data)) return fromArrayLike(obj.data);
  return undefined;
}

function isAnyArrayBuffer(value) {
  return value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer);
}

Buffer.of = function of(...items) {
  const buf = new Buffer(items.length);
  for (let i = 0; i < items.length; i++) buf[i] = items[i];
  return buf;
};

/**
 * 为什么没有池化也别用 `createUnsafeBuffer` 那套：见文件头边界 1。
 * `allocUnsafe` = `alloc`（都是零初始化）——**这是有意的安全增强**，不是"忘了"。
 */
Buffer.alloc = function alloc(size, fill, encoding) {
  validateNumber(size, 'size', 0, MAX_LENGTH);
  const buf = new Buffer(size);
  if (fill !== undefined && fill !== 0 && size > 0) return repeatFillOrFill(buf, fill, encoding);
  return buf;
};

function repeatFillOrFill(buf, fill, encoding) {
  return Buffer.prototype.fill.call(buf, fill, 0, buf.length, encoding);
}

Buffer.allocUnsafe = function allocUnsafe(size) {
  validateNumber(size, 'size', 0, MAX_LENGTH);
  // 池化是 §3.2 坑 1 的源头；这里直接给"只属于自己"的内存
  return new Buffer(size);
};

Buffer.allocUnsafeSlow = function allocUnsafeSlow(size) {
  validateNumber(size, 'size', 0, MAX_LENGTH);
  return new Buffer(size);
};

Buffer.isBuffer = function isBuffer(b) {
  return b instanceof Buffer;
};

Buffer.isEncoding = function isEncoding(encoding) {
  return typeof encoding === 'string' && encoding.length !== 0 && normalizeEncoding(encoding) !== undefined;
};

Buffer.byteLength = function byteLength(string, encoding) {
  if (typeof string !== 'string') {
    if (ArrayBuffer.isView(string) || isAnyArrayBuffer(string)) return string.byteLength;
    throw invalidArgType('string', ['string', 'Buffer', 'ArrayBuffer'], string);
  }
  const len = string.length;
  if (len === 0) return 0;
  if (!encoding || encoding === 'utf8') return hostByteLength(string, 'utf8');
  if (encoding === 'ascii') return len;
  const canonical = normalizeEncodingOf(encoding);
  // ⚠️ 未知编码**不抛错**，按 utf8 算（node/lib/buffer.js:930 的 TODO 就写着"更该抛"，
  // 但现行语义是不抛）。这里照现行语义，否则 `byteLength(s,'typo')` 会比 Node 更容易炸。
  if (canonical === undefined) return hostByteLength(string, 'utf8');
  return hostByteLength(string, canonical);
};

Buffer.compare = function compare(buf1, buf2) {
  if (!(buf1 instanceof Uint8Array)) throw invalidArgType('buf1', ['Buffer', 'Uint8Array'], buf1);
  if (!(buf2 instanceof Uint8Array)) throw invalidArgType('buf2', ['Buffer', 'Uint8Array'], buf2);
  if (buf1 === buf2) return 0;
  return compareBytes(bufs(buf1), bufs(buf2));
};

function bufs(view) {
  return bytesOf(view);
}

/**
 * `concat(list, totalLength)` —— 只接受 Uint8Array 元素（Uint16Array 会被 Node 拒绝，
 * 所以"byteLength 与元素数不一致"那条坑在这里不存在）。
 * 显式 totalLength 大于实际总和时**零填充**（Node 行为，依赖靠它补齐固定长度头）。
 */
Buffer.concat = function concat(list, length) {
  if (!Array.isArray(list)) throw invalidArgType('list', 'Array', list);
  if (list.length === 0) return new Buffer(0);
  if (length === undefined) {
    length = 0;
    for (let i = 0; i < list.length; i++) {
      if (!(list[i] instanceof Uint8Array)) throw invalidArgType('list[' + i + ']', ['Buffer', 'Uint8Array'], list[i]);
      length += list[i].length;
    }
  } else {
    validateOffset(length, 'length');
    for (let i = 0; i < list.length; i++) {
      if (!(list[i] instanceof Uint8Array)) throw invalidArgType('list[' + i + ']', ['Buffer', 'Uint8Array'], list[i]);
    }
  }
  const buffer = new Buffer(length);
  let pos = 0;
  for (let i = 0; i < list.length; i++) {
    const buf = list[i];
    const bufLength = buf.length;
    if (pos + bufLength > length) {
      const rest = length - pos;
      for (let k = 0; k < rest; k++) buffer[pos + k] = buf[k];
      pos = length;
      break;
    }
    for (let k = 0; k < bufLength; k++) buffer[pos + k] = buf[k];
    pos += bufLength;
  }
  return buffer; // 新建即零填充：Node 末尾那段 TypedArrayPrototypeFill(0) 在这里天然成立
};

/**
 * `SlowBuffer` 已废弃（DEP0005）。**明确抛错**而不是留 undefined：
 * 生态里真有老代码 `Buffer.SlowBuffer(n)`，静默 undefined 只会得到 "not a function"，
 * 看不出是"沙箱不做"还是"依赖坏了"（node-tty.js 对 ReadStream 用的是同一条取向）。
 */
function SlowBuffer() {
  const e = new Error('SlowBuffer is not supported in the sandbox (deprecated in Node; use Buffer.allocUnsafeSlow)');
  e.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
  throw e;
}

Object.defineProperty(Buffer, 'poolSize', { value: POOL_SIZE, writable: true, enumerable: true, configurable: true });
Buffer.SlowBuffer = SlowBuffer;

// ──────────────────────────── 数值读写（全沙箱，纯算术）────────────────────────────
//
// 为什么不用 DataView：Node 自己的 JS 实现（node/lib/internal/buffer.js）就是逐字节算术，
// 且它的**越界报错**（"an integer" / ">= 0 and <= 7" / ERR_BUFFER_OUT_OF_BOUNDS）是从这套算术里长出来的；
// 用 DataView 反而要额外复刻一遍边界语义。浮点两条路用 DataView（引擎原生，端序显式）。

function checkBounds(buf, offset, byteLength) {
  validateNumber(offset, 'offset');
  if (buf[offset] === undefined || buf[offset + byteLength] === undefined) boundsError(offset, buf.length - (byteLength + 1));
}

function boundsError(value, length, type) {
  if (Math.floor(value) !== value) {
    // 这一行不是多余的：`readUIntLE(0)`（byteLength 传 undefined）在 Node 上抛的是
    // **ERR_INVALID_ARG_TYPE**——就是这里 validateNumber 抛的，不是 ERR_OUT_OF_RANGE。
    validateNumber(value, type);
    throw outOfRange(type || 'offset', 'an integer', value);
  }
  if (length < 0) throw bufferOutOfBounds();
  throw outOfRange(type || 'offset', '>= ' + (type ? 1 : 0) + ' and <= ' + length, value);
}

function checkInt(value, min, max, buf, offset, byteLength) {
  if (value > max || value < min) {
    const n = typeof min === 'bigint' ? 'n' : '';
    let range;
    if (byteLength > 3) {
      if (min === 0 || min === 0n) range = '>= 0' + n + ' and < 2' + n + ' ** ' + (byteLength + 1) * 8 + n;
      else range = '>= -(2' + n + ' ** ' + ((byteLength + 1) * 8 - 1) + n + ') and < 2' + n + ' ** ' + ((byteLength + 1) * 8 - 1) + n;
    } else {
      range = '>= ' + min + n + ' and <= ' + max + n;
    }
    throw outOfRange('value', range, value);
  }
  checkBounds(buf, offset, byteLength);
}

function readUIntLE(offset, byteLength) {
  if (offset === undefined) throw invalidArgType('offset', 'number', offset);
  if (byteLength === 6) return readUInt48LE(this, offset);
  if (byteLength === 5) return readUInt40LE(this, offset);
  if (byteLength === 3) return readUInt24LE(this, offset);
  if (byteLength === 4) return readUInt32LE(this, offset);
  if (byteLength === 2) return readUInt16LE(this, offset);
  if (byteLength === 1) return readUInt8(this, offset);
  boundsError(byteLength, 6, 'byteLength');
}

function readUIntBE(offset, byteLength) {
  if (offset === undefined) throw invalidArgType('offset', 'number', offset);
  if (byteLength === 6) return readUInt48BE(this, offset);
  if (byteLength === 5) return readUInt40BE(this, offset);
  if (byteLength === 3) return readUInt24BE(this, offset);
  if (byteLength === 4) return readUInt32BE(this, offset);
  if (byteLength === 2) return readUInt16BE(this, offset);
  if (byteLength === 1) return readUInt8(this, offset);
  boundsError(byteLength, 6, 'byteLength');
}

function readIntLE(offset, byteLength) {
  if (offset === undefined) throw invalidArgType('offset', 'number', offset);
  switch (byteLength) {
    case 6:
      return readInt48LE(this, offset);
    case 5:
      return readInt40LE(this, offset);
    case 4:
      return readInt32LE(this, offset);
    case 3:
      return readInt24LE(this, offset);
    case 2:
      return readInt16LE(this, offset);
    case 1:
      return readInt8(this, offset);
  }
  boundsError(byteLength, 6, 'byteLength');
}

function readIntBE(offset, byteLength) {
  if (offset === undefined) throw invalidArgType('offset', 'number', offset);
  switch (byteLength) {
    case 6:
      return readInt48BE(this, offset);
    case 5:
      return readInt40BE(this, offset);
    case 4:
      return readInt32BE(this, offset);
    case 3:
      return readInt24BE(this, offset);
    case 2:
      return readInt16BE(this, offset);
    case 1:
      return readInt8(this, offset);
  }
  boundsError(byteLength, 6, 'byteLength');
}

function readUInt8(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const val = buf[offset];
  if (val === undefined) boundsError(offset, buf.length - 1);
  return val;
}

function readUInt16LE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 1];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 2);
  return first + last * 2 ** 8;
}

function readUInt16BE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 1];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 2);
  return first * 2 ** 8 + last;
}

function readUInt24LE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 2];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 3);
  return first + buf[offset + 1] * 2 ** 8 + last * 2 ** 16;
}

function readUInt24BE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 2];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 3);
  return first * 2 ** 16 + buf[offset + 1] * 2 ** 8 + last;
}

function readUInt32LE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 3];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 4);
  return first + buf[offset + 1] * 2 ** 8 + buf[offset + 2] * 2 ** 16 + last * 2 ** 24;
}

function readUInt32BE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 3];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 4);
  return first * 2 ** 24 + buf[offset + 1] * 2 ** 16 + buf[offset + 2] * 2 ** 8 + last;
}

function readUInt40LE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 4];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 5);
  return first + buf[offset + 1] * 2 ** 8 + buf[offset + 2] * 2 ** 16 + buf[offset + 3] * 2 ** 24 + last * 2 ** 32;
}

function readUInt40BE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 4];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 5);
  return first * 2 ** 32 + buf[offset + 1] * 2 ** 24 + buf[offset + 2] * 2 ** 16 + buf[offset + 3] * 2 ** 8 + last;
}

function readUInt48LE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 5];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 6);
  return (
    first +
    buf[offset + 1] * 2 ** 8 +
    buf[offset + 2] * 2 ** 16 +
    buf[offset + 3] * 2 ** 24 +
    (buf[offset + 4] + last * 2 ** 8) * 2 ** 32
  );
}

function readUInt48BE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 5];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 6);
  return (
    (first * 2 ** 8 + buf[offset + 1]) * 2 ** 32 +
    buf[offset + 2] * 2 ** 24 +
    buf[offset + 3] * 2 ** 16 +
    buf[offset + 4] * 2 ** 8 +
    last
  );
}

function readInt8(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const val = buf[offset];
  if (val === undefined) boundsError(offset, buf.length - 1);
  return val | (val & 2 ** 7) * 0x1fffffe;
}

function readInt16LE(buf, offset) {
  const val = readUInt16LE(buf, offset);
  return val | (val & 2 ** 15) * 0x1fffe;
}

function readInt16BE(buf, offset) {
  const val = readUInt16BE(buf, offset);
  return val | (val & 2 ** 15) * 0x1fffe;
}

function readInt24LE(buf, offset) {
  const val = readUInt24LE(buf, offset);
  return val | (val & 2 ** 23) * 0x1fe;
}

function readInt24BE(buf, offset) {
  const val = readUInt24BE(buf, offset);
  return val | (val & 2 ** 23) * 0x1fe;
}

function readInt32LE(buf, offset) {
  const val = readUInt32LE(buf, offset);
  return val | (val & 2 ** 31) * 0x1;
}

function readInt32BE(buf, offset) {
  const val = readUInt32BE(buf, offset);
  return val | (val & 2 ** 31) * 0x1;
}

/**
 * 48/40 位的**有符号**读法照抄 node/lib/internal/buffer.js:364-391：符号位在高字节上，
 * 用 `(b | (b & 2**k) * M) * 2**32 + 低位` 构造。这里不能"用自己的写法化简"——
 * 我先前那版（先读无符号再补符号）在 40 位上算错，是差分测试抓出来的。
 */
function readInt48LE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 5];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 6);
  const val = buf[offset + 4] + last * 2 ** 8;
  return (
    (val | (val & 2 ** 15) * 0x1fffe) * 2 ** 32 +
    first +
    buf[offset + 1] * 2 ** 8 +
    buf[offset + 2] * 2 ** 16 +
    buf[offset + 3] * 2 ** 24
  );
}

function readInt40LE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 4];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 5);
  return (
    (last | (last & 2 ** 7) * 0x1fffffe) * 2 ** 32 +
    first +
    buf[offset + 1] * 2 ** 8 +
    buf[offset + 2] * 2 ** 16 +
    buf[offset + 3] * 2 ** 24
  );
}

function readInt48BE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 5];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 6);
  const val = buf[offset + 1] + first * 2 ** 8;
  return (
    (val | (val & 2 ** 15) * 0x1fffe) * 2 ** 32 +
    buf[offset + 2] * 2 ** 24 +
    buf[offset + 3] * 2 ** 16 +
    buf[offset + 4] * 2 ** 8 +
    last
  );
}

function readInt40BE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 4];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 5);
  return (
    (first | (first & 2 ** 7) * 0x1fffffe) * 2 ** 32 +
    buf[offset + 1] * 2 ** 24 +
    buf[offset + 2] * 2 ** 16 +
    buf[offset + 3] * 2 ** 8 +
    last
  );
}

function readFloatLE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 3];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 4);
  return new DataView(buf.buffer, buf.byteOffset + offset, 4).getFloat32(0, true);
}

function readFloatBE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 3];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 4);
  return new DataView(buf.buffer, buf.byteOffset + offset, 4).getFloat32(0, false);
}

function readDoubleLE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 7];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 8);
  return new DataView(buf.buffer, buf.byteOffset + offset, 8).getFloat64(0, true);
}

function readDoubleBE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 7];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 8);
  return new DataView(buf.buffer, buf.byteOffset + offset, 8).getFloat64(0, false);
}

function writeU_Int8(buf, value, offset, min, max) {
  value = +value;
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  if (value > max || value < min) throw outOfRange('value', '>= ' + min + ' and <= ' + max, value);
  if (buf[offset] === undefined) boundsError(offset, buf.length - 1);
  buf[offset] = value;
  return offset + 1;
}

function writeU_Int16LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 1);
  buf[offset] = value;
  buf[offset + 1] = value >>> 8;
  return offset + 2;
}

function writeU_Int16BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 1);
  buf[offset] = value >>> 8;
  buf[offset + 1] = value;
  return offset + 2;
}

function writeU_Int24LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 2);
  buf[offset] = value;
  buf[offset + 1] = value >>> 8;
  buf[offset + 2] = value >>> 16;
  return offset + 3;
}

function writeU_Int24BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 2);
  buf[offset] = value >>> 16;
  buf[offset + 1] = value >>> 8;
  buf[offset + 2] = value;
  return offset + 3;
}

function writeU_Int32LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 3);
  buf[offset] = value;
  buf[offset + 1] = value >>> 8;
  buf[offset + 2] = value >>> 16;
  buf[offset + 3] = value >>> 24;
  return offset + 4;
}

function writeU_Int32BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 3);
  buf[offset] = value >>> 24;
  buf[offset + 1] = value >>> 16;
  buf[offset + 2] = value >>> 8;
  buf[offset + 3] = value;
  return offset + 4;
}

function writeU_Int40LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 4);
  const newVal = value;
  buf[offset] = value;
  buf[offset + 1] = value >>> 8;
  buf[offset + 2] = value >>> 16;
  buf[offset + 3] = value >>> 24;
  buf[offset + 4] = Math.floor(newVal * 2 ** -32);
  return offset + 5;
}

function writeU_Int40BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 4);
  buf[offset] = Math.floor(value * 2 ** -32);
  buf[offset + 1] = value >>> 24;
  buf[offset + 2] = value >>> 16;
  buf[offset + 3] = value >>> 8;
  buf[offset + 4] = value;
  return offset + 5;
}

function writeU_Int48LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 5);
  const newVal = Math.floor(value * 2 ** -32);
  buf[offset] = value;
  buf[offset + 1] = value >>> 8;
  buf[offset + 2] = value >>> 16;
  buf[offset + 3] = value >>> 24;
  buf[offset + 4] = newVal;
  buf[offset + 5] = newVal >>> 8;
  return offset + 6;
}

function writeU_Int48BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 5);
  const newVal = Math.floor(value * 2 ** -32);
  buf[offset] = newVal >>> 8;
  buf[offset + 1] = newVal;
  buf[offset + 2] = value >>> 24;
  buf[offset + 3] = value >>> 16;
  buf[offset + 4] = value >>> 8;
  buf[offset + 5] = value;
  return offset + 6;
}

function writeUIntLE(value, offset, byteLength) {
  switch (byteLength) {
    case 6:
      return writeU_Int48LE(this, value, offset, 0, 0xffffffffffff);
    case 5:
      return writeU_Int40LE(this, value, offset, 0, 0xffffffffff);
    case 3:
      return writeU_Int24LE(this, value, offset, 0, 0xffffff);
    case 4:
      return writeU_Int32LE(this, value, offset, 0, 0xffffffff);
    case 2:
      return writeU_Int16LE(this, value, offset, 0, 0xffff);
    case 1:
      return writeU_Int8(this, value, offset, 0, 0xff);
  }
  boundsError(byteLength, 6, 'byteLength');
}

function writeUIntBE(value, offset, byteLength) {
  switch (byteLength) {
    case 6:
      return writeU_Int48BE(this, value, offset, 0, 0xffffffffffff);
    case 5:
      return writeU_Int40BE(this, value, offset, 0, 0xffffffffff);
    case 3:
      return writeU_Int24BE(this, value, offset, 0, 0xffffff);
    case 4:
      return writeU_Int32BE(this, value, offset, 0, 0xffffffff);
    case 2:
      return writeU_Int16BE(this, value, offset, 0, 0xffff);
    case 1:
      return writeU_Int8(this, value, offset, 0, 0xff);
  }
  boundsError(byteLength, 6, 'byteLength');
}

function writeIntLE(value, offset, byteLength) {
  switch (byteLength) {
    case 6:
      return writeU_Int48LE(this, value, offset, -0x800000000000, 0x7fffffffffff);
    case 5:
      return writeU_Int40LE(this, value, offset, -0x8000000000, 0x7fffffffff);
    case 4:
      return writeU_Int32LE(this, value, offset, -0x80000000, 0x7fffffff);
    case 3:
      return writeU_Int24LE(this, value, offset, -0x800000, 0x7fffff);
    case 2:
      return writeU_Int16LE(this, value, offset, -0x8000, 0x7fff);
    case 1:
      return writeU_Int8(this, value, offset, -0x80, 0x7f);
  }
  boundsError(byteLength, 6, 'byteLength');
}

function writeIntBE(value, offset, byteLength) {
  switch (byteLength) {
    case 6:
      return writeU_Int48BE(this, value, offset, -0x800000000000, 0x7fffffffffff);
    case 5:
      return writeU_Int40BE(this, value, offset, -0x8000000000, 0x7fffffffff);
    case 4:
      return writeU_Int32BE(this, value, offset, -0x80000000, 0x7fffffff);
    case 3:
      return writeU_Int24BE(this, value, offset, -0x800000, 0x7fffff);
    case 2:
      return writeU_Int16BE(this, value, offset, -0x8000, 0x7fff);
    case 1:
      return writeU_Int8(this, value, offset, -0x80, 0x7f);
  }
  boundsError(byteLength, 6, 'byteLength');
}

function writeFloatLE(buf, val, offset) {
  val = +val;
  offset = offset === undefined ? 0 : offset;
  checkBounds(buf, offset, 3);
  new DataView(buf.buffer, buf.byteOffset + offset, 4).setFloat32(0, val, true);
  return offset + 4;
}

function writeFloatBE(buf, val, offset) {
  val = +val;
  offset = offset === undefined ? 0 : offset;
  checkBounds(buf, offset, 3);
  new DataView(buf.buffer, buf.byteOffset + offset, 4).setFloat32(0, val, false);
  return offset + 4;
}

function writeDoubleLE(buf, val, offset) {
  val = +val;
  offset = offset === undefined ? 0 : offset;
  checkBounds(buf, offset, 7);
  new DataView(buf.buffer, buf.byteOffset + offset, 8).setFloat64(0, val, true);
  return offset + 8;
}

function writeDoubleBE(buf, val, offset) {
  val = +val;
  offset = offset === undefined ? 0 : offset;
  checkBounds(buf, offset, 7);
  new DataView(buf.buffer, buf.byteOffset + offset, 8).setFloat64(0, val, false);
  return offset + 8;
}

/** BigInt64：Node 的 JS 路径用 `Number(value & 0xffffffffn)` 拆高低 32 位，这里照抄（含混类型的 TypeError） */
function writeBigU_Int64LE(buf, value, offset, min, max) {
  checkInt(value, min, max, buf, offset, 7);
  let lo = Number(value & 0xffffffffn);
  buf[offset] = lo;
  lo = lo >> 8;
  buf[offset + 1] = lo;
  lo = lo >> 8;
  buf[offset + 2] = lo;
  lo = lo >> 8;
  buf[offset + 3] = lo;
  let hi = Number((value >> 32n) & 0xffffffffn);
  buf[offset + 4] = hi;
  hi = hi >> 8;
  buf[offset + 5] = hi;
  hi = hi >> 8;
  buf[offset + 6] = hi;
  hi = hi >> 8;
  buf[offset + 7] = hi;
  return offset + 8;
}

/** BigInt64 的 BE：Node 是**从 offset+7 往回写**（node/lib/internal/buffer.js:612），照抄 */
function writeBigU_Int64BE(buf, value, offset, min, max) {
  checkInt(value, min, max, buf, offset, 7);
  let lo = Number(value & 0xffffffffn);
  buf[offset + 7] = lo;
  lo = lo >> 8;
  buf[offset + 6] = lo;
  lo = lo >> 8;
  buf[offset + 5] = lo;
  lo = lo >> 8;
  buf[offset + 4] = lo;
  let hi = Number((value >> 32n) & 0xffffffffn);
  buf[offset + 3] = hi;
  hi = hi >> 8;
  buf[offset + 2] = hi;
  hi = hi >> 8;
  buf[offset + 1] = hi;
  hi = hi >> 8;
  buf[offset] = hi;
  return offset + 8;
}

function readBigUInt64LE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 7];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 8);
  const lo = first + buf[offset + 1] * 2 ** 8 + buf[offset + 2] * 2 ** 16 + buf[offset + 3] * 2 ** 24;
  const hi = buf[offset + 4] + buf[offset + 5] * 2 ** 8 + buf[offset + 6] * 2 ** 16 + last * 2 ** 24;
  return BigInt(lo) + (BigInt(hi) << 32n);
}

function readBigUInt64BE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 7];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 8);
  const hi = first * 2 ** 24 + buf[offset + 1] * 2 ** 16 + buf[offset + 2] * 2 ** 8 + buf[offset + 3];
  const lo = buf[offset + 4] * 2 ** 24 + buf[offset + 5] * 2 ** 16 + buf[offset + 6] * 2 ** 8 + last;
  return (BigInt(hi) << 32n) + BigInt(lo);
}

function readBigInt64LE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 7];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 8);
  const val = buf[offset + 4] + buf[offset + 5] * 2 ** 8 + buf[offset + 6] * 2 ** 16 + (last << 24);
  return (BigInt(val) << 32n) + BigInt(first + buf[offset + 1] * 2 ** 8 + buf[offset + 2] * 2 ** 16 + buf[offset + 3] * 2 ** 24);
}

function readBigInt64BE(buf, offset) {
  offset = offset === undefined ? 0 : offset;
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 7];
  if (first === undefined || last === undefined) boundsError(offset, buf.length - 8);
  const val = (first << 24) + buf[offset + 1] * 2 ** 16 + buf[offset + 2] * 2 ** 8 + buf[offset + 3];
  return (BigInt(val) << 32n) + BigInt(buf[offset + 4] * 2 ** 24 + buf[offset + 5] * 2 ** 16 + buf[offset + 6] * 2 ** 8 + last);
}

const PROTO = Buffer.prototype;

// 单一入口：所有实例方法都挂在这个内部方法集合上，避免每加一个方法就写一遍 `PROTO.x = ...`
const NUMERIC = {
  readUIntLE: readUIntLE,
  readUIntBE: readUIntBE,
  readUInt8: function (offset) {
    return readUInt8(this, offset);
  },
  readUInt16LE: function (offset) {
    return readUInt16LE(this, offset);
  },
  readUInt16BE: function (offset) {
    return readUInt16BE(this, offset);
  },
  readUInt24LE: function (offset) {
    return readUInt24LE(this, offset);
  },
  readUInt24BE: function (offset) {
    return readUInt24BE(this, offset);
  },
  readUInt32LE: function (offset) {
    return readUInt32LE(this, offset);
  },
  readUInt32BE: function (offset) {
    return readUInt32BE(this, offset);
  },
  readIntLE: readIntLE,
  readIntBE: readIntBE,
  readInt8: function (offset) {
    return readInt8(this, offset);
  },
  readInt16LE: function (offset) {
    return readInt16LE(this, offset);
  },
  readInt16BE: function (offset) {
    return readInt16BE(this, offset);
  },
  readInt24LE: function (offset) {
    return readInt24LE(this, offset);
  },
  readInt24BE: function (offset) {
    return readInt24BE(this, offset);
  },
  readInt32LE: function (offset) {
    return readInt32LE(this, offset);
  },
  readInt32BE: function (offset) {
    return readInt32BE(this, offset);
  },
  readFloatLE: function (offset) {
    return readFloatLE(this, offset);
  },
  readFloatBE: function (offset) {
    return readFloatBE(this, offset);
  },
  readDoubleLE: function (offset) {
    return readDoubleLE(this, offset);
  },
  readDoubleBE: function (offset) {
    return readDoubleBE(this, offset);
  },
  readBigUInt64LE: function (offset) {
    return readBigUInt64LE(this, offset);
  },
  readBigUInt64BE: function (offset) {
    return readBigUInt64BE(this, offset);
  },
  readBigInt64LE: function (offset) {
    return readBigInt64LE(this, offset);
  },
  readBigInt64BE: function (offset) {
    return readBigInt64BE(this, offset);
  },
  writeUIntLE: writeUIntLE,
  writeUIntBE: writeUIntBE,
  writeUInt8: function (value, offset) {
    return writeU_Int8(this, value, offset, 0, 0xff);
  },
  writeUInt16LE: function (value, offset) {
    return writeU_Int16LE(this, value, offset, 0, 0xffff);
  },
  writeUInt16BE: function (value, offset) {
    return writeU_Int16BE(this, value, offset, 0, 0xffff);
  },
  writeUInt24LE: function (value, offset) {
    return writeU_Int24LE(this, value, offset, 0, 0xffffff);
  },
  writeUInt24BE: function (value, offset) {
    return writeU_Int24BE(this, value, offset, 0, 0xffffff);
  },
  writeUInt32LE: function (value, offset) {
    return writeU_Int32LE(this, value, offset, 0, 0xffffffff);
  },
  writeUInt32BE: function (value, offset) {
    return writeU_Int32BE(this, value, offset, 0, 0xffffffff);
  },
  writeIntLE: writeIntLE,
  writeIntBE: writeIntBE,
  writeInt8: function (value, offset) {
    return writeU_Int8(this, value, offset, -0x80, 0x7f);
  },
  writeInt16LE: function (value, offset) {
    return writeU_Int16LE(this, value, offset, -0x8000, 0x7fff);
  },
  writeInt16BE: function (value, offset) {
    return writeU_Int16BE(this, value, offset, -0x8000, 0x7fff);
  },
  writeInt24LE: function (value, offset) {
    return writeU_Int24LE(this, value, offset, -0x800000, 0x7fffff);
  },
  writeInt24BE: function (value, offset) {
    return writeU_Int24BE(this, value, offset, -0x800000, 0x7fffff);
  },
  writeInt32LE: function (value, offset) {
    return writeU_Int32LE(this, value, offset, -0x80000000, 0x7fffffff);
  },
  writeInt32BE: function (value, offset) {
    return writeU_Int32BE(this, value, offset, -0x80000000, 0x7fffffff);
  },
  writeFloatLE: function (value, offset) {
    return writeFloatLE(this, value, offset);
  },
  writeFloatBE: function (value, offset) {
    return writeFloatBE(this, value, offset);
  },
  writeDoubleLE: function (value, offset) {
    return writeDoubleLE(this, value, offset);
  },
  writeDoubleBE: function (value, offset) {
    return writeDoubleBE(this, value, offset);
  },
  writeBigUInt64LE: function (value, offset) {
    return writeBigU_Int64LE(this, value, offset === undefined ? 0 : offset, 0n, 0xffffffffffffffffn);
  },
  writeBigUInt64BE: function (value, offset) {
    return writeBigU_Int64BE(this, value, offset === undefined ? 0 : offset, 0n, 0xffffffffffffffffn);
  },
  writeBigInt64LE: function (value, offset) {
    return writeBigU_Int64LE(this, value, offset === undefined ? 0 : offset, -0x8000000000000000n, 0x7fffffffffffffffn);
  },
  writeBigInt64BE: function (value, offset) {
    return writeBigU_Int64BE(this, value, offset === undefined ? 0 : offset, -0x8000000000000000n, 0x7fffffffffffffffn);
  },
};

// 小写别名（Node 同时挂 `readUint32LE` 这类写法：历史拼写差异，生态两种都在用）
const LOWER_ALIASES = {
  readUintLE: 'readUIntLE',
  readUintBE: 'readUIntBE',
  readUint8: 'readUInt8',
  readUint16LE: 'readUInt16LE',
  readUint16BE: 'readUInt16BE',
  readUint32LE: 'readUInt32LE',
  readUint32BE: 'readUInt32BE',
  writeUintLE: 'writeUIntLE',
  writeUintBE: 'writeUIntBE',
  writeUint8: 'writeUInt8',
  writeUint16LE: 'writeUInt16LE',
  writeUint16BE: 'writeUInt16BE',
  writeUint32LE: 'writeUInt32LE',
  writeUint32BE: 'writeUInt32BE',
};

for (const name of Object.keys(NUMERIC)) {
  PROTO[name] = NUMERIC[name];
  if (Object.prototype.hasOwnProperty.call(LOWER_ALIASES, name)) PROTO[LOWER_ALIASES[name]] = NUMERIC[name];
}
// BigUint 拼写（Node 同时提供 readBigUint64LE / readBigUInt64LE）
PROTO.readBigUint64LE = PROTO.readBigUInt64LE;
PROTO.readBigUint64BE = PROTO.readBigUInt64BE;
PROTO.writeBigUint64LE = PROTO.writeBigUInt64LE;
PROTO.writeBigUint64BE = PROTO.writeBigUInt64BE;

export { Buffer, SlowBuffer };

export default {
  Buffer: Buffer,
  SlowBuffer: SlowBuffer,
  poolSize: POOL_SIZE,
};
