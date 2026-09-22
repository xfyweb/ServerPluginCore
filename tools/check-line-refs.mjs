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
// 四类**冻结的帧**（见仓库根 AGENTS.md §3.1）：vendor/quickjs（我们发行的引擎，帧 = fork 提交）、
// node/lib（Node 源码，帧 = Node 提交）、**Linux 内核源码（帧 = 内核版本，如 6.12.110）**、
// 第三方包（帧 = pnpm-lock.yaml）。
// 缺哪个源码树就跳过并说明——别人克隆仓库时本来就没有。
//
// Linux 那一类是**部分子树**（`include/`、`kernel/`、`security/`、`drivers/` … 里只解了被引用的文件）：
// 所以"树在、文件不在"在这里是**正常状态**，报 ❓ 但不判失败，把文件解出来即可核对。
//
// ⚠️ **第四类：我们自己会改的代码（本仓库源码、工作区里的 survey 目录……）不写行号。**
// 行号是**坐标**，坐标只相对一个**冻结的帧**才有意义：
//   · 上游那三份有版本/哈希当帧 ⇒ 行号可查、可守；
//   · 我们自己这份**每次提交都在动** ⇒ 记哈希则注释要么永远落后（"等下个发版再更新"）、
//     要么每次提交都要改注释；而读者读的是**工作区**，不是那个哈希指向的树 ⇒ 哈希对他零信息。
// 所以这类引用**不进行号体检，而是直接报错**，要求改成符号名（`core/main.ts` 的 `resolveTier()`）。
// 这不是洁癖：本仓库原有的 4 处自引行号**已经全部烂了**——最典型的是
// `core/main.ts:36`（曾指"由 id 前缀推导信任档"），而**删掉那一行的正是引用它的那次迁移**，
// 于是它现在指着 CLI 横幅 `console.log('[spc] state=...')`，且没有任何东西会响。
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
/**
 * Linux 这棵树的版本号 = **它的帧**。三个来源，按可靠性排：
 *   ① 完整树里的 `Makefile`（`VERSION`/`PATCHLEVEL`/`SUBLEVEL` 三行）——最权威；
 *   ② 工作区里那个官方 tarball 的文件名（`linux-<版本>.tar.xz`）——部分子树没有 `.git` 也没有 `Makefile`，
 *      版本只体现在"当初解的是哪个包"，所以文件名就是证据；
 *   ③ 都没有 ⇒ `null`，体检打 `linux=?`：**明说这个帧没锚住**，别让人以为"没报就是对的"。
 */
