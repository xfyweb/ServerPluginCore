// 采集"候选包到底用了 stream 的哪些面"——逐行列出调用点，作为 shim 的范围依据
// 用法：node _audit/tools/truth/stream-surface.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SURVEY_DIR } from '../paths.mjs';

const ROOT = SURVEY_DIR + '/node_modules';
const PKGS = ['graceful-fs', 'fast-glob', 'csv-parse', 'chokidar', 'proper-lockfile'];

/** 只扫真正会被装载的入口：package.json 的 main / module / exports 指向的文件及同目录树 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const PATTERNS = [
  /require\(\s*['"](?:node:)?stream['"]\s*\)/g,
  /from\s+['"](?:node:)?stream['"]/g,
  /require\(\s*['"](?:node:)?stream\/(\w+)['"]\s*\)/g,
  /from\s+['"](?:node:)?stream\/(\w+)['"]/g,
  // 用到的成员名（尽可能具体的写法）
  /\bStream\b/g,
  /\b(Readable|Writable|Duplex|Transform|PassThrough)\b/g,
  /\b(pipeline|finished|addAbortSignal|isReadable|isWritable)\b/g,
];

for (const pkg of PKGS) {
  const dir = join(ROOT, pkg);
  let dirStat;
  try {
    dirStat = statSync(dir);
  } catch {
    console.log(`\n=== ${pkg}: 未安装`);
    continue;
  }
  if (!dirStat.isDirectory()) continue;
  console.log(`\n=== ${pkg}`);
  const files = walk(dir);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const hits = [];
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) hits.push(m[0]);
    }
    if (hits.length === 0) continue;
    const counts = new Map();
    for (const h of hits) counts.set(h, (counts.get(h) ?? 0) + 1);
    const rel = f.slice(dir.length + 1);
    const summary = [...counts.entries()].map(([k, v]) => `${k}×${v}`).join(', ');
    console.log(`  ${rel}: ${summary}`);
  }
}
