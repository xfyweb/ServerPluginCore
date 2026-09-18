// node:path 仿真——**POSIX 语义**
//
// 为什么固定 posix（而不是跟着宿主平台走）：
//   · ROADMAP「明确不做（现阶段）」写明 Windows 部署是 v1.x 目标，当前部署面是 Linux；
//   · 固定语义让**开发机是 Windows 也能得到确定结果**——测试比的是 `node:path.posix`，
//     不会出现"我机器上绿、CI 上红"。
//   · 代价：若将来部署到 Windows，`path.win32` 需要真实现（现在是明确抛错，不静默假装）。
//
// **一处与 Node 的差别（原来是"故意用虚拟根 /"，现已改为按沙箱 cwd 解析）**：
// `posixResolve()` 的兜底基准 = **沙箱 cwd（= 插件数据目录，`__spcEnv.dataDir`）**，与 `process.cwd()`、
// 以及 fs 层"相对路径按数据目录解析"三者同源。取值失败（宿主 realm 里跑单测、没有 `__spcEnv`）回退 `/`。
//
// 为什么改：虚拟根 `/` 会让 `path.resolve('out/a')` 得到 `/out/a`，再交给 fs 就是**作用域外** →
// EACCES。真实依赖正是这么写的——`mkdirp/dist/mjs/path-arg.js:11` 就是 `path = resolve(path)`，
// 于是 `mkdirp.sync('out/a/b/c')` 直接 EACCES（实测：`_audit/dep-smoke.mts`）。
// 已知边界：Windows 开发机上数据目录是 `D:\…` 形态，这里统一换成 `/` 分隔（`D:/…`）让 POSIX 的
// `dirname`/`join`/`..` 都能用；但 `posixIsAbsolute('D:/…')` 仍按 POSIX 语义给 **false**（不认盘符）。
// Linux 上（部署目标）完全自洽。
//
// 内联约束：静态、无占位符，可被构建层直接打进插件产物。
import * as win32Fns from './node-path-win32.js';

const SLASH = 47; // '/'
const DOT = 46; // '.'
const COLON = 58; // ':'（盘符分隔符，见 `isDriveAbsolute`）

/**
 * 沙箱 cwd = 数据目录（与 `process.cwd()`、fs 的相对路径解析同一个出处）。
 *
 * **每次都读**（不缓存）：`loadShimFresh` 类测试会换 `__spcEnv` 再重新 import，缓存住会让它读到旧值
 * （实测：`resolve('a.txt')` 回 `/a.txt` 而不是数据目录下的路径）。
 * 代价是一次 `JSON.parse` —— 相对路径解析不是热路径上的热环节，而"读错了 cwd"是最难查的一类错。
 */
function cwd() {
  let dir = '/';
  try {
    const env = JSON.parse(globalThis.__spcEnv);
    if (env && typeof env.dataDir === 'string' && env.dataDir.length > 0) dir = env.dataDir;
  } catch {
    dir = '/';
  }
  // 形态按 **posix** 归一（这个函数是 posix 原语的兜底基准，POSIX 算法只认 `/`）；
  // win32 那边在 `node-path-win32.js` 里自己换成 `\`
  return dir.indexOf('\\') === -1 ? dir : dir.split('\\').join('/');
}

/**
 * win32 实现要的 cwd：与 posix 的 `cwd()` **同一来源**（`__spcEnv.dataDir`），只是形态换成 `\`。
 *
 * 为什么必须同源：两个实现都会用 cwd 兜底相对路径。若各自按不同来源解析，
 * `path.resolve('a')` 与 `path.win32.resolve('a')` 在同一个沙箱里可能落在**不同的盘/目录**上。
 */
export function __cwd() {
  return cwd();
}

