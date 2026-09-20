// 在 WSL(Linux) 里跑：把宿主 Node 真实暴露的 constants 按组 dump 成 JSON。
// 用法（在 WSL 里跑，取 Linux 真值）：wsl -e node <仓库>/tools/truth/dump-const.mjs
import { writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodeCrypto from 'node:crypto';
import { TRUTH_DATA } from '../paths.mjs';

const out = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  fs: nodeFs.constants,
  os: nodeOs.constants,
  crypto: nodeCrypto.constants,
};
writeFileSync(TRUTH_DATA + '/const-linux.json', JSON.stringify(out, null, 1));
console.log(
  'ok', process.version, process.platform, process.arch,
  'fs', Object.keys(out.fs).length,
  'errno', Object.keys(out.os.errno ?? {}).length,
  'signals', Object.keys(out.os.signals ?? {}).length,
  'crypto', Object.keys(out.crypto).length,
);
