// 从 zlib 真值生成 node-zlib.js 要嵌入的 constants / codes 表（**固定 22.22.1 基线**）
//   用法：node _audit/gen-zlib-tables.mjs > tools/truth/data/zlib-tables.txt
import { readFileSync, writeFileSync } from 'node:fs';
import { TRUTH_DATA, SANDBOX_MODULES } from '../paths.mjs';

const t = JSON.parse(readFileSync(TRUTH_DATA + '/zlib-truth.json', 'utf8'));
const entries = Object.entries(t.constants);
const width = Math.max(...entries.map(([k]) => k.length));

const out = [];
out.push('/** zlib 常量表（v22.22.1 基线；含 zlib / brotli / zstd 三族） */');
out.push('const CONSTANTS = Object.freeze({');
for (const [k, v] of entries) {
  out.push(`  ${k.padEnd(width)}: ${typeof v === 'string' ? JSON.stringify(v) : v},`);
}
out.push('});');
out.push('');
out.push('/**');
out.push(" * `zlib.codes`：Node 给的是**双向映射**（`0 → 'Z_OK'` 且 `'Z_OK' → 0`），实测确认。");
out.push(' * ⚠️ **只收错误码那 9 个**——其余 Z_* 是参数/策略常量，数值会撞车');
out.push(' * （`Z_DEFAULT_STRATEGY` 也是 0，全表双向映射会把 `Z_OK` 覆盖掉，实测踩到）。');
out.push(' */');
out.push('const CODES = Object.freeze((() => {');
out.push('  const map = {};');
out.push('  const ERROR_CODES = [');
for (const n of [
  'Z_OK',
  'Z_STREAM_END',
  'Z_NEED_DICT',
  'Z_ERRNO',
  'Z_STREAM_ERROR',
  'Z_DATA_ERROR',
  'Z_MEM_ERROR',
  'Z_BUF_ERROR',
  'Z_VERSION_ERROR',
]) {
  out.push(`    '${n}',`);
}
out.push('  ];');
out.push('  for (const name of ERROR_CODES) {');
out.push('    const value = CONSTANTS[name];');
out.push("    if (typeof value !== 'number') continue;");
out.push('    map[name] = value;');
out.push('    map[value] = name;');
out.push('  }');
out.push('  return map;');
out.push('})());');

const target = TRUTH_DATA + '/zlib-tables.txt';
writeFileSync(target, out.join('\n') + `\n\n// constants ${entries.length} 键\n`, 'utf8');

// 同时把表填进 shim 的对应区间（省得再手工拼一次）
const shimPath = SANDBOX_MODULES + '/node-zlib.js';
const shim = readFileSync(shimPath, 'utf8');
const start = shim.indexOf('/** zlib 常量表');
const end = shim.indexOf('// ──────────────────────────── 明确不支持的');
if (start < 0 || end < 0) throw new Error('shim 里的表区间没找到');
writeFileSync(
  shimPath,
  shim.slice(0, start) + out.join('\n') + '\n\n' + shim.slice(end),
  'utf8',
);
console.log(`ok：constants ${entries.length} 键、codes ${9} 个错误码，已写 ${target} 并填入 shim`);
