// node:string_decoder 仿真 —— StringDecoder
//
// 唯一的存在理由：**跨 chunk 切断一个多字节字符**。流式读取时一个 utf8 字符可能被拆到两个 chunk 里，
// 而 `buf.toString('utf8')` 每次都会把半个字符变成替换字符（`\uFFFD`），拼起来就永久坏了。
// StringDecoder 记住"上一个 chunk 末尾那半个字符"，等后续字节到齐再吐出来。
//
// ══ 状态机照 node/src/string_decoder.cc 逐条移植（:57 DecodeData / :228 FlushData）══
// 移植而不是另写一套的理由：这套边界规则很密（见下），自己写必然在某些编码上漂移。
// **每次"字节 → 字符串"仍走宿主**（`bytes.toString`）——宿主那侧是 `StringBytes::Encode`，
// 与 C++ 里的 `MakeString` 是同一个实现，所以替换字符的粒度、非法序列的处理天然一致。
// 分工与 node-buffer.js 一致：状态（几个字节的尾巴）在沙箱，编解码在宿主。
//
// 四条容易想当然、但 Node 就是这么做的：
//   1. **hex / ascii / latin1 是无状态的**，等价于 `buf.toString(enc)`。其中 **hex 是"编码"不是"解码"**：
//      `new StringDecoder('hex').write(Buffer.from('abc'))` 返回 `'616263'`（输入字节的十六进制），
//      不是把 'abc' 当十六进制文本解出来的 `[0xab]`。
//   2. **base64 / base64url 同理**：`write` 返回的是输入字节的 base64 串（留载单位是 3 字节，
//      即"别把一个 4 字符组切开"），不是解码。照抄 Node，不"修正"。
//   3. **utf8 的块尾回退**按**前导字节**算还缺几字节；`0xC0`/`0xF5` 这类前导字节 Node 也照算
//      （所以 `[c0,80]` 会被留到下一块，flush 时给两个替换字符）。非法字节（`0x80`–`0xBF` 打头）
//      排在块尾时**不留**，直接交给解码器出替换字符。
//   4. **`end()` 之后字符槽不清零**（Node 的 FlushData 只清 missing/buffered）——
//      于是 `end()` 后 `lastChar` 仍能读出上一次的残留字节。这是 Node 的真实行为，测试里钉住了。
//
// ══ 已知边界 ══
//   · 不含未文档化的遗留 API `text(buf, offset)`（Node 自己在源码里标了 "undocumented legacy stuff"）；
//   · `ERR_INVALID_THIS`（原生解码器缓冲被回收）在沙箱里不可能发生，不做；
//   · 编码名归一化在这里是**本地小表**（不 import node-buffer.js 的内部函数——那会把 `normalizeEncoding`
//     变成 `node:buffer` 的导出，污染插件可见的模块面）。两边表同源，改一处必须改两处。
//
// 内联约束：静态、无占位符、只相对 import `./node-buffer.js`（取 Buffer 做字符槽与 lastChar 视图）。

import { Buffer } from './node-buffer.js';

const kChars = Symbol('spc.StringDecoder.chars');
const kMissing = Symbol('spc.StringDecoder.missingBytes');
const kBuffered = Symbol('spc.StringDecoder.bufferedBytes');
const kEncoding = Symbol('spc.StringDecoder.encoding');

/** 字符槽长度：node/src/string_decoder.h:34 `kIncompleteCharactersEnd`（一个字符最多 4 字节） */
const INCOMPLETE_CHAR_SLOT = 4;

/**
 * 编码名归一化（与 node-buffer.js 里的同源，见文件头"已知边界"）。
 * 语义要点：`undefined`/`null`/`''` 都当 utf8（Node 的 normalizeEncoding 第一行），
 * 非字符串落空 → 构造器抛 ERR_UNKNOWN_ENCODING（`new StringDecoder(123)` 在 Node 上就是抛）。
 */
