// node:util 仿真
//
// **为什么自己实现而不是让宿主代工**（判据见 module-emulation-design §3.2.1）：
// `format`/`inspect`/`types` 收的都是**沙箱值**（对象、闭包、原型、循环引用）。交给宿主只能传 JSON
// ——原型、getter、Map/Set、循环引用全丢，那正是"假等/假值"这类静默 bug 的温床。
// 唯一走宿主代工的是 `TextEncoder`/`TextDecoder`：QuickJS **没有**这两个全局（实测见
// `_audit/quickjs-globals-probe.mjs`），而编解码保真本来就该交给宿主（§3.2.2 的三条理由）。
//
// **已知边界**（写在这里免得被当 bug）：
//   · `inspect` 是**结构子集**，不追求与 Node 逐字符相同（缩进/换行/颜色排版不复刻）；
//     但结构不许骗人——Map 不能印成 `{}`、循环引用不能爆栈、超出 depth 要显式省略。
//   · `TextDecoder` 只支持 `utf-8`/`utf-16le`/`latin1` 三个标签族；其余**WHATWG 合法但我们没实现**的
//     标签（`windows-1252`/`ascii`/`utf-16be`…）明确抛 `ERR_ENCODING_NOT_SUPPORTED`——不静默给近似值。
//   · `TextDecoder({stream:true})` 不支持（流式交给 `node:string_decoder`）。
//   · `deprecate` 的警告走 `console.warn`（沙箱没有 `process.emitWarning`），每个包装函数只警告一次。
//   · `debuglog` 默认 no-op（沙箱里 `process.env` 是空的，没有 `NODE_DEBUG`），可用 `.enabled` 打开。
//   · 明确抛 `ERR_NOT_SUPPORTED_IN_SANDBOX` 的：`styleText`/`MIMEType`/`aborted`/`transferableAbortSignal`/
//     `transferableAbortController`/`getCallSites`/`setTraceSigintHandler`/`parseArgs`/`toUSVString`/
//     `getSystemErrorMessage`。
//
// 内联约束：静态、无占位符；能力只能运行时从 `globalThis.__host` 取。
import assertModule from './node-assert.js';
import constantsTable from './node-constants.js';

const kInspectCustom = Symbol.for('nodejs.util.inspect.custom');
const kPromisifyCustom = Symbol.for('nodejs.util.promisify.custom');
const kCallbackifyCustom = Symbol.for('nodejs.util.callbackify.custom');

// ──────────────────────────── 宿主通道（编解码代工）────────────────────────────

/** 宿主返回**字符串 = 错误信封**（约定见 module-emulation-design §3.2 的桥契约） */
function unwrapHost(raw) {
  if (typeof raw !== 'string') return raw;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const info = parsed && parsed.__spcError;
  if (!info) return parsed;
  // 对外像 Node：编码类错误统一翻成 ERR_ENCODING_NOT_SUPPORTED，宿主码留在 spcCode（§7 的翻译模式）
  const e = new TypeError('The encoded data was not valid for encoding');
  e.code = 'ERR_ENCODING_NOT_SUPPORTED';
  e.spcCode = info.code;
  throw e;
}

function toExactArrayBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (ArrayBuffer.isView(view)) {
    const v = view;
    return v.byteOffset === 0 && v.byteLength === v.buffer.byteLength
      ? v.buffer
      : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  }
  const e = new TypeError('The "input" argument must be an instance of ArrayBuffer or ArrayBufferView');
  e.code = 'ERR_INVALID_ARG_TYPE';
  throw e;
}

function hostEncode(text, hostEncoding = 'utf8') {
  return new Uint8Array(unwrapHost(globalThis.__host['bytes.fromString'](text, hostEncoding)));
}

function hostDecode(bytes, hostEncoding) {
  const raw = unwrapHost(globalThis.__host['bytes.toString'](toExactArrayBuffer(bytes), hostEncoding));
  return typeof raw === 'string' ? raw : String(raw);
}

// ──────────────────────────── inspect ────────────────────────────

const DEFAULT_INSPECT_OPTIONS = {
  depth: 2,
  colors: false,
  showHidden: false,
  maxArrayLength: 100,
  maxStringLength: 10000,
  breakLength: 80,
  compact: 3,
  sorted: false,
  getters: false,
};

