// 生成 `core/sandbox-modules/node-crypto.js` 要嵌入的静态表
// （`getHashes` / `getCiphers` / `getCurves` / `constants`），写进该文件的**生成区间**（标记之间）
// —— 可反复重跑（幂等）。约定见 `tools/truth/generated-block.mjs`。
//
// 用法：`node tools/truth/gen-crypto-tables.mjs`（真值先跑 `tools/truth/crypto-truth{,2}.mjs` 采）
// 取值取向：**固定基线**（与 path=posix、constants=Linux、os 三分法一致）——
// 这几个清单是宿主 OpenSSL 的真相，开发机与生产机可能不同，所以按仿真版本钉死。
//
// 附注（2026-09-27）：原版只往 stdout 打印（靠手贴进 shim），现在直接写进生成区间；
// `data/crypto-tables.txt` 仍写出，只作**人可读的记录**。
import { readFileSync, writeFileSync } from 'node:fs';
import { TRUTH_DATA, SANDBOX_MODULES } from '../paths.mjs';
import { spliceGenerated } from './generated-block.mjs';

const t1 = JSON.parse(readFileSync(TRUTH_DATA + '/crypto-truth.json', 'utf8'));
const t2 = JSON.parse(readFileSync(TRUTH_DATA + '/crypto-truth2.json', 'utf8'));

const arr = (name, list) => {
  const lines = [`const ${name} = Object.freeze([`];
  for (let i = 0; i < list.length; i += 4) {
    lines.push('  ' + list.slice(i, i + 4).map((s) => JSON.stringify(s)).join(', ') + ',');
  }
  lines.push(']);');
  return lines.join('\n');
};

const consts = Object.entries(t2.constantsRaw);
const kWidth = Math.max(...consts.map(([k]) => k.length));
const constLines = ['const CONSTANTS = Object.freeze({'];
for (const [k, v] of consts) {
  constLines.push(`  ${k.padEnd(kWidth)}: ${typeof v === 'string' ? JSON.stringify(v) : v},`);
}
constLines.push('});');

const block = [
  arr('HASHES', t1.getHashes),
  '',
  arr('CIPHERS', t1.getCiphers),
  '',
  arr('CURVES', t2.getCurves),
  '',
  constLines.join('\n'),
  '',
  `// getHashes ${t1.getHashes.length} 项 / getCiphers ${t1.getCiphers.length} 项 / getCurves ${t2.getCurves.length} 项 / constants ${consts.length} 键`,
].join('\n');

writeFileSync(TRUTH_DATA + '/crypto-tables.txt', block + '\n', 'utf8');

const r = spliceGenerated({
  file: SANDBOX_MODULES + '/node-crypto.js',
  name: 'crypto-tables',
  origin: 'tools/truth/gen-crypto-tables.mjs',
  block,
  // 首次：从 HASHES 起，到 CONSTANTS 的收尾 `});`（再吞掉紧跟的计数注释行）
  bootstrap: {
    from: 'const HASHES = Object.freeze([',
    closeAfter: 'const CONSTANTS = Object.freeze({',
    close: '\n});',
    swallow: /^\/\/ getHashes \d+ 项/,
  },
});
console.log(
  r === 'unchanged'
    ? `未变化：表已是最新（hash ${t1.getHashes.length} / cipher ${t1.getCiphers.length} / curve ${t2.getCurves.length} / constants ${consts.length}）`
    : `ok：hash ${t1.getHashes.length} / cipher ${t1.getCiphers.length} / curve ${t2.getCurves.length} / constants ${consts.length}，已写 data/crypto-tables.txt 并填入 shim`,
);
