// node:url 仿真 —— WHATWG 面**宿主代工**，legacy 面**沙箱自实现**
//
// 分工（判据见 module-emulation-design §3.2.1，决策见 §13.1 第 7 条）：
//   · WHATWG `URL` / `URLSearchParams` 的**解析、规范化、百分号编解码** → 宿主代工
//     （`globalThis.__host['url.*']`，实现在 core/hostApi.ts）。两条硬理由：
//     ① QuickJS 里**根本没有 URL / URLSearchParams**；
//     ② 难点不是主流程而是畸形输入——非法端口、IDNA、`+` 与 `%20` 的区别、百分号编码的边角，
//        自己写必然逐条漂移，而宿主就是 Node，结果天然一致。
//   · **对象身份留在沙箱**：`URL` 实例只是"宿主快照的读取器"，一次赋值 = 回宿主重算一次再换快照
//     （≈0.21ms/次跨界；赋值不是热路径，换来的是规范级保真）。`searchParams` 必须是**同一个对象且是活的**，
//     所以这里把它做成"身份在沙箱、内容从快照刷新"的常驻对象，而不是每次新建。
//   · legacy `Url` / `parse` / `format` / `resolve` / `resolveObject` 与 `pathToFileURL` /
//     `fileURLToPath` / `fileURLToPathBuffer` → **沙箱自实现**：它们是纯字符串算法、不依赖 URL 全局，
//     逐行移植 node/lib/url.js（行号指本地 v27 检出）与 node/lib/internal/url.js，
//     并由真值表 `_audit/fs-url-truth.json`（WSL node v22.22.1 实测）逐条差分守住。
//
// ══ 已知边界（写在这里，免得被当成 bug）══
//   1. **路径语义固定 POSIX/Linux**（与 node-path.js 同一取向）。两处后果：
//      · `pathToFileURL` 的相对路径按 `process.cwd()` 解析，沙箱里 cwd =**数据目录**（取 `__spcEnv.dataDir`）。
//        注意这与 node-path.js 的 `resolve()` 兜底虚拟根 `/` **不同**——那里是"路径拼接没依据"，
//        这里是"文件 URL 必须能指回插件作用域里的真文件"，按数据目录解析才有意义；
//      · 宿主是 Windows 时 `pathToFileURL('/tmp/x')` 与宿主结果**有意不同**（宿主给 `file:///D:/tmp/x`）。
//        对齐测试只在 Linux 宿主上跟宿主比。
//   2. **不发 DeprecationWarning**：Node 的 `url.parse()` 首次调用发 DEP0169、非法端口发 DEP0170。
//      沙箱里没有 process 可发（也不该把宿主告警面暴露给插件），且沙箱要"静默、可复现"。
//   3. **非法端口按 v22.22.1 基线**：`url.parse('http://x:abc/a')` 把 `:abc` 当路径段，给出 `http://x/:abc/a`。
//      本地 v27 检出已把这里改成 `throw ERR_INVALID_ARG_VALUE`（url.js:519-521）——**那是新行为**，
//      与"仿真基线固定 v22.22.1"（§13.1 第 4 条）冲突，故以基线为准（真值表与宿主 v24 都是基线行为）。
//   4. **`querystring` 只做 legacy 用到的那一档**：默认 `sep='&'` / `eq='='` / `maxKeys=1000`、空段跳过、
//      "只有出现完整 `%HH` 才解码"（这是 `url.parse(..., true)` 的 `query` 语义）。自定义分隔符/解码器不存在——
//      url.js 从不传它们。
//   5. **唯一一处间接依赖 `bytes.*` 权限点的地方**：畸形百分号编码的字节级回退
//      （`url.parse('…?a=%E4', true)` 时 `decodeURIComponent` 抛错 → 交给 node-buffer 的 UTF-8 解码，
//      得到 U+FFFD）。理由同 §3.2.2：UTF-8 的替换字符语义必须交给宿主。
//      主流程**不碰**它——`URL` / `URLSearchParams` / `pathToFileURL` / `fileURLToPath` /
//      `fileURLToPathBuffer`（ASCII 路径有快路径）都只用 `url.parse` + `url.encode` 两个点，
//      真沙箱冒烟用例就是这条不变量的回归。
//   6. `URL.createObjectURL` / `revokeObjectURL` **明确抛 `ERR_NOT_SUPPORTED_IN_SANDBOX`**：
//      沙箱里没有 Blob，也没有对象 URL 注册表；静默返回占位串会让 `fetch(blob:)` 这类代码安静地坏掉。
//   7. `URLPattern` **不在导出面**：v22.22.1 的 `url` 模块导出里没有它（Node 是后来才挂上去的）。
//   8. `toUSVString` 是沙箱内手写的 well-formed 化（QuickJS 没有 ES2024 的 `String.prototype.toWellFormed`）：
//      孤立代理项 → U+FFFD，与宿主同语义。USVString 转换一律用**模板串**而不是 `String()`——
//      Symbol 上前者抛 TypeError、后者给 `'Symbol()'`，Node 用的是前者（`u.hostname = Symbol()` 会抛）。
//
// 内联约束：静态、无占位符、不 import 任何 `node:*`；能力只在运行时从 `globalThis.__host` 取，
// 事实（cwd）从 `globalThis.__spcEnv` 取。除 `./node-buffer.js` 外不依赖任何伴随文件。

import { Buffer } from './node-buffer.js';

// ──────────────────────────── 环境事实 ────────────────────────────

const FACTS = JSON.parse(globalThis.__spcEnv);
if (!FACTS || typeof FACTS !== 'object' || typeof FACTS.dataDir !== 'string') {
  // 建沙箱时没注入环境事实 = 宿主侧接线漏了。响亮报错，不要退化成"随便给个 cwd"
  // （`pathToFileURL` 的绝对路径要靠它，猜错的后果是插件拿到指向别处的 file: URL）。
  const err = new Error('sandbox env facts missing (globalThis.__spcEnv)');
  err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
  throw err;
}

/** 沙箱的 `process.cwd()`（同一个事实，见 node-process.js 的 `cwd()`） */
const CWD = FACTS.dataDir;

// ──────────────────────────── 宿主代工通道 ────────────────────────────

/**
 * 桥的**错误信封**还原。
 *
 * `globalThis.__host` 是**裸桥**：宿主侧（core/sandbox.ts）把返回值一律 `JSON.stringify`，
 * 失败时回一个单键信封字符串。判定收紧为"只有键 + `__spcError` + code 是 string"——
 * 免得插件数据里出现 `__spcError` 字样时被误判（同 node-buffer.js 与 host-api.js）。
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
      throw fromHostError(env.__spcError.code, env.__spcError.params);
    }
  }
  return raw;
}

/**
 * 宿主码 → 沙箱异常的翻译（§7 的 errno 翻译模式的同一条思路：对外像 Node，对内保留宿主码）。
 *
 * 目前只有一条需要翻译：宿主 `parseUrl` 把一切解析失败收敛成 `ERR_INVALID_URL`（信封里带 `input`），
 * 而 Node 在这条路上抛的是 **TypeError**，且错误对象上带 `input` 自有属性（`Object.keys(e)` = ['code','input']）。
 * 少了这层翻译，插件拿到的是 `Error: ERR_INVALID_URL`——`err.name` 与 `err.input` 都对不上。
 */
function fromHostError(code, params) {
  if (code === 'ERR_INVALID_URL') return invalidUrl(params && params.input);
  const err = new Error(code);
  err.code = code;
  if (params) err.params = params; // 诊断用（含宿主拒绝的原因，如未知 URL 部件）
  return err;
}

/** 一次跨界调用 → JSON 解码后的值。参数个数固定展开：桥不认"数组当参数表"。 */
function hostCall1(name, a) {
  return decodeHost(name, globalThis.__host[name](a));
}
function hostCall2(name, a, b) {
  return decodeHost(name, globalThis.__host[name](a, b));
}
function hostCall3(name, a, b, c) {
  return decodeHost(name, globalThis.__host[name](a, b, c));
}

function decodeHost(name, raw) {
  const text = unwrapHostResult(raw); // 信封在这里变成异常
  if (typeof text !== 'string') {
    // 宿主侧接线坏了（这几个方法一律回 JSON 文本）。响亮失败，别把垃圾当结果。
    const err = new Error('sandbox bridge contract violation: ' + name + ' returned ' + Object.prototype.toString.call(text));
    err.code = 'INTERNAL';
    throw err;
  }
  return JSON.parse(text);
}

// ──────────────────────────── 错误构造 ────────────────────────────

/** Node 的 `ERR_INVALID_URL`：TypeError + `code` + `input`（两个自有属性，顺序也照抄） */
function invalidUrl(input) {
  const err = new TypeError('Invalid URL');
  err.code = 'ERR_INVALID_URL';
  err.input = input;
  return err;
}

function missingArgs(a, b) {
  const err = new TypeError(
    b === undefined
      ? 'The "' + a + '" argument must be specified'
      : 'The "' + a + '" and "' + b + '" arguments must be specified',
  );
  err.code = 'ERR_MISSING_ARGS';
  return err;
}

