// node:path 仿真——**POSIX 语义**
//
// 为什么固定 posix（而不是跟着宿主平台走）：
//   · ROADMAP「明确不做（现阶段）」写明 Windows 部署是 v1.x 目标，当前部署面是 Linux；
//   · 固定语义让**开发机是 Windows 也能得到确定结果**——测试比的是 `node:path.posix`，
//     不会出现"我机器上绿、CI 上红"。
//   · 代价：若将来部署到 Windows，`path.win32` 需要真实现（现在是明确抛错，不静默假装）。
//
// **一处与 Node 的差别（原来是"故意用虚拟根 /"，现已改为按沙箱 cwd 解析）**：
// `resolve()` 的兜底基准 = **沙箱 cwd（= 插件数据目录，`__spcEnv.dataDir`）**，与 `process.cwd()`、
// 以及 fs 层"相对路径按数据目录解析"三者同源。取值失败（宿主 realm 里跑单测、没有 `__spcEnv`）回退 `/`。
//
// 为什么改：虚拟根 `/` 会让 `path.resolve('out/a')` 得到 `/out/a`，再交给 fs 就是**作用域外** →
// EACCES。真实依赖正是这么写的——`mkdirp/dist/mjs/path-arg.js:11` 就是 `path = resolve(path)`，
// 于是 `mkdirp.sync('out/a/b/c')` 直接 EACCES（实测：`_audit/dep-smoke.mts`）。
// 已知边界：Windows 开发机上数据目录是 `D:\…` 形态，这里统一换成 `/` 分隔（`D:/…`）让 POSIX 的
// `dirname`/`join`/`..` 都能用；但 `isAbsolute('D:/…')` 仍按 POSIX 语义给 **false**（不认盘符）。
// Linux 上（部署目标）完全自洽。
//
// 内联约束：静态、无占位符，可被构建层直接打进插件产物。

const SLASH = 47; // '/'
const DOT = 46; // '.'

/**
 * 沙箱 cwd = 数据目录（与 `process.cwd()`、fs 的相对路径解析同一个出处）。
 * 只在第一次调用时解析；拿不到（没有引导层注入 / 宿主 realm 单测）就回退 `/`。
 * Windows 盘符路径把 `\` 换成 `/`：POSIX 的那套字符串算法只认 `/`。
 */
let sandboxCwd;
function cwd() {
  if (sandboxCwd === undefined) {
    let dir = '/';
    try {
      const env = JSON.parse(globalThis.__spcEnv);
      if (env && typeof env.dataDir === 'string' && env.dataDir.length > 0) dir = env.dataDir;
    } catch {
      dir = '/';
    }
    sandboxCwd = dir.indexOf('\\') === -1 ? dir : dir.split('\\').join('/');
  }
  return sandboxCwd;
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

export function normalize(path) {
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

export function isAbsolute(path) {
  assertPath(path, 'path');
  return path.length > 0 && path.charCodeAt(0) === SLASH;
}

export function join(...args) {
  if (args.length === 0) return '.';
  let joined;
  for (const arg of args) {
    assertPath(arg, 'path');
    if (arg.length === 0) continue;
    joined = joined === undefined ? arg : joined + '/' + arg;
  }
  if (joined === undefined) return '.';
  return normalize(joined);
}

export function resolve(...args) {
  let resolved = '';
  let absolute = false;
  // 从最后一个参数往前拼，遇到绝对路径就停（Node 的语义）
  for (let i = args.length - 1; i >= -1 && !absolute; i--) {
    const seg = i >= 0 ? args[i] : cwd();
    if (i >= 0) assertPath(seg, 'path');
    if (seg.length === 0) continue;
    resolved = seg + '/' + resolved;
    absolute = seg.charCodeAt(0) === SLASH;
  }
  const body = normalizeParts(resolved, !absolute);
  if (absolute) return body.length > 0 ? '/' + body : '/';
  return body.length > 0 ? body : '.';
}

export function dirname(path) {
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
  // Node 的历史怪癖：`dirname('/foo')` 仍有 root 时返回 `//`
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}

export function basename(path, ext) {
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

export function extname(path) {
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

export function parse(path) {
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

export function format(pathObject) {
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
 * 见 `resolve` 的说明），于是 `relative('a', '/b')` 得到 `'../b'`；
 * 而 Node 会按 `process.cwd()` 解析相对参数，结果是**随 cwd 变化**的。
 * 两个参数都是绝对路径时与 Node 逐字一致（不经过虚拟根）。
 */
export function relative(from, to) {
  assertPath(from, 'from');
  assertPath(to, 'to');
  if (from === to) return '';
  const f = resolve(from).split('/').filter(Boolean);
  const t = resolve(to).split('/').filter(Boolean);
  let common = 0;
  while (common < f.length && common < t.length && f[common] === t[common]) common++;
  const parts = [];
  for (let i = common; i < f.length; i++) parts.push('..');
  return parts.concat(t.slice(common)).join('/');
}

/** posix 下是恒等（命名空间前缀是 Windows 的概念） */
export function toNamespacedPath(path) {
  return path;
}

export const sep = '/';
export const delimiter = ':';

/** `path.win32`：**明确抛错**，不静默给出 posix 结果（见文件头） */
function unsupportedWin32(name) {
  const fn = function () {
    const err = new Error('path.win32.' + name + ' is not supported in the sandbox (POSIX paths only)');
    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
    throw err;
  };
  // 保留函数名：堆栈与日志里看不出 `win32.join` 会很难排障
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

const WIN32_METHODS = [
  'resolve', 'normalize', 'isAbsolute', 'join', 'relative', 'toNamespacedPath',
  'dirname', 'basename', 'extname', 'format', 'parse',
];
const win32 = {};
for (const m of WIN32_METHODS) win32[m] = /* @__PURE__ */ unsupportedWin32(m);
win32.sep = '\\';
win32.delimiter = ';';

const posix = {
  resolve: resolve,
  normalize: normalize,
  isAbsolute: isAbsolute,
  join: join,
  relative: relative,
  toNamespacedPath: toNamespacedPath,
  dirname: dirname,
  basename: basename,
  extname: extname,
  format: format,
  parse: parse,
  sep: sep,
  delimiter: delimiter,
  win32: win32,
};
posix.posix = posix;

export { posix, win32 };
export default posix;
