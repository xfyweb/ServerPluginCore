// check-line-refs.mjs —— 注释里引的"源码路径:行号"，**那一行还是当初那一行吗**？
//
// 为什么需要它：注释引行号是为了标明**结论的出处**，而行号是**提交相对**的 ——
// 源码一升级就静默烂掉，而且没有任何东西会报错。这个工具把"结论过期了"变成一条能跑出来的结论。
//
// ⚠️ **它判"变了没有"，不判"对不对"**。原因：锚常常是散文级的（"内存超限那个检查"），
// 没有启发式能可靠地判对错 —— 我试过两种都很糟：太松的（随便撞上一个标识符就算过）
// 连"把 :445 改成 :1445（那行只有一个 }）"都抓不住；太紧的会把正确的引用判成漂移。
// 所以：**正确性靠人/agent 核一次，之后靠这个工具守住"别再悄悄变"**。
//
// 用法：
//   node tools/check-line-refs.mjs            # 体检（与快照比）
//   node tools/check-line-refs.mjs --update   # 核对无误后，把当前状态记成新快照
//   node tools/check-line-refs.mjs --json
//
// 三类基准（见仓库根 AGENTS.md §3.1）：vendor/quickjs（我们发行的引擎）、node/lib（Node 源码）、
// 第三方包（锁在 pnpm-lock.yaml）。缺哪个源码树就跳过并说明——别人克隆仓库时本来就没有。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './paths.mjs';

const ARGS = process.argv.slice(2);
const UPDATE = ARGS.includes('--update');
const JSON_OUT = ARGS.includes('--json');
const SNAP = path.join(REPO_ROOT, 'tools', 'line-refs.snapshot.json');

