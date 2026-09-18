// node:querystring 仿真——查询串的 legacy 编解码
//
// **逐行移植 `node/lib/querystring.js`**（本地 `node/` 是契约宗主），不做"自己理解的查询串解析"：
// 这个模块的细节（`maxKeys` 的消耗算法、`+` 与 `%20` 的差别、空段的处理、`stringify` 对
// 非标量的静默空串）全是生态里被依赖的行为，凭印象写必然差分。
//
// 分工与边界：
//   1. **纯计算**：`encodeStr` / `unescapeBuffer` 的字节扫描都在沙箱里（逐行照抄，
//      包括 `unhexTable` 表与 `noEscape` 表）；
//   2. **宿主代工**：唯一一处是"坏转义的字节级回退"（`decodeURIComponent` 抛错后按
//      UTF-8 重新解释字节）——UTF-8 替换字符的边角语义在宿主（同 `node-string_decoder.js`）。
//      少这一条，`parse('a=%E4')` 会抛错而 Node 给 U+FFFD；
//   3. **与 `node-url.js` 里那份 querystring 子集的关系**：那是 legacy `url.parse` 用的**私有子集**
//      （只支持默认分隔符、没有 `unescapeBuffer`），本文件是面向 `node:querystring` 的**完整面**。
//      两份并存是**有意的**：合并要动已验证的 `node-url.js`，收益只有省几十行，等真有需要再说。
//      行为差异已核对：默认形态下两者结果一致（`url.parse(..., true)` 的既有用例全绿）。
//
// 内联约束：静态、无占位符（见 registry.ts 头注释）。

import { Buffer } from './node-buffer.js';

// ──────────────────────────────── 表（照抄 internal/querystring.js）────────────────────────────────

/** `%00`…`%FF` 的十六进制表（大写，Node 的输出就是大写） */
const hexTable = [];
for (let i = 0; i < 256; i++) {
  hexTable[i] = '%' + (i < 16 ? '0' : '') + i.toString(16).toUpperCase();
}

/** 十六进制位 → 值；-1 = 不是十六进制位。越界索引得 `undefined`，与 Node 的 `Int8Array` 同义 */
const unhexTable = (function () {
  const t = [];
  for (let i = 0; i < 256; i++) t[i] = -1;
  for (let i = 48; i <= 57; i++) t[i] = i - 48; // 0-9
  for (let i = 65; i <= 70; i++) t[i] = i - 55; // A-F
  for (let i = 97; i <= 102; i++) t[i] = i - 87; // a-f
  return t;
})();

/**
 * `querystring.escape` **不转义**的字符表（`! - . _ ~ ' ( ) *` 与字母数字）。
 * 注意与 `encodeURIComponent` 的差别：`encodeURIComponent` **保留** `!'()*`，这里要转义它们。
 */
const noEscape = (function () {
  const t = new Uint8Array(128);
  const keep = "!-._~'()*";
  for (let i = 48; i <= 57; i++) t[i] = 1;
  for (let i = 65; i <= 90; i++) t[i] = 1;
  for (let i = 97; i <= 122; i++) t[i] = 1;
  for (let i = 0; i < keep.length; i++) t[keep.charCodeAt(i)] = 1;
  return t;
})();

// ──────────────────────────────── 编码（internal/querystring.js:45 encodeStr）────────────────────

