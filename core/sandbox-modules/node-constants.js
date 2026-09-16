// node:constants 仿真——POSIX/Linux 常量值
//
// Node 的 `constants` 已被官方标记为 deprecated，它实际是 `fs.constants` + `crypto.constants` 的合并。
// 生态里仍有不少包在**加载期**就 `require('constants')` 取 `O_RDONLY` / `F_OK` / `COPYFILE_EXCL` 一类。
//
// **取值取向：POSIX/Linux**——与 `node-path.js` 固定 posix 语义一致（本项目暂不支持 Windows 部署，
// 见 ROADMAP「明确不做（现阶段）」）。这与"沙箱内真实能力由宿主执行"有一个已知缝隙：
// 若宿主是 Windows，这些数值与宿主 fs 的期望不一致。当前不构成问题（`fs` 仿真落地时，
// 若它校验这些 flag，应改为宿主侧解释而不是沿用这里的数值），但**宿主扩到 Windows 前必须重估**。
//
// 内联约束：静态、无占位符。

// fs.constants
export var F_OK = 0;
export var R_OK = 4;
export var W_OK = 2;
export var X_OK = 1;

export var O_RDONLY = 0;
export var O_WRONLY = 1;
export var O_RDWR = 2;
export var O_CREAT = 64;
export var O_EXCL = 128;
export var O_NOCTTY = 256;
export var O_TRUNC = 512;
export var O_APPEND = 1024;
export var O_DIRECTORY = 65536;
export var O_NOFOLLOW = 131072;
export var O_SYNC = 1052672;
export var O_DSYNC = 4096;
export var O_SYMLINK = 0;
export var O_NONBLOCK = 2048;

export var S_IFMT = 61440;
export var S_IFREG = 32768;
export var S_IFDIR = 16384;
export var S_IFCHR = 8192;
export var S_IFBLK = 24576;
export var S_IFIFO = 4096;
export var S_IFLNK = 40960;
export var S_IFSOCK = 49152;

export var COPYFILE_EXCL = 1;
export var COPYFILE_FICLONE = 2;
export var COPYFILE_FICLONE_FORCE = 4;

export var UV_FS_O_FILEMAP = 0;

export default {
  F_OK: F_OK,
  R_OK: R_OK,
  W_OK: W_OK,
  X_OK: X_OK,
  O_RDONLY: O_RDONLY,
  O_WRONLY: O_WRONLY,
  O_RDWR: O_RDWR,
  O_CREAT: O_CREAT,
  O_EXCL: O_EXCL,
  O_NOCTTY: O_NOCTTY,
  O_TRUNC: O_TRUNC,
  O_APPEND: O_APPEND,
  O_DIRECTORY: O_DIRECTORY,
  O_NOFOLLOW: O_NOFOLLOW,
  O_SYNC: O_SYNC,
  O_DSYNC: O_DSYNC,
  O_SYMLINK: O_SYMLINK,
  O_NONBLOCK: O_NONBLOCK,
  S_IFMT: S_IFMT,
  S_IFREG: S_IFREG,
  S_IFDIR: S_IFDIR,
  S_IFCHR: S_IFCHR,
  S_IFBLK: S_IFBLK,
  S_IFIFO: S_IFIFO,
  S_IFLNK: S_IFLNK,
  S_IFSOCK: S_IFSOCK,
  COPYFILE_EXCL: COPYFILE_EXCL,
  COPYFILE_FICLONE: COPYFILE_FICLONE,
  COPYFILE_FICLONE_FORCE: COPYFILE_FICLONE_FORCE,
  UV_FS_O_FILEMAP: UV_FS_O_FILEMAP,
};