// ── 基准修订：快照必须记下"是对着哪个修订建的" ────────────────────────────
// 为什么：行号的正确性**只相对于某个修订**才有意义。若源码树换了修订而快照没记，
// 体检会报一堆"变了"（噪声），而 --update 会把快照悄悄重锚到一个**没人知道**的修订上
// —— 那样这个工具就失去了"基准"这个概念。
function sh(cmd, args, cwd) {
  try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
function readBaselines() {
  const vendorRoot = ROOTS.vendor;                        // .../vendor/quickjs
  const forkRoot = path.resolve(vendorRoot, '..', '..');  // fork 根
  const out = {};
  out.vendor = {
    forkCommit: sh('git', ['-C', forkRoot, 'rev-parse', '--short', 'HEAD']),
    forkBranch: sh('git', ['-C', forkRoot, 'rev-parse', '--abbrev-ref', 'HEAD']),
    engineVersion: fs.existsSync(path.join(vendorRoot, 'VERSION'))
      ? fs.readFileSync(path.join(vendorRoot, 'VERSION'), 'utf8').trim() : null,
  };
  out.node = { commit: sh('git', ['-C', ROOTS.node, 'rev-parse', '--short', 'HEAD']) };
  const lock = path.join(REPO_ROOT, 'pnpm-lock.yaml');
  out.pkgs = { lockSha: fs.existsSync(lock) ? crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex').slice(0, 12) : null };
  return out;
}
const fmtBaselines = (b) => [
  'vendor=' + (b?.vendor?.forkCommit ?? '?') + (b?.vendor?.engineVersion ? '/VERSION ' + b.vendor.engineVersion : ''),
  'node=' + (b?.node?.commit ?? '?'),
  'pkgs.lock=' + (b?.pkgs?.lockSha ?? '?'),
].join('   ');

const ROOTS = {
  vendor: process.env.SPC_VENDOR_ROOT ?? path.resolve(REPO_ROOT, '..', 'quickjs-emscripten-spc', 'vendor', 'quickjs'),
  node: process.env.SPC_NODE_ROOT ?? path.resolve(REPO_ROOT, '..', 'node'),
  pkgs: [path.join(REPO_ROOT, 'node_modules'), path.resolve(REPO_ROOT, '..', '_deps-survey', 'node_modules')],
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.spc', 'tools']);
const TEXT_EXT = /\.(md|ts|mts|mjs|js|cjs)$/;
const REF_RE = /`?([A-Za-z0-9_@][A-Za-z0-9_./@-]*\.(?:js|c|h|mjs|cjs|ts))[:：](\d+)(?:-(\d+))?`?/g;
const QUOTED_ABORT = /Aborted\(|Assertion failed|RuntimeError:/;   // 运行时消息的引文，行号是原文，不判

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (TEXT_EXT.test(e.name)) out.push(p);
  }
  return out;
}

const NODE_BASES = ['', 'lib', 'lib/internal', 'lib/internal/assert', 'lib/internal/streams',
  'lib/internal/bootstrap', 'src', 'deps/uv/include', 'deps/v8/include'];
function findByBasename(baseDir, name, budget = { n: 6000 }) {
  if (!fs.existsSync(baseDir) || budget.n <= 0 || /^index\./.test(name)) return null;
  const stack = [baseDir]; const hits = [];
  while (stack.length && budget.n > 0) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (budget.n-- <= 0) break;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p); else if (e.name === name) hits.push(p);
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

function resolveTarget(refPath) {
  const p = refPath.replace(/^\.\//, '');
  if (p.startsWith('vendor/quickjs/')) {
    const f = path.join(ROOTS.vendor, p.slice('vendor/quickjs/'.length));
    return fs.existsSync(f) ? { file: f, kind: 'vendor' } : { missing: 'vendor', root: ROOTS.vendor };
  }
  if (/^(node\/)?(lib|src|internal|deps)\//.test(p) || /^[a-z][a-z0-9_-]*\.(js|c|h)$/.test(p)) {
    const rel = p.replace(/^node\//, '');
    for (const b of NODE_BASES) { const f = path.join(ROOTS.node, b, rel); if (fs.existsSync(f)) return { file: f, kind: 'node' }; }
    const byName = findByBasename(path.join(ROOTS.node, 'lib'), path.basename(rel));
    return byName ? { file: byName, kind: 'node' } : { missing: 'node', root: ROOTS.node };
  }
  for (const base of ROOTS.pkgs) { const f = path.join(base, p); if (fs.existsSync(f)) return { file: f, kind: 'pkg' }; }
  const seg = p.split('/');
  if (seg.length > 1) {
    for (const base of ROOTS.pkgs) {
      const pkgRoot = path.join(base, seg[0]);
      if (!fs.existsSync(pkgRoot)) continue;
      const byName = findByBasename(pkgRoot, path.basename(p));
      if (byName) return { file: byName, kind: 'pkg' };
    }
  }
  return { missing: 'pkg', root: ROOTS.pkgs.join(' | ') };
}

// ── 扫描 ───────────────────────────────────────────────────────────────────
const rows = [];
const fileCache = new Map();
const readLines = (f) => { if (!fileCache.has(f)) fileCache.set(f, fs.readFileSync(f, 'utf8').split('\n')); return fileCache.get(f); };

for (const f of walk(REPO_ROOT)) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (QUOTED_ABORT.test(lines[i])) continue;
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(lines[i])) !== null) {
      const t = resolveTarget(m[1]);
      const rec = { site: path.relative(REPO_ROOT, f) + ':' + (i + 1), citingFile: path.relative(REPO_ROOT, f), ref: m[0].replace(/`/g, ''), refPath: m[1], num: Number(m[2]) };
      if (t.missing) { rows.push({ ...rec, skipped: '缺 ' + t.missing + ' 源码根' }); continue; }
      const target = readLines(t.file);
      const text = target[rec.num - 1];
      if (text === undefined) { rows.push({ ...rec, gone: true, kind: t.kind }); continue; }
      rows.push({ ...rec, kind: t.kind, file: path.relative(path.dirname(REPO_ROOT), t.file).replace(/\\/g, '/'), sha: crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 12) });
    }
  }
}

// ── 与快照比 ───────────────────────────────────────────────────────────────
const snap = fs.existsSync(SNAP) ? JSON.parse(fs.readFileSync(SNAP, 'utf8')) : { entries: {} };
const nowBaselines = readBaselines();
const baseChanged = snap.baselines && fmtBaselines(snap.baselines) !== fmtBaselines(nowBaselines);
// ⚠️ 快照的键 = `引用所在文件 | 目标文件`，**两个行号都不进键**：
//   · 不含"目标行号" —— 否则"把 :445 改成 :1445"会变成"新增+删除"而不是"这一条变了"，变异测试抓不住（踩过）；
//   · 不含"引用所在行号" —— 否则给文件加一行头注释，全文件的引用位置就整体移位 ⇒ 满屏"已删/新增"（噪声）。
// 值里是**列表**：同一文件可以引同一目标的多处（例：`（...:1741`/`:1221-1230`），单值会覆盖掉其中一条（踩过）。
const entries = {};
for (const r of rows) {
  if (r.skipped) continue;
  const k = r.citingFile + '|' + r.refPath;
  (entries[k] ??= { file: r.file, refs: [] }).refs.push({ ref: r.ref, num: r.num, sha: r.sha ?? null, gone: !!r.gone });
}

if (UPDATE) {
  const oldDesc = snap.baselines ? fmtBaselines(snap.baselines) : '（首次，无旧基准）';
  fs.writeFileSync(SNAP, JSON.stringify({
    at: new Date().toISOString(),
    baselines: nowBaselines,
    note: '行号引用快照：正确性靠人核一次，此后由 check-line-refs.mjs 守住"别再悄悄变"。' +
      'baselines 记的是**这份快照是对着哪个修订建的**——换修订后必须重新核一遍再 --update。',
    entries,
  }, null, 1));
  console.log('已更新快照：' + path.relative(REPO_ROOT, SNAP) + '（' + Object.keys(entries).length + ' 条引用处）');
  console.log('  旧基准： ' + oldDesc);
  console.log('  新基准： ' + fmtBaselines(nowBaselines));
  if (snap.baselines && oldDesc !== fmtBaselines(nowBaselines)) {
    console.log('  ⚠️ **基准变了**——旧快照里那些"行号对不对"的结论可能已经不成立，值得重核一遍。');
  }
  process.exit(0);
}

// 比"签名列表"：每处引用 → `行号:该行内容哈希`。
// 这样**改行号**或**目标行内容变了**都会让签名不同 ⇒ 报"变了"（而不是误报成"新引用"）。
const sig = (refs) => refs.map((x) => (x.gone ? x.num + ':GONE' : x.num + ':' + x.sha)).sort().join(' , ');
const changed = [], gone = [], added = [];
for (const [k, v] of Object.entries(entries)) {
  const old = snap.entries[k];
  if (!old) { added.push([k, v]); continue; }
  if (v.refs.some((x) => x.gone)) { gone.push([k, { file: v.file, num: v.refs.find((x) => x.gone).num }]); continue; }
  const a = sig(old.refs), b = sig(v.refs);
  if (a !== b) changed.push([k, { file: v.file, was: a, now: b }]);
}
const removed = Object.keys(snap.entries).filter((k) => !entries[k]);
const totalRefs = rows.filter((r) => !r.skipped).length;
const skipped = rows.filter((r) => r.skipped).length;

if (JSON_OUT) {
  console.log(JSON.stringify({ totalRefs, skipped, changed, gone, added, removed }, null, 2));
  process.exit(changed.length + gone.length > 0 ? 1 : 0);
}

console.log('=== 行号引用体检：共 ' + rows.length + ' 处（其中 ' + totalRefs + ' 处有目标，' + skipped + ' 处跳过：缺源码树）===');
if (baseChanged) {
  console.log('');
  console.log('  ⚠️⚠️ **基准修订和快照里记的不一样** —— 下面的"变了"很可能只是**源码树换了修订**，');
  console.log('       不是引用写错了。先对齐修订（或确认确实要在新修订上重核），再下结论。');
  console.log('       快照基准： ' + fmtBaselines(snap.baselines));
  console.log('       当前基准： ' + fmtBaselines(nowBaselines));
  console.log('');
}
console.log('  基准        ' + fmtBaselines(nowBaselines));
console.log('  ✅ 未变        ' + (Object.keys(entries).length - changed.length - gone.length - added.length) + ' 条引用处');
console.log('  ⚠️ 变了        ' + changed.length);
console.log('  ❌ 目标行没了  ' + gone.length);
console.log('  ➕ 新增引用处  ' + added.length + '（没进快照；核对无误后跑 --update）');
if (removed.length) console.log('  ➖ 引用处已删  ' + removed.length);

if (changed.length) {
  console.log('\n=== 变了（**不一定是错**：源码升级了、或引用该更新了——去看一眼）===');
  for (const [k, v] of changed.slice(0, 20)) {
    console.log('  ' + k);
    console.log('      快照: ' + v.was);
    console.log('      现在: ' + v.now + '   （' + v.file + '）');
  }
  if (changed.length > 20) console.log('  …还有 ' + (changed.length - 20) + ' 条');
}
if (gone.length) {
  console.log('\n=== 目标文件没有那一行了（引用确实烂了）===');
  for (const [k, v] of gone.slice(0, 20)) console.log('  ' + k + '   ' + v.file + ':' + v.num);
}
process.exit(changed.length + gone.length > 0 ? 1 : 0);
