// 把 _audit/fs-tables.txt 的两张表填进 node-fs.js 的占位符（表是从 WSL 真值生成的，避免手抄出错）
// 用法：node _audit/tools/truth/splice-fs-tables.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { TRUTH_DATA, SANDBOX_MODULES } from '../paths.mjs';

const shimPath = SANDBOX_MODULES + '/node-fs.js';
const tables = readFileSync(TRUTH_DATA + '/fs-tables.txt', 'utf8');

const errnoStart = tables.indexOf('const ERRNO = {');
const constStart = tables.indexOf('const FS_CONSTANTS = {');
if (errnoStart < 0 || constStart < 0) throw new Error('表段落找不到，先跑 gen-fs-tables.mjs');
const errnoTable = tables.slice(errnoStart, constStart).trimEnd();
const constTable = tables.slice(constStart).split('\n// 无真值文案')[0].trimEnd();

let src = readFileSync(shimPath, 'utf8');
const before = src;
src = src.replace('/*__ERRNO_TABLE__*/', errnoTable);
src = src.replace('/*__FS_CONSTANTS_TABLE__*/', constTable);
if (src === before || src.includes('__ERRNO_TABLE__') || src.includes('__FS_CONSTANTS_TABLE__')) {
  throw new Error('占位符替换失败');
}
writeFileSync(shimPath, src, 'utf8');
console.log(`ok: errno ${errnoTable.split('\n').length - 2} 行、常量 ${constTable.split('\n').length - 2} 行`);
