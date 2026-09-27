// 生成 `core/sandbox-modules/node-zlib.js` 里的 `constants` / `codes` 两张表，
// 写进该文件的**生成区间**（标记之间）—— 可反复重跑（幂等）。约定见 `tools/truth/generated-block.mjs`。
//
// 用法：`node tools/truth/gen-zlib-tables2.mjs`（真值先跑 `tools/truth/zlib-truth.mjs` 采）
// 取值取向：**固定基线**（与 path=posix、constants=Linux、crypto 静态清单同一取向）——
// 这几个清单是宿主压缩库的真相，开发机与生产机可能不同，所以按仿真版本钉死。
//
// 附注（2026-09-27）：原来的两步链 `gen-zlib-tables2 → data/zlib-tables.txt → refill-zlib-tables`
// 已并成这一个脚本（`refill-zlib-tables.mjs` 删除）；`data/zlib-tables.txt` 仍写出，只作**人可读的记录**。
import { readFileSync, writeFileSync } from 'node:fs';
import { TRUTH_DATA, SANDBOX_MODULES } from '../paths.mjs';
import { spliceGenerated } from './generated-block.mjs';

const t = JSON.parse(readFileSync(TRUTH_DATA + '/zlib-truth.json', 'utf8'));
const entries = Object.entries(t.constants);
const width = Math.max(...entries.map(([k]) => k.length));

const out = [];
out.push('/** zlib 常量表（含 zlib / brotli / zstd 三族） */');
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

const block = out.join('\n');

writeFileSync(
  TRUTH_DATA + '/zlib-tables.txt',
  block + `\n\n// constants ${entries.length} 键\n`,
  'utf8',
);

const r = spliceGenerated({
  file: SANDBOX_MODULES + '/node-zlib.js',
  name: 'zlib-tables',
  origin: 'tools/truth/gen-zlib-tables2.mjs',
  block,
  // 首次：从常量表起，到"明确不支持的"那节标题为止（那个标题保留在区间外）
  bootstrap: { from: '/** zlib 常量表', to: '// ──────────────────────────── 明确不支持的' },
});
console.log(
  r === 'unchanged'
    ? `未变化：表已是最新（constants ${entries.length} 键、codes 9 个错误码）`
    : `ok：constants ${entries.length} 键、codes 9 个错误码，已写 data/zlib-tables.txt 并填入 shim`,
);