/**
 * `ERR_INVALID_ARG_TYPE`：文案要与 Node **逐字**一样才有价值（生态里有按文案分支的测试），
 * 所以这里照 node/lib/internal/errors.js 的分组规则来：原生类型走 "of type"，
 * 大写开头的构造器名走 "an instance of"。`Received ...` 照 `determineSpecificType`。
 */
function determineSpecificType(value) {
  if (value === null || value === undefined) return '' + value;
  if (typeof value === 'function' && value.name) return 'function ' + value.name;
  if (typeof value === 'object') {
    return value.constructor && value.constructor.name ? 'an instance of ' + value.constructor.name : 'an instance of Object';
  }
  if (typeof value === 'string') return "type string ('" + value + "')";
  return 'type ' + typeof value + ' (' + String(value) + ')';
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
  let msg = 'The "' + name + '" argument must be ';
  if (types.length > 0) {
    msg += (types.length > 1 ? 'one of type ' : 'of type ') + types.join(' or ');
    if (instances.length > 0 || other.length > 0) msg += ' or ';
  }
  if (instances.length > 0) {
    msg += 'an instance of ' + instances.join(' or ');
    if (other.length > 0) msg += ' or ';
  }
  if (other.length > 0) msg += (other.length > 1 ? 'one of ' : '') + other.join(' or ');
  msg += '. Received ' + determineSpecificType(actual);
  const err = new TypeError(msg);
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

function invalidTuple() {
  const err = new TypeError('Each query pair must be an iterable [name, value] tuple');
  err.code = 'ERR_INVALID_TUPLE';
  return err;
}

function invalidThis(what) {
  const err = new TypeError('Method ' + what + '.prototype method called on incompatible receiver');
  err.code = 'ERR_INVALID_THIS';
  return err;
}

function invalidUrlScheme(scheme) {
  const err = new TypeError('The URL must be of scheme ' + scheme);
  err.code = 'ERR_INVALID_URL_SCHEME';
  return err;
}

/** `ERR_INVALID_FILE_URL_HOST` 的文案里带**构建期平台名**；仿真是 Linux 基线，所以固定 linux */
function invalidFileUrlHost() {
  const err = new TypeError('File URL host must be "localhost" or empty on linux');
  err.code = 'ERR_INVALID_FILE_URL_HOST';
  return err;
}

function invalidFileUrlPath(reason) {
  const err = new TypeError('File URL path ' + reason);
  err.code = 'ERR_INVALID_FILE_URL_PATH';
  return err;
}

function invalidUri() {
  const err = new URIError('URI malformed');
  err.code = 'ERR_INVALID_URI';
  return err;
}

function assertString(value, name) {
  if (typeof value !== 'string') throw invalidArgType(name, ['string'], value);
}

/** 明确不做的调用：报错要能一眼看出"是沙箱没支持"，而不是"我参数写错了"（同 node-os.js 的取向） */
function unsupported(name, why) {
  const fn = function () {
    const err = new Error('url.' + name + ' is not supported in the sandbox (' + why + ')');
    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
    throw err;
  };
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

// ──────────────────────────── WHATWG URLSearchParams ────────────────────────────
//
// 沙箱侧只保留**列表**（扁平的 [k, v, k, v, ...]，与 Node 的 `#searchParams` 同形）；
// "字符串 → 列表"与"列表 → 字符串"两步跨界交给宿主（`url.paramsParse` / `url.paramsStringify`）。
// 这样做的原因：编码表与畸形输入（`+` vs `%20`、非法 `%`、孤立代理项）全是宿主 Node 说了算。

const SP_LIST = new WeakMap(); // URLSearchParams → 扁平列表
const SP_CACHE = new WeakMap(); // URLSearchParams → 已序列化串（Node 有同样的 #serialized 缓存）
const SP_URL = new WeakMap(); // URLSearchParams → 绑定的 URL（Node 的 "associated url object"）

function spListOf(self) {
  const list = SP_LIST.get(self);
  if (!list) throw invalidThis('URLSearchParams');
  return list;
}

function spInvalidate(p) {
  SP_CACHE.delete(p);
}

/**
 * 变更后回写 URL（Node: `#markUpdated` → `setURLSearchParamsModified`）。
 *
 * **无条件的**：Node 上 `u.searchParams.delete('不存在')` 也会让 `u.href` 变化——
 * `new URL('http://x/a?b')` 上删一个不存在的键，href 会变成 `http://x/a?b=`（实测 v22.22.1）。
 * 因为 URL 的 href 一旦被"searchParams 已修改"标记，就整体重新序列化。少了这一条，
 * 这种"删了个寂寞却改变了 href"的行为对不上。
 */
function spMarkUpdated(p) {
  spInvalidate(p);
  const u = SP_URL.get(p);
  if (!u) return; // 独立构造的 URLSearchParams：没有 URL 要回写
  const st = URL_STATE.get(u);
  if (!st) return;
  applySnapshot(u, hostCall3('url.setPart', st.snap.href, 'search', spSerialize(p)));
}

function spSerialize(p) {
  const cached = SP_CACHE.get(p);
  if (cached !== undefined) return cached;
  const list = spListOf(p);
  const pairs = [];
  for (let i = 0; i < list.length; i += 2) pairs.push([list[i], list[i + 1]]);
  const text = hostCall2('url.paramsStringify', JSON.stringify(pairs));
  SP_CACHE.set(p, text);
  return text;
}

/** 快照里的 pairs → 原地替换列表内容（对象身份不变——Node 里 `u.searchParams` 恒等） */
function spSetPairs(p, pairs) {
  const list = SP_LIST.get(p);
  if (!list) return;
  list.length = 0;
  for (let i = 0; i < pairs.length; i++) list.push(pairs[i][0], pairs[i][1]);
  spInvalidate(p);
}

/** 活迭代器：每次 `next()` 都重读列表（Node 的 URLSearchParamsIterator 就是这么做的） */
function makeIterator(params, kind) {
  let index = 0;
  const it = {
    next() {
      const list = SP_LIST.get(params);
      if (!list || index >= list.length) return { value: undefined, done: true };
      const name = list[index];
      const value = list[index + 1];
      index += 2;
      if (kind === 'key') return { value: name, done: false };
      if (kind === 'value') return { value: value, done: false };
      return { value: [name, value], done: false };
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  Object.defineProperty(it, Symbol.toStringTag, { value: 'URLSearchParams Iterator', configurable: true });
  return it;
}

// for merge sort（internal/url.js:1419 的逐行移植：只比 key，两个槽一起搬）
function mergeSortRun(out, start, mid, end, lBuffer, rBuffer) {
  const sizeLeft = mid - start;
  const sizeRight = end - mid;
  let l, r, o;
  for (l = 0; l < sizeLeft; l++) lBuffer[l] = out[start + l];
  for (r = 0; r < sizeRight; r++) rBuffer[r] = out[mid + r];
  l = 0;
  r = 0;
  o = start;
  while (l < sizeLeft && r < sizeRight) {
    if (lBuffer[l] <= rBuffer[r]) {
      out[o++] = lBuffer[l++];
      out[o++] = lBuffer[l++];
    } else {
      out[o++] = rBuffer[r++];
      out[o++] = rBuffer[r++];
    }
  }
  while (l < sizeLeft) out[o++] = lBuffer[l++];
  while (r < sizeRight) out[o++] = rBuffer[r++];
}

/** `String.prototype.toWellFormed` 的等价物（ES2024，QuickJS 没有）。
 * 孤立代理项 → U+FFFD。必须做：Node 的所有 URLSearchParams 入参都先过这一道，
 * 少了它 `get('\uD800')` 与 Node 的键就不是同一个字符串。
 */
function toWellFormed(s) {
  let needs = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      if (c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          i++;
          continue;
        }
      }
      needs = true;
      break;
    }
  }
  if (!needs) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s.charAt(i) + s.charAt(i + 1);
        i++;
        continue;
      }
    }
    out += c >= 0xd800 && c <= 0xdfff ? '\uFFFD' : s.charAt(i);
  }
  return out;
}

/** Node 的 `toUSVString`：非字符串走模板串（`Symbol` 会因此抛 TypeError，与 Node 一致） */
function toUSVString(value) {
  return toWellFormed(typeof value === 'string' ? value : `${value}`);
}

