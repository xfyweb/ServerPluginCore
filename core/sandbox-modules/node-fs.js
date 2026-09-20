// node:fs 仿真（P2-B）—— **作用域 = 插件数据目录**
//
// 分工（module-emulation-design §3.2.1「宿主代工：判据与边界」）：
//   · **真实动作在宿主**：`core/hostApi.ts` 的 fs.* 原语——路径收敛（F1–F7）、大小上限、inode 预检、
//     权限点（`fs.read.data` / `fs.write.data`）、审计都在那儿；沙箱里没有系统调用，也不该有。
//   · **形状与错误语义在沙箱**：本文件做 Node 的 API 形状（options 归一化、Stats/Dirent、回调风格）
//     与 **errno 翻译**（设计 §7：宿主码 → POSIX 码，同时在 `err.spcCode` 里保留原始码）。
// 为什么形状不能也代工：桥只传字符串/字节，返回对象要 JSON 往返（丢原型/getter），
// 而 `stats.isFile()`、`dirent.name` 必须是**真方法/真属性**（§3.2.1 阻断 1、3）。
//
// ══ 已知边界（写在这里，免得被当成 bug）══
//  1. **fd 类**（open/read/write/fstat/fsync/fd 形式）、`fs.watch`/`watchFile`、流
//     （createReadStream/createWriteStream）、软链创建（symlink/link/readlink）、属主与权限位
//     （chmod/chown/utimes）、`statfs`/`cp`/`glob`/`opendir`：**一律抛 `ERR_NOT_SUPPORTED_IN_SANDBOX`**。
//     不做静默 undefined、不假装成功（fail-closed；静默降级比报错危险）。
//  2. **软链语义与 Node 不同**：路径收敛（F2/F5）会把软链**解析成目标**，所以对软链本身的操作
//     （unlink/rm/rename 软链）作用在目标上，`lstatSync` 也**认不出软链**（它拿到的已经是目标的路径）；
//     悬空软链会得到 `ELOOP`（fail-closed）。本批不支持创建软链。
//     **补偿能力**：`readdirSync(…, { withFileTypes: true })` 的 `Dirent` 不经过收敛，`isSymbolicLink()` 是准的。
//  3. **异步只是形状**：宿主 fs.* 原语全是同步的，promises/回调都"排进微任务后同步执行"——
//     仍会占用事件循环（Node 上是线程池）。回调**照 Node 异步触发**（queueMicrotask），
//     但相对顺序与 Node 不同（Node 的线程池回调排在微任务队列之后，我们的回调**就是**一个微任务）。
//  4. **硬上限**：读 1 MiB、写 64 MiB、目录 10000 条（宿主侧拒绝，超限给 EFBIG/ENOSPC）。
//     不是吝啬：读到的内容会变成沙箱堆里的字节，32 MiB 的堆撑不住更大的文件，
//     而那时报出来的是 PLUGIN_MEMORY_LIMIT（误导，所以宁可在宿主侧按"能安全进 VM"的尺寸拒绝）。
//  5. 不支持 `{ bigint: true }`（BigIntStats）与 `readdirSync(…, { recursive: true })`：**抛错**不降级。
//  6. `fs.constants` 与 `err.errno`/文案都是 **Linux 真值**（`tools/truth/fs-url-truth.mjs` 在 WSL node v22.22.1
//     上取的运行值，生成脚本 `tools/truth/gen-fs-tables.mjs`），与 `node-path.js` 固定 posix、
//     `node-constants.js` 取 Linux 是同一个取向。
//  7. **`URL` 路径参数只在 POSIX 语义下成立**：`fileURLToPath` 是 POSIX 基线（沙箱路径语义本来就是 posix），
//     所以 Windows 宿主上 `new URL('file:///C:/x')` 解析出的 `/C:/x` 与真实数据目录对不上。
//     插件写字符串路径最稳；这条与"暂不支持 Windows 部署"是同一个已知边界。
//  8. `readFileSync(p, { flag: 'w' })` 这类**写旗标**明确抛错：Node 上它会把文件截断再读，
//     我们不做"读一个文件却改了它"的事（只读旗标 `r`/`r+`/`rs`/`rs+` 支持）。
//  9. **文本读写不需要 `bytes.*` 权限**（编码在宿主侧跟读/写一起做，见 `fs.readText`/`fs.writeText`
//     的注释）。只有下面这几条边角会用到宿主编解码、从而需要插件声明 `bytes.encode`/`bytes.decode`：
//     路径参数传 **Buffer**（要解码成字符串）、`readdirSync`/`realpathSync`/`mkdtempSync` 用
//     `{ encoding: 'buffer' }`（要把名字编码成字节）。正常写字符串路径 + 文本读写**不会**碰到。
//
// 内联约束：静态、无占位符、不 import 任何 `node:*`；能力只在运行时从 `globalThis.__host` 取。

import { Buffer } from './node-buffer.js';
import { fileURLToPath, URL } from './node-url.js';

// ──────────────────────────── 宿主通道 ────────────────────────────

/**
 * 桥的**错误信封**还原。`globalThis.__host` 是裸桥，`@host/api` 的 `__wrap`/`__json`
 * 是另一个模块里的沙箱侧包装——这里拿到的是桥本身，所以信封还原得自己做（同 node-buffer.js）。
 * 判定收紧为"只有键信封"：单键 + `__spcError` + code 是字符串，免得插件数据里出现该字样被误判。
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

/**
 * 二进制参数**必须是 ArrayBuffer**：桥只认 ArrayBuffer，不认视图（传视图会以
 * "Couldn't allocate memory to get ArrayBuffer" 失败，读起来像 OOM）。
 * 整块视图复用底层 buffer（不拷贝），否则切出区间。
 */
