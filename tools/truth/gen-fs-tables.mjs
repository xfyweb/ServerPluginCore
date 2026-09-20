// 从 _audit/data/fs-url-truth.json（WSL node v22.22.1 运行值）生成 node-fs.js 要嵌入的两张表：
//   ① errno：名字 → [Linux 正值, strerror 文案]（写 err.message 用；Node 的 err.errno 是它的相反数）
//   ② fs.constants：键 → 值（照抄宿主，不自己编）
// 用法：node _audit/tools/truth/gen-fs-tables.mjs
import { readFileSync } from 'node:fs';

const truth = JSON.parse(readFileSync(new URL('./fs-url-truth.json', import.meta.url), 'utf8'));

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
const lines = [];
lines.push(`const ERRNO = {`);
for (const [name, num, message] of rows) {
  lines.push(`  ${name.padEnd(width)}: [${String(num).padStart(3)}, ${JSON.stringify(message)}],`);
}
lines.push(`};`);

const c = truth.fsConstants;
const cw = Math.max(...Object.keys(c).map((k) => k.length));
const clines = [`const FS_CONSTANTS = {`];
for (const [k, v] of Object.entries(c)) clines.push(`  ${k.padEnd(cw)}: ${v},`);
clines.push(`};`);

process.stdout.write(
  lines.join('\n') +
    '\n\n' +
    clines.join('\n') +
    `\n\n// 无真值文案的 errno（libuv 不认识）：${unknown.join(' ') || '（无）'}\n` +
    `// 共 ${rows.length} 个 errno、${Object.keys(c).length} 个 fs 常量\n`,
);