function normalizeEncoding(enc) {
  if (enc === undefined || enc === null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  if (typeof enc !== 'string') return undefined;
  // 空串也是 utf8：Node 的 `normalizeEncoding` 走 default 分支（util.js:258 的 `if (enc === '') return 'utf8'`），
  // 于是 `new StringDecoder('')` 与 `Buffer.isEncoding('')` 的答案**不同**（后者是 false）。
  // 实测对照：宿主 `new StringDecoder('')` → 'utf8'，而 `new StringDecoder(' ')` → 抛。
  // 少了这一行，`new StringDecoder('')` 会抛 ERR_UNKNOWN_ENCODING —— 与 Node 相反。
  if (enc === '') return 'utf8';
  switch (enc.toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return 'utf8';
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return 'utf16le';
    case 'latin1':
    case 'binary':
      return 'latin1';
    case 'ascii':
      return 'ascii';
    case 'base64':
      return 'base64';
    case 'base64url':
      return 'base64url';
    case 'hex':
      return 'hex';
  }
  return undefined;
}

function unknownEncoding(encoding) {
  const e = new TypeError('Unknown encoding: ' + encoding);
  e.code = 'ERR_UNKNOWN_ENCODING';
  return e;
}

/** `The "buf" argument must be an instance of Buffer, TypedArray, or DataView. Received ...` */
function invalidBufArg(buf) {
  let received;
  if (buf === null) received = 'null';
  else if (buf === undefined) received = 'undefined';
  else if (typeof buf === 'object') {
    const name = buf.constructor && buf.constructor.name;
    received = typeof name === 'string' && name !== '' ? 'an instance of ' + name : 'an object';
  } else if (typeof buf === 'string') {
    received = "type string ('" + buf + "')";
  } else received = 'type ' + typeof buf + ' (' + String(buf) + ')';
  const e = new TypeError('The "buf" argument must be an instance of Buffer, TypedArray, or DataView. Received ' + received);
  e.code = 'ERR_INVALID_ARG_TYPE';
  return e;
}

/** 任意视图 → **字节视图**（Uint16Array/DataView 的 `[i]` 不是字节；Node 取的是原始字节） */
function bytesOf(view) {
  if (view instanceof Uint8Array) return view;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * 桥的错误信封还原 + JSON 解码（与 node-buffer.js 里的同名逻辑同源）。
 * `globalThis.__host` 是**裸桥**：宿主对返回值一律 `JSON.stringify`，所以字符串结果回来是**带引号的
 * JSON 文本**，必须自己 parse；失败则是 `{"__spcError":{code,params}}` 信封（§3.2 坑 2）。
 */
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

/** 宿主代工：字节 → 字符串（与 node-buffer.js 走同一条通道；编码名已归一化过） */
function makeString(bytesView, canonicalEncoding) {
  const buf = bytesView.byteOffset === 0 && bytesView.byteLength === bytesView.buffer.byteLength ? bytesView.buffer : bytesView.buffer.slice(bytesView.byteOffset, bytesView.byteOffset + bytesView.byteLength);
  let raw;
  try {
    raw = unwrapHostResult(globalThis.__host['bytes.toString'](buf, canonicalEncoding));
  } catch (err) {
    // 与 node-buffer.js 同一套翻译：宿主码 ENCODING_UNKNOWN → Node 的 ERR_UNKNOWN_ENCODING，宿主码留 spcCode
    if (err && err.code === 'ENCODING_UNKNOWN') {
      const e = new TypeError('Unknown encoding: ' + canonicalEncoding);
      e.code = 'ERR_UNKNOWN_ENCODING';
      e.spcCode = 'ENCODING_UNKNOWN';
      throw e;
    }
    throw err;
  }
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** 把 src[srcStart, srcStart+n) 拷进字符槽的 slotOffset 处（对应 C++ 的 memcpy 到 IncompleteCharacterBuffer） */
function copyIntoSlot(slot, slotOffset, src, srcStart, n) {
  for (let i = 0; i < n; i++) slot[slotOffset + i] = src[srcStart + i];
}

/**
 * `StringDecoder::DecodeData`（node/src/string_decoder.cc:57）的移植。
 * data 必须是**字节视图**；返回值是本次能吐出来的字符串（可能为空 = 还差字节）。
 */
function decodeData(decoder, data) {
  const enc = decoder[kEncoding];
  const slot = decoder[kChars];
  let nread = data.length;
  let prepend = null;
  let body;

  if (enc === 'utf8' || enc === 'utf16le' || enc === 'base64' || enc === 'base64url') {
    // ── 先把"上一块留下的半个字符"补完 ──
    if (decoder[kMissing] > 0) {
      if (enc === 'utf8') {
        // 期望的是续接字节（10xxxxxx）；来了别的字节就说明那半个字符**就是这样了**（非法序列），
        // 立刻把它交给解码器出替换字符，新字节从下一轮重新开始——少了这段，
        // 一个坏字节会把它后面**所有**的字节都拖进字符槽里，输出会整体错位。
        for (let i = 0; i < nread && i < decoder[kMissing]; ++i) {
          if ((data[i] & 0xc0) !== 0x80) {
            decoder[kMissing] = 0;
            copyIntoSlot(slot, decoder[kBuffered], data, 0, i);
            decoder[kBuffered] += i;
            data = data.subarray(i);
            nread -= i;
            break;
          }
        }
      }
      const found = Math.min(nread, decoder[kMissing]);
      copyIntoSlot(slot, decoder[kBuffered], data, 0, found);
      data = data.subarray(found);
      nread -= found;
      decoder[kMissing] -= found;
      decoder[kBuffered] += found;
      if (decoder[kMissing] === 0) {
        prepend = makeString(slot.subarray(0, decoder[kBuffered]), enc);
        decoder[kBuffered] = 0;
      }
    }

    if (nread === 0) {
      // 补完上一块就把这一块用完了（或本来就是空块）
      body = prepend === null ? '' : prepend;
      prepend = null;
    } else {
      let buffered = 0;
      let missing = 0;
      if (enc === 'utf8' && (data[nread - 1] & 0x80) !== 0) {
        // 块尾落在非 ASCII 字节上：往回找出这一"半个字符"从哪开始、还缺几个字节
        let i = nread - 1;
        for (;;) {
          buffered++;
          if ((data[i] & 0xc0) === 0x80) {
            // 续接字节：继续往前找前导字节
            if (buffered >= 4 || i === 0) {
              // 连续 4 个以上续接字节 / 整块里根本没有前导字节 → 非法 utf8，交给解码器处理
              buffered = 0;
              break;
            }
            i--;
            continue;
          }
          if ((data[i] & 0xe0) === 0xc0) missing = 2;
          else if ((data[i] & 0xf0) === 0xe0) missing = 3;
          else if ((data[i] & 0xf8) === 0xf0) missing = 4;
          else {
            // 这个前导字节指示的字符超出可表示范围（如 0xF8+）→ 非法，交给解码器
            buffered = 0;
            break;
          }
          if (buffered >= missing) {
            // 尾部字节数已经够了：要么正好是一个完整字符（==），要么本来就是非法序列（>）
            buffered = 0;
            missing = 0;
          }
          missing -= buffered;
          break;
        }
      } else if (enc === 'utf16le') {
        if (nread % 2 === 1) {
          buffered = 1;
          missing = 1; // 半个码元
        } else if ((data[nread - 1] & 0xfc) === 0xd8) {
          buffered = 2;
          missing = 2; // 半个"代理对"：高代理项在前、低代理项还没来
        }
      } else if (enc === 'base64' || enc === 'base64url') {
        buffered = nread % 3; // 3 字节 → 4 个 base64 字符，块尾多于 3 的倍数就留到下一块
        if (buffered > 0) missing = 3 - buffered;
      }

      // 到这里 missing/buffered 必然是从 0 开始算的（C++ 那两个 DCHECK 就是在说这件事）
      decoder[kBuffered] = buffered;
      decoder[kMissing] = missing;
      if (buffered > 0) {
        nread -= buffered;
        copyIntoSlot(slot, 0, data, nread, buffered);
      }
      body = nread > 0 ? makeString(data.subarray(0, nread), enc) : '';
    }
    return prepend === null ? body : prepend + body;
  }

  // ASCII / HEX / LATIN1：无状态，整块交给解码器（HEX 是"编码字节"，见文件头第 1 条）
  return makeString(data, enc);
}

/** `StringDecoder::FlushData`（:228）的移植：把字符槽里剩余字节吐出来，并清状态（**不清字符槽**） */
function flushData(decoder) {
  const enc = decoder[kEncoding];
  if (enc === 'utf16le' && decoder[kBuffered] % 2 === 1) {
    // 单个尾字节按 Node 的做法**丢掉**（不是给替换字符）
    decoder[kMissing]--;
    decoder[kBuffered]--;
  }
  if (decoder[kBuffered] === 0) return '';
  const ret = makeString(decoder[kChars].subarray(0, decoder[kBuffered]), enc);
  decoder[kMissing] = 0;
  decoder[kBuffered] = 0;
  return ret;
}

class StringDecoder {
  constructor(encoding) {
    const canonical = normalizeEncoding(encoding);
    if (canonical === undefined) throw unknownEncoding(encoding);
    /** 与 Node 一样是**自有可枚举属性**（`Object.keys(decoder)` = ['encoding']） */
    this.encoding = canonical;
    this[kEncoding] = canonical;
    // 字符槽用 Buffer（不是普通 Uint8Array）：Node 的 `lastChar` 是从原生缓冲上取 subarray，
    // 拿到的就是 Buffer——依赖会 `lastChar.toString('hex')`，类型不对会直接炸。
    this[kChars] = Buffer.alloc(INCOMPLETE_CHAR_SLOT);
    this[kMissing] = 0;
    this[kBuffered] = 0;
  }

  /**
   * 喂一块数据，返回"目前能确定"的字符串（末尾不完整的字符会被留到下次）。
   * 字符串入参**原样返回**（Node 的 JS 层第一行就是这么写的：已经在字符串域里，没有"半个字符"问题）。
   */
  write(buf) {
    if (typeof buf === 'string') return buf;
    if (!ArrayBuffer.isView(buf)) throw invalidBufArg(buf);
    return decodeData(this, bytesOf(buf));
  }

  /** 收尾：可选的最后一块 + 把留着的半个字符吐出来（多半是替换字符）。之后本对象可复用。 */
  end(buf) {
    const ret = buf === undefined ? '' : this.write(buf);
    if (this[kBuffered] > 0) return ret + flushData(this);
    return ret;
  }

  /** 还差几个字节才能凑完当前的半个字符（Node 的 `lastNeed`） */
  get lastNeed() {
    return this[kMissing];
  }

  /** 当前半个字符一共攒了几个字节（= 已缓冲 + 还缺：Node 的 `lastTotal`） */
  get lastTotal() {
    return this[kBuffered] + this[kMissing];
  }

  /**
   * 当前攒着的字节（Node 返回原生字符槽的 4 字节视图，**不是**"只有那几个字节"）——
   * 所以 `lastChar.length` 恒为 4，多出来的部分是零。照 Node 给，别"顺手优化"成定长拷贝。
   */
  get lastChar() {
    return this[kChars].subarray(0, INCOMPLETE_CHAR_SLOT);
  }
}

export { StringDecoder };

export default { StringDecoder: StringDecoder };