class URLSearchParams {
  /**
   * 入参四态（照 internal/url.js:385-477）：
   *   · undefined        → 空
   *   · 对象/函数        → ① 本就是 URLSearchParams（走私有列表拷贝，不跨界）
   *                        ② 有 `Symbol.iterator` → 序列序列（每项必须长度 2，否则 ERR_INVALID_TUPLE）
   *                        ③ 否则当**记录**（`Reflect.ownKeys` + 只取 enumerable，后来的同键覆盖先前的）
   *   · 其它（含数字）   → `${init}` 后按查询串解析（`new URLSearchParams(123)` → `123=`）
   * 记录分支解释了 `new URLSearchParams(new URL('http://x/?a=1'))` 为什么是空的：URL 的属性全在原型上。
   */
  constructor(init) {
    const list = [];
    SP_LIST.set(this, list);

    if (init === undefined) return;

    if (init !== null && (typeof init === 'object' || typeof init === 'function')) {
      const iter = init[Symbol.iterator];
      if (iter !== undefined && iter !== null && typeof iter !== 'function') {
        const err = new TypeError('The argument \'Query pairs\' is not iterable');
        err.code = 'ERR_ARG_NOT_ITERABLE';
        throw err;
      }
      if (typeof iter === 'function') {
        if (iter === URLSearchParams.prototype[Symbol.iterator] && SP_LIST.has(init)) {
          const src = SP_LIST.get(init);
          for (let i = 0; i < src.length; i++) list.push(src[i]);
          return;
        }
        for (const pair of init) {
          if (pair === null || pair === undefined) throw invalidTuple();
          if (Array.isArray(pair)) {
            if (pair.length !== 2) throw invalidTuple();
            list.push(toUSVString(pair[0]), toUSVString(pair[1]));
          } else {
            if ((typeof pair !== 'object' && typeof pair !== 'function') || typeof pair[Symbol.iterator] !== 'function') {
              throw invalidTuple();
            }
            let length = 0;
            const flat = [];
            for (const element of pair) {
              length++;
              flat.push(toUSVString(element));
            }
            if (length !== 2) throw invalidTuple();
            list.push(flat[0], flat[1]);
          }
        }
      } else {
        // 记录分支：`visited` 处理"两个不同的键 well-formed 化后变成同一个"（保留后者，WPT 要求）
        const visited = new Map();
        const keys = Reflect.ownKeys(init);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const desc = Object.getOwnPropertyDescriptor(init, key);
          if (desc === undefined || !desc.enumerable) continue;
          const typedKey = toUSVString(key);
          const typedValue = toUSVString(init[key]);
          const at = visited.get(typedKey);
          if (at !== undefined) list[at] = typedValue;
          else {
            visited.set(typedKey, list.length);
            list.push(typedKey, typedValue);
          }
        }
      }
      return;
    }

    const text = toUSVString(init);
    if (!text) return;
    const pairs = hostCall1('url.paramsParse', text);
    for (let i = 0; i < pairs.length; i++) list.push(pairs[i][0], pairs[i][1]);
  }

  get size() {
    return spListOf(this).length / 2;
  }

  append(name, value) {
    const list = spListOf(this);
    if (arguments.length < 2) throw missingArgs('name', 'value');
    list.push(toUSVString(name), toUSVString(value));
    spMarkUpdated(this);
  }

  delete(name, value) {
    const list = spListOf(this);
    if (arguments.length < 1) throw missingArgs('name');
    name = toUSVString(name);
    const length = list.length;
    let write = 0;
    if (value !== undefined) {
      value = toUSVString(value);
      for (let i = 0; i < length; i += 2) {
        if (list[i] === name && list[i + 1] === value) continue;
        if (write !== i) {
          list[write] = list[i];
          list[write + 1] = list[i + 1];
        }
        write += 2;
      }
    } else {
      for (let i = 0; i < length; i += 2) {
        if (list[i] === name) continue;
        if (write !== i) {
          list[write] = list[i];
          list[write + 1] = list[i + 1];
        }
        write += 2;
      }
    }
    if (write !== length) {
      list.length = write;
      spInvalidate(this);
    }
    spMarkUpdated(this);
  }

  get(name) {
    const list = spListOf(this);
    if (arguments.length < 1) throw missingArgs('name');
    name = toUSVString(name);
    for (let i = 0; i < list.length; i += 2) {
      if (list[i] === name) return list[i + 1];
    }
    return null;
  }

  getAll(name) {
    const list = spListOf(this);
    if (arguments.length < 1) throw missingArgs('name');
    const values = [];
    name = toUSVString(name);
    for (let i = 0; i < list.length; i += 2) {
      if (list[i] === name) values.push(list[i + 1]);
    }
    return values;
  }

  has(name, value) {
    const list = spListOf(this);
    if (arguments.length < 1) throw missingArgs('name');
    name = toUSVString(name);
    if (value !== undefined) value = toUSVString(value);
    for (let i = 0; i < list.length; i += 2) {
      if (list[i] === name && (value === undefined || list[i + 1] === value)) return true;
    }
    return false;
  }

  set(name, value) {
    const list = spListOf(this);
    if (arguments.length < 2) throw missingArgs('name', 'value');
    name = toUSVString(name);
    value = toUSVString(value);
    const length = list.length;
    let found = false;
    let write = 0;
    for (let i = 0; i < length; i += 2) {
      const cur = list[i];
      let keep = true;
      if (cur === name) {
        if (!found) {
          list[write] = cur;
          list[write + 1] = value;
          found = true;
        } else {
          keep = false;
        }
      } else if (write !== i) {
        list[write] = cur;
        list[write + 1] = list[i + 1];
      }
      if (keep) write += 2;
    }
    if (found && write !== length) list.length = write;
    if (!found) list.push(name, value);
    spMarkUpdated(this);
  }

  /**
   * 稳定排序：短表插入排序、长表自底向上归并（照 internal/url.js:698-743）。
   * 为什么不用 `Array.prototype.sort`：V8 的 sort 稳定、QuickJS 的**不一定**——
   * 稳定性在这里是可观测语义（`b=1&a=2&b=3&a=4` 排序后必须保持同键的相对次序）。
   */
  sort() {
    const a = spListOf(this);
    const len = a.length;
    if (len <= 2) {
      // 无需处理
    } else if (len < 100) {
      for (let i = 2; i < len; i += 2) {
        const curKey = a[i];
        const curVal = a[i + 1];
        let j;
        for (j = i - 2; j >= 0; j -= 2) {
          if (a[j] > curKey) {
            a[j + 2] = a[j];
            a[j + 3] = a[j + 1];
          } else {
            break;
          }
        }
        a[j + 2] = curKey;
        a[j + 3] = curVal;
      }
    } else {
      const lBuffer = new Array(len);
      const rBuffer = new Array(len);
      for (let step = 2; step < len; step *= 2) {
        for (let start = 0; start < len - 2; start += 2 * step) {
          const mid = start + step;
          let end = mid + step;
          end = end < len ? end : len;
          if (mid > end) continue;
          mergeSortRun(a, start, mid, end, lBuffer, rBuffer);
        }
      }
    }
    spMarkUpdated(this);
  }

  entries() {
    spListOf(this);
    return makeIterator(this, 'key+value');
  }

  forEach(callback, thisArg) {
    spListOf(this);
    if (typeof callback !== 'function') throw invalidArgType('callback', ['function'], callback);
    let i = 0;
    for (;;) {
      const list = SP_LIST.get(this); // 每轮重读：回调里可能改了 URL 的 search
      if (i >= list.length) break;
      const name = list[i];
      const value = list[i + 1];
      callback.call(thisArg, value, name, this);
      i += 2;
    }
  }

  keys() {
    spListOf(this);
    return makeIterator(this, 'key');
  }

  values() {
    spListOf(this);
    return makeIterator(this, 'value');
  }

  toString() {
    spListOf(this);
    return spSerialize(this);
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, {
  value: 'URLSearchParams',
  configurable: true,
});

// ──────────────────────────── WHATWG URL ────────────────────────────

const URL_STATE = new WeakMap(); // URL → { snap, params }