function encodeStr(str, noEscapeTable, table) {
  const len = str.length;
  if (len === 0) return '';
  let out = '';
  let lastPos = 0;
  let i = 0;
  outer: for (; i < len; i++) {
    let c = str.charCodeAt(i);
    while (c < 0x80) {
      if (noEscapeTable[c] !== 1) {
        if (lastPos < i) out += str.slice(lastPos, i);
        lastPos = i + 1;
        out += table[c];
      }
      if (++i === len) break outer;
      c = str.charCodeAt(i);
    }
    if (lastPos < i) out += str.slice(lastPos, i);
    if (c < 0x800) {
      lastPos = i + 1;
      out += table[0xc0 | (c >> 6)] + table[0x80 | (c & 0x3f)];
      continue;
    }
    if (c < 0xd800 || c >= 0xe000) {
      lastPos = i + 1;
      out += table[0xe0 | (c >> 12)] + table[0x80 | ((c >> 6) & 0x3f)] + table[0x80 | (c & 0x3f)];
      continue;
    }
    // 代理对的高位：必须接着低半区，否则 Node 抛 ERR_INVALID_URI
    ++i;
    if (i >= len) {
      const err = new Error('URI malformed');
      err.code = 'ERR_INVALID_URI';
      throw err;
    }
    const c2 = str.charCodeAt(i) & 0x3ff;
    lastPos = i + 1;
    c = 0x10000 + (((c & 0x3ff) << 10) | c2);
    out +=
      table[0xf0 | (c >> 18)] +
      table[0x80 | ((c >> 12) & 0x3f)] +
      table[0x80 | ((c >> 6) & 0x3f)] +
      table[0x80 | (c & 0x3f)];
  }
  if (lastPos === 0) return str;
  if (lastPos < len) return out + str.slice(lastPos);
  return out;
}

/**
 * `querystring.escape`（querystring.js:163）。
 * 非字符串先转字符串：**对象走 `String(obj)`**（会调 `toString`），其余 `'' + v`。
 */
function qsEscape(str) {
  if (typeof str !== 'string') {
    if (typeof str === 'object') str = String(str);
    else str += '';
  }
  return encodeStr(str, noEscape, hexTable);
}

// ──────────────────────────────── 解码 ────────────────────────────────

/** 字节级百分号解码（querystring.js:84 `unescapeBuffer` 的等价物），`plusAsSpace` = `decodeSpaces` */
function scanUnescape(s, plusAsSpace) {
  const out = [];
  const maxLength = s.length - 2;
  let index = 0;
  let hasHex = false;
  while (index < s.length) {
    let currentChar = s.charCodeAt(index);
    if (currentChar === 43 /* + */ && plusAsSpace) {
      out.push(32);
      index++;
      continue;
    }
    if (currentChar === 37 /* % */ && index < maxLength) {
      const hexHigh = unhexTable[s.charCodeAt(++index)];
      if (!(hexHigh >= 0)) {
        out.push(37); // 孤立的 `%`：原样留下
        continue;
      } else {
        const hexLow = unhexTable[s.charCodeAt(++index)];
        if (!(hexLow >= 0)) {
          out.push(37);
          index--; // 退一格：`%4z` 里的 `4` 还要当下一个普通字符处理
        } else {
          hasHex = true;
          currentChar = hexHigh * 16 + hexLow;
        }
      }
    }
    out.push(currentChar & 0xff); // Node 往 Buffer 里写的是 charCode 的低 8 位
    index++;
  }
  return { bytes: out, hasHex: hasHex };
}

/**
 * `querystring.unescapeBuffer(s[, decodeSpaces])`（公开 API，`body-parser` 一类会用）。
 *
 * 与 Node 的差别：Node 返回 `Buffer.allocUnsafe(s.length)` 并在 `hasHex` 为假时**返回整段**
 * （尾部的未初始化字节对它无所谓——它只用于 `.toString()`）。这里返回**实际写出的字节**，
 * `.length` 因此更小。差异写进设计 §9；对生态里的用法（都是 `.toString()`）无影响。
 */
export function unescapeBuffer(s, decodeSpaces) {
  const { bytes } = scanUnescape(String(s), !!decodeSpaces);
  return Buffer.from(bytes);
}

