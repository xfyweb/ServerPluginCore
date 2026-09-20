// node:path 的 **win32 语义**实现（P2-E / 模型 B：仿真平台跟随宿主）
//
// 逐条照 `node/lib/path.js` 的 win32 那半移植（本地 `node/` 是契约宗主），保留它那些"看着奇怪但必须一致"的
// 细节：UNC 根、`\\?\` 长路径前缀、**保留设备名**（`CON`/`NUL`/`COM1`…，`C:CON` 也要识别）、盘符相对 cwd、
// 以及 `normalize` 里那条防"冒名绝对路径"的补偿（`.\` 前缀，CVE-2024-36139 那一类）。
//
// 为什么不直接抄 Node 的源码：它依赖 `primordials`、`internal/constants`、`internal/validators` 与
// `process.env['=C:']`（每盘一个 cwd）——搬进来会带一整串沙箱里没有的内部设施。所以**照算法重写**，
// 验收方式是**与真 Windows 上的 node v22.22.1 逐条差分**（`tools/truth/path-win32-diff.mjs`）。
//
// 边界（写清楚免得被当 bug）：
//   1. **盘符相对 cwd 走沙箱 cwd**：Node 用 `process.cwd()` + `process.env['=C:']`；沙箱里
//      `process.env` 是冻结空对象 ⇒ 统一用沙箱 cwd（数据目录）兜底。而且只有"仿真平台 = win32
//      且宿主就是 Windows"时才会走到这里，两者的盘符本来就一致，实际分歧面很小。
//   2. **不实现 `matchesGlob`**：v22.22.1 的 `path.win32` 上没有它（本地 v27 源码里有，那是更新的版本），
//      沙箱基线固定 v22.22.1 ⇒ 不登记（登记了反而与基线不符）。
//   3. `_makeLong` 是 Node 的内部别名（= `toNamespacedPath`），一并给上以对齐导出面。
//
// 内联约束：静态、无占位符（见 registry.ts 头注释）。

const SLASH = 47; // '/'
const BACKSLASH = 92; // '\'
const DOT = 46; // '.'
const COLON = 58; // ':'
const QUESTION = 63; // '?'
const A_UPPER = 65;
const Z_UPPER = 90;
const A_LOWER = 97;
const Z_LOWER = 122;

function isPathSeparator(code) {
  return code === SLASH || code === BACKSLASH;
}

function isWindowsDeviceRoot(code) {
  return (code >= A_UPPER && code <= Z_UPPER) || (code >= A_LOWER && code <= Z_LOWER);
}

/** Windows 保留设备名（照 `lib/path.js` 的表，含上标数字那几个） */
const WINDOWS_RESERVED_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  'COM\u00b9', 'COM\u00b2', 'COM\u00b3',
  'LPT\u00b9', 'LPT\u00b2', 'LPT\u00b3',
];

function isWindowsReservedName(path, colonIndex) {
  const devicePart = path.slice(0, colonIndex).toUpperCase();
  return WINDOWS_RESERVED_NAMES.indexOf(devicePart) !== -1;
}