const PARTS = ['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];

function urlStateOf(self) {
  const st = URL_STATE.get(self);
  if (!st) throw invalidThis('URL');
  return st;
}

/** 换快照并刷新绑定的 searchParams（**同一个对象**，只换内容） */
function applySnapshot(self, snap) {
  const st = URL_STATE.get(self);
  st.snap = snap;
  if (st.params) spSetPairs(st.params, snap.params);
}

/**
 * WebIDL 的 USVString 转换（internal/url.js:889 的 `input = \`${input}\`` 逐字等价）。
 *
 * 为什么必须是模板串而不是 `String(x)`：**Symbol 上两者行为相反**——`String(Symbol())` 给
 * `'Symbol()'`，而模板串抛 `TypeError: Cannot convert a Symbol value to a string`。
 * Node 在 URL 的入参/base/setter 上用的都是模板串（`new URL(Symbol())`、`u.hostname = Symbol()`
 * 都抛 TypeError），照抄它才不会在符号上漂移。
 */
function toUSV(value) {
  return typeof value === 'string' ? value : `${value}`;
}

class URL {
  constructor(input, base) {
    if (arguments.length < 1) throw missingArgs('url');
    // 转换发生在解析**之前**且不在任何 try 里——所以 `new URL(Symbol())` 抛的是 TypeError
    // （没有 code），而不是 ERR_INVALID_URL。`URL.parse` 那边的 catch 也要认这一点。
    const href = toUSV(input);
    const snap =
      base === undefined
        ? hostCall1('url.resolveHref', href)
        : hostCall2('url.resolveHref', href, toUSV(base));
    URL_STATE.set(this, { snap: snap, params: null });
  }

  get href() {
    return urlStateOf(this).snap.href;
  }
  /**
   * `href` setter **不回用当前 URL 当 base**（规范如此）：`u.href = '/c'` 是**抛错**，不是相对解析。
   * 所以这里走独立的 `url.resolveHref(value)`，而不是 `url.setPart`——后者的 host 实现是
   * `u.href = value`，失败时抛的是裸 TypeError，过桥会退化成 `INTERNAL`，与 Node 的
   * `ERR_INVALID_URL` 对不上。
   */
  set href(value) {
    urlStateOf(this);
    applySnapshot(this, hostCall1('url.resolveHref', toUSV(value)));
  }

  get origin() {
    return urlStateOf(this).snap.origin;
  }
  get protocol() {
    return urlStateOf(this).snap.protocol;
  }
  get username() {
    return urlStateOf(this).snap.username;
  }
  get password() {
    return urlStateOf(this).snap.password;
  }
  get host() {
    return urlStateOf(this).snap.host;
  }
  get hostname() {
    return urlStateOf(this).snap.hostname;
  }
  get port() {
    return urlStateOf(this).snap.port;
  }
  get pathname() {
    return urlStateOf(this).snap.pathname;
  }
  get search() {
    return urlStateOf(this).snap.search;
  }
  get hash() {
    return urlStateOf(this).snap.hash;
  }

  /**
   * 活的、身份稳定的 `searchParams`：
   *   · 身份稳定（`u.searchParams === u.searchParams`）——Node 就是同一个对象；
   *   · 内容随 URL 变：换快照时原地刷新（见 `applySnapshot`）；
   *   · 反向联动：列表变更时回写 URL 的 `search`（见 `spMarkUpdated`）。
   * 三条缺一条都会让 `const p = u.searchParams; u.search = '?x=1'; p.get('x')` 这类代码静默错。
   */
  get searchParams() {
    const st = urlStateOf(this);
    if (!st.params) {
      const p = new URLSearchParams(st.snap.params); // 数组入参：走列表拷贝，不跨界
      SP_URL.set(p, this);
      st.params = p;
    }
    return st.params;
  }

  toString() {
    return urlStateOf(this).snap.href;
  }
  toJSON() {
    return urlStateOf(this).snap.href;
  }
}

/**
 * 各个部件 setter（getter 已在 class 体里定义，这里只补 set，省略 `get` 不会覆盖它）：
 * 一律"回宿主重算一次 → 换快照"。
 *
 * **非法值静默忽略**是 WHATWG 语义，宿主（真实 URL 的 setter）已经照做——所以这里不需要
 * 也不应该自己校验（自己校验必然与规范在边角上漂移）。唯一例外见上面的 `href`。
 */
for (const part of PARTS) {
  if (part === 'href') continue;
  Object.defineProperty(URL.prototype, part, {
    configurable: true,
    set(value) {
      const st = urlStateOf(this);
      applySnapshot(this, hostCall3('url.setPart', st.snap.href, part, toUSV(value)));
    },
  });
}

Object.defineProperty(URL.prototype, Symbol.toStringTag, { value: 'URL', configurable: true });

/**
 * `URL.canParse` / `URL.parse`：**解析失败不抛**的两个静态入口（失败给 `false` / `null`）。
 *
 * 但只吞"解析失败"这一种：`err.code === 'ERR_INVALID_URL'`。另外两类必须**照抛**：
 *   · USVString 转换失败（`URL.canParse(Symbol())` 抛 TypeError）——Node 在 internal/url.js:1207
 *     先转换再进 try 的绑定调用，所以它跑在 try 之外；
 *   · 宿主的其它错误（例如权限点没授予的 `PERMISSION_DENIED`）——把它吞成 `false`/`null`
 *     就等于把"你没权限"伪装成"这串不是合法 URL"，是最难查的那种假阴性。
 */
function isParseFailure(err) {
  return Boolean(err) && err.code === 'ERR_INVALID_URL';
}

URL.canParse = function canParse(input, base) {
  if (arguments.length < 1) throw missingArgs('url');
  const href = toUSV(input);
  const b = base === undefined ? undefined : toUSV(base);
  try {
    if (b === undefined) hostCall1('url.resolveHref', href);
    else hostCall2('url.resolveHref', href, b);
    return true;
  } catch (err) {
    if (isParseFailure(err)) return false;
    throw err;
  }
};

URL.parse = function parse(input, base) {
  if (arguments.length < 1) throw missingArgs('url');
  try {
    return base === undefined ? new URL(input) : new URL(input, base);
  } catch (err) {
    if (isParseFailure(err)) return null;
    throw err;
  }
};

URL.createObjectURL = /* @__PURE__ */ unsupported('createObjectURL', 'the sandbox has no Blob or object-URL registry');
URL.revokeObjectURL = /* @__PURE__ */ unsupported('revokeObjectURL', 'the sandbox has no Blob or object-URL registry');

// ──────────────────────────── querystring 子集（legacy 专用）────────────────────────────
//
// 移植 node/lib/querystring.js 与 internal/querystring.js 的**默认形态**：
// `sep='&'`、`eq='='`、`maxKeys=1000`、`escape` 用自建 hexTable（空格 → `%20`，不是 `+`）。
// `url.parse(..., true)` 与 `Url.prototype.format` 只用到这一档，所以自定义分隔符/解码器不实现。

const hexTable = [];
for (let i = 0; i < 256; i++) {
  hexTable[i] = '%' + (i < 16 ? '0' : '') + i.toString(16).toUpperCase();
}

/** hex 值表（-1 = 不是十六进制位），照 internal/querystring.js:20 的 isHexTable 语义 */
const unhexTable = (function () {
  const t = new Array(128);
  for (let i = 0; i < 128; i++) t[i] = -1;
  for (let i = 48; i <= 57; i++) t[i] = i - 48; // 0-9
  for (let i = 65; i <= 70; i++) t[i] = i - 55; // A-F
  for (let i = 97; i <= 102; i++) t[i] = i - 87; // a-f
  return t;
})();

/** `! - . _ ~ ' ( ) *` 与字母数字不转义（querystring 用的那张表，**~ 不转义**） */
const qsNoEscape = (function () {
  const t = new Uint8Array(128);
  const keep = "!-._~'()*";
  for (let i = 48; i <= 57; i++) t[i] = 1;
  for (let i = 65; i <= 90; i++) t[i] = 1;
  for (let i = 97; i <= 122; i++) t[i] = 1;
  for (let i = 0; i < keep.length; i++) t[keep.charCodeAt(i)] = 1;
  return t;
})();

/**
 * `encodeStr`（internal/querystring.js:45 的逐行移植）。
 * 为什么不用 `encodeURIComponent`：它不转义 `!'()*`，而 Node 的表要转义（`%21%27%28%29*` 里
 * 只有 `*` 保留）；且它对孤立代理项抛 URIError，而 Node 这里也是抛，但抛的是 ERR_INVALID_URI。
 */
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
    ++i;
    if (i >= len) throw invalidUri();
    const c2 = str.charCodeAt(i) & 0x3ff;
    lastPos = i + 1;
    c = 0x10000 + (((c & 0x3ff) << 10) | c2);
    out += table[0xf0 | (c >> 18)] + table[0x80 | ((c >> 12) & 0x3f)] + table[0x80 | ((c >> 6) & 0x3f)] + table[0x80 | (c & 0x3f)];
  }
  if (lastPos === 0) return str;
  if (lastPos < len) return out + str.slice(lastPos);
  return out;
}

/** `querystring.escape`（= encodeURIComponent + `!'()*` 也转义） */
function qsEscape(str) {
  if (typeof str !== 'string') str = typeof str === 'object' ? String(str) : str + '';
  return encodeStr(str, qsNoEscape, hexTable);
}

/** 是否含**完整**的 `%HH`——只有含它才需要解码（Node 的 keyEncoded/valEncoded 扫描标志等价物） */
function hasPercentHex(s) {
  for (let i = 0; i + 2 < s.length; i++) {
    if (s.charCodeAt(i) === 37) {
      const hi = s.charCodeAt(i + 1);
      const lo = s.charCodeAt(i + 2);
      if (hi < 128 && lo < 128 && unhexTable[hi] >= 0 && unhexTable[lo] >= 0) return true;
    }
  }
  return false;
}

/**
 * `decodeURIComponent` 的安全回退（internal/querystring.js `unescapeBuffer` 的等价物）。
 *
 * 为什么需要：`%E4` 这种"是合法转义、但不是合法 UTF-8"的输入会让 `decodeURIComponent` 抛错，
 * Node 这时退回**字节级**解码再按 UTF-8 读——结果是 U+FFFD。少了这条回退，
 * `url.parse('http://x/?a=%E4', true).query.a` 会抛错而 Node 给替换字符。
 * UTF-8 那一步必须交给 `./node-buffer.js`（替换字符的边角语义在宿主）。
 */
