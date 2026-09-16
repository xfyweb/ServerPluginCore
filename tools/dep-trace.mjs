// 追引用链：某包"卡在某个模块"时，查明那个引用究竟从哪条依赖链进来
//
// 为什么需要它：覆盖度报告只会说"A 卡在 X"，但那**不代表 A 引用了 X**——可能是它的依赖引用的。
// 实测教训：`fs-extra` 被判为"卡在 stream"，追下去发现它自己根本没引用 stream，
// 是它的依赖 `graceful-fs` 带的，而后者只用了 `stream` 的 `Stream` 和 `call` 两个东西。
// 差之毫厘：不追链就会把"一个极小的 shim"估成"实现整个 stream"。
//
// 用法：
//   node tools/dep-trace.mjs fs-extra stream
//   node tools/dep-trace.mjs chokidar stream --dir ../_deps-survey
//   node tools/dep-trace.mjs tar zlib --depth 5
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const [rootPkg, target] = positional;
if (!rootPkg || !target) {
  console.error('用法：node tools/dep-trace.mjs <包名> <模块名> [--dir <取样目录>] [--depth N]');
  process.exit(2);
}
const DIR = opt('--dir', process.env.SPC_SURVEY_DIR ?? join(process.cwd(), '..', '_deps-survey'));
const MAX_DEPTH = Number(opt('--depth', 6));
const NM = join(DIR, 'node_modules');
if (!existsSync(NM)) {
  console.error(`找不到取样目录的 node_modules：${NM}（用 --dir 指定）`);
  process.exit(2);
}

/** 递归列出一个包目录下的源码文件（跳过它自己的 node_modules） */
function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.git') continue;
      const p = join(d, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.(js|cjs|mjs|ts)$/.test(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** 这个包的哪些文件**直接**引用了 target */
function directUsers(pkgName, pkgDir) {
  const re = new RegExp(`(?:require\\(\\s*|from\\s+|import\\s*\\(?\\s*)['"](?:node:)?${target.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]`);
  const hits = [];
  for (const f of sourceFiles(pkgDir)) {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    if (re.test(src)) hits.push(f.slice(pkgDir.length).replace(/\\/g, '/'));
  }
  return hits;
}

const readPkg = (name) => {
  const p = join(NM, name, 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

console.log(`目标模块："${target}"    根包："${rootPkg}"    取样目录：${DIR}\n`);

const hits = [];
const missing = [];
const seen = new Set();
(function bfs(name, depth, chain) {
  if (depth > MAX_DEPTH || seen.has(name)) return;
  seen.add(name);
  const dir = join(NM, name);
  if (!existsSync(dir)) { missing.push(`${name}（未安装）`); return; }
  const pkg = readPkg(name);
  if (!pkg) return;
  const users = directUsers(name, dir);
  if (users.length) hits.push({ name, version: pkg.version, depth, chain, files: users });
  for (const dep of Object.keys(pkg.dependencies ?? {})) bfs(dep, depth + 1, [...chain, name]);
})(rootPkg, 0, []);

if (!hits.length) {
  console.log(`没有找到直接引用 "${target}" 的包。`);
  console.log('可能原因：① 引用它的包没在依赖树里（可选依赖被跳过）；② 是运行期字符串拼接出来的引用。');
} else {
  console.log(`引用链上有 ${hits.length} 个包**直接**引用了它：\n`);
  for (const h of [...hits].sort((a, b) => a.depth - b.depth)) {
    const path = h.depth === 0 ? '（根包自己）' : h.chain.join(' → ') + ` → ${h.name}`;
    console.log(`  ${h.name}@${h.version}   [深度 ${h.depth}]  ${path}`);
    console.log(`      文件：${h.files.slice(0, 6).join(', ')}${h.files.length > 6 ? ` …(+${h.files.length - 6})` : ''}`);
  }
  const viaDep = hits.filter((h) => h.depth > 0);
  if (viaDep.length && !hits.some((h) => h.depth === 0)) {
    console.log(`\n  ⚠️ 根包 "${rootPkg}" **自己并没有引用** "${target}"——引用全部来自依赖链。`);
    console.log('     判断门槛时要以**实际引用的那个包**为准，不是根包（可能就是个小 shim 的事）。');
  }
}
if (missing.length) console.log(`\n未安装（依赖树里声明了但目录不存在）：${[...new Set(missing)].join(', ')}`);
