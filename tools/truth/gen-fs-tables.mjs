// 生成 `core/sandbox-modules/node-fs.js` 的两张真值表（errno 名字→[号, 文案] / `fs.constants`），
// 写进该文件的**生成区间**（标记之间）—— 可反复重跑（幂等）。约定见 `tools/truth/generated-block.mjs`。
//
// 用法：`node tools/truth/gen-fs-tables.mjs`（真值先跑 `tools/truth/fs-url-truth.mjs` 采）
import { readFileSync } from 'node:fs';
import { TRUTH_DATA, SANDBOX_MODULES } from '../paths.mjs';
import { spliceGenerated } from './generated-block.mjs';

const truth = JSON.parse(readFileSync(TRUTH_DATA + '/fs-url-truth.json', 'utf8'));

// ① errno：名字 → [Linux 正值, strerror 文案]（写 err.message 用；Node 的 err.errno 是它的相反数）
const unknown = [];
const rows = [];
for (const [name, { num, message }] of Object.entries(truth.systemErrorMessages)) {
  // libuv 对不认识的号返回 "Unknown system error N"；这种不算真值，不进表（缺了就退回 EIO 的文案）
  if (/^Unknown system error/.test(message)) {
    unknown.push(name);
    continue;
  }
  rows.push([name, num, message]);
}
rows.sort((a, b) => a[1] - b[1]);

const width = Math.max(...rows.map((r) => r[0].length));
const lines = ['const ERRNO = {'];
for (const [name, num, message] of rows) {
  lines.push(`  ${name.padEnd(width)}: [${String(num).padStart(3)}, ${JSON.stringify(message)}],`);
}
lines.push('};');

// ② fs.constants：键 → 值（照抄宿主，不自己编）
const c = truth.fsConstants;
const cw = Math.max(...Object.keys(c).map((k) => k.length));
const clines = ['const FS_CONSTANTS = {'];
for (const [k, v] of Object.entries(c)) clines.push(`  ${k.padEnd(cw)}: ${v},`);
clines.push('};');

const block = [
  ...lines,
  '',
  ...clines,
  `// 无真值文案的 errno（libuv 不认识）：${unknown.join(' ') || '（无）'}`,
  `// 共 ${rows.length} 个 errno、${Object.keys(c).length} 个 fs 常量`,
].join('\n');

const r = spliceGenerated({
  file: SANDBOX_MODULES + '/node-fs.js',
  name: 'fs-tables',
  origin: 'tools/truth/gen-fs-tables.mjs',
  block,
  bootstrap: {
    from: 'const ERRNO = {',
    closeAfter: 'const FS_CONSTANTS = {',
    close: '\n};',
    swallow: /^\/\/ 共 \d+ 个 errno/,
  },
});
console.log(
  r === 'unchanged'
    ? `未变化：表已是最新（errno ${rows.length} 条、常量 ${Object.keys(c).length} 条）`
    : `ok: errno ${rows.length} 条、fs 常量 ${Object.keys(c).length} 条（无文案的 errno：${unknown.length}）`,
);
