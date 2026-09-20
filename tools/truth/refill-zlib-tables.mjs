// 把（修好的）表填回 node-zlib.js：按"生成说明注释"与"明确不支持"两个锚点定位
import { readFileSync, writeFileSync } from 'node:fs';
import { TRUTH_DATA, SANDBOX_MODULES } from '../paths.mjs';

const shimPath = SANDBOX_MODULES + '/node-zlib.js';
const s = readFileSync(shimPath, 'utf8');
const anchorStart = '// 由 `tools/truth/gen-zlib-tables2.mjs` 从 WSL 真值生成——**勿手改**';
const anchorEnd = '// ──────────────────────────── 明确不支持的';
const i = s.indexOf(anchorStart);
const j = s.indexOf(anchorEnd);
if (i < 0 || j < 0 || j < i) throw new Error('锚点没找到');

const tables = readFileSync(TRUTH_DATA + '/zlib-tables.txt', 'utf8').split('\n// constants ')[0].trimEnd();
if (!tables.includes('const CONSTANTS') || !tables.includes('const CODES')) throw new Error('表内容不对');

const out = s.slice(0, i + anchorStart.length) + '\n\n' + tables + '\n\n' + s.slice(j);
writeFileSync(shimPath, out, 'utf8');
console.log('ok：表已填回，长度', out.length);