function invalidArgType(name, expected, actual) {
  const err = new TypeError(
    `The "${name}" argument must be of type ${expected}. Received ${typeof actual}`,
  );
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

/** 与 `lib/path.js` 的 `normalizeString` 同一算法（去掉 primordials 依赖） */
function normalizeString(path, allowAboveRoot, separator, sepFn) {
  let res = '';
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (sepFn(code)) break;
    else code = SLASH;

    if (sepFn(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // NOOP
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 ||
            res.charCodeAt(res.length - 1) !== DOT || res.charCodeAt(res.length - 2) !== DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.length - lastSegmentLength - 1;
            if (lastSlashIndex === -1) {
              res = '';
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf(separator);
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = '';
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? separator + '..' : '..';
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += separator + path.slice(lastSlash + 1, i);
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

function formatExt(ext) {
  return ext ? `${ext[0] === '.' ? '' : '.'}${ext}` : '';
}

function _format(sep, pathObject) {
  const dir = pathObject.dir || pathObject.root;
  const base = pathObject.base || `${pathObject.name || ''}${formatExt(pathObject.ext)}`;
  if (!dir) return base;
  return dir === pathObject.root ? `${dir}${base}` : `${dir}${sep}${base}`;
}

/**
 * 沙箱 cwd 的 win32 形态：**本文件自己从 `globalThis.__spcEnv` 取**，不 import 别的 shim。
 *
 * 为什么不去 import `node-path.js` 的 `cwd()`（试过，两种写法都不行）：
 *   · **注入提供者**（`__setWin32CwdProvider`）= 模块级可变状态：同进程里出现第二个
 *     `node-path.js` 实例（测试加查询串重新 import）就会把共享的本模块的提供者覆盖掉，
 *     第一个实例跟着拿到错的 cwd（实测症状：`resolve()` 突然回 `D:\`）；
 *   · **live binding import**（`import { __cwd } from './node-path.js'`）= 更隐蔽：本模块是**单实例**
 *     （`node-path.js?x=1` 与 `?x=2` 都解析到同一个 `./node-path-win32.js`），于是那个 `__cwd` 绑定
 *     只指向**某一个**实例的 cwd，另一个实例拿到的还是它。
 *
 * ⇒ cwd 的**唯一来源是 `__spcEnv.dataDir`**（`process.cwd()`/`os.homedir()`/fs 相对路径同源），
 *   两个实现各自从这同一份事实里读，就不存在"谁覆盖谁"。
 *
 * 形态：`path.win32` 的输出一律是 `\`，所以 cwd 也归一成 `\`（输入给 `/` 会产出混合形态）。
 */
function win32Cwd() {
  let dir = '/';
  try {
    const env = JSON.parse(globalThis.__spcEnv);
    if (env && typeof env.dataDir === 'string' && env.dataDir.length > 0) {
      dir = env.dataDir.indexOf('\\') === -1 ? env.dataDir : env.dataDir.split('\\').join('/');
    }
  } catch {
    dir = '/';
  }
  return dir.indexOf('/') === -1 ? dir : dir.split('/').join('\\');
}

export function resolve(...args) {
  let resolvedDevice = '';
  let resolvedTail = '';
  let resolvedAbsolute = false;

  for (let i = args.length - 1; i >= -1; i--) {
    let path;
    if (i >= 0) {
      path = args[i];
      if (typeof path !== 'string') throw invalidArgType('path', 'string', path);
      if (path.length === 0) continue;
    } else if (resolvedDevice.length === 0) {
      path = win32Cwd();
      // 快速路径：无参数、或单个 `.`/空串且 cwd 本身绝对
      if (args.length === 0 ||
          (args.length === 1 && (args[0] === '' || args[0] === '.') &&
           isPathSeparator(path.charCodeAt(0)))) {
        return path;
      }
    } else {
      // Windows 的"每盘一个 cwd"（`process.env['=C:']`）。**沙箱复现不了**——见文件头边界 1：
      // 那些 `=X:` 变量被 Node 从 JS 可见的 `process.env` 里过滤掉了（实测 `Object.entries(process.env)`
      // 里没有它们），只有 C 层的 `uv_os_getenv` 读得到，而 `path.resolve` 正是在原生代码里读的。
      // ⇒ 退到"沙箱 cwd（若盘符一致）或该盘根"。差异面只有一种情形：
      // **在 A 盘下 resolve 一个 B 盘的盘符相对路径**（如 cwd=D:\ 时 `resolve('C:a')`）。
      path = win32Cwd();
      if (path === undefined ||
          (path.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() &&
           path.charCodeAt(2) === BACKSLASH)) {
        path = `${resolvedDevice}\\`;
      }
    }

    const len = path.length;
    let rootEnd = 0;
    let device = '';
    let isAbsolute = false;
    const code = path.charCodeAt(0);

    if (len === 1) {
      if (isPathSeparator(code)) {
        rootEnd = 1;
        isAbsolute = true;
      }
    } else if (isPathSeparator(code)) {
      // 可能的 UNC 根
      isAbsolute = true;
      if (isPathSeparator(path.charCodeAt(1))) {
        let j = 2;
        let last = j;
        while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          const firstPart = path.slice(last, j);
          last = j;
          while (j < len && isPathSeparator(path.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
            if (j === len || j !== last) {
              if (firstPart !== '.' && firstPart !== '?') {
                device = `\\\\${firstPart}\\${path.slice(last, j)}`;
                rootEnd = j;
              } else {
                device = `\\\\${firstPart}`;
                rootEnd = 4;
              }
            }
          }
        }
      } else {
        rootEnd = 1;
      }
    } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === COLON) {
      device = path.slice(0, 2);
      rootEnd = 2;
      if (len > 2 && isPathSeparator(path.charCodeAt(2))) {
        isAbsolute = true;
        rootEnd = 3;
      }
    }

    if (device.length > 0) {
      if (resolvedDevice.length > 0) {
        if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
      } else {
        resolvedDevice = device;
      }
    }

    if (resolvedAbsolute) {
      if (resolvedDevice.length > 0) break;
    } else {
      resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}`;
      resolvedAbsolute = isAbsolute;
      if (isAbsolute && resolvedDevice.length > 0) break;
    }
  }

  resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute, '\\', isPathSeparator);
  return resolvedAbsolute
    ? `${resolvedDevice}\\${resolvedTail}`
    : `${resolvedDevice}${resolvedTail}` || '.';
}

export function normalize(path) {
  if (typeof path !== 'string') throw invalidArgType('path', 'string', path);
  const len = path.length;
  if (len === 0) return '.';
  let rootEnd = 0;
  let device;
  let isAbsolute = false;
  const code = path.charCodeAt(0);

  if (len === 1) return code === SLASH ? '\\' : path;
  if (isPathSeparator(code)) {
    isAbsolute = true;
    if (isPathSeparator(path.charCodeAt(1))) {
      let j = 2;
      let last = j;
      while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
      if (j < len && j !== last) {
        const firstPart = path.slice(last, j);
        last = j;
        while (j < len && isPathSeparator(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
          if (j === len || j !== last) {
            if (firstPart === '.' || firstPart === '?') {
              device = `\\\\${firstPart}`;
              rootEnd = 4;
              const colonIndex = path.indexOf(':');
              const possibleDevice = path.slice(4, colonIndex + 1);
              if (isWindowsReservedName(possibleDevice, possibleDevice.length - 1)) {
                device = `\\\\?\\${possibleDevice}`;
                rootEnd = 4 + possibleDevice.length;
              }
            } else if (j === len) {
              return `\\\\${firstPart}\\${path.slice(last)}\\`;
            } else {
              device = `\\\\${firstPart}\\${path.slice(last, j)}`;
              rootEnd = j;
            }
          }
        }
      }
    } else {
      rootEnd = 1;
    }
  } else {
    const colonIndex = path.indexOf(':');
    if (colonIndex > 0) {
      if (isWindowsDeviceRoot(code) && colonIndex === 1) {
        device = path.slice(0, 2);
        rootEnd = 2;
        if (len > 2 && isPathSeparator(path.charCodeAt(2))) {
          isAbsolute = true;
          rootEnd = 3;
        }
      } else if (isWindowsReservedName(path, colonIndex)) {
        device = path.slice(0, colonIndex + 1);
        rootEnd = colonIndex + 1;
      }
    }
  }

  let tail = rootEnd < len
    ? normalizeString(path.slice(rootEnd), !isAbsolute, '\\', isPathSeparator)
    : '';
  if (tail.length === 0 && !isAbsolute) tail = '.';
  if (tail.length > 0 && isPathSeparator(path.charCodeAt(len - 1))) tail += '\\';
  if (!isAbsolute && device === undefined && path.includes(':')) {
    // 相对路径的 tail 不能被 Windows 解释成绝对路径（`CVE-2024-36139` 那一类）
    if (tail.length >= 2 && isWindowsDeviceRoot(tail.charCodeAt(0)) && tail.charCodeAt(1) === COLON) {
      return `.\\${tail}`;
    }
    let index = path.indexOf(':');
    do {
      if (index === len - 1 || isPathSeparator(path.charCodeAt(index + 1))) {
        return `.\\${tail}`;
      }
    } while ((index = path.indexOf(':', index + 1)) !== -1);
  }
  const colonIndex = path.indexOf(':');
  if (isWindowsReservedName(path, colonIndex)) {
    return `.\\${device === undefined ? '' : device}${tail}`;
  }
  if (device === undefined) return isAbsolute ? `\\${tail}` : tail;
  return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
}

export function isAbsolute(path) {
  if (typeof path !== 'string') throw invalidArgType('path', 'string', path);
  const len = path.length;
  if (len === 0) return false;
  const code = path.charCodeAt(0);
  return isPathSeparator(code) ||
    (len > 2 && isWindowsDeviceRoot(code) && path.charCodeAt(1) === COLON &&
     isPathSeparator(path.charCodeAt(2)));
}

export function join(...args) {
  if (args.length === 0) return '.';
  const paths = [];
  for (const arg of args) {
    if (typeof arg !== 'string') throw invalidArgType('path', 'string', arg);
    if (arg.length > 0) paths.push(arg);
  }
  if (paths.length === 0) return '.';

  const firstPart = paths[0];
  let joined = paths.join('\\');

  let needsReplace = true;
  let slashCount = 0;
  if (isPathSeparator(firstPart.charCodeAt(0))) {
    ++slashCount;
    const firstLen = firstPart.length;
    if (firstLen > 1 && isPathSeparator(firstPart.charCodeAt(1))) {
      ++slashCount;
      if (firstLen > 2) {
        if (isPathSeparator(firstPart.charCodeAt(2))) ++slashCount;
        else needsReplace = false;
      }
    }
  }
  if (needsReplace) {
    while (slashCount < joined.length && isPathSeparator(joined.charCodeAt(slashCount))) slashCount++;
    if (slashCount >= 2) joined = `\\${joined.slice(slashCount)}`;
  }

  // 有保留设备名时跳过 normalize（Node 的同一处特判）
  const parts = [];
  let part = '';
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '\\') {
      if (part) parts.push(part);
      part = '';
      while (i + 1 < joined.length && joined[i + 1] === '\\') i++;
    } else {
      part += joined[i];
    }
  }
  if (part) parts.push(part);
  if (parts.some((p) => {
    const colonIndex = p.indexOf(':');
    return colonIndex !== -1 && isWindowsReservedName(p, colonIndex);
  })) {
    let result = '';
    for (let i = 0; i < joined.length; i++) result += joined[i] === '/' ? '\\' : joined[i];
    return result;
  }

  return normalize(joined);
}

export function relative(from, to) {
  if (typeof from !== 'string') throw invalidArgType('from', 'string', from);
  if (typeof to !== 'string') throw invalidArgType('to', 'string', to);
  if (from === to) return '';

  const fromOrig = resolve(from);
  const toOrig = resolve(to);
  if (fromOrig === toOrig) return '';

  from = fromOrig.toLowerCase();
  to = toOrig.toLowerCase();
  if (from === to) return '';

  if (fromOrig.length !== from.length || toOrig.length !== to.length) {
    const fromSplit = fromOrig.split('\\');
    const toSplit = toOrig.split('\\');
    if (fromSplit[fromSplit.length - 1] === '') fromSplit.pop();
    if (toSplit[toSplit.length - 1] === '') toSplit.pop();

    const fromLen = fromSplit.length;
    const toLen = toSplit.length;
    const length = fromLen < toLen ? fromLen : toLen;
    let i;
    for (i = 0; i < length; i++) {
      if (fromSplit[i].toLowerCase() !== toSplit[i].toLowerCase()) break;
    }
    if (i === 0) return toOrig;
    if (i === length) {
      if (toLen > length) return toSplit.slice(i).join('\\');
      if (fromLen > length) return '..\\'.repeat(fromLen - 1 - i) + '..';
      return '';
    }
    return '..\\'.repeat(fromLen - i) + toSplit.slice(i).join('\\');
  }

  let fromStart = 0;
  while (fromStart < from.length && from.charCodeAt(fromStart) === BACKSLASH) fromStart++;
  let fromEnd = from.length;
  while (fromEnd - 1 > fromStart && from.charCodeAt(fromEnd - 1) === BACKSLASH) fromEnd--;
  const fromLen = fromEnd - fromStart;

  let toStart = 0;
  while (toStart < to.length && to.charCodeAt(toStart) === BACKSLASH) toStart++;
  let toEnd = to.length;
  while (toEnd - 1 > toStart && to.charCodeAt(toEnd - 1) === BACKSLASH) toEnd--;
  const toLen = toEnd - toStart;

  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i);
    if (fromCode !== to.charCodeAt(toStart + i)) break;
    else if (fromCode === BACKSLASH) lastCommonSep = i;
  }

  if (i !== length) {
    if (lastCommonSep === -1) return toOrig;
  } else {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === BACKSLASH) return toOrig.slice(toStart + i + 1);
      if (i === 2) return toOrig.slice(toStart + i);
    }
    if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === BACKSLASH) lastCommonSep = i;
      else if (i === 2) lastCommonSep = 3;
    }
    if (lastCommonSep === -1) lastCommonSep = 0;
  }

  let out = '';
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || from.charCodeAt(i) === BACKSLASH) {
      out += out.length === 0 ? '..' : '\\..';
    }
  }

  toStart += lastCommonSep;
  if (out.length > 0) return `${out}${toOrig.slice(toStart, toEnd)}`;
  if (toOrig.charCodeAt(toStart) === BACKSLASH) ++toStart;
  return toOrig.slice(toStart, toEnd);
}

export function toNamespacedPath(path) {
  if (typeof path !== 'string' || path.length === 0) return path;
  const resolvedPath = resolve(path);
  if (resolvedPath.length <= 2) return path;

  if (resolvedPath.charCodeAt(0) === BACKSLASH) {
    if (resolvedPath.charCodeAt(1) === BACKSLASH) {
      const code = resolvedPath.charCodeAt(2);
      if (code !== QUESTION && code !== DOT) {
        return `\\\\?\\UNC\\${resolvedPath.slice(2)}`;
      }
    }
  } else if (isWindowsDeviceRoot(resolvedPath.charCodeAt(0)) &&
             resolvedPath.charCodeAt(1) === COLON &&
             resolvedPath.charCodeAt(2) === BACKSLASH) {
    return `\\\\?\\${resolvedPath}`;
  }
  return resolvedPath;
}

export function dirname(path) {
  if (typeof path !== 'string') throw invalidArgType('path', 'string', path);
  const len = path.length;
  if (len === 0) return '.';
  let rootEnd = -1;
  let offset = 0;
  const code = path.charCodeAt(0);

  if (len === 1) return isPathSeparator(code) ? path : '.';

  if (isPathSeparator(code)) {
    rootEnd = offset = 1;
    if (isPathSeparator(path.charCodeAt(1))) {
      let j = 2;
      let last = j;
      while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
      if (j < len && j !== last) {
        last = j;
        while (j < len && isPathSeparator(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
          if (j === len) return path;
          if (j !== last) rootEnd = offset = j + 1;
        }
      }
    }
  } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === COLON) {
    rootEnd = len > 2 && isPathSeparator(path.charCodeAt(2)) ? 3 : 2;
    offset = rootEnd;
  }

  let end = -1;
  let matchedSlash = true;
  for (let i = len - 1; i >= offset; --i) {
    if (isPathSeparator(path.charCodeAt(i))) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }

  if (end === -1) {
    if (rootEnd === -1) return '.';
    end = rootEnd;
  }
  return path.slice(0, end);
}

export function basename(path, suffix) {
  if (suffix !== undefined && typeof suffix !== 'string') {
    throw invalidArgType('suffix', 'string', suffix);
  }
  if (typeof path !== 'string') throw invalidArgType('path', 'string', path);
  let start = 0;
  let end = -1;
  let matchedSlash = true;

  if (path.length >= 2 && isWindowsDeviceRoot(path.charCodeAt(0)) && path.charCodeAt(1) === COLON) {
    start = 2;
  }

  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return '';
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= start; --i) {
      const code = path.charCodeAt(i);
      if (isPathSeparator(code)) {
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
          if (code === suffix.charCodeAt(extIdx)) {
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

  for (let i = path.length - 1; i >= start; --i) {
    if (isPathSeparator(path.charCodeAt(i))) {
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
  if (typeof path !== 'string') throw invalidArgType('path', 'string', path);
  let start = 0;
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;

  if (path.length >= 2 && path.charCodeAt(1) === COLON && isWindowsDeviceRoot(path.charCodeAt(0))) {
    start = startPart = 2;
  }

  for (let i = path.length - 1; i >= start; --i) {
    const code = path.charCodeAt(i);
    if (isPathSeparator(code)) {
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

  if (startDot === -1 || end === -1 || preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
    return '';
  }
  return path.slice(startDot, end);
}

export function format(pathObject) {
  if (pathObject === null || typeof pathObject !== 'object') {
    throw invalidArgType('pathObject', 'object', pathObject);
  }
  return _format('\\', pathObject);
}

export function parse(path) {
  if (typeof path !== 'string') throw invalidArgType('path', 'string', path);
  const ret = { root: '', dir: '', base: '', ext: '', name: '' };
  if (path.length === 0) return ret;

  const len = path.length;
  let rootEnd = 0;
  let code = path.charCodeAt(0);

  if (len === 1) {
    if (isPathSeparator(code)) {
      ret.root = ret.dir = path;
      return ret;
    }
    ret.base = ret.name = path;
    return ret;
  }
  if (isPathSeparator(code)) {
    rootEnd = 1;
    if (isPathSeparator(path.charCodeAt(1))) {
      let j = 2;
      let last = j;
      while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
      if (j < len && j !== last) {
        last = j;
        while (j < len && isPathSeparator(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
          if (j === len) rootEnd = j;
          else if (j !== last) rootEnd = j + 1;
        }
      }
    }
  } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === COLON) {
    if (len <= 2) {
      ret.root = ret.dir = path;
      return ret;
    }
    rootEnd = 2;
    if (isPathSeparator(path.charCodeAt(2))) {
      if (len === 3) {
        ret.root = ret.dir = path;
        return ret;
      }
      rootEnd = 3;
    }
  }
  if (rootEnd > 0) ret.root = path.slice(0, rootEnd);

  let startDot = -1;
  let startPart = rootEnd;
  let end = -1;
  let matchedSlash = true;
  let i = path.length - 1;
  let preDotState = 0;

  for (; i >= rootEnd; --i) {
    code = path.charCodeAt(i);
    if (isPathSeparator(code)) {
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
    if (startDot === -1 || preDotState === 0 ||
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
      ret.base = ret.name = path.slice(startPart, end);
    } else {
      ret.name = path.slice(startPart, startDot);
      ret.base = path.slice(startPart, end);
      ret.ext = path.slice(startDot, end);
    }
  }
  if (startPart > 0 && startPart !== rootEnd) ret.dir = path.slice(0, startPart - 1);
  else ret.dir = ret.root;

  return ret;
}

export const sep = '\\';
export const delimiter = ';';

/**
 * `path.win32` 对象。`win32`/`posix` 两个自引用由 `node-path.js` 装回
 * （两个实现互相引用会形成模块循环，所以这里留空再补——与 Node 的 `win32.win32 === win32` 对齐）。
 */
export const win32 = {
  resolve,
  normalize,
  isAbsolute,
  join,
  relative,
  toNamespacedPath,
  dirname,
  basename,
  extname,
  format,
  parse,
  sep,
  delimiter,
  _makeLong: toNamespacedPath,
};

export default win32;
