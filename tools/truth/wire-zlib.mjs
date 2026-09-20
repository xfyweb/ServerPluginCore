import { readFileSync, writeFileSync } from 'node:fs';
import { TRUTH_DATA } from '../paths.mjs';
// ① 填表
const shim = 'core/sandbox-modules/node-zlib.js';
let s = readFileSync(shim, 'utf8');
const tables = readFileSync(TRUTH_DATA + '/zlib-tables.txt', 'utf8').split('\n// constants ')[0].trimEnd();
if (!s.includes('/*__ZLIB_TABLES__*/')) throw new Error('占位符不在');
s = s.replace('/*__ZLIB_TABLES__*/', tables);
writeFileSync(shim, s, 'utf8');
// ② 权限点
const perm = 'core/permissions/registry.ts';
let p = readFileSync(perm, 'utf8');
const anchor = "registry.register({\n  name: 'crypto.hash',";
const add = `// zlib 组：压缩/解压也是**宿主代工**（原生压缩库不可复刻），scope=self 同理——输入输出都在调用方手里。
registry.register({
  name: 'zlib.compress',
  group: 'zlib',
  description: '压缩（deflate/gzip 及其 raw 形态）与 crc32',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

registry.register({
  name: 'zlib.decompress',
  group: 'zlib',
  description: '解压（inflate/gunzip/unzip 及其 raw 形态）',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

` + anchor;
if (!p.includes(anchor)) throw new Error('权限锚点没找到');
p = p.replace(anchor, add);
writeFileSync(perm, p, 'utf8');
// ③ 登记表
const reg = 'core/sandbox-modules/registry.ts';
let r = readFileSync(reg, 'utf8');
const regAnchor = "];\n\nconst BY_CANONICAL";
const regAdd = `  {
    canonical: 'zlib',
    stage: 'P3',
    needsHost: true,
    note: '最小集：**同步面 + 回调面**（\\\`deflateRawSync\\\`/\\\`inflateRawSync\\\`/\\\`gzipSync\\\`/\\\`crc32\\\` … 与对应的回调形态），宿主代工、字节进字节出；错误保真（\\\`Z_DATA_ERROR\\\`/\\\`Z_BUF_ERROR\\\` + message + errno）。**流式入口**（\\\`createGzip\\\` 一族）与 brotli/zstd **明确抛错**（前者等 \\\`stream\\\`，后者无实测需求）',
  },
];\n\nconst BY_CANONICAL`;
if (!r.includes(regAnchor)) throw new Error('登记表锚点没找到');
r = r.replace(regAnchor, regAdd);
writeFileSync(reg, r, 'utf8');
// ④ JSON 结果组（crc32 走 JSON 解码；bytes 方法由 binaryResult 决定用 __bin）
const sb = 'core/sandbox.ts';
let x = readFileSync(sb, 'utf8');
x = x.replace("new Set(['fs', 'lifecycle', 'events', 'url', 'crypto'])", "new Set(['fs', 'lifecycle', 'events', 'url', 'crypto', 'zlib'])");
writeFileSync(sb, x, 'utf8');
console.log('ok：表/权限/登记表/结果组都就位');