function percentDecodeFallback(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 37 && i + 2 < s.length) {
      const hi = s.charCodeAt(i + 1);
      const lo = s.charCodeAt(i + 2);
      if (hi < 128 && lo < 128 && unhexTable[hi] >= 0 && unhexTable[lo] >= 0) {
        bytes.push(unhexTable[hi] * 16 + unhexTable[lo]);
        i += 2;
        continue;
      }
    }
    bytes.push(c & 0xff); // Node 往字节缓冲里写的是 charCode 的低 8 位
  }
  return Buffer.from(bytes).toString('utf8');
}

function qsDecodeStr(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return percentDecodeFallback(s);
  }
}

/** `querystring.parse`：null 原型对象、重复键变数组、最多 1000 对、空段跳过 */
function qsParse(qs) {
  const obj = { __proto__: null };
  if (typeof qs !== 'string' || qs.length === 0) return obj;
  let pairs = 1000;
  const parts = qs.split('&');
  const last = parts.length - 1;
  for (let idx = 0; idx <= last; idx++) {
    const part = parts[idx];
    if (part === '') {
      if (idx === last) break; // 末尾的空段（`a=1&`）不算一对，也不消耗配额
      if (--pairs === 0) return obj;
      continue;
    }
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawVal = eq === -1 ? '' : part.slice(eq + 1);
    let key = rawKey.split('+').join(' ');
    let value = rawVal.split('+').join(' ');
    // 空串不解码（Node: `key.length > 0 && keyEncoded`）——`=b` 的键要原样留在 '' 上
    if (key.length > 0 && hasPercentHex(rawKey)) key = qsDecodeStr(key);
    if (value.length > 0 && hasPercentHex(rawVal)) value = qsDecodeStr(value);
    const cur = obj[key];
    if (cur === undefined) obj[key] = value;
    else if (Array.isArray(cur)) cur[cur.length] = value;
    else obj[key] = [cur, value];
    if (--pairs === 0) return obj;
  }
  return obj;
}

/** `querystring.stringify` 的值转换（querystring.js:195 `encodeStringified`）：非标量一律 '' */
function qsEncodeValue(v) {
  if (typeof v === 'string') return v.length ? qsEscape(v) : '';
  if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v) < 1e21 ? '' + v : qsEscape('' + v);
  if (typeof v === 'bigint') return '' + v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
}

function qsStringify(obj) {
  if (obj === null || typeof obj !== 'object') return '';
  const keys = Object.keys(obj);
  let fields = '';
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = obj[k];
    const ks = qsEncodeValue(k) + '=';
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      if (fields) fields += '&';
      for (let j = 0; j < v.length; j++) {
        if (j) fields += '&';
        fields += ks + qsEncodeValue(v[j]);
      }
    } else {
      if (fields) fields += '&';
      fields += ks + qsEncodeValue(v);
    }
  }
  return fields;
}

// ──────────────────────────── legacy Url / parse / format / resolve ────────────────────────────

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

const protocolPattern = /^[a-z0-9.+-]+:/i;
const portPattern = /:[0-9]*$/;
const hostPattern = /^\/\/[^@/]+@[^@/]+/;
const simplePathPattern = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/;

const hostnameMaxLen = 255;

const CHAR_TAB = 9;
const CHAR_LINE_FEED = 10;
const CHAR_CARRIAGE_RETURN = 13;
const CHAR_SPACE = 32;
const CHAR_DOUBLE_QUOTE = 34;
const CHAR_HASH = 35;
const CHAR_PERCENT = 37;
const CHAR_SINGLE_QUOTE = 39;
const CHAR_FORWARD_SLASH = 47;
const CHAR_COLON = 58;
const CHAR_SEMICOLON = 59;
const CHAR_LEFT_ANGLE_BRACKET = 60;
const CHAR_RIGHT_ANGLE_BRACKET = 62;
const CHAR_QUESTION_MARK = 63;
const CHAR_AT = 64;
const CHAR_LEFT_SQUARE_BRACKET = 91;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_RIGHT_SQUARE_BRACKET = 93;
const CHAR_CIRCUMFLEX_ACCENT = 94;
const CHAR_GRAVE_ACCENT = 96;
const CHAR_LEFT_CURLY_BRACKET = 123;
const CHAR_VERTICAL_LINE = 124;
const CHAR_RIGHT_CURLY_BRACKET = 125;
const CHAR_NO_BREAK_SPACE = 160;
const CHAR_ZERO_WIDTH_NOBREAK_SPACE = 0xfeff;

/** 允许"不安全/不明智"字符的协议（internal/url.js:113） */
const unsafeProtocol = new Set(['javascript', 'javascript:']);
/** 永远没有主机名的协议（internal/url.js:118） */
const hostlessProtocol = new Set(['javascript', 'javascript:']);
/** 一定含 `//` 的协议（internal/url.js:123） */
const slashedProtocol = new Set([
  'http', 'http:', 'https', 'https:', 'ftp', 'ftp:', 'gopher', 'gopher:', 'file', 'file:', 'ws', 'ws:', 'wss', 'wss:',
]);

function isIpv6Hostname(hostname) {
  return hostname.charCodeAt(0) === CHAR_LEFT_SQUARE_BRACKET && hostname.charCodeAt(hostname.length - 1) === CHAR_RIGHT_SQUARE_BRACKET;
}

// 见 url.js:161-175 的长注释：这是"禁止主机码点"与 parse 的 host 扫描字符的**交集**再加三个
// （`:` 防协议伪造、`@` 防 auth 混淆、`[]` 防被 isIpv6Hostname 误判），用来兜住 IDNA 的欺骗面。
const forbiddenHostChars = /[\0\t\n\r #%/:<>?@[\\\]^|]/;
const forbiddenHostCharsIpv6 = /[\0\t\n\r #%/<>?@\\^|]/;

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url instanceof Url) return url;
  const urlObject = new Url();
  urlObject.parse(url, parseQueryString, slashesDenoteHost);
  return urlObject;
}