function toExactArrayBuffer(view) {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/** 参数编组：字符串原样、字节转 ArrayBuffer、其余 JSON 化（与 @host/api 的 __marshal 同一契约） */
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

/** 宿主返回 JSON 文本 → 真值 */
function callJson(name, ...args) {
  const raw = hostRaw(name, args);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** 二进制通道：宿主返回 ArrayBuffer（字符串 = 错误信封，已在 hostRaw 里抛掉） */
function callBytes(name, ...args) {
  const raw = hostRaw(name, args);
  if (typeof raw === 'string' || !(raw instanceof ArrayBuffer)) {
    const e = new Error('sandbox bridge: expected bytes from ' + name);
    e.code = 'INTERNAL';
    throw e;
  }
  return raw;
}

// ──────────────────────────── errno 翻译（设计 §7）────────────────────────────

// 表由 `tools/truth/gen-fs-tables.mjs` 从 WSL 真值生成（node v22.22.1 的运行值）——**勿手改**
const ERRNO = {
  EPERM          : [  1, "operation not permitted"],
  ENOENT         : [  2, "no such file or directory"],
  ESRCH          : [  3, "no such process"],
  EINTR          : [  4, "interrupted system call"],
  EIO            : [  5, "i/o error"],
  ENXIO          : [  6, "no such device or address"],
  E2BIG          : [  7, "argument list too long"],
  ENOEXEC        : [  8, "exec format error"],
  EBADF          : [  9, "bad file descriptor"],
  EAGAIN         : [ 11, "resource temporarily unavailable"],
  EWOULDBLOCK    : [ 11, "resource temporarily unavailable"],
  ENOMEM         : [ 12, "not enough memory"],
  EACCES         : [ 13, "permission denied"],
  EFAULT         : [ 14, "bad address in system call argument"],
  EBUSY          : [ 16, "resource busy or locked"],
  EEXIST         : [ 17, "file already exists"],
  EXDEV          : [ 18, "cross-device link not permitted"],
  ENODEV         : [ 19, "no such device"],
  ENOTDIR        : [ 20, "not a directory"],
  EISDIR         : [ 21, "illegal operation on a directory"],
  EINVAL         : [ 22, "invalid argument"],
  ENFILE         : [ 23, "file table overflow"],
  EMFILE         : [ 24, "too many open files"],
  ENOTTY         : [ 25, "inappropriate ioctl for device"],
  ETXTBSY        : [ 26, "text file is busy"],
  EFBIG          : [ 27, "file too large"],
  ENOSPC         : [ 28, "no space left on device"],
  ESPIPE         : [ 29, "invalid seek"],
  EROFS          : [ 30, "read-only file system"],
  EMLINK         : [ 31, "too many links"],
  EPIPE          : [ 32, "broken pipe"],
  ERANGE         : [ 34, "result too large"],
  ENAMETOOLONG   : [ 36, "name too long"],
  ENOSYS         : [ 38, "function not implemented"],
  ENOTEMPTY      : [ 39, "directory not empty"],
  ELOOP          : [ 40, "too many symbolic links encountered"],
  ENODATA        : [ 61, "no data available"],
  EPROTO         : [ 71, "protocol error"],
  EOVERFLOW      : [ 75, "value too large for defined data type"],
  EILSEQ         : [ 84, "illegal byte sequence"],
  ENOTSOCK       : [ 88, "socket operation on non-socket"],
  EDESTADDRREQ   : [ 89, "destination address required"],
  EMSGSIZE       : [ 90, "message too long"],
  EPROTOTYPE     : [ 91, "protocol wrong type for socket"],
  ENOPROTOOPT    : [ 92, "protocol not available"],
  EPROTONOSUPPORT: [ 93, "protocol not supported"],
  ENOTSUP        : [ 95, "operation not supported on socket"],
  EOPNOTSUPP     : [ 95, "operation not supported on socket"],
  EAFNOSUPPORT   : [ 97, "address family not supported"],
  EADDRINUSE     : [ 98, "address already in use"],
  EADDRNOTAVAIL  : [ 99, "address not available"],
  ENETDOWN       : [100, "network is down"],
  ENETUNREACH    : [101, "network is unreachable"],
  ECONNABORTED   : [103, "software caused connection abort"],
  ECONNRESET     : [104, "connection reset by peer"],
  ENOBUFS        : [105, "no buffer space available"],
  EISCONN        : [106, "socket is already connected"],
  ENOTCONN       : [107, "socket is not connected"],
  ETIMEDOUT      : [110, "connection timed out"],
  ECONNREFUSED   : [111, "connection refused"],
  EHOSTUNREACH   : [113, "host is unreachable"],
  EALREADY       : [114, "connection already in progress"],
  ECANCELED      : [125, "operation canceled"],
};

// ──────────────────────────── 常量 ────────────────────────────

// `fs.constants` 也是 Linux 真值（同 node-constants.js 的取向），同一份生成脚本产出——**勿手改**
const FS_CONSTANTS = {
  COPYFILE_EXCL               : 1,
  COPYFILE_FICLONE            : 2,
  COPYFILE_FICLONE_FORCE      : 4,
  F_OK                        : 0,
  O_APPEND                    : 1024,
  O_CREAT                     : 64,
  O_DIRECT                    : 16384,
  O_DIRECTORY                 : 65536,
  O_DSYNC                     : 4096,
  O_EXCL                      : 128,
  O_NOATIME                   : 262144,
  O_NOCTTY                    : 256,
  O_NOFOLLOW                  : 131072,
  O_NONBLOCK                  : 2048,
  O_RDONLY                    : 0,
  O_RDWR                      : 2,
  O_SYNC                      : 1052672,
  O_TRUNC                     : 512,
  O_WRONLY                    : 1,
  R_OK                        : 4,
  S_IFBLK                     : 24576,
  S_IFCHR                     : 8192,
  S_IFDIR                     : 16384,
  S_IFIFO                     : 4096,
  S_IFLNK                     : 40960,
  S_IFMT                      : 61440,
  S_IFREG                     : 32768,
  S_IFSOCK                    : 49152,
  S_IRGRP                     : 32,
  S_IROTH                     : 4,
  S_IRUSR                     : 256,
  S_IRWXG                     : 56,
  S_IRWXO                     : 7,
  S_IRWXU                     : 448,
  S_IWGRP                     : 16,
  S_IWOTH                     : 2,
  S_IWUSR                     : 128,
  S_IXGRP                     : 8,
  S_IXOTH                     : 1,
  S_IXUSR                     : 64,
  UV_DIRENT_BLOCK             : 7,
  UV_DIRENT_CHAR              : 6,
  UV_DIRENT_DIR               : 2,
  UV_DIRENT_FIFO              : 4,
  UV_DIRENT_FILE              : 1,
  UV_DIRENT_LINK              : 3,
  UV_DIRENT_SOCKET            : 5,
  UV_DIRENT_UNKNOWN           : 0,
  UV_FS_COPYFILE_EXCL         : 1,
  UV_FS_COPYFILE_FICLONE      : 2,
  UV_FS_COPYFILE_FICLONE_FORCE: 4,
  UV_FS_O_FILEMAP             : 0,
  UV_FS_SYMLINK_DIR           : 1,
  UV_FS_SYMLINK_JUNCTION      : 2,
  W_OK                        : 2,
  X_OK                        : 1,
};

/** 写旗标全集（把"Node 认但本仿真不支持"与"真的非法旗标"分开报） */
const READ_WRITE_FLAGS = new Set(['a', 'ax', 'a+', 'ax+', 'as', 'as+', 'w', 'wx', 'w+', 'wx+']);

/**
 * 宿主码 → POSIX errno 名（设计 §7 的表 + 本批新增的原语码）。
 * 表里没有的码：如果它**本身就是** POSIX 名（宿主原生 fs 错误会直通，如 ENOENT/EEXIST/EISDIR），
 * 就原样用；否则落到 EIO（未分类内部错误）。
 */
const HOST_CODE_TO_ERRNO = {
  // 路径收敛（core/fs/safe-path.ts）
  PATH_OUT_OF_SCOPE: 'EACCES',
  SYMLINK_ESCAPE: 'EACCES',
  PARENT_ESCAPE: 'EACCES',
  SPECIAL_PATH_DENIED: 'EACCES',
  SYMLINK_DANGLING: 'ELOOP',
  PARENT_MISSING: 'ENOENT',
  // 权限（宿主侧判定，未授予/未声明）
  PERMISSION_DENIED: 'EACCES',
  // 本批 fs 原语
  NOT_FOUND: 'ENOENT',
  ALREADY_EXISTS: 'EEXIST',
  IS_A_DIRECTORY: 'EISDIR',
  NOT_A_FILE: 'EISDIR',
  NOT_A_DIRECTORY: 'ENOTDIR',
  FILE_TOO_LARGE: 'EFBIG',
  TARGET_TOO_LARGE: 'EFBIG',
  ENTRY_LIMIT_EXCEEDED: 'ENOSPC',
  // 其它
  TIMEOUT: 'ETIMEDOUT',
  INODE_PRECHECK_MISSING: 'EIO',
  INODE_MISMATCH: 'EIO',
  INVALID_ARGS: 'EINVAL',
};

function errnoName(hostCode) {
  if (Object.prototype.hasOwnProperty.call(HOST_CODE_TO_ERRNO, hostCode)) {
    return HOST_CODE_TO_ERRNO[hostCode];
  }
  if (Object.prototype.hasOwnProperty.call(ERRNO, hostCode)) return hostCode;
  // 宿主（就是 Node）自己那套契约码直通，别把它翻成 EIO
  if (hostCode.startsWith('ERR_')) return hostCode;
  return 'EIO';
}

/**
 * 宿主错误 → Node 形状的 Error：`code` / `errno`（Linux 上的负值）/ `syscall` / `path` / `dest`，
 * message 用 Node 的格式 `CODE: strerror, syscall 'path'`（strerror 文案也是 Linux 真值）。
 * **`err.spcCode` 保留宿主原始码**（§7 的取舍：对外像 POSIX，对内不丢信息）；
 * 宿主错误信封里的 `params` 也带过来（排障用，如越界时收敛后的路径）。
 */
function toNodeError(err, syscall, path, dest) {
  const hostCode = err && typeof err.code === 'string' ? err.code : 'INTERNAL';
  const code = errnoName(hostCode);
  // 宿主自己那套 `ERR_*` 契约码原样保留（如 `ERR_UNKNOWN_ENCODING`）：它们**不是** errno，
  // 硬翻成 EIO 会把"编码名写错了"说成"i/o error"（Node 给的是 TypeError + ERR_*）。
  if (code.startsWith('ERR_')) {
    const e = new TypeError(code);
    e.code = code;
    e.spcCode = hostCode;
    if (err && err.params) e.params = err.params;
    return e;
  }
  const entry = ERRNO[code] || ERRNO.EIO;
  let message = code + ': ' + entry[1] + ', ' + syscall;
  if (path !== undefined) message += " '" + path + "'";
  if (dest !== undefined) message += " -> '" + dest + "'";
  const e = new Error(message);
  e.errno = -entry[0];
  e.code = code;
  e.syscall = syscall;
  if (path !== undefined) e.path = path;
  if (dest !== undefined) e.dest = dest;
  e.spcCode = hostCode;
  if (err && err.params) e.params = err.params;
  return e;
}

/** 把一次宿主调用的错误翻译成某个系统调用的名字（每个 API 的 syscall 照宿主 Node 的真值） */
function withSyscall(syscall, path, dest, fn) {
  try {
    return fn();
  } catch (err) {
    if (err && typeof err.code === 'string' && !err.spcCode) {
      throw toNodeError(err, syscall, path, dest);
    }
    throw err; // 我们自己抛的参数校验错误（ERR_INVALID_ARG_*）原样上抛
  }
}

// ──────────────────────────── 参数校验（错误形状照 Node）────────────────────────────

function inspectValue(v) {
  if (typeof v === 'string') return "'" + v + "'";
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return 'an instance of ' + ((v && v.constructor && v.constructor.name) || 'Object');
}

function describeType(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t !== 'object') return t === 'function' ? 'function' : 'type ' + t + ' (' + String(v) + ')';
  return 'an instance of ' + ((v.constructor && v.constructor.name) || 'Object');
}

function invalidArgType(name, expected, value) {
  const e = new TypeError(
    'The "' + name + '" argument must be of type ' + expected.join(' or ') + '. Received ' + describeType(value),
  );
  e.code = 'ERR_INVALID_ARG_TYPE';
  return e;
}

function invalidArgValue(name, value, reason) {
  const e = new TypeError("The argument '" + name + "' " + reason + '. Received ' + inspectValue(value));
  e.code = 'ERR_INVALID_ARG_VALUE';
  return e;
}

function unknownEncoding(enc) {
  const e = new TypeError('Unknown encoding: ' + enc);
  e.code = 'ERR_UNKNOWN_ENCODING';
  return e;
}

/** 沙箱明确不支持的能力：响亮抛错（照 node-os/node-util 的既有做法） */
function unsupported(name, why) {
  const e = new Error(name + ' is not available in the sandbox: ' + why);
  e.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
  e.method = name;
  return e;
}

/** 造一个"调用即抛"的替身（保留函数形状，别让依赖在 `typeof x === 'function'` 上被骗过去后静默分支） */
function stub(name, why) {
  return function sandboxUnsupported() {
    throw unsupported(name, why);
  };
}

/**
 * 路径参数归一化：Node 接受 string / Buffer / URL。
 * ⚠️ **数字不被当作 fd**（Node 会把数字当文件描述符用）：fd 面本批不支持，照类型错误报，
 * 这样插件立刻知道是自己传错了，而不是拿到一个"看起来能用"的 fd。
 */
function toPathString(p, name) {
  if (typeof p === 'string') return p;
  if (ArrayBuffer.isView(p)) {
    return Buffer.from(p.buffer, p.byteOffset, p.byteLength).toString('utf8');
  }
  if (p instanceof URL) return fileURLToPath(p);
  throw invalidArgType(name || 'path', ['string', 'Buffer', 'URL'], p);
}

/** 调用方写的是绝对路径吗（POSIX 语义 + Windows 形态都认，与宿主 resolvePluginPath 同一判据） */
function isAbsPath(p) {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** 沙箱的"当前目录"（= 数据目录）：来自引导层注入的环境事实，只解析一次 */
let cachedDataDir;
function dataDir() {
  if (cachedDataDir === undefined) {
    try {
      cachedDataDir = JSON.parse(globalThis.__spcEnv).dataDir;
    } catch {
      cachedDataDir = null;
    }
  }
  return cachedDataDir;
}

/**
 * 宿主给的绝对路径 → **调用方写的那种形式**：把"第一个被创建的目录"还原成调用方的前缀写法。
 *
 * 为什么要这一手：Node 的 `mkdirSync('b/c/d', {recursive:true})` 返回 `'b'`（WSL 实测）——
 * **照调用方写的那个相对形式**回。宿主侧为了安全必须用收敛后的绝对路径，所以返回值在这里还原：
 * 先数出 created 落在数据目录下几层，再把调用方那个字符串截到同样层数（**保留调用方自己的分隔符**）。
 */
function callerDepthForm(callerPath, absCreated) {
  const tail = inCallerForm(absCreated);
  const depth = tail.split(/[\\/]/).filter(Boolean).length;
  if (depth <= 0) return callerPath;
  // split 带捕获组：奇数位是分隔符，于是"前 depth 段"= 前 2*depth-1 个 token
  const tokens = callerPath.split(/([\\/])/);
  return tokens.slice(0, depth * 2 - 1).join('');
}

function inCallerForm(absPath) {
  const dir = dataDir();
  if (typeof absPath !== 'string' || typeof dir !== 'string' || dir === '') return absPath;
  const sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

function assertEncoding(enc) {
  // Node 的 getOptions：`'buffer'` 是"要 Buffer"的哨兵，跳过校验（后续在 toString 处才会炸）
  if (enc && enc !== 'buffer' && !Buffer.isEncoding(enc)) {
    throw invalidArgValue('encoding', enc, 'is invalid encoding');
  }
}

function assertMode(mode, name) {
  if (mode === undefined || mode === null) return undefined;
  if (typeof mode !== 'number' || !Number.isInteger(mode)) {
    // Node 的原话（internal/fs/utils.js 的校验器）："mode must be int32 or null/undefined"
    const e = new TypeError((name || 'mode') + ' must be int32 or null/undefined');
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  return mode;
}

// ──────────────────────────── Stats / Dirent ────────────────────────────

/**
 * `fs.Stats` 的形状照宿主 Node（WSL v22.22.1 实测）：
 *   · **自有数据属性**：dev mode nlink uid gid rdev blksize ino size blocks
 *     atimeMs mtimeMs ctimeMs birthtimeMs（顺序也照抄——`Object.keys` 会暴露顺序）
 *   · `atime`/`mtime`/`ctime`/`birthtime` 是**原型 getter**（每次访问现算 Date），不是自有属性
 *   · **没有 toJSON**（Node 也没有，别"顺手加"：加了 `JSON.stringify(stats)` 的行为就与 Node 不同）
 * `is*` 判定用 mode 位（`S_IFMT`），与 Node 一致——宿主给的 `kind` 字段留给 Dirent 用。
 */
class Stats {
  constructor(f) {
    this.dev = f.dev;
    this.mode = f.mode;
    this.nlink = f.nlink;
    this.uid = f.uid;
    this.gid = f.gid;
    this.rdev = f.rdev;
    this.blksize = f.blksize;
    this.ino = f.ino;
    this.size = f.size;
    this.blocks = f.blocks;
    this.atimeMs = f.atimeMs;
    this.mtimeMs = f.mtimeMs;
    this.ctimeMs = f.ctimeMs;
    this.birthtimeMs = f.birthtimeMs;
  }
  _checkModeProperty(bit) {
    return (this.mode & FS_CONSTANTS.S_IFMT) === bit;
  }
  isFile() {
    return this._checkModeProperty(FS_CONSTANTS.S_IFREG);
  }
  isDirectory() {
    return this._checkModeProperty(FS_CONSTANTS.S_IFDIR);
  }
  isBlockDevice() {
    return this._checkModeProperty(FS_CONSTANTS.S_IFBLK);
  }
  isCharacterDevice() {
    return this._checkModeProperty(FS_CONSTANTS.S_IFCHR);
  }
  isSymbolicLink() {
    return this._checkModeProperty(FS_CONSTANTS.S_IFLNK);
  }
  isFIFO() {
    return this._checkModeProperty(FS_CONSTANTS.S_IFIFO);
  }
  isSocket() {
    return this._checkModeProperty(FS_CONSTANTS.S_IFSOCK);
  }
  get atime() {
    return new Date(this.atimeMs);
  }
  get mtime() {
    return new Date(this.mtimeMs);
  }
  get ctime() {
    return new Date(this.ctimeMs);
  }
  get birthtime() {
    return new Date(this.birthtimeMs);
  }
}

/**
 * `fs.Dirent`：自有属性 `name` / `parentPath` / `path`（后者是前者的**废弃别名**，Node 里两个都有），
 * 原型上一组 `is*` 方法。`parentPath` = **调用方传进来的那个目录路径**（不是收敛后的绝对路径）——
 * 依赖普遍写 `join(dirent.parentPath, dirent.name)`，给绝对路径会让相对路径的调用方拼错。
 * 类型判据用宿主给的 `kind`（非自有属性，`Object.keys(dirent)` 只该看到那三个）。
 */
class Dirent {
  constructor(name, kind, parentPath) {
    this.name = name;
    this.parentPath = parentPath;
    this.path = parentPath;
    Object.defineProperty(this, '_kind', { value: kind, enumerable: false, writable: false });
  }
  isFile() {
    return this._kind === 'file';
  }
  isDirectory() {
    return this._kind === 'dir';
  }
  isSymbolicLink() {
    return this._kind === 'symlink';
  }
  isBlockDevice() {
    return this._kind === 'block';
  }
  isCharacterDevice() {
    return this._kind === 'char';
  }
  isFIFO() {
    return this._kind === 'fifo';
  }
  isSocket() {
    return this._kind === 'socket';
  }
}

// ──────────────────────────── options 归一化 ────────────────────────────

/** `readFile` 系列：options 可以是字符串（编码）或对象；返回要用的编码（null = 要 Buffer） */
function readFileOptions(options) {
  let enc = null;
  let flag;
  if (typeof options === 'string') {
    enc = options;
  } else if (options !== undefined && options !== null) {
    if (typeof options !== 'object') throw invalidArgType('options', ['string', 'Object'], options);
    if (options.encoding !== undefined && options.encoding !== null) enc = options.encoding;
    flag = options.flag;
  }
  if (enc !== null) {
    if (typeof enc !== 'string') throw invalidArgType('encoding', ['string', 'null', 'undefined'], enc);
    if (enc === 'buffer') throw unknownEncoding(enc);
    assertEncoding(enc);
  }
  if (flag !== undefined) {
    // 只认只读旗标：写旗标（'w'/'a'）在 Node 上会先截断/追加再读，我们不做这种"读一个文件却改了它"的事
    if (flag !== 'r' && flag !== 'r+' && flag !== 'rs' && flag !== 'rs+') {
      if (typeof flag === 'string' && READ_WRITE_FLAGS.has(flag)) {
        throw unsupported('fs.readFileSync', 'flag ' + flag + ' (only read-only flags are supported)');
      }
      throw invalidArgValue('flags', flag, 'is invalid');
    }
  }
  return enc;
}

/** `writeFile` / `appendFile` 系列：返回 { enc, append, exclusive } */
function writeFileOptions(options, defaultFlag) {
  let enc = 'utf8';
  let flag = defaultFlag;
  if (typeof options === 'string') {
    enc = options;
  } else if (options !== undefined && options !== null) {
    if (typeof options !== 'object') throw invalidArgType('options', ['string', 'Object'], options);
    if (options.encoding !== undefined && options.encoding !== null) enc = options.encoding;
    if (options.flag !== undefined) flag = options.flag;
  }
  if (typeof enc !== 'string') throw invalidArgType('encoding', ['string', 'null', 'undefined'], enc);
  // `{encoding:'buffer'}` 在**写**这一侧是错的（Node 实测：TypeError ERR_UNKNOWN_ENCODING "Unknown encoding: buffer"）；
  // `'buffer'` 只是**读目录/取路径**那类 API 的合法哨兵，不是编码名
  if (enc === 'buffer') throw unknownEncoding(enc);
  assertEncoding(enc);
  return { enc, flag };
}

/** 目录名编码：`'buffer'` 是**合法**取值（readdir 特有），其余照 assertEncoding */
function nameEncoding(options) {
  let enc = 'utf8';
  if (typeof options === 'string') {
    enc = options;
  } else if (options !== undefined && options !== null) {
    if (typeof options !== 'object') throw invalidArgType('options', ['string', 'Object'], options);
    if (options.encoding !== undefined) enc = options.encoding;
  }
  if (enc === 'buffer') return 'buffer';
  if (typeof enc !== 'string') throw invalidArgType('encoding', ['string'], enc);
  assertEncoding(enc);
  return enc;
}

/** 写旗标 → { append, exclusive }（宿主原语只认这两种语义，fd 面的旗标本批不支持） */
function flagSemantics(flag) {
  switch (flag) {
    case undefined:
    case 'w':
    case 'w+':
      return { append: false, exclusive: false };
    case 'a':
    case 'a+':
    case 'as':
    case 'as+':
      return { append: true, exclusive: false };
    case 'wx':
    case 'xw':
    case 'wx+':
    case 'xw+':
      return { append: false, exclusive: true };
    case 'ax':
    case 'xa':
    case 'ax+':
    case 'xa+':
      return { append: true, exclusive: true };
    default:
      throw invalidArgValue('flags', flag, 'is invalid');
  }
}

/**
 * 写进去的**字节视图**（文本走 `fs.writeText`，不经过这里）。
 *
 * ⚠️ 裸 `ArrayBuffer` 是**不接受**的：Node 的 `writeFileSync(p, new Uint8Array(2).buffer)` 报
 * `ERR_INVALID_ARG_TYPE`（data 的合法类型只有 string/Buffer/TypedArray/DataView）——
 * 差分测试抓出来的（我一开始"顺手"支持了它，那是与 Node 不同）。要写底层 buffer 就传视图。
 */
function toByteView(data) {
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw invalidArgType('data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
}

// ──────────────────────────── 同步 API ────────────────────────────

function readFileSync(path, options) {
  const enc = readFileOptions(options);
  const p = toPathString(path);
  let result;
  try {
    // 带编码读 → 宿主一次做完"读 + 解码"（`fs.readText`）；不带编码 → 走二进制通道拿字节。
    // 为什么解码不在沙箱里做：那要过 `bytes.decode` 权限点，会让"用 node:fs 读文本"额外依赖 bytes 声明
    // ——设计 §6 的映射表写的是 `fs.readFile → fs.read.data`，仿真模块不得引入新的权限语义。
    result = enc === null ? Buffer.from(callBytes('fs.readBytes', p)) : callJson('fs.readText', p, enc).content;
  } catch (err) {
    // syscall 照宿主真值：目标不存在时报的是 **open**；而"目标是目录"在 Node 上是读到一半才炸的
    // （syscall 是 **read**，文案 "illegal operation on a directory, read"）——两者都照抄。
    const code = errnoName(err && typeof err.code === 'string' ? err.code : 'INTERNAL');
    throw toNodeError(err, code === 'EISDIR' ? 'read' : 'open', p);
  }
  return result;
}

function writeImpl(file, data, options, defaultFlag) {
  const { enc, flag } = writeFileOptions(options, defaultFlag);
  const { append, exclusive } = flagSemantics(flag);
  const p = toPathString(file);
  const payload = JSON.stringify({ append, exclusive });
  withSyscall('open', p, undefined, () => {
    if (typeof data === 'string') {
      // 文本写：编码在宿主侧做（理由同上面的 readFileSync——不引入 bytes.* 依赖）
      callJson('fs.writeText', p, data, JSON.stringify({ append, exclusive, encoding: enc }));
      return;
    }
    callJson('fs.writeBytes', p, toByteView(data), payload);
  });
}

function writeFileSync(file, data, options) {
  writeImpl(file, data, options, 'w');
}

function appendFileSync(file, data, options) {
  writeImpl(file, data, options, 'a');
}

function statImpl(path, options, follow, syscall) {
  const opts = options !== undefined && options !== null && typeof options === 'object' ? options : undefined;
  if (opts && opts.bigint === true) {
    throw unsupported('fs.' + syscall + 'Sync', 'BigIntStats ({ bigint: true }) is not implemented');
  }
  const p = toPathString(path);
  try {
    const f = callJson('fs.statFull', p, follow ? 'true' : 'false');
    return new Stats(f);
  } catch (err) {
    if (opts && opts.throwIfNoEntry === false && err && err.code === 'ENOENT') return undefined;
    throw toNodeError(err, follow ? 'stat' : 'lstat', p);
  }
}

function statSync(path, options) {
  return statImpl(path, options, true, 'stat');
}

function lstatSync(path, options) {
  return statImpl(path, options, false, 'lstat');
}

function readdirSync(path, options) {
  const opts = options !== undefined && options !== null && typeof options === 'object' ? options : undefined;
  if (opts && opts.recursive === true) {
    throw unsupported('fs.readdirSync', '{ recursive: true } is not implemented');
  }
  const enc = nameEncoding(options);
  const p = toPathString(path);
  const res = withSyscall('scandir', p, undefined, () => callJson('fs.readdirEntries', p));
  if (opts && opts.withFileTypes === true) {
    return res.entries.map(
      (e) => new Dirent(enc === 'buffer' ? Buffer.from(e.name, 'utf8') : e.name, e.kind, p),
    );
  }
  return res.entries.map((e) => (enc === 'buffer' ? Buffer.from(e.name, 'utf8') : e.name));
}

function mkdirSync(path, options) {
  const opts = options !== undefined && options !== null && typeof options === 'object' ? options : {};
  const mode = assertMode(opts.mode);
  const p = toPathString(path);
  const payload = { recursive: opts.recursive === true };
  if (mode !== undefined) payload.mode = mode;
  const res = withSyscall('mkdir', p, undefined, () => callJson('fs.mkdir', p, JSON.stringify(payload)));
  // Node 的返回值：recursive 下给**第一个被创建的目录**（用调用方写的相对形式，见 callerDepthForm）；
  // 什么都没创建（已存在）给 undefined
  if (opts.recursive !== true || res.created === null) return undefined;
  return isAbsPath(p) ? res.created : callerDepthForm(p, res.created);
}

function mkdtempSync(prefix, options) {
  const enc = nameEncoding(options);
  const p = toPathString(prefix, 'prefix');
  // Node 自己会把 `XXXXXX` 拼在 prefix 后面再调 mkdtemp，所以它所有错误（连 `err.path`）都带 XXXXXX——
  // 报错文案要对齐就得照抄这一手（`tools/truth/data/fs-url-truth.json` 的 mkdtemp_missingParent 实测）
  const res = withSyscall('mkdtemp', p + 'XXXXXX', undefined, () => callJson('fs.mkdtemp', p));
  // 返回值 = **调用方写的那个前缀 + 宿主给的随机后缀**（Node 实测：相对进、相对出）——
  // 这样调用方写 `data/t-` 就回 `data/t-abc123`，分隔符形状也照旧
  const created = p + String(res.suffix);
  return enc === 'buffer' ? Buffer.from(created, 'utf8') : created;
}

function rmSyncImpl(path, options, syscall) {
  const opts = options !== undefined && options !== null && typeof options === 'object' ? options : {};
  const p = toPathString(path);
  try {
    callJson('fs.rm', p, JSON.stringify({ recursive: opts.recursive === true, force: opts.force === true }));
  } catch (err) {
    const code = errnoName(err && typeof err.code === 'string' ? err.code : 'INTERNAL');
    if (code === 'EISDIR' && syscall === 'rm') {
      // Node 的 rmSync 对目录不给 recursive 时抛的是**非 errno** 的 SystemError（WSL 实测）：
      // name=SystemError code=ERR_FS_EISDIR errno=21(正) syscall='rm'
      const e = new Error(
        'Path is a directory: rm returned EISDIR (is a directory) ' + p,
      );
      e.name = 'SystemError';
      e.code = 'ERR_FS_EISDIR';
      e.errno = ERRNO.EISDIR[0];
      e.syscall = 'rm';
      e.path = p;
      e.spcCode = err.code;
      throw e;
    }
    if (code === 'EISDIR' && syscall === 'rmdir') {
      // rmdirSync(文件) 在 Node 上是 ENOTDIR（不是 EISDIR）
      throw toNodeError({ code: 'ENOTDIR', params: err.params }, 'rmdir', p);
    }
    // Node 的 rm 在"目标不存在"时报的 syscall 是 lstat（它内部先 lstat）
    const realSyscall = syscall === 'rm' && code === 'ENOENT' ? 'lstat' : syscall;
    throw toNodeError(err, realSyscall, p);
  }
}

function rmSync(path, options) {
  rmSyncImpl(path, options, 'rm');
}

function rmdirSync(path, options) {
  const opts = options !== undefined && options !== null && typeof options === 'object' ? options : {};
  const p = toPathString(path);
  if (opts.recursive === true) {
    // Node 22 里 `rmdir(…, {recursive:true})` 已废弃，内部**转成 rm**（见 node/lib/fs.js）。
    // 这里照做（只是不发 DEP0147 警告：沙箱没有给插件看的警告通道，发了也没人看）。
    rmSyncImpl(p, { recursive: true, maxRetries: 0 }, 'rm');
    return;
  }
  // 非递归 rmdir 与 rm 的语义不同（空目录成功 / 非空 ENOTEMPTY / 目标不是目录 ENOTDIR），
  // 所以走宿主专门的 `fs.rmdir` 原语——用 rm 的 `{recursive:false}` 会得到 ERR_FS_EISDIR（那是 rm 的语义）
  withSyscall('rmdir', p, undefined, () => callJson('fs.rmdir', p));
}

/**
 * chmodSync：**唯一做掉的元数据写**。理由见 hostApi 的 fs.chmod 注释——它只作用于插件数据目录里的
 * 文件自己的权限位（不是宿主资源）。chown / utimes / fchmod 仍然抛错（属主/时间戳是宿主语义；
 * 实测依赖对这些调用都是 best-effort 包裹，抛错不会打断它们）。
 */
function chmodSync(path, mode) {
  const p = toPathString(path);
  const m = assertMode(mode, 'mode');
  if (m === undefined) throw invalidArgType('mode', ['int32'], mode);
  withSyscall('chmod', p, undefined, () => callJson('fs.chmod', p, String(m)));
}

function unlinkSync(path) {
  rmSyncImpl(path, { recursive: false, force: false }, 'unlink');
}

function renameSync(oldPath, newPath) {
  const from = toPathString(oldPath, 'oldPath');
  const to = toPathString(newPath, 'newPath');
  withSyscall('rename', from, to, () => callJson('fs.rename', from, to));
}

function copyFileSync(src, dest, mode) {
  const from = toPathString(src, 'src');
  const to = toPathString(dest, 'dest');
  const flags = assertMode(mode, 'mode');
  withSyscall('copyfile', from, to, () =>
    callJson('fs.copyFile', from, to, JSON.stringify({ exclusive: flags === FS_CONSTANTS.COPYFILE_EXCL })),
  );
}

/**
 * **返回给插件的路径必须是沙箱形态**（POSIX：\ → /）。
 *
 * 为什么：沙箱的路径语义固定 posix，而数据目录在 Windows 开发机上是 `C:\Users\…`。
 * `process.cwd()` / `os.tmpdir()` 这些**出口**已经统一成 `C:/Users/…`（core/emulated-env.ts），
 * 路径类的返回值必须跟着一致，否则"把沙箱路径喂回沙箱 path 函数"就会错位——
 * 实测：`tmp` 包拿 `path.relative(fs.realpathSync(os.tmpdir()), …)` 一对，反斜杠立刻算出 `../C:\…`。
 * 宿主侧照旧用宿主形态（`validatePath` 会先 resolve 归一化），只有**交回插件**的这一层要转。
 */
function toSandboxForm(p) {
  return p.indexOf('\\') === -1 ? p : p.split('\\').join('/');
}

function realpathSync(path, options) {
  const enc = nameEncoding(options);
  const p = toPathString(path);
  // syscall 照真值：realpathSync 对不存在的路径报的是 lstat
  const res = withSyscall('lstat', p, undefined, () => callJson('fs.realpath', p));
  const out = toSandboxForm(res.path);
  return enc === 'buffer' ? Buffer.from(out, 'utf8') : out;
}
realpathSync.native = realpathSync;

function accessSync(path, mode) {
  const p = toPathString(path);
  const m = mode === undefined || mode === null ? FS_CONSTANTS.F_OK : assertMode(mode, 'mode');
  withSyscall('access', p, undefined, () => callJson('fs.access', p, String(m)));
}

function existsSync(path) {
  // Node 的 existsSync **永不抛**（连类型错都不抛，返回 false）
  try {
    const p = toPathString(path);
    callJson('fs.statFull', p, 'true');
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────── 回调风格（Node 的薄包装）────────────────────────────

/**
 * 回调风格的通用包装（设计 §8 已定：支持回调，且**必须异步触发**）。
 * 为什么异步是硬要求：Node 的 fs 回调来自线程池，依赖的时序假设建立在这上面；
 * 同步触发会让"在 Node 上能跑"的代码在沙箱里出微妙的顺序错（静默行为差异）。
 * 这里用 queueMicrotask（引导层补给的标准全局）——比 nextTick 更接近 Node 的"回调在微任务之后"，
 * 但**不完全相同**：我们的回调本身就是一个微任务（见文件头边界 3）。
 */
function callbackify(syncFn) {
  return function sandboxCallbackStyle(...args) {
    const cb = args.pop();
    if (typeof cb !== 'function') {
      throw invalidArgType('callback', ['function'], cb);
    }
    queueMicrotask(() => {
      let value;
      try {
        value = syncFn.apply(null, args);
      } catch (err) {
        cb(err);
        return;
      }
      cb(null, value);
    });
  };
}

/** `fs.exists(path, cb)` 的回调只收一个布尔（没有 err 位），单独一个包装 */
function existsCallback(path, cb) {
  if (typeof cb !== 'function') throw invalidArgType('callback', ['function'], cb);
  queueMicrotask(() => cb(existsSync(path)));
}

// ──────────────────────────── promises 面 ────────────────────────────

/**
 * `fs.promises`：与同步实现**同一套动作**，只是形状是 Promise。
 * `async` 函数体一开始就同步执行，所以这里并没有真的把工作挪出事件循环（文件头边界 3）。
 */
const promises = {
  async access(path, mode) {
    return accessSync(path, mode);
  },
  async appendFile(path, data, options) {
    return appendFileSync(path, data, options);
  },
  async copyFile(src, dest, mode) {
    return copyFileSync(src, dest, mode);
  },
  async mkdir(path, options) {
    return mkdirSync(path, options);
  },
  async mkdtemp(prefix, options) {
    return mkdtempSync(prefix, options);
  },
  async readFile(path, options) {
    return readFileSync(path, options);
  },
  async readdir(path, options) {
    return readdirSync(path, options);
  },
  async realpath(path, options) {
    return realpathSync(path, options);
  },
  async rename(oldPath, newPath) {
    return renameSync(oldPath, newPath);
  },
  async rm(path, options) {
    return rmSync(path, options);
  },
  async rmdir(path, options) {
    return rmdirSync(path, options);
  },
  async stat(path, options) {
    return statSync(path, options);
  },
  async lstat(path, options) {
    return lstatSync(path, options);
  },
  async unlink(path) {
    return unlinkSync(path);
  },
  async writeFile(path, data, options) {
    return writeFileSync(path, data, options);
  },
  constants: FS_CONSTANTS,
  // 明确不支持的（与 fs.* 同一批，形状保持一致：调用即抛 ERR_NOT_SUPPORTED_IN_SANDBOX）
  chmod: stub('fs.promises.chmod', 'permission bits are host-managed'),
  chown: stub('fs.promises.chown', 'ownership is host-managed'),
  cp: stub('fs.promises.cp', 'recursive copy is not implemented yet'),
  glob: stub('fs.promises.glob', 'glob is not implemented yet'),
  lchmod: stub('fs.promises.lchmod', 'permission bits are host-managed'),
  lchown: stub('fs.promises.lchown', 'ownership is host-managed'),
  link: stub('fs.promises.link', 'hard links are not exposed to plugins'),
  lutimes: stub('fs.promises.lutimes', 'timestamps are host-managed'),
  open: stub('fs.promises.open', 'file descriptors are not exposed to plugins'),
  opendir: stub('fs.promises.opendir', 'directory handles are not exposed to plugins'),
  readlink: stub('fs.promises.readlink', 'symlinks are not exposed to plugins'),
  statfs: stub('fs.promises.statfs', 'filesystem statistics are not exposed to plugins'),
  symlink: stub('fs.promises.symlink', 'symlink creation is not exposed to plugins'),
  truncate: stub('fs.promises.truncate', 'truncate is not implemented yet'),
  utimes: stub('fs.promises.utimes', 'timestamps are host-managed'),
  watch: stub('fs.promises.watch', 'there is no inotify surface in the sandbox (poll with timers)'),
};

// ──────────────────────────── 明确不支持的能力 ────────────────────────────

const FD_WHY = 'file descriptors are not exposed to plugins';
const STREAM_WHY = 'streams are not available in the sandbox (this batch does not emulate node:stream)';
const WATCH_WHY = 'there is no inotify surface in the sandbox (poll with timers/@host/api)';
const SYMLINK_WHY = 'symlink/link creation is not exposed to plugins';
const META_WHY = 'host-managed metadata (mode/owner/timestamps) is not exposed';

const open = stub('fs.open', FD_WHY);
const openSync = stub('fs.openSync', FD_WHY);
const close = stub('fs.close', FD_WHY);
const closeSync = stub('fs.closeSync', FD_WHY);
const read = stub('fs.read', FD_WHY);
const readSync = stub('fs.readSync', FD_WHY);
const readv = stub('fs.readv', FD_WHY);
const readvSync = stub('fs.readvSync', FD_WHY);
const write = stub('fs.write', FD_WHY);
const writeSync = stub('fs.writeSync', FD_WHY);
const writev = stub('fs.writev', FD_WHY);
const writevSync = stub('fs.writevSync', FD_WHY);
const fstat = stub('fs.fstat', FD_WHY);
const fstatSync = stub('fs.fstatSync', FD_WHY);
const ftruncate = stub('fs.ftruncate', FD_WHY);
const ftruncateSync = stub('fs.ftruncateSync', FD_WHY);
const fsync = stub('fs.fsync', FD_WHY);
const fsyncSync = stub('fs.fsyncSync', FD_WHY);
const fdatasync = stub('fs.fdatasync', FD_WHY);
const fdatasyncSync = stub('fs.fdatasyncSync', FD_WHY);
const fchmod = stub('fs.fchmod', FD_WHY);
const fchmodSync = stub('fs.fchmodSync', FD_WHY);
const fchown = stub('fs.fchown', FD_WHY);
const fchownSync = stub('fs.fchownSync', FD_WHY);
const futimes = stub('fs.futimes', FD_WHY);
const futimesSync = stub('fs.futimesSync', FD_WHY);
const createReadStream = stub('fs.createReadStream', STREAM_WHY);
const createWriteStream = stub('fs.createWriteStream', STREAM_WHY);
const watch = stub('fs.watch', WATCH_WHY);
const watchFile = stub('fs.watchFile', WATCH_WHY);
const unwatchFile = stub('fs.unwatchFile', WATCH_WHY);
const symlink = stub('fs.symlink', SYMLINK_WHY);
const symlinkSync = stub('fs.symlinkSync', SYMLINK_WHY);
const link = stub('fs.link', SYMLINK_WHY);
const linkSync = stub('fs.linkSync', SYMLINK_WHY);
const readlink = stub('fs.readlink', SYMLINK_WHY);
const readlinkSync = stub('fs.readlinkSync', SYMLINK_WHY);
const lchmod = stub('fs.lchmod', META_WHY);
const lchmodSync = stub('fs.lchmodSync', META_WHY);
const chown = stub('fs.chown', META_WHY);
const chownSync = stub('fs.chownSync', META_WHY);
const lchown = stub('fs.lchown', META_WHY);
const lchownSync = stub('fs.lchownSync', META_WHY);
const utimes = stub('fs.utimes', META_WHY);
const utimesSync = stub('fs.utimesSync', META_WHY);
const lutimes = stub('fs.lutimes', META_WHY);
const lutimesSync = stub('fs.lutimesSync', META_WHY);
const opendir = stub('fs.opendir', 'directory handles are not exposed to plugins');
const opendirSync = stub('fs.opendirSync', 'directory handles are not exposed to plugins');
const statfs = stub('fs.statfs', 'filesystem statistics are not exposed to plugins');
const statfsSync = stub('fs.statfsSync', 'filesystem statistics are not exposed to plugins');
const cp = stub('fs.cp', 'recursive copy is not implemented yet');
const cpSync = stub('fs.cpSync', 'recursive copy is not implemented yet');
const glob = stub('fs.glob', 'glob is not implemented yet');
const globSync = stub('fs.globSync', 'glob is not implemented yet');
const openAsBlob = stub('fs.openAsBlob', 'there is no Blob in the sandbox yet');
const truncate = stub('fs.truncate', 'truncate is not implemented yet');
const truncateSync = stub('fs.truncateSync', 'truncate is not implemented yet');
class ReadStream extends stub('fs.ReadStream', STREAM_WHY) {}
class WriteStream extends stub('fs.WriteStream', STREAM_WHY) {}
const FileReadStream = ReadStream;
const FileWriteStream = WriteStream;
class Dir extends stub('fs.Dir', 'directory handles are not exposed to plugins') {}

// ──────────────────────────── 导出 ────────────────────────────

const fs = {
  // 类与常量
  Stats,
  Dirent,
  ReadStream,
  WriteStream,
  FileReadStream,
  FileWriteStream,
  Dir,
  constants: FS_CONSTANTS,
  F_OK: FS_CONSTANTS.F_OK,
  R_OK: FS_CONSTANTS.R_OK,
  W_OK: FS_CONSTANTS.W_OK,
  X_OK: FS_CONSTANTS.X_OK,
  promises,

  // 读
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
  accessSync,
  existsSync,

  // 写
  writeFileSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  renameSync,
  copyFileSync,

  // 回调风格
  readFile: callbackify(readFileSync),
  writeFile: callbackify(writeFileSync),
  appendFile: callbackify(appendFileSync),
  readdir: callbackify(readdirSync),
  stat: callbackify(statSync),
  lstat: callbackify(lstatSync),
  mkdir: callbackify(mkdirSync),
  mkdtemp: callbackify(mkdtempSync),
  rm: callbackify(rmSync),
  rmdir: callbackify(rmdirSync),
  unlink: callbackify(unlinkSync),
  rename: callbackify(renameSync),
  copyFile: callbackify(copyFileSync),
  realpath: callbackify(realpathSync),
  access: callbackify(accessSync),
  exists: existsCallback,
  chmod: callbackify(chmodSync),

  // 明确不支持
  open,
  openSync,
  close,
  closeSync,
  read,
  readSync,
  readv,
  readvSync,
  write,
  writeSync,
  writev,
  writevSync,
  fstat,
  fstatSync,
  ftruncate,
  ftruncateSync,
  fsync,
  fsyncSync,
  fdatasync,
  fdatasyncSync,
  fchmod,
  fchmodSync,
  fchown,
  fchownSync,
  futimes,
  futimesSync,
  createReadStream,
  createWriteStream,
  watch,
  watchFile,
  unwatchFile,
  symlink,
  symlinkSync,
  link,
  linkSync,
  readlink,
  readlinkSync,
  chmodSync,
  lchmod,
  lchmodSync,
  chown,
  chownSync,
  lchown,
  lchownSync,
  utimes,
  utimesSync,
  lutimes,
  lutimesSync,
  opendir,
  opendirSync,
  statfs,
  statfsSync,
  cp,
  cpSync,
  glob,
  globSync,
  openAsBlob,
  truncate,
  truncateSync,
};

export {
  Stats,
  Dirent,
  ReadStream,
  WriteStream,
  FileReadStream,
  FileWriteStream,
  Dir,
  FS_CONSTANTS as constants,
  promises,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
  accessSync,
  existsSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  renameSync,
  copyFileSync,
  open,
  openSync,
  close,
  closeSync,
  read,
  readSync,
  readv,
  readvSync,
  write,
  writeSync,
  writev,
  writevSync,
  fstat,
  fstatSync,
  ftruncate,
  ftruncateSync,
  fsync,
  fsyncSync,
  fdatasync,
  fdatasyncSync,
  fchmod,
  fchmodSync,
  fchown,
  fchownSync,
  futimes,
  futimesSync,
  createReadStream,
  createWriteStream,
  watch,
  watchFile,
  unwatchFile,
  symlink,
  symlinkSync,
  link,
  linkSync,
  readlink,
  readlinkSync,
  chmodSync,
  lchmod,
  lchmodSync,
  chown,
  chownSync,
  lchown,
  lchownSync,
  utimes,
  utimesSync,
  lutimes,
  lutimesSync,
  opendir,
  opendirSync,
  statfs,
  statfsSync,
  cp,
  cpSync,
  glob,
  globSync,
  openAsBlob,
  truncate,
  truncateSync,
};

export const {
  F_OK,
  R_OK,
  W_OK,
  X_OK,
} = FS_CONSTANTS;

// 回调风格也要有具名导出（`import { readFile } from 'node:fs'` 很常见）
export const readFile = fs.readFile;
export const writeFile = fs.writeFile;
export const appendFile = fs.appendFile;
export const readdir = fs.readdir;
export const stat = fs.stat;
export const lstat = fs.lstat;
export const mkdir = fs.mkdir;
export const mkdtemp = fs.mkdtemp;
export const rm = fs.rm;
export const rmdir = fs.rmdir;
export const unlink = fs.unlink;
export const rename = fs.rename;
export const copyFile = fs.copyFile;
export const realpath = fs.realpath;
export const access = fs.access;
export const exists = fs.exists;
export const chmod = fs.chmod;

export default fs;