function latin1From(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function utf8From(bytes) {
  // UTF-8 那一步交给宿主（node-buffer 的 bytes 通道）：替换字符的边角语义不在沙箱
  return Buffer.from(bytes).toString('utf8');
}

/** `querystring.unescape(s[, decodeSpaces])`（querystring.js:131） */
export function unescape(s, decodeSpaces) {
  try {
    return decodeURIComponent(s);
  } catch {
    return unescapeBuffer(s, decodeSpaces).toString();
  }
}

// ──────────────────────────────── stringify（querystring.js:227）────────────────────────────────

/** 自定义编码器路径下的值转换（querystring.js:178 `stringifyPrimitive`） */
function stringifyPrimitive(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return '' + v;
  if (typeof v === 'bigint') return '' + v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
}

/** 默认编码器路径下的值转换（querystring.js:195 `encodeStringified`）：空串不编码 */
function encodeStringified(v, encode) {
  if (typeof v === 'string') return v.length ? encode(v) : '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    // ≥1e21 会变成科学计数法（含 `+`），那时必须转义
    return Math.abs(v) < 1e21 ? '' + v : encode('' + v);
  }
  if (typeof v === 'bigint') return '' + v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
}

function encodeStringifiedCustom(v, encode) {
  return encode(stringifyPrimitive(v));
}

export function stringify(obj, sep, eq, options) {
  sep ||= '&';
  eq ||= '=';

  let encode = qsEscape;
  if (options && typeof options.encodeURIComponent === 'function') {
    encode = options.encodeURIComponent;
  }
  const convert = encode === qsEscape ? encodeStringified : encodeStringifiedCustom;

  if (obj !== null && typeof obj === 'object') {
    const keys = Object.keys(obj);
    const len = keys.length;
    let fields = '';
    for (let i = 0; i < len; ++i) {
      const k = keys[i];
      const v = obj[k];
      const ks = convert(k, encode) + eq;

      if (Array.isArray(v)) {
        const vlen = v.length;
        if (vlen === 0) continue; // 空数组 = 这个键根本不出现
        if (fields) fields += sep;
        for (let j = 0; j < vlen; ++j) {
          if (j) fields += sep;
          fields += ks;
          fields += convert(v[j], encode);
        }
      } else {
        if (fields) fields += sep;
        fields += ks;
        fields += convert(v, encode);
      }
    }
    return fields;
  }
  return '';
}

// ──────────────────────────────── parse（querystring.js:317）────────────────────────────────

function charCodes(str) {
  if (str.length === 0) return [];
  if (str.length === 1) return [str.charCodeAt(0)];
  const ret = new Array(str.length);
  for (let i = 0; i < str.length; ++i) ret[i] = str.charCodeAt(i);
  return ret;
}

const defSepCodes = [38]; // &
const defEqCodes = [61]; // =

/** 坏转义的兜底解绑（querystring.js:478 `decodeStr`） */
function decodeStr(s, decoder) {
  try {
    return decoder(s);
  } catch {
    return unescape(s, true);
  }
}

function addKeyVal(obj, key, value, keyEncoded, valEncoded, decode) {
  if (key.length > 0 && keyEncoded) key = decodeStr(key, decode);
  if (value.length > 0 && valEncoded) value = decodeStr(value, decode);

  if (obj[key] === undefined) {
    obj[key] = value;
  } else {
    const curValue = obj[key];
    // Node 用 `curValue.pop` 判断"已经是数组了"（值全是自己造的，所以这样判是安全的）
    if (curValue.pop) curValue[curValue.length] = value;
    else obj[key] = [curValue, value];
  }
}