function tagOf(v) {
  return Object.prototype.toString.call(v);
}

function quoteString(s, maxLength) {
  // 截断的是**字符串本身**（Node 的 maxStringLength 语义），不是引号包裹后的结果
  const truncated = typeof maxLength === 'number' && s.length > maxLength;
  const shown = truncated ? s.slice(0, maxLength) : s;
  let out = "'" + shown.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
  if (truncated) out += '... ' + (s.length - maxLength) + ' more characters';
  return out;
}

/**
 * 结构化渲染。**不追求与 Node 逐字符一致**（见文件头），但结构必须真实：
 * 类型名/条数/循环标记/深度省略都要在。
 */
function inspectValue(value, options, depth, seen) {
  const opts = options;
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'undefined') return 'undefined';
  if (t === 'boolean' || t === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (t === 'bigint') return String(value) + 'n';
  if (t === 'string') return quoteString(value, opts.maxStringLength);
  if (t === 'symbol') return String(value);
  if (t === 'function') {
    const name = value.name;
    return name ? '[Function: ' + name + ']' : '[Function (anonymous)]';
  }

  // 自定义 inspect（生态里大量使用，例如 chalk/error 类库）
  const custom = value[kInspectCustom];
  if (typeof custom === 'function') {
    const rendered = custom.call(value, depth, opts);
    return typeof rendered === 'string' ? rendered : inspectValue(rendered, opts, depth, seen);
  }

  const tag = tagOf(value);
  if (tag === '[object Date]') return value.toISOString();
  if (tag === '[object RegExp]') return String(value);

  const found = seen.indexOf(value);
  if (found !== -1) return '[Circular *' + (found + 1) + ']';

  if (depth < 0) return Array.isArray(value) ? '[Array]' : '[' + (tag.slice(8, -1) || 'Object') + ']';
  seen = seen.concat([value]);

  if (Array.isArray(value)) {
    const parts = [];
    const limit = Math.min(value.length, opts.maxArrayLength);
    for (let i = 0; i < limit; i++) {
      parts.push(i in value ? inspectValue(value[i], opts, depth - 1, seen) : '<1 empty item>');
    }
    if (value.length > limit) parts.push('... ' + (value.length - limit) + ' more items');
    return '[ ' + parts.join(', ') + ' ]';
  }

  if (tag === '[object Map]') {
    const parts = [];
    for (const [k, v] of value) {
      parts.push(inspectValue(k, opts, depth - 1, seen) + ' => ' + inspectValue(v, opts, depth - 1, seen));
    }
    return 'Map(' + value.size + ') { ' + parts.join(', ') + ' }';
  }
  if (tag === '[object Set]') {
    const parts = [];
    for (const v of value) parts.push(inspectValue(v, opts, depth - 1, seen));
    return 'Set(' + value.size + ') { ' + parts.join(', ') + ' }';
  }
  if (tag === '[object Error]' || /Error\]$/.test(tag)) {
    const own = Object.keys(value).filter((k) => !['message', 'stack'].includes(k));
    const extra = own.length ? ' { ' + own.map((k) => k + ': ' + inspectValue(value[k], opts, depth - 1, seen)).join(', ') + ' }' : '';
    return (value.name || 'Error') + (value.message ? ': ' + value.message : '') + extra;
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const parts = [];
    const limit = Math.min(value.length, opts.maxArrayLength);
    for (let i = 0; i < limit; i++) parts.push(String(value[i]));
    return (value.constructor ? value.constructor.name : 'TypedArray') + '(' + value.length + ') [ ' + parts.join(', ') + ' ]';
  }
  if (tag === '[object Number]' || tag === '[object String]' || tag === '[object Boolean]' ||
      tag === '[object Symbol]' || tag === '[object BigInt]') {
    return '[' + tag.slice(8, -1) + ': ' + String(value.valueOf()) + ']';
  }

  const keys = opts.showHidden ? Object.getOwnPropertyNames(value) : Object.keys(value);
  if (opts.sorted) keys.sort();
  const parts = keys.map((k) => {
    const desc = Object.getOwnPropertyDescriptor(value, k);
    const shown = desc && typeof desc.get === 'function' && !opts.getters
      ? '[Getter]'
      : inspectValue(value[k], opts, depth - 1, seen);
    return k + ': ' + shown;
  });
  const prefix = /^\[object [A-Za-z]*\]$/.test(tag) && tag !== '[object Object]' ? tag.slice(8, -1) + ' ' : '';
  return prefix + '{ ' + parts.join(', ') + ' }';
}