function linuxVersion() {
  const mk = path.join(ROOTS.linux, 'Makefile');
  if (fs.existsSync(mk)) {
    const text = fs.readFileSync(mk, 'utf8');
    const pick = (k) => new RegExp('^' + k + '\\s*=\\s*(\\d+)', 'm').exec(text)?.[1];
    const v = [pick('VERSION'), pick('PATCHLEVEL'), pick('SUBLEVEL')];
    if (v.every(Boolean)) return v.join('.');
  }
  try {
    const f = fs.readdirSync(path.resolve(REPO_ROOT, '..', '_kernel-dl'))
      .find((n) => /^linux-[\d.]+\.tar\.xz$/.test(n));
    if (f) return f.replace(/^linux-/, '').replace(/\.tar\.xz$/, '');
  } catch { /* 没有下载目录：这台机器上就没有，按 ③ 处理 */ }
  return null;
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
  out.linux = { version: linuxVersion() };
  const lock = path.join(REPO_ROOT, 'pnpm-lock.yaml');
  out.pkgs = { lockSha: fs.existsSync(lock) ? crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex').slice(0, 12) : null };
  return out;
}
const fmtBaselines = (b) => [
  'vendor=' + (b?.vendor?.forkCommit ?? '?') + (b?.vendor?.engineVersion ? '/VERSION ' + b.vendor.engineVersion : ''),
  'node=' + (b?.node?.commit ?? '?'),
  'linux=' + (b?.linux?.version ?? '?'),
  'pkgs.lock=' + (b?.pkgs?.lockSha ?? '?'),
].join('   ');

const ROOTS = {
  vendor: process.env.SPC_VENDOR_ROOT ?? path.resolve(REPO_ROOT, '..', 'quickjs-emscripten-spc', 'vendor', 'quickjs'),
  node: process.env.SPC_NODE_ROOT ?? path.resolve(REPO_ROOT, '..', 'node'),
  // Linux 内核源码。**部分子树就够**：体检是"按被引用的路径去找"，找到就核对那一行，
  // 找不到只报 ❓（树在、文件不在）而**不判失败**——部分子树里没有哪个文件，就把那个文件解出来。
  linux: process.env.SPC_LINUX_ROOT ?? path.resolve(REPO_ROOT, '..', 'linux-6.12'),
  pkgs: [path.join(REPO_ROOT, 'node_modules'), path.resolve(REPO_ROOT, '..', '_deps-survey', 'node_modules')],
};
const WORKSPACE_ROOT = path.dirname(REPO_ROOT);   // 开发工作区根（仓库外那一圈）：自引判定要连它一起看
// Linux 引用的**树名前缀**（`linux-6.12/include/linux/notifier.h:185`）。从根目录名推出来，
// 这样 `SPC_LINUX_ROOT` 指到别处时前缀跟着变，不用手改两处。
const LINUX_PREFIX = path.basename(ROOTS.linux) + '/';
// 冻结的帧所在的位置：落在这里面的文件**不算"我们自己的码"**——
// 否则 `../node/lib/fs.js:12` 这种"用相对路径写的 Node 引用"会被误判成自引（它引的是冻结的 Node，不是我们的源码）。
const FROZEN_DIRS = [ROOTS.vendor, ROOTS.node, ROOTS.linux, ...ROOTS.pkgs];
const under = (f, root) => { const r = path.resolve(root); return f === r || f.startsWith(r + path.sep); };

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.spc', 'tools']);
const TEXT_EXT = /\.(md|ts|mts|mjs|js|cjs)$/;
// `.json` 也收：`sdk/schema/manifest.schema.json:31` 这种自引行号一样会烂，而且它烂了没人看得见。
// 实测放宽到 json 只多出 2 处（都是自引），零噪声 ⇒ 值得。
const REF_RE = /`?([A-Za-z0-9_@][A-Za-z0-9_./@-]*\.(?:js|c|h|mjs|cjs|ts|json))[:：](\d+)(?:-(\d+))?`?/g;
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

// 解析顺序 = **帧的优先级**：先认"这条引用主张的到底是哪一份源码"。
// `vendor/` 必须先判：它是发行引擎，虽然不在本仓库里，但**仓库里将来也可能有同名目录**。
// 自引（本仓库/工作区）**必须早于 node 与第三方包**：目标就在读者手边那份工作区里，
// 别的解释都是舍近求远（当前顶层目录与 Node 的 `lib/src/…` 前缀不冲突，但一旦冲突，读者引的一定是
// 他自己仓库里那份）。落在冻结根下面的文件（`../node/lib/fs.js`）**排除**在自引之外。
function resolveTarget(refPath) {
  const p = refPath.replace(/^\.\//, '');
  if (p.startsWith('vendor/quickjs/')) {
    const f = path.join(ROOTS.vendor, p.slice('vendor/quickjs/'.length));
    return fs.existsSync(f) ? { file: f, kind: 'vendor' } : { missing: 'vendor', root: ROOTS.vendor };
  }
  // Linux 源码：带树名前缀的写法（`linux-6.12/include/linux/notifier.h:185`）。
  // ⚠️ 这一支**必须在自引判定之前**：那棵树就摆在工作区里，不先拦下来，`linux-6.12/…` 会被
  // 解析成工作区文件 ⇒ 判成"我们自己在改的码"（`unfrozen`）而**直接失败**——反直觉，且看着像工具坏了。
  if (p.startsWith(LINUX_PREFIX)) {
    const f = path.join(ROOTS.linux, p.slice(LINUX_PREFIX.length));
    if (!fs.existsSync(ROOTS.linux)) return { missing: 'linux', root: ROOTS.linux };
    return fs.existsSync(f) ? { file: f, kind: 'linux' } : { notFound: 'linux' };
  }
  for (const [root, kind] of [[REPO_ROOT, 'self'], [WORKSPACE_ROOT, 'local']]) {
    const f = path.resolve(root, p);
    if (!under(f, root)) continue;                                    // 别让 `../..` 逃出去
    if (FROZEN_DIRS.some((r) => under(f, r))) continue;               // 冻结帧的源码，不算"我们的码"
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
    return { file: f, kind, unfrozen: true };
  }
  // Linux 源码：**内核树根相对路径**的写法（`include/linux/notifier.h:185`、`kernel/notifier.c:73`）。
  // 与 Node 的 `lib/fs.js` 同一套路：不带树名前缀，基准由 AGENTS.md §3.1 的表给。
  // ⚠️ 这份目录名单**刻意不含 `lib/`、`src/`、`deps/`**：那三个是 Node 的基座（`lib/fs.js` 必须解析到 Node），
  // 而 Linux 的 `lib/string.c` 这类真要用时，写成 `linux-6.12/lib/string.c` 即可（带了前缀就走上面那一支）。
  const LINUX_TOP = /^(include|kernel|security|fs|mm|net|ipc|arch|block|crypto|drivers|init|io_uring|rust|sound|usr|virt|samples|certs|scripts)\//;
  if (LINUX_TOP.test(p)) {
    if (!fs.existsSync(ROOTS.linux)) return { missing: 'linux', root: ROOTS.linux };
    const f = path.join(ROOTS.linux, p);
    // 树在、文件不在 = **部分子树的正常状态**（不是"引用写错了"）：报 ❓ 并提示去解那个文件，
    // 所以这里带一个 `'linux'` 标记，让下面的输出能把这句话说对。
    return fs.existsSync(f) ? { file: f, kind: 'linux' } : { notFound: 'linux' };
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
  // 落空：分两种，**不要混为一谈**——
  //   · 源码树压根不在这台机器上 ⇒ 跳过（别人克隆仓库时本来就没有，见文件头）；
  //   · 树在、里面没这个文件 ⇒ **可疑**（多半是引用写错了）。报出来，但不判失败：
  //     它也可能是"引了树之外的某份文件"，工具没资格替人下这个结论。
  const available = { vendor: fs.existsSync(ROOTS.vendor), node: fs.existsSync(ROOTS.node), pkg: ROOTS.pkgs.some((b) => fs.existsSync(b)) };
  for (const k of ['vendor', 'node', 'pkg']) if (!available[k]) return { missing: k, root: k === 'vendor' ? ROOTS.vendor : k === 'node' ? ROOTS.node : ROOTS.pkgs.join(' | ') };
  return { notFound: true };
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
      if (t.notFound) { rows.push({ ...rec, notFound: t.notFound }); continue; }
      // **不冻结的帧**（我们自己在改的码）：不进快照、也没什么"变没变"可比 —— 直接当违规报。
      // 这里只把"那一行现在是什么"读出来当证据（例如 `core/main.ts:36` 现在是 CLI 横幅），
      // 让人一眼看出"它早就不是当初指的东西了"，照此改写成符号名。
      if (t.unfrozen) {
        const now = readLines(t.file)[rec.num - 1];
        rows.push({ ...rec, unfrozen: true, kind: t.kind, file: path.relative(REPO_ROOT, t.file).replace(/\\/g, '/'), now: now === undefined ? null : now.trim() });
        continue;
      }
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
  // 只把**冻结帧**上的引用记进快照：自引比不了"变没变"（它本来就在动），找不到目标的也没得比。
  if (r.skipped || r.unfrozen || r.notFound) continue;
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
const skippedRows = rows.filter((r) => r.skipped).length;          // 缺源码树：这台机器上就没有，跳过
const unfrozen = rows.filter((r) => r.unfrozen);                   // 自引：不冻结的帧 ⇒ 必改
const notFound = rows.filter((r) => r.notFound);                   // 树在、文件不在 ⇒ 可疑
const totalRefs = rows.length - skippedRows - unfrozen.length - notFound.length;

if (JSON_OUT) {
  console.log(JSON.stringify({ totalRefs, skipped: skippedRows, unfrozen: unfrozen.length, notFound: notFound.length, changed, gone, added, removed }, null, 2));
  process.exit(changed.length + gone.length + unfrozen.length > 0 ? 1 : 0);
}

console.log('=== 行号引用体检：共 ' + rows.length + ' 处（' + totalRefs + ' 处在冻结帧上有目标，' + skippedRows + ' 处跳过：缺源码树）===');
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
console.log('  ⛔ 不冻结的帧  ' + unfrozen.length + ' 处自引行号（' + (unfrozen.length ? '**必改**：改成符号名，见 AGENTS.md §3.1' : '好，一处都没有') + '）');
if (notFound.length) console.log('  ❓ 目标找不到  ' + notFound.length + ' 处（源码树在、文件不在 ⇒ 多半是引用写错了；**Linux 那棵是部分子树**，解出该文件即可）');

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
if (unfrozen.length) {
  console.log('\n=== ⛔ 不冻结的帧：**我们自己在改的码**不该写行号 —— 改成符号名 ===');
  console.log('    （写成 `core/main.ts` 的 `resolveTier()`／`HostApi` 的 `host.*` 桥／`Manifest.id` 这样，');
  console.log('      符号在一个工作区里是可 grep 的，行号不是。理由见本文件头与 AGENTS.md §3.1。）');
  for (const r of unfrozen.slice(0, 20)) {
    console.log('  ' + r.site + '  →  ' + r.ref);
    console.log('      ' + r.file + ':' + r.num + ' 现在是： ' + (r.now === null ? '（**没有这一行**）' : r.now.slice(0, 96)));
  }
  if (unfrozen.length > 20) console.log('  …还有 ' + (unfrozen.length - 20) + ' 处');
}
if (notFound.length) {
  console.log('\n=== ❓ 目标找不到（源码树在，但里面没这个文件）===');
  for (const r of notFound.slice(0, 20)) {
    console.log('  ' + r.site + '  →  ' + r.ref);
    if (r.notFound === 'linux') console.log('      Linux 是**部分子树**：把 ' + r.refPath + ' 从同版本内核包里解出来就能核对');
  }
}
process.exit(changed.length + gone.length + unfrozen.length > 0 ? 1 : 0);