export function parse(qs, sep, eq, options) {
  const obj = { __proto__: null };

  if (typeof qs !== 'string' || qs.length === 0) return obj;

  const sepCodes = !sep ? defSepCodes : charCodes(String(sep));
  const eqCodes = !eq ? defEqCodes : charCodes(String(eq));
  const sepLen = sepCodes.length;
  const eqLen = eqCodes.length;

  let pairs = 1000;
  if (options && typeof options.maxKeys === 'number') {
    // 非正数当"无限"（Node 用 -1 代替 Infinity，语义相同：只有显式减到 0 才停）
    pairs = options.maxKeys > 0 ? options.maxKeys : -1;
  }

  let decode = unescape;
  if (options && typeof options.decodeURIComponent === 'function') {
    decode = options.decodeURIComponent;
  }
  const customDecode = decode !== unescape;

  let lastPos = 0;
  let sepIdx = 0;
  let eqIdx = 0;
  let key = '';
  let value = '';
  let keyEncoded = customDecode;
  let valEncoded = customDecode;
  const plusChar = customDecode ? '%20' : ' ';
  let encodeCheck = 0;
  for (let i = 0; i < qs.length; ++i) {
    const code = qs.charCodeAt(i);

    if (code === sepCodes[sepIdx]) {
      if (++sepIdx === sepLen) {
        const end = i - sepIdx + 1;
        if (eqIdx < eqLen) {
          if (lastPos < end) {
            key += qs.slice(lastPos, end);
          } else if (key.length === 0) {
            if (--pairs === 0) return obj;
            lastPos = i + 1;
            sepIdx = eqIdx = 0;
            continue;
          }
        } else if (lastPos < end) {
          value += qs.slice(lastPos, end);
        }

        addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

        if (--pairs === 0) return obj;
        keyEncoded = valEncoded = customDecode;
        key = value = '';
        encodeCheck = 0;
        lastPos = i + 1;
        sepIdx = eqIdx = 0;
      }
    } else {
      sepIdx = 0;
      if (eqIdx < eqLen) {
        if (code === eqCodes[eqIdx]) {
          if (++eqIdx === eqLen) {
            const end = i - eqIdx + 1;
            if (lastPos < end) key += qs.slice(lastPos, end);
            encodeCheck = 0;
            lastPos = i + 1;
          }
          continue;
        } else {
          eqIdx = 0;
          if (!keyEncoded) {
            // 先探一次"看起来像 %HH"，避免每个键都白跑一次解码。
            // 注意这层 `else` 是**必须的**：少了它，`%zz` 里的 `z` 会被当成"hex 探测的第 2 位"
            // 白白吃掉（`encodeCheck` 停在 2，后面 `%42` 的 `4` 直接把它凑到 3 而误判为"已编码"）。
            if (code === 37 /* % */) {
              encodeCheck = 1;
              continue;
            } else if (encodeCheck > 0) {
              if (unhexTable[code] >= 0) {
                if (++encodeCheck === 3) keyEncoded = true;
                continue;
              } else {
                encodeCheck = 0;
              }
            }
          }
        }
        if (code === 43 /* + */) {
          if (lastPos < i) key += qs.slice(lastPos, i);
          key += plusChar;
          lastPos = i + 1;
          continue;
        }
      }
      if (code === 43 /* + */) {
        if (lastPos < i) value += qs.slice(lastPos, i);
        value += plusChar;
        lastPos = i + 1;
      } else if (!valEncoded) {
        if (code === 37 /* % */) {
          encodeCheck = 1;
        } else if (encodeCheck > 0) {
          if (unhexTable[code] >= 0) {
            if (++encodeCheck === 3) valEncoded = true;
          } else {
            encodeCheck = 0;
          }
        }
      }
    }
  }

  if (lastPos < qs.length) {
    if (eqIdx < eqLen) key += qs.slice(lastPos);
    else if (sepIdx < sepLen) value += qs.slice(lastPos);
  } else if (eqIdx === 0 && key.length === 0) {
    return obj; // 正好停在空段上
  }

  addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

  return obj;
}

// ──────────────────────────────── 导出面 ────────────────────────────────
//
// **别名必须是同一个函数对象**：Node 的 `QueryString.encode === QueryString.stringify`、
// `decode === parse`（实测 `_audit/qs-shape-truth.json`）。写成两份等价实现会让
// `qs.encode === qs.stringify` 变成 false —— 那种差异没人会去查文档，只会诡异。

const QueryString = {
  unescapeBuffer: unescapeBuffer,
  unescape: unescape,
  escape: qsEscape,
  stringify: stringify,
  encode: stringify,
  parse: parse,
  decode: parse,
};

export { qsEscape as escape };
export { stringify as encode };
export { parse as decode };

export default QueryString;