export function inspect(value, options) {
  const opts = Object.assign({}, DEFAULT_INSPECT_OPTIONS, inspect.defaultOptions, options || {});
  return inspectValue(value, opts, typeof opts.depth === 'number' ? opts.depth : 2, []);
}
inspect.custom = kInspectCustom;
inspect.defaultOptions = Object.assign({}, DEFAULT_INSPECT_OPTIONS);

// ──────────────────────────── format ────────────────────────────

const FORMAT_PATTERN = /%[sdifjoOc%]/g;

function formatValue(token, value, opts) {
  switch (token) {
    case '%s': {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
      if (value === null || value === undefined) return String(value);
      return inspect(value, Object.assign({}, opts, { depth: 0, colors: false }));
    }
    case '%d':
      // Node：`%d` 只认数字/**bigint**，其余一律 NaN（不做隐式转换）
      return typeof value === 'bigint' ? String(value) : String(Number(value));
    case '%i':
      return String(Number.parseInt(value, 10)) === 'NaN' ? 'NaN' : String(Number.parseInt(value, 10));
    case '%f':
      return String(Number.parseFloat(value));
    case '%j':
      try {
        return JSON.stringify(value);
      } catch {
        return '[Circular]';
      }
    case '%o':
      return inspect(value, Object.assign({}, opts, { showHidden: true, depth: 4 }));
    case '%O':
      return inspect(value, opts);
    case '%c':
      // CSS 指令：Node 在无颜色时直接丢弃（`format` 里就是空）
      return '';
    case '%%':
      return '%';
  }
  return token;
}

/**
 * `format` / `formatWithOptions` 的共同内核（照 Node `lib/util.js` 的 `formatWithOptionsInternal`）：
 *   · 首参不是字符串 → 每个参数各自 inspect（字符串原样）再用空格拼；
 *   · 首参是字符串 → 逐个消费 `%s %d %i %f %j %o %O %c %%`，多余的参数追加在末尾；
 *   · 指令数多于参数时，**原样留下**那个指令（Node 的行为，不吞掉）。
 */
function formatImpl(inspectOptions, args) {
  if (args.length === 0) return '';
  const first = args[0];
  if (typeof first !== 'string') {
    return args.map((a) => (typeof a === 'string' ? a : inspect(a, inspectOptions))).join(' ');
  }
  let index = 1;
  let out = first.replace(FORMAT_PATTERN, (m) => {
    if (m === '%%') return m; // `%%` 不消费参数，原样留着（Node 的输出里就是 `%%`）
    if (index >= args.length) return m;
    return formatValue(m, args[index++], inspectOptions || {});
  });
  for (; index < args.length; index++) {
    const a = args[index];
    out += ' ' + (typeof a === 'string' ? a : inspect(a, inspectOptions));
  }
  return out;
}

export function format(...args) {
  return formatImpl(DEFAULT_INSPECT_OPTIONS, args);
}

export function formatWithOptions(inspectOptions, ...args) {
  return formatImpl(inspectOptions, args);
}

// ──────────────────────────── 其它纯计算 ────────────────────────────

