// node:zlib 仿真 —— **同步面 + 回调面**（流式面等 `stream` 落地）
//
// 分工（module-emulation-design §3.2.1，与 node-crypto 同型）：
//   · **压缩解压全在宿主**（`zlib.*` 宿主方法）：deflate/gzip 的字节流是原生库的产物，
//     自己实现既不可能也没必要；而这些操作天生"字节进字节出"，正是桥最擅长的形状。
//   · **沙箱里只有形状**：同步/回调两种形态、options 归一化、`constants`/`codes` 静态表、错误文案还原。
//
// ══ 已知边界（写在这里，免得被当成 bug）══
//  1. **流式入口明确抛错**：`createGzip`/`createDeflateRaw`/`createInflate`/`createUnzip` 以及
//     `Deflate`/`Gzip`/`Inflate` 这些类都返回**流对象**（要 `node:stream` 仿真，本批没有）。
//     不做静默降级——给它一个假流比抛错危险得多。
//  2. **brotli 与 zstd 明确抛错**：宿主一支调用就能做，但没有实测需求，不铺开（`zlib.constants` 里照样有它们的常量，
//     因为那些常量本来就在 Node 的表里）。
//  3. **回调是"排进微任务后同步执行"**（同 node-fs 的说明）：仍占用事件循环，只是形状像异步。
//  4. **options 的宽容度照 Node**（实测）：第二个参数不是对象时**被忽略**（`deflateRawSync(buf, 'zzz')` 不报错）；
//     越界的 `level`/`maxOutputLength` 由**宿主**给出准确错误（`ERR_OUT_OF_RANGE` / `ERR_BUFFER_TOO_LARGE`）。
//  5. **错误保真**：解压失败时 Node 抛的是 `Error` + `code: 'Z_DATA_ERROR'`/`'Z_BUF_ERROR'` + `errno` +
//     具体 message（"invalid block type"/"unexpected end of file"/"incorrect header check"…）。
//     桥只带 `{code, params}`，所以宿主把 name/message/errno 放进 params，这里还原（设计 §7 的约定）。
//     依赖就是按这些分支的：`adm-zip` 的 inflater 与 deflate 路径都读 `error.code`。
//  6. **`constants` 是固定 22.22.1 基线**（WSL 真值生成），与 path=posix / crypto 的静态清单同一取向：
//     宿主 zlib/OpenSSL 版本会变，插件不该在两种机器上看到不同的常量表。计算仍交宿主。
//  7. **字符串输入按 utf8 编成字节**（实测 `deflateSync('abc')` 可用）——走 bytes 通道，需要 `bytes.encode`。
//
// 内联约束：静态、无占位符、不 import 任何 `node:*`；能力只在运行时从 `globalThis.__host` 取。

import { Buffer } from './node-buffer.js';

// ──────────────────────────── 宿主通道 ────────────────────────────

