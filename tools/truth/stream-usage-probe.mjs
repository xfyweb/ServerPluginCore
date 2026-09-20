// 看候选包对 finished / stream 构造 的真实用法（决定 B1/B2 范围）
import { readFileSync } from 'node:fs';
import { SURVEY_DIR } from '../paths.mjs';

const ROOT = SURVEY_DIR + '/node_modules/';
const FILES = [
  'csv-parse/dist/cjs/index.cjs',
  'csv-parse/dist/cjs/sync.cjs',
  'csv-parse/lib/api/index.js',
  'proper-lockfile/lib/adapter.js',
  'chokidar/index.js',
];

for (const f of FILES) {
  let src;
  try {
    src = readFileSync(ROOT + f, 'utf8');
  } catch {
    console.log(`--- ${f}: 读不到`);
    continue;
  }
  const lines = src.split(/\r?\n/);
  const hits = [];
  lines.forEach((l, i) => {
    if (/\bfinished\b/.test(l) || /require\(['"](node:)?stream/.test(l) || /from ['"](node:)?stream/.test(l)) {
      hits.push(`  ${i + 1}: ${l.trim().slice(0, 150)}`);
    }
  });
  console.log(`--- ${f}: ${hits.length} 处`);
  for (const h of hits.slice(0, 14)) console.log(h);
}
