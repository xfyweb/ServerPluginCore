// Windows 真值采集（契约基线 node v24.20.0 / win32 / x64）
//
// 为什么必须用真 Windows 的 Node：`os.constants` 是 `src/node_constants.cc` 在**编译期**由平台宏
// （`#ifdef SIGINT` / `#ifdef WSAEINVAL` / `#ifdef E2BIG`）决定的 —— 本地 `node/` 源码（v27）
// 只能告诉你有哪些键，**给不出 Windows 的数值**；Linux 那份更是另一套。
//
// 用法（判卷人 = **本机 node**；见 tools/paths.mjs 的 JUDGE_NODE）：
//   & $env:SPC_JUDGE_NODE  tools/truth/win-truth.mjs > tools/truth/data/win-truth.json
import constants from 'node:constants';
import * as os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const sortedEntries = (obj) =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const out = {
  meta: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    // 采集时点：常量表是编译期定的，与运行环境无关，所以这个值可复现
    collectedAt: new Date().toISOString(),
  },

  // ── 顶层 `node:constants`（= os.constants.{dlopen,errno,priority,signals} + fs.constants + crypto.constants 合并）──
  topLevel: sortedEntries({ ...constants }),

  // ── 分组形状（决定我们 shim 的键集与分组）──
  groups: {
    errno: sortedEntries(os.constants.errno),
    signals: sortedEntries(os.constants.signals),
    priority: sortedEntries(os.constants.priority),
    dlopen: sortedEntries(os.constants.dlopen),
    libuv: sortedEntries(os.constants.libuv ?? {}),
    // os.constants 自己的键（可能还有 uv 之类的组）
    osConstantsKeys: Object.keys(os.constants).sort(),
  },

  // ── 由平台决定的行为性事实（我们的 `__spcEnv` 要按平台给这些）──
  platformFacts: {
    eol: JSON.stringify(os.EOL),
    devNull: os.devNull,
    sep: path.sep,
    delimiter: path.delimiter,
    pathWin32Sep: path.win32.sep,
    pathPosixSep: path.posix.sep,
    titleCasePlatform: process.platform === 'win32' ? 'Win32' : process.platform,
    // 我们关心但可能不稳定的值（tmpdir/homedir 与机器有关，只记形状）
    tmpdirShape: typeof os.tmpdir() === 'string' && os.tmpdir().length > 0,
    endianness: os.endianness(),
  },

  // ── fs.constants 的键集（Windows 上多/少什么）──
  fsConstants: sortedEntries(constants),
};

console.log(JSON.stringify(out, null, 2));