export function inherits(ctor, superCtor) {
  if (typeof ctor !== 'function') {
    const e = new TypeError('The "ctor" argument must be of type function');
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  if (superCtor === undefined || superCtor === null) {
    const e = new TypeError('The "superCtor" argument must be of type function');
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  ctor.super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

export function deprecate(fn, message, code) {
  if (typeof fn !== 'function') {
    const e = new TypeError('The "fn" argument must be of type function');
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  let warned = false;
  const wrapped = function (...args) {
    if (!warned) {
      warned = true;
      const suffix = code ? ' [' + code + ']' : '';
      globalThis.console.warn('DeprecationWarning: ' + String(message) + suffix);
    }
    return fn.apply(this, args);
  };
  Object.defineProperty(wrapped, 'name', { value: 'deprecated_' + (fn.name || 'anonymous'), configurable: true });
  wrapped.toString = () => fn.toString();
  return wrapped;
}

export function debuglog(section) {
  const enabled = false; // 沙箱里 process.env 为空：没有 NODE_DEBUG 可言
  const fn = function (...args) {
    if (!fn.enabled) return;
    globalThis.console.error(String(section) + ' ' + format(...args));
  };
  fn.enabled = enabled;
  return fn;
}

export function isDeepStrictEqual(a, b) {
  try {
    assertModule.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

export function promisify(original) {
  if (typeof original !== 'function') {
    const e = new TypeError('The "original" argument must be of type function');
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  const custom = original[kPromisifyCustom];
  if (custom !== undefined) {
    if (typeof custom !== 'function') {
      const e = new TypeError('The "util.promisify.custom" argument must be of type function');
      e.code = 'ERR_INVALID_ARG_VALUE';
      throw e;
    }
    return custom;
  }
  const fn = function (...args) {
    return new Promise((resolve, reject) => {
      original.call(this, ...args, (err, value) => {
        if (err) reject(err);
        else resolve(value);
      });
    });
  };
  Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
  Object.defineProperty(fn, 'name', { value: original.name, configurable: true });
  Object.defineProperty(fn, kPromisifyCustom, { value: custom, configurable: true });
  return fn;
}
promisify.custom = kPromisifyCustom;

export function callbackify(original) {
  if (typeof original !== 'function') {
    const e = new TypeError('The "original" argument must be of type function');
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  const fn = function (...args) {
    const cb = args.pop();
    if (typeof cb !== 'function') {
      const e = new TypeError('The "callback" argument must be of type function');
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
    const result = original.apply(this, args);
    if (!result || typeof result.then !== 'function') {
      const e = new TypeError('The "original" argument must be of type function returning a promise');
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
    result.then(
      (value) => queueMicrotask(() => cb(null, value)),
      (err) => queueMicrotask(() => cb(err || new Error('Promise rejected'))),
    );
  };
  Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
  Object.defineProperty(fn, 'name', { value: original.name, configurable: true });
  return fn;
}

/**
 * `errno` → 名字（反向查常量表，数据来自 Linux 真值）。
 * ⚠️ Node 收的是**负数**（`getSystemErrorName(-2)` → `'ENOENT'`，与 libuv 的错误码约定一致），
 * 正数抛 `ERR_OUT_OF_RANGE`。照抄，别"顺手改成正数"——那会让 `-errno` 的调用方全错。
 */
export function getSystemErrorName(err) {
  if (typeof err !== 'number') {
    const e = new TypeError('The "err" argument must be of type number');
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  if (err >= 0) {
    const e = new RangeError('The value of "err" is out of range. It must be a negative integer. Received ' + err);
    e.code = 'ERR_OUT_OF_RANGE';
    throw e;
  }
  const target = -err;
  for (const key of Object.keys(constantsTable)) {
    if (/^E[A-Z0-9_]+$/.test(key) && !key.startsWith('ENGINE_') && constantsTable[key] === target) {
      return key;
    }
  }
  const e = new RangeError('The value of "err" is out of range. It must be a valid error code number. Received ' + err);
  e.code = 'ERR_OUT_OF_RANGE';
  throw e;
}

// ──────────────────────────── types ────────────────────────────

const t = (v) => tagOf(v);
/**
 * 装箱族必须**同时**是对象：`Object.prototype.toString.call(1)` 也是 `'[object Number]'`
 * （原始值会伪装成装箱值），光看 tag 会把 `isNumberObject(1)` 判成 true —— 实测宿主是 false。
 */
const isBoxed = (v, tag) => typeof v === 'object' && v !== null && t(v) === tag;
/** 装箱族的 tag 集合（`typeof` 判定另见 isBoxed：原始值也会报这些 tag） */
const BOXED_TAGS = ['[object Number]', '[object String]', '[object Boolean]', '[object Symbol]', '[object BigInt]'];
export const types = {
  isAnyArrayBuffer: (v) => t(v) === '[object ArrayBuffer]' || t(v) === '[object SharedArrayBuffer]',
  isArrayBuffer: (v) => t(v) === '[object ArrayBuffer]',
  isSharedArrayBuffer: (v) => t(v) === '[object SharedArrayBuffer]',
  isArrayBufferView: (v) => ArrayBuffer.isView(v),
  isArgumentsObject: (v) => t(v) === '[object Arguments]',
  isAsyncFunction: (v) => t(v) === '[object AsyncFunction]',
  isBigInt64Array: (v) => t(v) === '[object BigInt64Array]',
  isBigIntObject: (v) => isBoxed(v, '[object BigInt]'),
  isBigUint64Array: (v) => t(v) === '[object BigUint64Array]',
  isBooleanObject: (v) => isBoxed(v, '[object Boolean]'),
  isBoxedPrimitive: (v) => typeof v === 'object' && v !== null && BOXED_TAGS.indexOf(t(v)) !== -1,
  // 下面这两个在沙箱里永远是 false——**这不是近似值，是如实的答案**：CryptoKey/KeyObject 是宿主对象，
  // 沙箱里造不出来（`crypto` 只做摘要），任何沙箱值都不可能是它们。
  isCryptoKey: () => false,
  isKeyObject: () => false,
  isDataView: (v) => t(v) === '[object DataView]',
  isDate: (v) => t(v) === '[object Date]',
  isExternal: () => false, // 沙箱里没有外部资源句柄；如实回答 false 而不是抛错
  isFloat16Array: (v) => t(v) === '[object Float16Array]',
  isFloat32Array: (v) => t(v) === '[object Float32Array]',
  isFloat64Array: (v) => t(v) === '[object Float64Array]',
  isGeneratorFunction: (v) => t(v) === '[object GeneratorFunction]',
  isGeneratorObject: (v) => t(v) === '[object Generator]',
  isInt8Array: (v) => t(v) === '[object Int8Array]',
  isInt16Array: (v) => t(v) === '[object Int16Array]',
  isInt32Array: (v) => t(v) === '[object Int32Array]',
  isMap: (v) => t(v) === '[object Map]',
  isMapIterator: (v) => t(v) === '[object Map Iterator]',
  isModuleNamespaceObject: (v) => t(v) === '[object Module]',
  isNativeError: (v) => /Error\]$/.test(t(v)),
  isNumberObject: (v) => isBoxed(v, '[object Number]'),
  isPromise: (v) => t(v) === '[object Promise]',
  isProxy: /* @__PURE__ */ unsupported('types.isProxy', 'proxy detection needs an internal-slot check that QuickJS does not expose'),
  isRegExp: (v) => t(v) === '[object RegExp]',
  isSet: (v) => t(v) === '[object Set]',
  isSetIterator: (v) => t(v) === '[object Set Iterator]',
  isStringObject: (v) => isBoxed(v, '[object String]'),
  isSymbolObject: (v) => isBoxed(v, '[object Symbol]'),
  isTypedArray: (v) => ArrayBuffer.isView(v) && t(v) !== '[object DataView]',
  isUint8Array: (v) => t(v) === '[object Uint8Array]',
  isUint8ClampedArray: (v) => t(v) === '[object Uint8ClampedArray]',
  isUint16Array: (v) => t(v) === '[object Uint16Array]',
  isUint32Array: (v) => t(v) === '[object Uint32Array]',
  isWeakMap: (v) => t(v) === '[object WeakMap]',
  isWeakSet: (v) => t(v) === '[object WeakSet]',
};

function unsupported(name, why) {
  const fn = function () {
    const e = new Error(name + ' is not supported in the sandbox (' + why + ')');
    e.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
    throw e;
  };
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

// ──────────────────────────── TextEncoder / TextDecoder ────────────────────────────

const DECODER_LABELS = {
  'utf-8': 'utf8',
  utf8: 'utf8',
  'unicode-1-1-utf-8': 'utf8',
  'utf-16le': 'utf16le',
  'utf-16': 'utf16le',
  latin1: 'latin1',
  'iso-8859-1': 'latin1',
};

export class TextEncoder {
  get encoding() {
    return 'utf-8';
  }
  encode(input = '') {
    return hostEncode(String(input));
  }
  encodeInto(source, destination) {
    if (!ArrayBuffer.isView(destination)) {
      const e = new TypeError('The "destination" argument must be an instance of Uint8Array');
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
    const text = String(source);
    const bytes = hostEncode(text);
    const written = Math.min(bytes.length, destination.length);
    for (let i = 0; i < written; i++) destination[i] = bytes[i];
    // `read` = **真正写进去的那部分**对应的字符数：把写入的字节解回来量长度，
    // 而不是乐观地报 `text.length`（目标数组不够长时那是错的）
    const read = written === bytes.length ? text.length : hostDecode(destination.subarray(0, written), 'utf8').length;
    return { read, written };
  }
}

export class TextDecoder {
  constructor(label, options) {
    const key = label === undefined ? 'utf-8' : String(label).toLowerCase();
    const host = DECODER_LABELS[key];
    if (host === undefined) {
      // Node 对**未知标签**与**合法但未实现**的标签都抛这个码；我们照做，绝不静默给近似解码
      const e = new RangeError('The "label" argument must be an encoding label we support (utf-8 / utf-16le / latin1)');
      e.code = 'ERR_ENCODING_NOT_SUPPORTED';
      throw e;
    }
    this._host = host;
    this._fatal = !!(options && options.fatal);
    this._ignoreBOM = !!(options && options.ignoreBOM);
  }
  get encoding() {
    return this._host === 'utf8' ? 'utf-8' : this._host === 'utf16le' ? 'utf-16le' : 'latin1';
  }
  get fatal() {
    return this._fatal;
  }
  get ignoreBOM() {
    return this._ignoreBOM;
  }
  decode(input, options) {
    if (options && options.stream) {
      const e = new Error('TextDecoder({ stream: true }) is not supported in the sandbox (use node:string_decoder)');
      e.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
      throw e;
    }
    if (input === undefined) return '';
    const bytes = toExactArrayBuffer(input);
    const text = hostDecode(bytes, this._host);
    if (this._fatal && this._host !== 'latin1') {
      // 「非法序列」的判据：**解出来的东西按同一编码再编回去必须逐字节一样**。不一样就说明输入里有非法序列。
      // 这样不依赖宿主暴露 fatal 解码，也不用自己复刻 UTF-8 的非法序列规则（§3.2.1 的判据）。
      const source = new Uint8Array(bytes);
      const roundTrip = hostEncode(text, this._host);
      let identical = roundTrip.length === source.length;
      for (let i = 0; identical && i < source.length; i++) identical = roundTrip[i] === source[i];
      if (!identical) {
        const e = new TypeError('The encoded data was not valid');
        e.code = 'ERR_ENCODING_INVALID_ENCODED_DATA';
        throw e;
      }
    }
    if (!this._ignoreBOM && text.charCodeAt(0) === 0xfeff) return text.slice(1);
    return text;
  }
}

// ──────────────────────────── 明确不做的 ────────────────────────────

export const styleText = /* @__PURE__ */ unsupported('styleText', 'no terminal styling in the sandbox');
export const MIMEType = /* @__PURE__ */ unsupported('MIMEType', 'not implemented yet');
export const aborted = /* @__PURE__ */ unsupported('aborted', 'AbortSignal plumbing is not exposed yet');
export const transferableAbortSignal = /* @__PURE__ */ unsupported('transferableAbortSignal', 'no cross-thread transfer in the sandbox');
export const transferableAbortController = /* @__PURE__ */ unsupported('transferableAbortController', 'no cross-thread transfer in the sandbox');
export const getCallSites = /* @__PURE__ */ unsupported('getCallSites', 'stack introspection is not exposed');
export const parseArgs = /* @__PURE__ */ unsupported('parseArgs', 'CLI parsing is not needed inside plugins yet');
export const toUSVString = /* @__PURE__ */ unsupported('toUSVString', 'not implemented yet');
export const getSystemErrorMessage = /* @__PURE__ */ unsupported('getSystemErrorMessage', 'host strerror table is not exposed');

export default {
  format,
  formatWithOptions,
  inspect,
  inherits,
  deprecate,
  debuglog,
  isDeepStrictEqual,
  promisify,
  callbackify,
  getSystemErrorName,
  types,
  TextEncoder,
  TextDecoder,
  styleText,
  MIMEType,
  aborted,
  transferableAbortSignal,
  transferableAbortController,
  getCallSites,
  parseArgs,
  toUSVString,
  getSystemErrorMessage,
};