Url.prototype.parse = function parse(url, parseQueryString, slashesDenoteHost) {
  assertString(url, 'url');
  const self = this;

  // 反斜杠在查询串之前一律当正斜杠（Chrome/IE/Opera 的历史行为，url.js:180）
  let hasHash = false;
  let hasAt = false;
  let start = -1;
  let end = -1;
  let rest = '';
  let lastPos = 0;
  for (let i = 0, inWs = false, split = false; i < url.length; ++i) {
    const code = url.charCodeAt(i);
    const isWs = code < 33 || code === CHAR_NO_BREAK_SPACE || code === CHAR_ZERO_WIDTH_NOBREAK_SPACE;
    if (start === -1) {
      if (isWs) continue;
      lastPos = start = i;
    } else if (inWs) {
      if (!isWs) {
        end = -1;
        inWs = false;
      }
    } else if (isWs) {
      end = i;
      inWs = true;
    }

    if (!split) {
      switch (code) {
        case CHAR_AT:
          hasAt = true;
          break;
        case CHAR_HASH:
          hasHash = true;
        // fall through
        case CHAR_QUESTION_MARK:
          split = true;
          break;
        case CHAR_BACKWARD_SLASH:
          if (i - lastPos > 0) rest += url.slice(lastPos, i);
          rest += '/';
          lastPos = i + 1;
          break;
      }
    } else if (!hasHash && code === CHAR_HASH) {
      hasHash = true;
    }
  }

  if (start !== -1) {
    if (lastPos === start) {
      if (end === -1) rest = start === 0 ? url : url.slice(start);
      else rest = url.slice(start, end);
    } else if (end === -1 && lastPos < url.length) {
      rest += url.slice(lastPos);
    } else if (end !== -1 && lastPos < end) {
      rest += url.slice(lastPos, end);
    }
  }

  if (!slashesDenoteHost && !hasHash && !hasAt) {
    const simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        this.query = parseQueryString ? qsParse(this.search.slice(1)) : this.search.slice(1);
      } else if (parseQueryString) {
        this.search = null;
        this.query = { __proto__: null };
      }
      return this;
    }
  }

  let proto = protocolPattern.exec(rest);
  let lowerProto;
  if (proto) {
    proto = proto[0];
    lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.slice(proto.length);
  }

  let slashes;
  if (slashesDenoteHost || proto || hostPattern.test(rest)) {
    slashes = rest.charCodeAt(0) === CHAR_FORWARD_SLASH && rest.charCodeAt(1) === CHAR_FORWARD_SLASH;
    if (slashes && !(proto && hostlessProtocol.has(lowerProto))) {
      rest = rest.slice(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol.has(lowerProto) && (slashes || (proto && !slashedProtocol.has(proto)))) {
    // 有主机名：第一个 `/`、`?`、`;`、`#` 结束主机段
    let hostEnd = -1;
    let atSign = -1;
    let nonHost = -1;
    for (let i = 0; i < rest.length; ++i) {
      switch (rest.charCodeAt(i)) {
        case CHAR_TAB:
        case CHAR_LINE_FEED:
        case CHAR_CARRIAGE_RETURN:
          // WHATWG URL 会把 tab/换行/回车删掉，这里照做
          rest = rest.slice(0, i) + rest.slice(i + 1);
          i -= 1;
          break;
        case CHAR_SPACE:
        case CHAR_DOUBLE_QUOTE:
        case CHAR_PERCENT:
        case CHAR_SINGLE_QUOTE:
        case CHAR_SEMICOLON:
        case CHAR_LEFT_ANGLE_BRACKET:
        case CHAR_RIGHT_ANGLE_BRACKET:
        case CHAR_BACKWARD_SLASH:
        case CHAR_CIRCUMFLEX_ACCENT:
        case CHAR_GRAVE_ACCENT:
        case CHAR_LEFT_CURLY_BRACKET:
        case CHAR_VERTICAL_LINE:
        case CHAR_RIGHT_CURLY_BRACKET:
          if (nonHost === -1) nonHost = i;
          break;
        case CHAR_HASH:
        case CHAR_FORWARD_SLASH:
        case CHAR_QUESTION_MARK:
          if (nonHost === -1) nonHost = i;
          hostEnd = i;
          break;
        case CHAR_AT:
          atSign = i;
          nonHost = -1;
          break;
      }
      if (hostEnd !== -1) break;
    }
    start = 0;
    if (atSign !== -1) {
      this.auth = decodeURIComponent(rest.slice(0, atSign));
      start = atSign + 1;
    }
    if (nonHost === -1) {
      this.host = rest.slice(start);
      rest = '';
    } else {
      this.host = rest.slice(start, nonHost);
      rest = rest.slice(nonHost);
    }

    this.parseHost();

    // 既然已经认定"有主机名"，那它就必须存在（哪怕是空串）
    if (typeof this.hostname !== 'string') this.hostname = '';
    const hostname = this.hostname;
    const ipv6Hostname = isIpv6Hostname(hostname);

    if (!ipv6Hostname) {
      rest = getHostname(this, rest, hostname);
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      this.hostname = this.hostname.toLowerCase();
    }

    if (this.hostname !== '') {
      if (ipv6Hostname) {
        if (forbiddenHostCharsIpv6.test(this.hostname)) throw invalidUrl(url);
      } else {
        // IDNA：宿主代工（`url.domainToASCII` 就是 Node 内部的 toASCII 那条 ICU 路径，
        // 真值表逐条比过：合法域、下划线、大小写、全角、非法 punycode 都一致）。
        this.hostname = domainToASCII(this.hostname);
        // 两条防欺骗：① 变空说明 toASCII 拒了；② 出现禁止字符说明是 toASCII 引进来的
        if (this.hostname === '' || forbiddenHostChars.test(this.hostname)) throw invalidUrl(url);
      }
    }

    const p = this.port ? ':' + this.port : '';
    const h = this.hostname || '';
    this.host = h + p;

    // host 字段保留 `[]`，hostname 去掉
    if (ipv6Hostname) {
      this.hostname = this.hostname.slice(1, -1);
      if (rest[0] !== '/') rest = '/' + rest;
    }
  }

  if (!unsafeProtocol.has(lowerProto)) rest = autoEscapeStr(rest);

  let questionIdx = -1;
  let hashIdx = -1;
  for (let i = 0; i < rest.length; ++i) {
    const code = rest.charCodeAt(i);
    if (code === CHAR_HASH) {
      this.hash = rest.slice(i);
      hashIdx = i;
      break;
    } else if (code === CHAR_QUESTION_MARK && questionIdx === -1) {
      questionIdx = i;
    }
  }

  if (questionIdx !== -1) {
    if (hashIdx === -1) {
      this.search = rest.slice(questionIdx);
      this.query = rest.slice(questionIdx + 1);
    } else {
      this.search = rest.slice(questionIdx, hashIdx);
      this.query = rest.slice(questionIdx + 1, hashIdx);
    }
    if (parseQueryString) this.query = qsParse(this.query);
  } else if (parseQueryString) {
    this.search = null;
    this.query = { __proto__: null };
  }

  const useQuestionIdx = questionIdx !== -1 && (hashIdx === -1 || questionIdx < hashIdx);
  const firstIdx = useQuestionIdx ? questionIdx : hashIdx;
  if (firstIdx === -1) {
    if (rest.length > 0) this.pathname = rest;
  } else if (firstIdx > 0) {
    this.pathname = rest.slice(0, firstIdx);
  }
  if (slashedProtocol.has(lowerProto) && this.hostname && !this.pathname) this.pathname = '/';

  // 为 http.request 服务：path = pathname + search
  if (this.pathname || this.search) {
    this.path = (this.pathname || '') + (this.search || '');
  }

  this.href = this.format();
  return this;
};

/**
 * 主机名里的第一个 `/ \ # ? :` 之后都归路径。
 *
 * **与本地 v27 检出不同**：v27 在遇到 `:` 时抛 `ERR_INVALID_ARG_VALUE`（url.js:519-521），
 * v22.22.1（仿真基线）只是把它当路径段——`url.parse('http://x:abc/a').href` 给 `http://x/:abc/a`。
 * 真值表与宿主 v24 都是基线行为，故按基线移植（见文件头边界 3）。
 */
function getHostname(self, rest, hostname) {
  for (let i = 0; i < hostname.length; ++i) {
    const code = hostname.charCodeAt(i);
    const isValid =
      code !== CHAR_FORWARD_SLASH &&
      code !== CHAR_BACKWARD_SLASH &&
      code !== CHAR_HASH &&
      code !== CHAR_QUESTION_MARK &&
      code !== CHAR_COLON;
    if (!isValid) {
      self.hostname = hostname.slice(0, i);
      return `/${hostname.slice(i)}${rest}`;
    }
  }
  return rest;
}

/** `autoEscapeStr` 的转义表（url.js:531-545，空串 = 该字符不转义） */
const escapedCodes = (function () {
  const t = new Array(126);
  for (let i = 0; i < 126; i++) t[i] = '';
  t[9] = '%09';
  t[10] = '%0A';
  t[13] = '%0D';
  t[32] = '%20';
  t[34] = '%22';
  t[39] = '%27';
  t[60] = '%3C';
  t[62] = '%3E';
  t[92] = '%5C';
  t[94] = '%5E';
  t[96] = '%60';
  t[123] = '%7B';
  t[124] = '%7C';
  t[125] = '%7D';
  return t;
})();

/** 自动转义 RFC 2396 里的分隔符与"不明智"字符；单引号也转（防 XSS） */
function autoEscapeStr(rest) {
  let escaped = '';
  let lastEscapedPos = 0;
  for (let i = 0; i < rest.length; ++i) {
    const escapedChar = escapedCodes[rest.charCodeAt(i)];
    if (escapedChar) {
      if (i > lastEscapedPos) escaped += rest.slice(lastEscapedPos, i);
      escaped += escapedChar;
      lastEscapedPos = i + 1;
    }
  }
  if (lastEscapedPos === 0) return rest;
  if (lastEscapedPos < rest.length) escaped += rest.slice(lastEscapedPos);
  return escaped;
}

/** 这些字符在 auth 段不必转义：`! - . _ ~ ' ( ) * :` 与字母数字（url.js:617-632） */
const noEscapeAuth = (function () {
  const t = new Uint8Array(128);
  const keep = "!-._~'()*:";
  for (let i = 48; i <= 57; i++) t[i] = 1;
  for (let i = 65; i <= 90; i++) t[i] = 1;
  for (let i = 97; i <= 122; i++) t[i] = 1;
  for (let i = 0; i < keep.length; i++) t[keep.charCodeAt(i)] = 1;
  return t;
})();

Url.prototype.format = function format() {
  let auth = this.auth || '';
  if (auth) {
    auth = encodeStr(auth, noEscapeAuth, hexTable);
    auth += '@';
  }

  let protocol = this.protocol || '';
  if (protocol && protocol.charCodeAt(protocol.length - 1) !== CHAR_COLON) protocol += ':';

  let pathname = this.pathname || '';
  let hash = this.hash || '';
  let host = '';
  let query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (this.hostname.indexOf(':') !== -1 && !isIpv6Hostname(this.hostname) ? '[' + this.hostname + ']' : this.hostname);
    if (this.port) host += ':' + this.port;
  }

  if (this.query !== null && typeof this.query === 'object') query = qsStringify(this.query);
  let search = this.search || (query && '?' + query) || '';

  // pathname 里的 `#` / `?` 必须先转义，否则拼出来的 href 会被重新解析成别的结构
  if (pathname.indexOf('#') !== -1 || pathname.indexOf('?') !== -1) {
    let newPathname = '';
    let lastPos = 0;
    for (let i = 0; i < pathname.length; i++) {
      const code = pathname.charCodeAt(i);
      if (code === CHAR_HASH || code === CHAR_QUESTION_MARK) {
        if (i > lastPos) newPathname += pathname.slice(lastPos, i);
        newPathname += code === CHAR_HASH ? '%23' : '%3F';
        lastPos = i + 1;
      }
    }
    if (lastPos < pathname.length) newPathname += pathname.slice(lastPos);
    pathname = newPathname;
  }

  // 只有 slashedProtocol 才拿得到 `//`（mailto:/xmpp: 不给），除非它本来就有
  if (this.slashes || slashedProtocol.has(protocol)) {
    if (this.slashes || host) {
      if (pathname && pathname.charCodeAt(0) !== CHAR_FORWARD_SLASH) pathname = '/' + pathname;
      host = '//' + host;
    } else if (
      protocol.length >= 4 &&
      protocol.charCodeAt(0) === 102 /* f */ &&
      protocol.charCodeAt(1) === 105 /* i */ &&
      protocol.charCodeAt(2) === 108 /* l */ &&
      protocol.charCodeAt(3) === 101 /* e */
    ) {
      host = '//';
    }
  }

  if (search.indexOf('#') !== -1) search = search.split('#').join('%23');

  if (hash && hash.charCodeAt(0) !== CHAR_HASH) hash = '#' + hash;
  if (search && search.charCodeAt(0) !== CHAR_QUESTION_MARK) search = '?' + search;

  return protocol + host + pathname + search + hash;
};