function assertPath(value, name) {
  if (typeof value !== 'string') {
    const err = new TypeError(
      'The "' + name + '" argument must be of type string. Received ' +
        (value === null ? 'null' : typeof value),
    );
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
}

/** 按段规整：去掉空段与 `.`，处理 `..`（allowAboveRoot=false 时丢弃越过根的部分） */
function normalizeParts(path, allowAboveRoot) {
  const out = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (allowAboveRoot) out.push('..');
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

function posixNormalize(path) {
  assertPath(path, 'path');
  if (path.length === 0) return '.';
  const absolute = path.charCodeAt(0) === SLASH;
  const trailing = path.charCodeAt(path.length - 1) === SLASH;
  const body = normalizeParts(path, !absolute);
  if (body.length === 0) {
    if (absolute) return '/';
    return trailing ? './' : '.';
  }
  const result = absolute ? '/' + body : body;
  return trailing ? result + '/' : result;
}

/**
 * `isAbsolute`：`/x` **或** `C:/x`（盘符形态）。
 *
 * 为什么 posix 口径也要认盘符：`resolve()`/`process.cwd()`/fs 的相对路径解析**共用同一个 cwd**，
 * 而那个 cwd 在 Windows 宿主上是 `C:/Users/…`。不认盘符就会出现
 * "`isAbsolute(cwd())` 为 false 而 `resolve()` 拿它当相对路径"这种自相矛盾（实测后果见 `resolve` 注释）。
 * Linux 部署（目标环境）上 cwd 是 `/…`，这条分支永远不触发 ⇒ 对齐测试不受影响。
 */
function posixIsAbsolute(path) {
  assertPath(path, 'path');
  return path.length > 0 && (path.charCodeAt(0) === SLASH || isDriveAbsolute(path));
}

function posixJoin(...args) {
  if (args.length === 0) return '.';
  let joined;
  for (const arg of args) {
    assertPath(arg, 'path');
    if (arg.length === 0) continue;
    joined = joined === undefined ? arg : joined + '/' + arg;
  }
  if (joined === undefined) return '.';
  return posixNormalize(joined);
}

/**
 * `C:/…` 这种**盘符绝对路径**也算绝对（见 `isAbsolute` 的说明）。
 *
 * ⚠️ 这条不是"为了兼容 Windows 顺手加的"，而是**自洽性要求**：`process.cwd()`（= 数据目录）在
 * Windows 宿主机上就是 `C:/Users/…` 这个形态，如果 `resolve` 不认它是绝对路径，就会把 cwd 再拼一次：
 * `posixResolve('C:/Users/x/tree')` → `C:/Users/x/C:/Users/x/tree`（**实测**，见 `_audit/diag-fastglob.mts`）。
 * 后果是真实依赖（`fast-glob` 拿 `path.posixResolve(task.base)` 当 glob base）算出错误的 base ⇒ 一个条目都匹配不到，
 * 而且**不报错、只给空结果**。
 *
 * 判定与 `node:path` 的 win32 版一致：`/^[A-Za-z]:/`（盘符后跟不跟 `/` 都算，`C:` 也算）。
 */
function isDriveAbsolute(path) {
  if (path.length < 2 || path.charCodeAt(1) !== COLON) return false;
  const c = path.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** 取路径的根（`'/'` 或 `'C:'`；没有根返回 `''`） */
function pathRoot(path) {
  if (path.charCodeAt(0) === SLASH) return '/';
  if (isDriveAbsolute(path)) return path.slice(0, 2);
  return '';
}

function posixResolve(...args) {
  let resolved = '';
  let absoluteRoot = '';
  // 从最后一个参数往前拼，遇到绝对路径就停（Node 的语义）
  for (let i = args.length - 1; i >= -1 && absoluteRoot === ''; i--) {
    const seg = i >= 0 ? args[i] : cwd();
    if (i >= 0) assertPath(seg, 'path');
    if (seg.length === 0) continue;
    resolved = seg + '/' + resolved;
    // 根单独留着：盘符在 `normalizeParts` 眼里只是一个普通段（`'C:'`），
    // 不摘掉就会得到 `C:/C:/Users/…` —— 这个不一致正是本轮踩到的坑
    absoluteRoot = pathRoot(seg);
  }
  // ⚠️ 盘符根必须**先摘掉再规整**：`normalizeParts` 不认识盘符，会把它当成一个普通段留着
  const forNormalize = absoluteRoot !== '' && absoluteRoot !== '/' && resolved.startsWith(absoluteRoot)
    ? resolved.slice(absoluteRoot.length)
    : resolved;
  const body = normalizeParts(forNormalize, absoluteRoot === '');
  if (absoluteRoot !== '') {
    // 根是 `/` 时 body 已经不含前导斜杠 ⇒ 直接拼；否则补一个斜杠
    return absoluteRoot === '/' ? '/' + body : body.length > 0 ? absoluteRoot + '/' + body : absoluteRoot + '/';
  }
  return body.length > 0 ? body : '.';
}

function posixDirname(path) {
  assertPath(path, 'path');
  if (path.length === 0) return '.';
  const hasRoot = path.charCodeAt(0) === SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? '/' : '.';
  // Node 的历史怪癖：`posixDirname('/foo')` 仍有 root 时返回 `//`
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}

function posixBasename(path, ext) {
  assertPath(path, 'path');
  if (ext !== undefined) assertPath(ext, 'ext');
  let start = 0;
  let end = -1;
  let matchedSlash = true;

  if (ext !== undefined && ext.length > 0 && ext.length <= path.length) {
    if (ext === path) return '';
    let extIdx = ext.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === SLASH) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false;
          firstNonSlashEnd = i + 1;
        }
        if (extIdx >= 0) {
          if (code === ext.charCodeAt(extIdx)) {
            if (--extIdx === -1) end = i;
          } else {
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }

  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return '';
  return path.slice(start, end);
}

function posixExtname(path) {
  assertPath(path, 'path');
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;

  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === SLASH) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (code === DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }

  if (
    startDot === -1 ||
    end === -1 ||
    preDotState === 0 ||
    // 形如 `.` / `..` 的整名是"全是点"，不算扩展名
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    return '';
  }
  return path.slice(startDot, end);
}

function posixParse(path) {
  assertPath(path, 'path');
  const result = { root: '', dir: '', base: '', ext: '', name: '' };
  if (path.length === 0) return result;
  const absolute = path.charCodeAt(0) === SLASH;
  const start = absolute ? 1 : 0;
  if (absolute) result.root = '/';

  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;

  for (let i = path.length - 1; i >= start; --i) {
    const code = path.charCodeAt(i);
    if (code === SLASH) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (code === DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }

  if (end !== -1) {
    const baseStart = startPart === 0 && absolute ? 1 : startPart;
    if (
      startDot === -1 ||
      preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    ) {
      result.base = result.name = path.slice(baseStart, end);
    } else {
      result.name = path.slice(baseStart, startDot);
      result.base = path.slice(baseStart, end);
      result.ext = path.slice(startDot, end);
    }
  }
  if (startPart > 0) result.dir = path.slice(0, startPart - 1);
  else if (absolute) result.dir = '/';
  return result;
}

/**
 * `format` 里 ext 的**补点**：Node 的约定是 ext 不带点时自动补一个
 * （`{name:'b', ext:'txt'}` → `b.txt`，`{ext:'txt'}` → `.txt`）。
 * 少了这一步会拼出 `btxt` 这种**错误的路径**，而且不报错——典型的静默错值。
 */
function formatExt(ext) {
  return ext ? (ext.charCodeAt(0) === DOT ? ext : '.' + ext) : '';
}

function posixFormat(pathObject) {
  if (pathObject === null || typeof pathObject !== 'object') {
    const err = new TypeError(
      'The "pathObject" argument must be of type object. Received ' +
        (pathObject === null ? 'null' : typeof pathObject),
    );
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  const dir = pathObject.dir || pathObject.root;
  const base = pathObject.base || (pathObject.name || '') + formatExt(pathObject.ext);
  if (!dir) return base;
  if (dir === pathObject.root) return dir + base;
  return dir + '/' + base;
}

/**
 * `relative` **继承了 `resolve` 的虚拟根兜底**——这是有意保留的差异，写在这里以免被当成 bug：
 * 两个参数里只要有一个是相对的，它就先按虚拟根 `/` 解析（沙箱里没有"当前工作目录"这个概念，
 * 见 `resolve` 的说明），于是 `posixRelative('a', '/b')` 得到 `'../b'`；
 * 而 Node 会按 `process.cwd()` 解析相对参数，结果是**随 cwd 变化**的。
 * 两个参数都是绝对路径时与 Node 逐字一致（不经过虚拟根）。
 */
function posixRelative(from, to) {
  assertPath(from, 'from');
  assertPath(to, 'to');
  if (from === to) return '';
  const f = posixResolve(from).split('/').filter(Boolean);
  const t = posixResolve(to).split('/').filter(Boolean);
  let common = 0;
  while (common < f.length && common < t.length && f[common] === t[common]) common++;
  const parts = [];
  for (let i = common; i < f.length; i++) parts.push('..');
  return parts.concat(t.slice(common)).join('/');
}

/** posix 下是恒等（命名空间前缀是 Windows 的概念） */
function posixToNamespacedPath(path) {
  return path;
}

export const sep = '/';
export const delimiter = ':';

/**
 * `path.win32`：**真实现**（P2-E），惰性取用。
 *
 * 来历：P2-E 之前这里是一排"明确抛错"的占位（模型 A：沙箱永远假装 Linux）。
 * 现在走**模型 B（仿真平台跟随宿主）**，所以 win32 必须有真语义——见 `node-path-win32.js`，
 * 照 `node/lib/path.js` 的 win32 那半重写，由 `_audit/path-win32-diff.mjs` 与真 Windows 上的
 * node v22.22.1 逐条差分。
 *
 * ⚠️ **必须惰性**：`node-path.js` ⇄ `node-path-win32.js` 是循环 import，本模块的顶层代码
 * 在 win32 模块**求值完之前**就会跑（win32 那边要 `import { __cwd }`）。此刻直接读 `win32Fns.sep`
 * 会命中 TDZ（实测：`Cannot access 'sep' before initialization`）。第一次访问时两者都已求值完。
 */
let win32Cache;
function getWin32() {
  if (win32Cache === undefined) {
    win32Cache = {
      resolve: win32Fns.resolve,
      normalize: win32Fns.normalize,
      isAbsolute: win32Fns.isAbsolute,
      join: win32Fns.join,
      relative: win32Fns.relative,
      toNamespacedPath: win32Fns.toNamespacedPath,
      dirname: win32Fns.dirname,
      basename: win32Fns.basename,
      extname: win32Fns.extname,
      format: win32Fns.format,
      parse: win32Fns.parse,
      sep: win32Fns.sep,
      delimiter: win32Fns.delimiter,
      _makeLong: win32Fns.toNamespacedPath,
    };
  }
  return win32Cache;
}

const posix = {
  resolve: posixResolve,
  normalize: posixNormalize,
  isAbsolute: posixIsAbsolute,
  join: posixJoin,
  relative: posixRelative,
  toNamespacedPath: posixToNamespacedPath,
  dirname: posixDirname,
  basename: posixBasename,
  extname: posixExtname,
  format: posixFormat,
  parse: posixParse,
  sep: sep,
  delimiter: delimiter,
};
posix.posix = posix;

/**
 * 当前平台该用哪一套：**跟随仿真平台**（P2-E / 模型 B）。
 *
 * ⚠️ 这个判断必须与 `node-constants.js` 的 `currentPlatform()`、`emulated-env.ts` 的
 * `resolveEmulatedPlatform()` **同一个判据**（都是读 `__spcEnv.platform`）——
 * 三处只要有一处漂移，就会出现"`path.sep` 是 `\` 而 `constants` 是 Linux 表"这种半跟状态。
 */
function currentPlatform() {
  try {
    const p = JSON.parse(globalThis.__spcEnv).platform;
    return p === 'win32' ? 'win32' : 'linux';
  } catch {
    return 'linux';
  }
}

/**
 * 当前平台的实现（每次读 `__spcEnv` 决定；不缓存——沙箱里 `__spcEnv` 是建沙箱时定死的）。
 *
 * 返回值是**真对象**（`posix` 或 win32 那个对象），不是 Proxy —— 少了一层间接，
 * `path === path.posix`（Node 上成立）这类**身份**关系也就自然成立。
 */
function active() {
  return currentPlatform() === 'win32' ? win32 : posix;
}

/** 两个对象互指（Node 的 `path.win32.win32 === path.win32`、`path.posix.posix === path.posix`） */
const win32 = getWin32();
win32.win32 = win32;
win32.posix = posix;
posix.win32 = win32;

/**
 * **具名导出必须跟随平台**（P2-E，本轮踩到的真缺陷）。
 *
 * 为什么：`import { resolve, parse } from 'path'` 走的是具名导出，而 `import path from 'path'` 走默认导出。
 * 如果具名导出写死成 posix 那一批，那么在 win32 沙箱里就会出现
 * "`path.resolve()` 是 win32 语义、但 `import { resolve } from 'path'` 是 posix 语义"这种**半跟**状态。
 * 实测后果：`mkdirp` 的 `path-arg.js` 用**具名**导入的 `resolve`/`parse`，在 `process.platform === 'win32'`
 * 时做"非法字符"检查——posix 的 `resolve` 给出 `C:/Users/…`、posix 的 `parse` 给出 `root: ''`，
 * 于是 `C:` 里的冒号被判成非法字符 ⇒ `EINVAL Illegal characters in path`（冒烟靶子直接回退）。
 *
 * 形状：每个具名导出是一个**委托函数**，调用时按当前平台转发（不是每个平台一份绑定，
 * 那样就没法在同一个沙箱里既服务 `path` 又服务 `path.win32`）。
 */
export function resolve(...args) {
  return active().resolve(...args);
}
export function normalize(...args) {
  return active().normalize(...args);
}
export function isAbsolute(...args) {
  return active().isAbsolute(...args);
}
export function join(...args) {
  return active().join(...args);
}
export function relative(...args) {
  return active().relative(...args);
}
export function toNamespacedPath(path) {
  return active().toNamespacedPath(path);
}
export function dirname(...args) {
  return active().dirname(...args);
}
export function basename(...args) {
  return active().basename(...args);
}
export function extname(...args) {
  return active().extname(...args);
}
export function format(...args) {
  return active().format(...args);
}
export function parse(...args) {
  return active().parse(...args);
}

export { posix, win32 };
export default active();
