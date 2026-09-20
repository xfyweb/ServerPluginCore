// 在 **Windows 的 node v22.22.1** 里跑：把 constants / os.constants / 平台行为事实 dump 成 JSON。
//
// 判卷人：官方 node v22.22.1 解压出的 `node.exe`（仓库外；路径见 tools/paths.mjs 的 JUDGE_NODE）。
// 用法：
//   & $env:SPC_JUDGE_NODE  tools/truth/dump-const-win.mjs
//
// 输出格式与 `const-linux.json` **同形**（fs / os / crypto 三组 + 平台事实），这样差分脚本可以逐键比对。
import { writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodeCrypto from 'node:crypto';
import nodePath from 'node:path';
import { TRUTH_DATA } from '../paths.mjs';

const out = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  // 与 Linux 那份对齐的三个组
  fs: nodeFs.constants,
  os: nodeOs.constants,
  crypto: nodeCrypto.constants,
  // Windows 侧额外要钉的行为性事实（`EOL`/`devNull`/分隔符）
  facts: {
    EOL: JSON.stringify(nodeOs.EOL),
    devNull: nodeOs.devNull,
    sep: nodePath.sep,
    delimiter: nodePath.delimiter,
    endianness: nodeOs.endianness(),
  },
};
writeFileSync(TRUTH_DATA + '/const-win.json', JSON.stringify(out, null, 1));
console.log(
  'ok', process.version, process.platform, process.arch,
  'fs', Object.keys(out.fs).length,
  'errno', Object.keys(out.os.errno ?? {}).length,
  'signals', Object.keys(out.os.signals ?? {}).length,
  'priority', Object.keys(out.os.priority ?? {}).length,
  'dlopen', Object.keys(out.os.dlopen ?? {}).length,
  'crypto', Object.keys(out.crypto).length,
);
