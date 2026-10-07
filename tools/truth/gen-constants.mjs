// 一次性生成器：把 WSL(Linux) 宿主 Node dump 出来的 constants 真值 → core/sandbox-modules/node-constants.js
// 用法（从仓库根）：node tools/truth/gen-constants.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { SANDBOX_MODULES, TRUTH_DATA } from '../paths.mjs';

const SRC = TRUTH_DATA + '/const-linux.json';
const OUT = SANDBOX_MODULES + '/node-constants.js';
const d = JSON.parse(readFileSync(SRC, 'utf8'));

/** Node 的 lib/constants.js 就是这个合并顺序（对象键序是可观测的，照抄） */
const groups = [
  ['os.constants.dlopen', d.os.dlopen ?? {}],
  ['os.constants.errno', d.os.errno ?? {}],
  ['os.constants.priority', d.os.priority ?? {}],
  ['os.constants.signals', d.os.signals ?? {}],
  ['fs.constants', d.fs ?? {}],
  ['crypto.constants', d.crypto ?? {}],
];

const flat = new Map();
for (const [, obj] of groups) {
  for (const [k, v] of Object.entries(obj)) flat.set(k, v);
}
const keys = [...flat.keys()];
if (!keys.every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) {
  throw new Error('键名不是合法标识符，不能生成解构导出');
}

const lines = [];
lines.push('// node:constants 仿真——**Linux/POSIX 真值**（不是转录头文件，是宿主 Node 的运行值）');
lines.push('//');
lines.push('// Node 的 `constants` 已被官方标记为 deprecated，实际是 `os.constants.{dlopen,errno,priority,signals}`');
lines.push('// + `fs.constants` + `crypto.constants` 的合并（见 `lib/constants.js`）。生态里仍有不少包在**加载期**');
lines.push('// 就 `require(\'constants\')` 取 `O_RDONLY` / `F_OK` / `COPYFILE_EXCL` 一类。');
lines.push('//');
lines.push('// **取值取向：Linux**——与 `node-path.js` 固定 posix 语义一致（本项目暂不支持 Windows 部署，见 ROADMAP）。');
lines.push('// 值来自真机运行值，逐键可核：');
lines.push(`//   $ wsl -e node tools/truth/dump-const.mjs   # ${d.platform}/${d.arch}, node ${d.node}`);
lines.push('//   → 再跑 tools/truth/gen-constants.mjs 生成本文件（真值在 tools/truth/data/ 下）');
lines.push('// 缺失键说明：`O_SYMLINK` 在 Linux 上**不存在**（它是 macOS/BSD 的键）——曾经"补"过一个');
lines.push('// `O_SYMLINK = 0`，那是在 Linux 上凭空造键，已删除。`SIGBREAK`/`SIGINFO`/`SIGLOST`、`WSA*` errno');
lines.push('// 同样不在表里（Windows/BSD 专有）。`defaultCipherList`/`defaultCoreCipherList` 是字符串，照实带出。');
lines.push('//');
lines.push('// 内联约束：静态、无占位符。Node 侧是 frozen，这里同样冻结。');
lines.push('');
lines.push('const constants = Object.freeze({');
for (const [label, obj] of groups) {
  const entries = Object.entries(obj);
  if (entries.length === 0) continue;
  lines.push(`  // ── ${label}（${entries.length} 键）──`);
  for (const [k, v] of entries) {
    // crypto 组里有字符串键（defaultCipherList / defaultCoreCipherList），必须照字面量引号化
    lines.push(`  ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v},`);
  }
}
lines.push('});');
lines.push('');
lines.push('export default constants;');
lines.push('');
lines.push('export const {');
for (const k of keys) lines.push(`  ${k},`);
lines.push('} = constants;');
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`wrote ${OUT}: ${keys.length} keys (fs ${Object.keys(d.fs).length}, errno ${Object.keys(d.os.errno).length}, signals ${Object.keys(d.os.signals).length}, crypto ${Object.keys(d.crypto).length})`);