/** 格式化：字符串先 parse 一遍（"把歪 URL 洗干净"是它的常见用法） */
function urlFormat(urlObject, options) {
  if (typeof urlObject === 'string') {
    urlObject = urlParse(urlObject);
  } else if (typeof urlObject !== 'object' || urlObject === null) {
    const err = new TypeError('The "urlObject" argument must be one of type object or string. Received ' + (urlObject === null ? 'null' : typeof urlObject + ' (' + String(urlObject) + ')'));
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  } else if (urlObject instanceof URL) {
    // WHATWG 实例走"快照 + 后缀手术"（见 formatUrlViaHost）：`options` 只认
    // fragment / unicode / search / auth 四个开关，Node 的 C++ 也是直接改这四个字段再序列化。
    let fragment = true;
    let unicode = false;
    let search = true;
    let auth = true;
    if (options) {
      if (typeof options !== 'object' || options === null) {
        const err = new TypeError(
          'The "options" argument must be of type object. Received ' + (options === null ? 'null' : typeof options),
        );
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (options.fragment != null) fragment = Boolean(options.fragment);
      if (options.unicode != null) unicode = Boolean(options.unicode);
      if (options.search != null) search = Boolean(options.search);
      if (options.auth != null) auth = Boolean(options.auth);
    }
    return formatUrlViaHost(urlObject.href, fragment, unicode, search, auth);
  }
  return Url.prototype.format.call(urlObject);
}

/**
 * 复刻 C++ 的 `url.format(href, hash, unicode, search, auth)`（node/src/node_url.cc:370）。
 *
 * 三个布尔开关**不自己做字符串手术**，而是走真实的部件 setter（= 宿主的 URL setter）：
 * C++ 那边是 `out->hash = nullopt` / `out->query = nullopt` / `out->username = ""`，
 * 效果等价于赋空——而赋空之后交给宿主序列化，才是规范口径（自己切子串会在
 * `http://x/a?` 这种"search 为空但 href 带 `?`"的形态上留下尾巴）。
 * 唯一不能用 setter 的是 `unicode`：C++ 是 `out->host = to_unicode(...)`，**直接改字段**
 * （绕过解析器，所以不会被 IDNA 转回 punycode），只能做一次定位替换。
 */
function formatUrlViaHost(href, fragment, unicode, search, auth) {
  const u = new URL(href);
  if (!fragment) u.hash = '';
  if (!search) u.search = '';
  if (!auth) {
    u.username = '';
    u.password = '';
  }
  let out = u.href;
  if (unicode && u.hostname) {
    // 权威段从 `//` 之后开始；auth 也在那里，所以要先跳过它。用下标定位而不是 indexOf(子串)：
    // `http://tt/` 里 `indexOf('tt')` 会先命中协议名里的 `tt`。
    const slash = out.indexOf('//');
    const authPart = u.username || u.password ? u.username + (u.password ? ':' + u.password : '') + '@' : '';
    const at = slash === -1 ? -1 : slash + 2 + (out.startsWith(authPart, slash + 2) ? authPart.length : 0);
    if (at !== -1 && out.startsWith(u.hostname, at)) {
      out = out.slice(0, at) + domainToUnicode(u.hostname) + out.slice(at + u.hostname.length);
    }
  }
  return out;
}

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function resolve(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

function spliceOne(list, index) {
  list.splice(index, 1);
}

Url.prototype.resolveObject = function resolveObject(relative) {
  if (typeof relative === 'string') {
    const rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  const result = new Url();
  Object.assign(result, this);

  // hash 永远被覆盖（`href=''` 也会清掉它）
  result.hash = relative.hash;

  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // `//foo/bar` 这类只保留协议
  if (relative.slashes && !relative.protocol) {
    const relativeWithoutProtocol = {};
    for (const key of Object.keys(relative)) {
      if (key !== 'protocol') relativeWithoutProtocol[key] = relative[key];
    }
    Object.assign(result, relativeWithoutProtocol);

    // urlParse 会给 `http://www.example.com` 这样的 URL 补上尾部 `/`
    if (slashedProtocol.has(result.protocol) && result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    if (!slashedProtocol.has(relative.protocol)) {
      Object.assign(result, relative);
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host && !/^file:?$/.test(relative.protocol) && !hostlessProtocol.has(relative.protocol)) {
      const relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      relative.host = relative.host || '';
      relative.hostname = relative.hostname || '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    if (result.pathname || result.search) {
      result.path = (result.pathname || '') + (result.search || '');
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  const isSourceAbs = result.pathname && result.pathname.charAt(0) === '/';
  const isRelAbs = relative.host || (relative.pathname && relative.pathname.charAt(0) === '/');
  let mustEndAbs = isRelAbs || isSourceAbs || (result.host && relative.pathname);
  const removeAllDots = mustEndAbs;
  let srcPath = (result.pathname && result.pathname.split('/')) || [];
  const relPath = (relative.pathname && relative.pathname.split('/')) || [];
  const noLeadingSlashes = result.protocol && !slashedProtocol.has(result.protocol);

  if (noLeadingSlashes) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      result.auth = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    if (relative.host || relative.host === '') {
      if (result.host !== relative.host) result.auth = null;
      result.host = relative.host;
      result.port = relative.port;
    }
    if (relative.hostname || relative.hostname === '') {
      if (result.hostname !== relative.hostname) result.auth = null;
      result.hostname = relative.hostname;
    }
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
  } else if (relPath.length) {
    srcPath = srcPath || [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (relative.search !== null && relative.search !== undefined) {
    if (noLeadingSlashes) {
      result.hostname = result.host = srcPath.shift();
      const authInHost = result.host && result.host.indexOf('@') > 0 && result.host.split('@');
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    if (result.pathname !== null || result.search !== null) {
      result.path = (result.pathname ? result.pathname : '') + (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = result.search ? '/' + result.search : null;
    result.href = result.format();
    return result;
  }

  let last = srcPath[srcPath.length - 1];
  const hasTrailingSlash = ((result.host || relative.host || srcPath.length > 1) && (last === '.' || last === '..')) || last === '';

  let up = 0;
  for (let i = srcPath.length - 1; i >= 0; i--) {
    last = srcPath[i];
    if (last === '.') {
      spliceOne(srcPath, i);
    } else if (last === '..') {
      spliceOne(srcPath, i);
      up++;
    } else if (up) {
      spliceOne(srcPath, i);
      up--;
    }
  }

  if (!mustEndAbs && !removeAllDots) {
    while (up--) srcPath.unshift('..');
  }

  if (mustEndAbs && srcPath[0] !== '' && (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  const joined = srcPath.join('/');
  if (hasTrailingSlash && joined.charAt(joined.length - 1) !== '/') {
    srcPath.push('');
  }

  const isAbsolute = srcPath[0] === '' || (srcPath[0] && srcPath[0].charAt(0) === '/');

  if (noLeadingSlashes) {
    result.hostname = result.host = isAbsolute ? '' : srcPath.length ? srcPath.shift() : '';
    const authInHost = result.host && result.host.indexOf('@') > 0 ? result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) srcPath.unshift('');

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  if (result.pathname !== null || result.search !== null) {
    result.path = (result.pathname ? result.pathname : '') + (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function parseHost() {
  let host = this.host;
  let port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ':') this.port = port.slice(1);
    host = host.slice(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

// ──────────────────────────── 文件 URL（POSIX 基线）────────────────────────────
//
// 移植 internal/url.js:1494-1719 的 **posix 分支**。为什么固定 posix 而不是跟随宿主：
// 与 node-path.js 同一取向——开发机是 Windows 也要得到确定结果；再说插件的文件都落在
// 数据目录里，那是 POSIX 路径。

/** `path.posix.resolve` 的等价物，兜底用沙箱的 cwd（= 数据目录，见 node-process.js） */
function posixResolve(filepath) {
  let resolved = '';
  let absolute = false;
  for (let i = 0; i >= -1 && !absolute; i--) {
    const seg = i >= 0 ? filepath : CWD;
    if (seg.length === 0) continue;
    resolved = seg + '/' + resolved;
    absolute = seg.charCodeAt(0) === CHAR_FORWARD_SLASH;
  }
  const out = [];
  for (const part of resolved.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else {
      out.push(part);
    }
  }
  const body = out.join('/');
  if (absolute) return body.length > 0 ? '/' + body : '/';
  return body.length > 0 ? body : '.';
}

/**
 * `file://` + 逐字节转义（node/src/node_url.cc:162 `EncodePathChars` 的等价物）。
 *
 * 为什么必须自己转义再交给宿主：宿主 `new URL('file:///a~b')` 不会把 `~` 编成 `%7E`，
 * 而 Node 的 `pathToFileURL('/a~b')` 给的就是 `%7E`——这 15 个字符（含 `%` 自身）
 * 是"预转义表"补的，剩下的（非 ASCII、0x7F）交给宿主解析器按 URL 规范编码，两边合起来才等价。
 * 真值表逐字符比过 0x01–0x7F。
 */
const FILE_URL_PRE_ESCAPE = (function () {
  const t = new Array(128);
  const singles = ' "#%<>?[\\]^`{|}~';
  for (let i = 0; i < 128; i++) t[i] = '';
  for (let i = 0; i < 0x20; i++) t[i] = hexTable[i];
  t[0x7f] = hexTable[0x7f];
  for (let i = 0; i < singles.length; i++) {
    const c = singles.charCodeAt(i);
    t[c] = hexTable[c];
  }
  return t;
})();

function encodeFilePathForUrl(resolved) {
  // `'file://' + path` 只有在 path 以 `/` 开头时才构成规范的 `file:///…`。
  // 生产（Linux）下 cwd 一定是 `/` 开头，所以这一行永不需要；它只兜住"开发机是 Windows、
  // 于是 dataDir 是 `C:\…`"这种基线不一致的形态：不兜的话拼出来是 `file://C%3A%5C…`，
  // 宿主的 URL 解析器会因为主机名里出现 `%` 而直接拒（ERR_INVALID_URL）。
  const abs = resolved.charCodeAt(0) === 47 ? resolved : '/' + resolved;
  let out = 'file://';
  for (let i = 0; i < abs.length; i++) {
    const c = abs.charCodeAt(i);
    if (c < 128) {
      const esc = FILE_URL_PRE_ESCAPE[c];
      out += esc === '' ? abs.charAt(i) : esc;
    } else {
      out += abs.charAt(i); // 非 ASCII 交给宿主解析器（按 URL 规范逐字节编码）
    }
  }
  return out;
}

function pathToFileURL(filepath) {
  assertString(filepath, 'path');
  const resolved = posixResolve(filepath);
  // `path.resolve` 会吃掉尾部斜杠，Node 在这里补回来（`pathToFileURL('/tmp/dir/')` → `.../dir/`）
  const lastCode = filepath.charCodeAt(filepath.length - 1);
  const withSlash = lastCode === CHAR_FORWARD_SLASH && resolved.charAt(resolved.length - 1) !== '/' ? resolved + '/' : resolved;
  return new URL(encodeFilePathForUrl(withSlash));
}

/** Node 的 `isURL` 形状判断（internal/url.js:844）：跨实现也能认，比 `instanceof` 稳 */
function isURL(value) {
  return Boolean(value && value.href && value.protocol && value.auth === undefined && value.path === undefined);
}

function toUrlForFilePath(path) {
  if (typeof path === 'string') return new URL(path); // 宿主解析：不合法 → ERR_INVALID_URL（与 Node 同）
  if (!isURL(path)) throw invalidArgType('path', ['string', 'URL'], path);
  return path;
}

function assertFileScheme(u) {
  if (u.protocol !== 'file:') throw invalidUrlScheme('file');
}

function getPathFromURLPosix(u) {
  if (u.hostname !== '') throw invalidFileUrlHost();
  const pathname = u.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] === '%') {
      const third = pathname.charCodeAt(n + 2) | 0x20;
      if (pathname[n + 1] === '2' && third === 102) {
        throw invalidFileUrlPath('must not include encoded / characters');
      }
    }
  }
  // 快路径：没有百分号就不必 decodeURIComponent（同 Node）
  return pathname.indexOf('%') !== -1 ? decodeURIComponent(pathname) : pathname;
}

/**
 * `options.windows` 是 Node 提供的逃生门（在 Linux 上按 Windows 规则解析文件 URL）。
 * 仿真的路径语义固定 POSIX（见文件头边界 1），做不到就**响亮抛错**——
 * 静默按 posix 处理会让调用方拿到一个看起来对、实际是另一种语义的路径。
 */
function assertPosixOnly(options) {
  if (options && options.windows === true) {
    const err = new Error(
      'fileURLToPath({ windows: true }) is not supported in the sandbox (the sandbox path semantics are fixed to POSIX)',
    );
    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
    throw err;
  }
}

function fileURLToPath(path, options) {
  const u = toUrlForFilePath(path);
  assertFileScheme(u);
  assertPosixOnly(options);
  return getPathFromURLPosix(u);
}

/**
 * 百分号解码成**字节**（不是字符串）：`fileURLToPathBuffer` 要保留非 UTF-8 的原始字节。
 * `%2F` 在这里**不报错**——Node 的 buffer 变体刻意不扫斜杠转义（internal/url.js:1622-1642 的长注释）。
 *
 * `Buffer.from(pathname, 'utf8')` 这一步有个**快路径**：URL 序列化后的 pathname 一定只有 ASCII
 * （非 ASCII 早被解析器编成 `%XX` 了），此时"UTF-8 字节"就是逐字符的 charCode，
 * 不必过桥。为什么在意：`bytes.encode` 是 node:buffer 的权限点，而 `url.*` 只该吃
 * `url.parse`/`url.encode`——为了一个恒等于 charCode 的转换去要另一个权限点不划算。
 */
function percentDecodeToBuffer(pathname) {
  let ascii = true;
  for (let i = 0; i < pathname.length; i++) {
    if (pathname.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }
  const utf8 = ascii ? pathname : Buffer.from(pathname, 'utf8');
  const bytes = [];
  for (let i = 0; i < utf8.length; i++) {
    const c = ascii ? utf8.charCodeAt(i) : utf8[i];
    if (c === 37 && i + 2 < utf8.length) {
      const hi = ascii ? utf8.charCodeAt(i + 1) : utf8[i + 1];
      const lo = ascii ? utf8.charCodeAt(i + 2) : utf8[i + 2];
      if (hi < 128 && lo < 128 && unhexTable[hi] >= 0 && unhexTable[lo] >= 0) {
        bytes.push(unhexTable[hi] * 16 + unhexTable[lo]);
        i += 2;
        continue;
      }
    }
    bytes.push(c);
  }
  return Buffer.from(bytes);
}

function fileURLToPathBuffer(path, options) {
  const u = toUrlForFilePath(path);
  assertFileScheme(u);
  assertPosixOnly(options);
  if (u.hostname !== '') throw invalidFileUrlHost();
  return percentDecodeToBuffer(u.pathname);
}

// ──────────────────────────── 其余导出面 ────────────────────────────

function domainToASCII(domain) {
  if (arguments.length < 1) throw missingArgs('domain');
  return hostCall1('url.domainToASCII', `${domain}`);
}

function domainToUnicode(domain) {
  if (arguments.length < 1) throw missingArgs('domain');
  return hostCall1('url.domainToUnicode', `${domain}`);
}

/**
 * `urlToHttpOptions`（internal/url.js:1469）。
 *
 * 关键点：**先铺开入参对象**（`...url`，Node 注释是"In case the url object was extended by the user"），
 * 再覆盖计算出来的字段——所以对普通对象调用时，它自带的 `username`/`password`/`port` 会留在结果里。
 * 原型是 `null`（`{ __proto__: null }`），与 Node 一致：避免 `options.constructor` 之类被原型链污染。
 */
function urlToHttpOptions(url) {
  if (typeof url !== 'object' && typeof url !== 'function') {
    throw invalidArgType('url', ['object'], url);
  }
  if (url === null) throw invalidArgType('url', ['object'], url);
  const hostname = url.hostname;
  const pathname = url.pathname;
  const port = url.port;
  const username = url.username;
  const password = url.password;
  const search = url.search;
  const options = {
    __proto__: null,
    ...url,
    protocol: url.protocol,
    hostname: hostname && hostname[0] === '[' ? hostname.slice(1, -1) : hostname,
    hash: url.hash,
    search: search,
    pathname: pathname,
    path: `${pathname || ''}${search || ''}`,
    href: url.href,
  };
  if (port !== '') options.port = Number(port);
  if (username || password) {
    options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
  }
  return options;
}

export {
  URL,
  URLSearchParams,
  Url,
  domainToASCII,
  domainToUnicode,
  fileURLToPath,
  fileURLToPathBuffer,
  pathToFileURL,
  urlFormat as format,
  urlParse as parse,
  urlResolve as resolve,
  urlResolveObject as resolveObject,
  urlToHttpOptions,
};

export default {
  URL,
  URLSearchParams,
  Url,
  domainToASCII,
  domainToUnicode,
  fileURLToPath,
  fileURLToPathBuffer,
  format: urlFormat,
  parse: urlParse,
  pathToFileURL,
  resolve: urlResolve,
  resolveObject: urlResolveObject,
  urlToHttpOptions,
};