function unwrapHostResult(raw) {
  if (typeof raw !== 'string' || raw.indexOf('__spcError') === -1) return raw;
  let env = null;
  try {
    env = JSON.parse(raw);
  } catch {
    return raw;
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

function toExactArrayBuffer(view) {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function marshalArg(a) {
  if (typeof a === 'string') return a;
  if (ArrayBuffer.isView(a) || a instanceof ArrayBuffer) {
    return a instanceof ArrayBuffer ? a : toExactArrayBuffer(a);
  }
  return JSON.stringify(a === undefined ? null : a);
}

function hostRaw(name, args) {
  return unwrapHostResult(globalThis.__host[name](...args.map(marshalArg)));
}

function callJson(name, ...args) {
  const raw = hostRaw(name, args);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function callBytes(name, ...args) {
  const raw = hostRaw(name, args);
  if (typeof raw === 'string' || !(raw instanceof ArrayBuffer)) {
    const e = new Error('sandbox bridge: expected bytes from ' + name);
    e.code = 'INTERNAL';
    throw e;
  }
  return Buffer.from(raw);
}

// ──────────────────────────── 错误形状 ────────────────────────────

function invalidArgType(name, phrase, value) {
  const got =
    value === undefined
      ? 'undefined'
      : value === null
        ? 'null'
        : typeof value === 'object'
          ? 'an instance of ' + ((value.constructor && value.constructor.name) || 'Object')
          : typeof value === 'string'
            ? "type string ('" + value + "')"
            : 'type ' + typeof value + ' (' + String(value) + ')';
  const e = new TypeError('The "' + name + '" argument must be ' + phrase + '. Received ' + got);
  e.code = 'ERR_INVALID_ARG_TYPE';
  return e;
}

function notSupported(name, why) {
  const e = new Error(name + ' is not available in the sandbox: ' + why);
  e.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
  e.method = name;
  return e;
}

function stub(name, why) {
  return function sandboxUnsupported() {
    throw notSupported(name, why);
  };
}

/**
 * 宿主错误 → Node 形状。
 * `Z_*` 是 **libuv/zlib 的错误码**（Node 原样暴露，不是 errno 名），所以直通并还原 name/message/errno；
 * `ERR_*` 是 Node 契约码，同样直通；其余（我们自己的平台码）按 §7 翻译。
 */
function toNodeZlibError(err) {
  const hostCode = err && typeof err.code === 'string' ? err.code : 'CRYPTO_NATIVE_ERROR';
  const params = (err && err.params) || {};
  const message = typeof params.message === 'string' ? params.message : hostCode;
  const ctor = params.name === 'RangeError' ? RangeError : params.name === 'TypeError' ? TypeError : Error;

  if (hostCode.startsWith('Z_') || hostCode.startsWith('ERR_') || hostCode === 'CRYPTO_NATIVE_ERROR') {
    const e = new ctor(message);
    if (hostCode !== 'CRYPTO_NATIVE_ERROR') e.code = hostCode;
    if (params.errno !== undefined) e.errno = Number(params.errno);
    return e;
  }
  if (hostCode === 'PERMISSION_DENIED') {
    const e = new Error('PERMISSION_DENIED');
    e.code = 'EACCES';
    e.spcCode = hostCode;
    return e;
  }
  if (hostCode === 'INVALID_ARGS') {
    const e = new TypeError('Invalid argument: ' + JSON.stringify(params));
    e.code = 'ERR_INVALID_ARG_VALUE';
    e.spcCode = hostCode;
    return e;
  }
  const e = new Error(hostCode);
  e.code = hostCode;
  e.spcCode = hostCode;
  return e;
}

// ──────────────────────────── 参数归一化 ────────────────────────────

/** 输入字节：字符串按 utf8（实测 Node 接受），视图/ArrayBuffer 原样；其余按 Node 的文案报错 */
function toInputBuffer(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw invalidArgType(
    'buffer',
    'of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer',
    data,
  );
}

/**
 * options 归一化：**非对象被忽略**（Node 实测行为），对象只挑我们支持的键；
 * `dictionary` 是字节，用 hex 过桥（桥只认字符串/ArrayBuffer）。
 */
function toHostOptions(options) {
  if (options === undefined || options === null || typeof options !== 'object') return '{}';
  const out = {};
  for (const key of ['level', 'maxOutputLength', 'strategy', 'windowBits', 'memLevel', 'flush', 'finishFlush']) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  if (options.dictionary !== undefined) {
    const dict = toInputBuffer(options.dictionary);
    out.dictionary = dict.toString('hex');
  }
  return JSON.stringify(out);
}

/** 回调形态的公共壳：参数归一化 → 计算 → 排进微任务回调（Node 保证回调不同步触发） */
function callbackifySync(compute, name) {
  return function asyncForm(...args) {
    const cb = args.pop();
    if (typeof cb !== 'function') throw invalidArgType('callback', 'of type function', cb);
    let result;
    try {
      result = compute(...args);
    } catch (err) {
      queueMicrotask(() => cb(err));
      return undefined;
    }
    const text = typeof result === 'string' ? result : result;
    queueMicrotask(() => cb(null, text));
    return undefined;
  };
}

// ──────────────────────────── 同步面 ────────────────────────────

function makeSync(hostMethod, permissionName) {
  return function runSync(data) {
    // arguments[1] 是 options（非对象时忽略，见文件头边界 4）
    const opts = arguments.length > 1 ? toHostOptions(arguments[1]) : '{}';
    const buf = toInputBuffer(data);
    try {
      return callBytes(hostMethod, buf, opts);
    } catch (err) {
      throw toNodeZlibError(err);
    }
  };
}

const deflateRawSync = makeSync('zlib.deflateRaw');
const deflateSync = makeSync('zlib.deflate');
const gzipSync = makeSync('zlib.gzip');
const inflateRawSync = makeSync('zlib.inflateRaw');
const inflateSync = makeSync('zlib.inflate');
const gunzipSync = makeSync('zlib.gunzip');
const unzipSync = makeSync('zlib.unzip');

const deflateRaw = callbackifySync(deflateRawSync, 'zlib.deflateRaw');
const deflate = callbackifySync(deflateSync, 'zlib.deflate');
const gzip = callbackifySync(gzipSync, 'zlib.gzip');
const inflateRaw = callbackifySync(inflateRawSync, 'zlib.inflateRaw');
const inflate = callbackifySync(inflateSync, 'zlib.inflate');
const gunzip = callbackifySync(gunzipSync, 'zlib.gunzip');
const unzip = callbackifySync(unzipSync, 'zlib.unzip');

function crc32(data, value) {
  const buf = toInputBuffer(data);
  const seed = value === undefined ? 0 : value;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    const e = new RangeError(
      'The value of "value" is out of range. It must be >= 0 and <= 4294967295. Received ' + String(seed),
    );
    e.code = 'ERR_OUT_OF_RANGE';
    throw e;
  }
  return callJson('zlib.crc32', buf, String(seed));
}

// ──────────────────────────── 静态表（固定 22.22.1 基线）────────────────────────────

// >>> GENERATED:zlib-tables（**勿手改**：由 tools/truth/gen-zlib-tables2.mjs 生成，重跑即替换本区间）
/** zlib 常量表（含 zlib / brotli / zstd 三族） */
const CONSTANTS = Object.freeze({
  Z_NO_FLUSH                                           : 0,
  Z_PARTIAL_FLUSH                                      : 1,
  Z_SYNC_FLUSH                                         : 2,
  Z_FULL_FLUSH                                         : 3,
  Z_FINISH                                             : 4,
  Z_BLOCK                                              : 5,
  Z_OK                                                 : 0,
  Z_STREAM_END                                         : 1,
  Z_NEED_DICT                                          : 2,
  Z_ERRNO                                              : -1,
  Z_STREAM_ERROR                                       : -2,
  Z_DATA_ERROR                                         : -3,
  Z_MEM_ERROR                                          : -4,
  Z_BUF_ERROR                                          : -5,
  Z_VERSION_ERROR                                      : -6,
  Z_NO_COMPRESSION                                     : 0,
  Z_BEST_SPEED                                         : 1,
  Z_BEST_COMPRESSION                                   : 9,
  Z_DEFAULT_COMPRESSION                                : -1,
  Z_FILTERED                                           : 1,
  Z_HUFFMAN_ONLY                                       : 2,
  Z_RLE                                                : 3,
  Z_FIXED                                              : 4,
  Z_DEFAULT_STRATEGY                                   : 0,
  ZLIB_VERNUM                                          : 4880,
  DEFLATE                                              : 1,
  INFLATE                                              : 2,
  GZIP                                                 : 3,
  GUNZIP                                               : 4,
  DEFLATERAW                                           : 5,
  INFLATERAW                                           : 6,
  UNZIP                                                : 7,
  BROTLI_DECODE                                        : 8,
  BROTLI_ENCODE                                        : 9,
  ZSTD_DECOMPRESS                                      : 11,
  ZSTD_COMPRESS                                        : 10,
  Z_MIN_WINDOWBITS                                     : 8,
  Z_MAX_WINDOWBITS                                     : 15,
  Z_DEFAULT_WINDOWBITS                                 : 15,
  Z_MIN_CHUNK                                          : 64,
  Z_MAX_CHUNK                                          : null,
  Z_DEFAULT_CHUNK                                      : 16384,
  Z_MIN_MEMLEVEL                                       : 1,
  Z_MAX_MEMLEVEL                                       : 9,
  Z_DEFAULT_MEMLEVEL                                   : 8,
  Z_MIN_LEVEL                                          : -1,
  Z_MAX_LEVEL                                          : 9,
  Z_DEFAULT_LEVEL                                      : -1,
  BROTLI_OPERATION_PROCESS                             : 0,
  BROTLI_OPERATION_FLUSH                               : 1,
  BROTLI_OPERATION_FINISH                              : 2,
  BROTLI_OPERATION_EMIT_METADATA                       : 3,
  BROTLI_PARAM_MODE                                    : 0,
  BROTLI_MODE_GENERIC                                  : 0,
  BROTLI_MODE_TEXT                                     : 1,
  BROTLI_MODE_FONT                                     : 2,
  BROTLI_DEFAULT_MODE                                  : 0,
  BROTLI_PARAM_QUALITY                                 : 1,
  BROTLI_MIN_QUALITY                                   : 0,
  BROTLI_MAX_QUALITY                                   : 11,
  BROTLI_DEFAULT_QUALITY                               : 11,
  BROTLI_PARAM_LGWIN                                   : 2,
  BROTLI_MIN_WINDOW_BITS                               : 10,
  BROTLI_MAX_WINDOW_BITS                               : 24,
  BROTLI_LARGE_MAX_WINDOW_BITS                         : 30,
  BROTLI_DEFAULT_WINDOW                                : 22,
  BROTLI_PARAM_LGBLOCK                                 : 3,
  BROTLI_MIN_INPUT_BLOCK_BITS                          : 16,
  BROTLI_MAX_INPUT_BLOCK_BITS                          : 24,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING        : 4,
  BROTLI_PARAM_SIZE_HINT                               : 5,
  BROTLI_PARAM_LARGE_WINDOW                            : 6,
  BROTLI_PARAM_NPOSTFIX                                : 7,
  BROTLI_PARAM_NDIRECT                                 : 8,
  BROTLI_DECODER_RESULT_ERROR                          : 0,
  BROTLI_DECODER_RESULT_SUCCESS                        : 1,
  BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT               : 2,
  BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT              : 3,
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
  BROTLI_DECODER_PARAM_LARGE_WINDOW                    : 1,
  BROTLI_DECODER_NO_ERROR                              : 0,
  BROTLI_DECODER_SUCCESS                               : 1,
  BROTLI_DECODER_NEEDS_MORE_INPUT                      : 2,
  BROTLI_DECODER_NEEDS_MORE_OUTPUT                     : 3,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE         : -1,
  BROTLI_DECODER_ERROR_FORMAT_RESERVED                 : -2,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE    : -3,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET  : -4,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME      : -5,
  BROTLI_DECODER_ERROR_FORMAT_CL_SPACE                 : -6,
  BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE            : -7,
  BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT       : -8,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1           : -9,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2           : -10,
  BROTLI_DECODER_ERROR_FORMAT_TRANSFORM                : -11,
  BROTLI_DECODER_ERROR_FORMAT_DICTIONARY               : -12,
  BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS              : -13,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_1                : -14,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_2                : -15,
  BROTLI_DECODER_ERROR_FORMAT_DISTANCE                 : -16,
  BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET              : -19,
  BROTLI_DECODER_ERROR_INVALID_ARGUMENTS               : -20,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES             : -21,
  BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS               : -22,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP               : -25,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1             : -26,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2             : -27,
  BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES          : -30,
  BROTLI_DECODER_ERROR_UNREACHABLE                     : -31,
  ZSTD_e_continue                                      : 0,
  ZSTD_e_flush                                         : 1,
  ZSTD_e_end                                           : 2,
  ZSTD_fast                                            : 1,
  ZSTD_dfast                                           : 2,
  ZSTD_greedy                                          : 3,
  ZSTD_lazy                                            : 4,
  ZSTD_lazy2                                           : 5,
  ZSTD_btlazy2                                         : 6,
  ZSTD_btopt                                           : 7,
  ZSTD_btultra                                         : 8,
  ZSTD_btultra2                                        : 9,
  ZSTD_c_compressionLevel                              : 100,
  ZSTD_c_windowLog                                     : 101,
  ZSTD_c_hashLog                                       : 102,
  ZSTD_c_chainLog                                      : 103,
  ZSTD_c_searchLog                                     : 104,
  ZSTD_c_minMatch                                      : 105,
  ZSTD_c_targetLength                                  : 106,
  ZSTD_c_strategy                                      : 107,
  ZSTD_c_enableLongDistanceMatching                    : 160,
  ZSTD_c_ldmHashLog                                    : 161,
  ZSTD_c_ldmMinMatch                                   : 162,
  ZSTD_c_ldmBucketSizeLog                              : 163,
  ZSTD_c_ldmHashRateLog                                : 164,
  ZSTD_c_contentSizeFlag                               : 200,
  ZSTD_c_checksumFlag                                  : 201,
  ZSTD_c_dictIDFlag                                    : 202,
  ZSTD_c_nbWorkers                                     : 400,
  ZSTD_c_jobSize                                       : 401,
  ZSTD_c_overlapLog                                    : 402,
  ZSTD_d_windowLogMax                                  : 100,
  ZSTD_CLEVEL_DEFAULT                                  : 3,
  ZSTD_error_no_error                                  : 0,
  ZSTD_error_GENERIC                                   : 1,
  ZSTD_error_prefix_unknown                            : 10,
  ZSTD_error_version_unsupported                       : 12,
  ZSTD_error_frameParameter_unsupported                : 14,
  ZSTD_error_frameParameter_windowTooLarge             : 16,
  ZSTD_error_corruption_detected                       : 20,
  ZSTD_error_checksum_wrong                            : 22,
  ZSTD_error_literals_headerWrong                      : 24,
  ZSTD_error_dictionary_corrupted                      : 30,
  ZSTD_error_dictionary_wrong                          : 32,
  ZSTD_error_dictionaryCreation_failed                 : 34,
  ZSTD_error_parameter_unsupported                     : 40,
  ZSTD_error_parameter_combination_unsupported         : 41,
  ZSTD_error_parameter_outOfBound                      : 42,
  ZSTD_error_tableLog_tooLarge                         : 44,
  ZSTD_error_maxSymbolValue_tooLarge                   : 46,
  ZSTD_error_maxSymbolValue_tooSmall                   : 48,
  ZSTD_error_stabilityCondition_notRespected           : 50,
  ZSTD_error_stage_wrong                               : 60,
  ZSTD_error_init_missing                              : 62,
  ZSTD_error_memory_allocation                         : 64,
  ZSTD_error_workSpace_tooSmall                        : 66,
  ZSTD_error_dstSize_tooSmall                          : 70,
  ZSTD_error_srcSize_wrong                             : 72,
  ZSTD_error_dstBuffer_null                            : 74,
  ZSTD_error_noForwardProgress_destFull                : 80,
  ZSTD_error_noForwardProgress_inputEmpty              : 82,
});

/**
 * `zlib.codes`：Node 给的是**双向映射**（`0 → 'Z_OK'` 且 `'Z_OK' → 0`），实测确认。
 * ⚠️ **只收错误码那 9 个**——其余 Z_* 是参数/策略常量，数值会撞车
 * （`Z_DEFAULT_STRATEGY` 也是 0，全表双向映射会把 `Z_OK` 覆盖掉，实测踩到）。
 */
const CODES = Object.freeze((() => {
  const map = {};
  const ERROR_CODES = [
    'Z_OK',
    'Z_STREAM_END',
    'Z_NEED_DICT',
    'Z_ERRNO',
    'Z_STREAM_ERROR',
    'Z_DATA_ERROR',
    'Z_MEM_ERROR',
    'Z_BUF_ERROR',
    'Z_VERSION_ERROR',
  ];
  for (const name of ERROR_CODES) {
    const value = CONSTANTS[name];
    if (typeof value !== 'number') continue;
    map[name] = value;
    map[value] = name;
  }
  return map;
})());
// <<< GENERATED:zlib-tables

// ──────────────────────────── 明确不支持的 ────────────────────────────

const STREAM_WHY = 'stream-based zlib is not available yet (this batch has no node:stream emulation)';
const CODEC_WHY = 'not implemented yet (no measured demand)';

const createDeflate = stub('zlib.createDeflate', STREAM_WHY);
const createDeflateRaw = stub('zlib.createDeflateRaw', STREAM_WHY);
const createGzip = stub('zlib.createGzip', STREAM_WHY);
const createInflate = stub('zlib.createInflate', STREAM_WHY);
const createInflateRaw = stub('zlib.createInflateRaw', STREAM_WHY);
const createGunzip = stub('zlib.createGunzip', STREAM_WHY);
const createUnzip = stub('zlib.createUnzip', STREAM_WHY);
const createBrotliCompress = stub('zlib.createBrotliCompress', CODEC_WHY);
const createBrotliDecompress = stub('zlib.createBrotliDecompress', CODEC_WHY);
const createZstdCompress = stub('zlib.createZstdCompress', CODEC_WHY);
const createZstdDecompress = stub('zlib.createZstdDecompress', CODEC_WHY);
const brotliCompress = stub('zlib.brotliCompress', CODEC_WHY);
const brotliCompressSync = stub('zlib.brotliCompressSync', CODEC_WHY);
const brotliDecompress = stub('zlib.brotliDecompress', CODEC_WHY);
const brotliDecompressSync = stub('zlib.brotliDecompressSync', CODEC_WHY);
const zstdCompress = stub('zlib.zstdCompress', CODEC_WHY);
const zstdCompressSync = stub('zlib.zstdCompressSync', CODEC_WHY);
const zstdDecompress = stub('zlib.zstdDecompress', CODEC_WHY);
const zstdDecompressSync = stub('zlib.zstdDecompressSync', CODEC_WHY);

class Deflate extends stub('zlib.Deflate', STREAM_WHY) {}
class DeflateRaw extends stub('zlib.DeflateRaw', STREAM_WHY) {}
class Gzip extends stub('zlib.Gzip', STREAM_WHY) {}
class Inflate extends stub('zlib.Inflate', STREAM_WHY) {}
class InflateRaw extends stub('zlib.InflateRaw', STREAM_WHY) {}
class Gunzip extends stub('zlib.Gunzip', STREAM_WHY) {}
class Unzip extends stub('zlib.Unzip', STREAM_WHY) {}
class BrotliCompress extends stub('zlib.BrotliCompress', CODEC_WHY) {}
class BrotliDecompress extends stub('zlib.BrotliDecompress', CODEC_WHY) {}
class ZstdCompress extends stub('zlib.ZstdCompress', CODEC_WHY) {}
class ZstdDecompress extends stub('zlib.ZstdDecompress', CODEC_WHY) {}

// ──────────────────────────── 导出 ────────────────────────────

const zlib = {
  // 同步面
  deflateRawSync,
  deflateSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
  gunzipSync,
  unzipSync,
  // 回调面（形状是异步，实现是同步——文件头边界 3）
  deflateRaw,
  deflate,
  gzip,
  inflateRaw,
  inflate,
  gunzip,
  unzip,
  // 校验与静态表
  crc32,
  constants: CONSTANTS,
  codes: CODES,
  // 类（形状标记，构造即抛错）
  Deflate,
  DeflateRaw,
  Gzip,
  Inflate,
  InflateRaw,
  Gunzip,
  Unzip,
  BrotliCompress,
  BrotliDecompress,
  ZstdCompress,
  ZstdDecompress,
  // 明确不支持
  createDeflate,
  createDeflateRaw,
  createGzip,
  createInflate,
  createInflateRaw,
  createGunzip,
  createUnzip,
  createBrotliCompress,
  createBrotliDecompress,
  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  brotliDecompressSync,
  createZstdCompress,
  createZstdDecompress,
  zstdCompress,
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
};

export {
  deflateRawSync,
  deflateSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
  gunzipSync,
  unzipSync,
  deflateRaw,
  deflate,
  gzip,
  inflateRaw,
  inflate,
  gunzip,
  unzip,
  crc32,
  Deflate,
  DeflateRaw,
  Gzip,
  Inflate,
  InflateRaw,
  Gunzip,
  Unzip,
  BrotliCompress,
  BrotliDecompress,
  ZstdCompress,
  ZstdDecompress,
  createDeflate,
  createDeflateRaw,
  createGzip,
  createInflate,
  createInflateRaw,
  createGunzip,
  createUnzip,
  createBrotliCompress,
  createBrotliDecompress,
  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  brotliDecompressSync,
  createZstdCompress,
  createZstdDecompress,
  zstdCompress,
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
};

export { CONSTANTS as constants, CODES as codes };

export default zlib;
