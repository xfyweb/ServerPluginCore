// 依赖面实测 + 构建闸覆盖度（构建层"依赖管控"与仿真排期的证据生成器）
//
// 回答两个问题：
//   ① 真实 npm 生态里，哪些包在 platform=node + format=esm 打包后会留下"运行期才解析模块"的欠条？
//   ② **按当前的仿真清单，这些包里能过几个？下一个该补哪个模块最划算？**
//
// 为什么需要它：依赖管控规则与仿真排期如果靠"想象生态长什么样"来定，就会误伤或排错序。
// 实测发现过：把欠条一律判失败，会拒掉包作者显式声明为可选的依赖（生态标准写法）。
//
// 用法：
//   1) 准备一个仓库外的取样目录（工具不会替你装包，避免污染仓库）：
//        mkdir <dir> && cd <dir> && npm init -y
//        npm i --registry=https://registry.npmmirror.com esbuild <包清单>
//   2) 回到仓库：
//        node tools/dep-survey.mjs                    # 全量报告 + 覆盖度
//        node tools/dep-survey.mjs --coverage         # 只看覆盖度
//        node tools/dep-survey.mjs --emulated p2b     # 指定预设
//        node tools/dep-survey.mjs --emulated node:path,node:fs
//        node tools/dep-survey.mjs --packages zod,ws,pg
//        node tools/dep-survey.mjs --json
//
// ⚠️ 覆盖度衡量的是「**能不能过构建闸**」，不是「运行期能不能用」。
//    过闸只说明"用到的模块都有仿真"，**不代表**仿真实现了依赖真正调用的那些函数。
//    运行期可用性属集成测试，别把这两个结论混起来。
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinModules } from 'node:module';

/**
 * 样本集。
 *  - `core`：形态覆盖（纯计算 / IO / 服务端 / 带可选原生加速器），用来验证规则与闸门；
 *  - `utils`：**插件作者真会用的那些小工具**（配置解析、文件操作、模板、校验、格式化、CLI）——
 *    它们的依赖面才代表沙箱插件的真实需求，`core` 里那批服务端包大多结构上不该在沙箱跑。
 */
const SETS = {
  core: [
    'zod', 'nanoid', 'chalk', 'picocolors', 'ms', 'semver', 'dayjs', 'lodash', 'uuid', 'yaml', 'ini',
    'dotenv', 'fs-extra', 'glob', 'rimraf', 'mkdirp', 'ajv', 'express', 'ws', 'axios', 'pino',
    'winston', 'ioredis', 'mysql2', 'pg', 'ssh2', 'dockerode',
  ],
  utils: [
    'debug', 'chokidar', 'fast-glob', 'globby', 'write-file-atomic', 'proper-lockfile', 'tmp', 'graceful-fs',
    'toml', 'json5', 'properties', 'csv-parse', 'fast-xml-parser',
    'mustache', 'handlebars', 'eta', 'ejs',
    'joi', 'valibot', 'superstruct',
    'date-fns', 'luxon',
    'change-case', 'slugify', 'bytes', 'pretty-bytes', 'humanize-duration', 'deepmerge', 'diff', 'sanitize-filename',
    'commander', 'yargs', 'ora', 'cli-table3',
    'execa', 'cross-spawn', 'which', 'pidusage', 'systeminformation',
    'tar', 'adm-zip', 'archiver',
    'marked',
  ],
};

/** 沙箱设计上**永远不会提供**的内建（网络/进程类：外包给官方驱动插件，见 build-layer-evidence §4.3） */
const NEVER = ['net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'child_process', 'worker_threads', 'cluster', 'vm', 'module', 'diagnostics_channel'];

/** 仿真清单预设（module-emulation-design §3 + build-layer-evidence §2 的实测补充） */
const PRESETS = {
  none: [],
  p2a: ['path', 'util', 'events', 'assert', 'url'],
  // 实测补充：debug 撞到 tty，fs-extra/dockerode 撞到 constants，两者成本都极低
  'p2a+': ['path', 'util', 'events', 'assert', 'url', 'tty', 'constants'],
  p2b: ['path', 'util', 'events', 'assert', 'url', 'tty', 'constants', 'fs', 'fs/promises', 'process', 'os'],
  p2c: ['path', 'util', 'events', 'assert', 'url', 'tty', 'constants', 'fs', 'fs/promises', 'process', 'os', 'buffer', 'crypto'],
};

/**
 * 追加一档 `current` = **真实登记表**（`core/sandbox-modules/registry.ts`），
 * 而不是靠人维护预设——否则"我们做到哪一档了"永远要靠手工拼 `--emulated` 列表猜。
 *
 * 之所以能直接 import `.ts`：Node ≥22.18 默认剥离类型（本项目用的是 v24）。老版本 Node 上
 * 这一档会缺席，工具继续跑（只在 stderr 提示一句），不让"量不了当前进度"变成跑不了工具。
 */
try {
  const { SANDBOX_MODULES } = await import('../core/sandbox-modules/registry.ts');
  PRESETS.current = SANDBOX_MODULES.map((m) => m.canonical);
  // 重排键序（覆盖度表按插入顺序算增量）：none → current → p2a → p2a+ → p2b → p2c
  for (const k of ['none', 'current', 'p2a', 'p2a+', 'p2b', 'p2c']) {
    if (!(k in PRESETS)) continue;
    const v = PRESETS[k];
    delete PRESETS[k];
    PRESETS[k] = v;
  }
} catch (err) {
  console.error(`（跳过 current 档：本机 Node 无法直接 import registry.ts — ${err?.code ?? err?.message}）`);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const asJson = flag('--json');
const onlyCoverage = flag('--coverage');
const setName = value('--set') ?? 'core';
const PKGS = value('--packages')?.split(',').map((s) => s.trim()).filter(Boolean)
  ?? (setName === 'all' ? [...SETS.core, ...SETS.utils] : SETS[setName]);
if (!PKGS) {
  console.error(`未知样本集：${setName}（可选：${Object.keys(SETS).join(' / ')} / all）`);
  process.exit(2);
}

const emuArg = value('--emulated');
const norm = (m) => m.replace(/^node:/, '');
const emulatedFor = (preset) => {
  if (!emuArg) return new Set(PRESETS[preset].map(norm));
  if (PRESETS[emuArg]) return new Set(PRESETS[emuArg].map(norm));
  return new Set(emuArg.split(',').map((s) => norm(s.trim())).filter(Boolean));
};

const DIR = process.env.SPC_SURVEY_DIR ?? join(process.cwd(), '..', '_deps-survey');
const SRC = join(DIR, 'entries');
const BUILTINS = new Set(builtinModules); // 含 node: 前缀与裸名两种形态
const pad = (s, n) => String(s).padEnd(n);

if (!existsSync(join(DIR, 'node_modules', 'esbuild'))) {
  console.error(`取样目录不可用：${DIR}`);
  console.error('先准备（工具不替你装包，避免污染仓库）：');
  console.error(`  mkdir "${DIR}" && cd "${DIR}" && npm init -y`);
  console.error(`  npm i --registry=https://registry.npmmirror.com esbuild ${PKGS.slice(0, 6).join(' ')} ...`);
  process.exit(2);
}
mkdirSync(SRC, { recursive: true });

/** 从磁盘读 package.json（不走 require：部分包的 exports 不暴露它） */
function pkgMeta(name) {
  const p = join(DIR, 'node_modules', name, 'package.json');
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return {
    version: j.version, type: j.type ?? 'commonjs',
    optional: Object.keys(j.optionalDependencies ?? {}),
    peerOptional: Object.entries(j.peerDependenciesMeta ?? {}).filter(([, v]) => v?.optional).map(([k]) => k),
    peer: Object.keys(j.peerDependencies ?? {}),
  };
}

/**
 * "缺哪个模块"和"缺多少功能"是两件事，必须分开测。
 *
 * 实测教训：`fs-extra` 被判为"卡在 stream"，但它自己根本没引用 stream——是它的依赖
 * `graceful-fs`（fs 的老牌 EMFILE 兼容层）带的，而 graceful-fs 只用了 `stream` 的
 * `Stream` 和 `call` 两个东西。也就是说：**需求面 12 个包的 stream，实际门槛可能极小。**
 *
 * 做法：在产物里找到 `X = __require("mod")` / `X = __toESM(__require("mod"))` 的绑定，
 * 再统计整份产物对该绑定访问了哪些属性。
 */
function modulePropUse(body) {
  const use = new Map();
  const bind = /(?:^|[;{}\s])(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*(?:__toESM\s*\(\s*)?__require\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of body.matchAll(bind)) {
    const ident = m[1];
    const mod = norm(m[2]);
    const esc = ident.replace(/\$/g, '\\$');
    // 取点号链上第一个有意义的段：`import_x.default.createReadStream` → createReadStream
    const props = new Set();
    for (const p of body.matchAll(new RegExp(`\\b${esc}((?:\\.[A-Za-z_$][\\w$]*)+)`, 'g'))) {
      const seg = p[1].split('.').filter((s) => s && s !== 'default' && s !== '__esModule');
      if (seg.length) props.add(seg[0]);
    }
    for (const p of body.matchAll(new RegExp(`\\b${esc}\\[["']([^"']+)["']\\]`, 'g'))) {
      if (p[1] !== 'default' && p[1] !== '__esModule') props.add(p[1]);
    }
    if (!use.has(mod)) use.set(mod, new Set());
    for (const p of props) use.get(mod).add(p);
  }
  return use;
}

/** 产物里"被外部化的模块引用"——两种形态都要收：运行期兜底调用 + 遗留的 ESM import */
function externalRefs(text) {
  const body = text
    .split('\n')
    .filter((l) => !/function\s+__\w+\s*\(/.test(l)) // 别把 `function __require() {` 当成调用点
    .join('\n')
    // 去掉块注释：webpack 风格的 `/* webpackIgnore: true */ "fs"` 本质是字面量，不去掉会被误判成动态
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const litCalls = [...body.matchAll(/__require\s*\(\s*["']([^"']+)["']\s*\)/g)];
  const esm = [...body.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);
  const all = [...litCalls.map((m) => m[1]), ...esm].filter((s) => !s.startsWith('.') && !s.startsWith('/'));
  return {
    specs: [...new Set(all)],
    dynCalls: (body.match(/__require\s*\(/g) || []).length - litCalls.length,
    propUse: modulePropUse(body),
  };
}

const rows = [];
for (const name of PKGS) {
  const meta = pkgMeta(name);
  if (!meta) { rows.push({ name, missing: true }); continue; }
  const entryFile = join(SRC, `${name.replace(/[@/]/g, '_')}.js`);
  writeFileSync(entryFile, `import * as mod from '${name}';\nexport { mod };\n`);
  const row = { name, kind: meta.type === 'module' ? 'ESM' : 'CJS', version: meta.version, optional: meta.optional, peerOptional: meta.peerOptional, peer: meta.peer };
  try {
    const r = await build({ entryPoints: [entryFile], bundle: true, format: 'esm', platform: 'node', target: 'es2022', write: false, logLevel: 'silent', absWorkingDir: DIR });
    const text = r.outputFiles[0].text;
    const refs = externalRefs(text);
    row.ok = true;
    row.bytes = text.length;
    row.warnings = r.warnings.length;
    row.debt = text.includes('Dynamic require of ');
    row.specs = refs.specs;
    row.dynCalls = refs.dynCalls;
    row.propUse = refs.propUse;
    // 归一化去 node: 前缀，便于与仿真清单比对
    row.mods = [...new Set(refs.specs.map(norm))];
    row.builtinMods = row.mods.filter((s) => BUILTINS.has(s));
    row.otherMods = row.mods.filter((s) => !BUILTINS.has(s));
  } catch (e) {
    row.ok = false;
    row.err = (e.errors ?? [{ text: String(e) }]).map((x) => x.text).join('; ').slice(0, 120);
  }
  rows.push(row);
}

const built = rows.filter((r) => r.ok);
const classify = (r, spec) => {
  const bare = norm(spec);
  if (BUILTINS.has(bare)) return NEVER.includes(bare) ? '内建(永不仿真)' : '内建';
  if (r.optional.includes(spec)) return 'optionalDep';
  if (r.peerOptional.includes(spec)) return '可选peer';
  if (r.peer.includes(spec)) return 'peer';
  return '真缺失';
};

// ── 覆盖度计算 ──
// 过闸条件：① 构建成功 ② 无动态欠条 ③ 用到的内建全部在仿真清单里
// 解析不到的非内建 specifier 会被自动 stub（与 Node 行为一致），不算卡点
const blockersOf = (r, emulated) => r.builtinMods.filter((m) => !emulated.has(m));
const passes = (r, emulated) => r.ok && r.dynCalls === 0 && blockersOf(r, emulated).length === 0;
const why = (r, emulated) => {
  const b = blockersOf(r, emulated);
  if (b.length) return b.join('+');
  return r.dynCalls ? `动态require×${r.dynCalls}` : '?';
};

if (!onlyCoverage && !asJson) {
  console.log(`取样目录：${DIR}\n`);
  console.log(pad('包名', 14) + pad('格式', 6) + pad('版本', 12) + pad('体积', 11) + pad('欠条', 7) + '被外部化的模块（归属）');
  console.log('-'.repeat(118));
  let refCount = 0, dynCalls = 0;
  for (const r of rows) {
    if (r.missing) { console.log(`${pad(r.name, 14)}(未安装，跳过)`); continue; }
    if (!r.ok) { console.log(`${pad(r.name, 14)}${pad(r.kind, 6)}${pad(r.version, 12)}构建失败：${r.err}`); continue; }
    dynCalls += r.dynCalls;
    refCount += r.mods.length;
    const specs = r.mods.map((s) => `${s}[${classify(r, s)}]`).join(' ');
    console.log(`${pad(r.name, 14)}${pad(r.kind, 6)}${pad(r.version, 12)}${pad(r.bytes + 'B', 11)}${pad(r.debt ? '有' : '·', 7)}${specs}${r.dynCalls ? `  +动态×${r.dynCalls}` : ''}`);
  }
  console.log('-'.repeat(118));
  const nonBuiltin = new Map();
  for (const r of built) for (const s of r.otherMods) nonBuiltin.set(s, classify(r, s));
  console.log(`\n共 ${rows.length} 个包：构建成功 ${built.length}，有欠条 ${rows.filter((r) => r.debt).length}`);
  console.log(`被外部化的模块引用 ${refCount} 个（按包去重累计）；动态欠条 ${dynCalls} 处`);
  console.log(`\n非内建的引用共 ${nonBuiltin.size} 个（这些才是"依赖"问题，其余都是"仿真覆盖度"问题）：`);
  for (const [spec, owner] of nonBuiltin) console.log(`  · ${pad(spec, 34)} ${owner}`);
  const declared = built.filter((r) => r.optional.length || r.peerOptional.length || r.peer.length);
  if (declared.length) {
    console.log('\n声明了 optional / peer 的包（= "不装也合法"，不是意外）：');
    for (const r of declared) {
      const parts = [];
      if (r.optional.length) parts.push(`optionalDependencies=[${r.optional}]`);
      if (r.peerOptional.length) parts.push(`可选peer=[${r.peerOptional}]`);
      if (r.peer.length) parts.push(`peer=[${r.peer}]`);
      console.log(`  ${pad(r.name, 14)} ${parts.join('  ')}`);
    }
  }
  console.log('');
}

// ── 覆盖度报告 ──
console.log('== 构建闸覆盖度 ==');
console.log('（过闸 = 构建成功 + 无动态欠条 + 用到的内建全部有仿真；**不代表运行期可用**）\n');
console.log(pad('仿真预设', 10) + pad('过闸', 9) + '本档新增解锁');
console.log('-'.repeat(118));
let prevPass = new Set();
for (const preset of Object.keys(PRESETS)) {
  const emu = emulatedFor(preset);
  const okRows = built.filter((r) => passes(r, emu));
  const now = new Set(okRows.map((r) => r.name));
  const added = [...now].filter((n) => !prevPass.has(n));
  console.log(`${pad(preset, 10)}${pad(`${now.size}/${built.length}`, 9)}${added.length ? added.join(' ') : '（无）'}`);
  prevPass = now;
}
console.log('-'.repeat(118));

const lastEmu = emulatedFor(emuArg && PRESETS[emuArg] ? emuArg : 'p2c');
const blocked = built.filter((r) => !passes(r, lastEmu));
console.log(`\n该档之后仍被卡住的 ${blocked.length} 个包：`);
for (const r of blocked) console.log(`  ${pad(r.name, 12)} ${why(r, lastEmu)}`);

// ── 下一个该补谁 ──
// 两个度量必须分开，否则会误导：
//   · 需求面     = 有多少个"卡住的包"用到了它（长期收益）
//   · 单独补它的效果 = 把它加进基线后，能**完全过闸**的包（即时收益，通常远小于需求面）
const baseName = emuArg && PRESETS[emuArg] ? emuArg : 'p2c';
const base = emulatedFor(baseName);
const failing = built.filter((r) => !passes(r, base));
const demand = new Map();
const unlock = new Map();
for (const m of new Set(failing.flatMap((r) => blockersOf(r, base)))) {
  const withM = new Set([...base, m]);
  demand.set(m, failing.filter((r) => blockersOf(r, base).includes(m)).map((r) => r.name));
  unlock.set(m, failing.filter((r) => passes(r, withM)).map((r) => r.name));
}
console.log(`\n== 下一个该补谁 ==（基线：${baseName}）\n`);
console.log(pad('模块', 24) + pad('需求面', 8) + '单独补它 → 能完全过闸的包');
console.log('-'.repeat(118));
for (const [m, need] of [...demand.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const got = unlock.get(m);
  console.log(
    pad(m, 24) + pad(`${need.length} 个`, 8) + (got.length ? got.join(' ') : '（0 个 —— 卡住它的包都还差别的模块）') +
      (NEVER.includes(m) ? '   ⚠ 设计上不仿真' : ''),
  );
}
console.log('-'.repeat(118));

// 离过闸最近的包（卡点最少）——这些才是可救的。带上**每包实际需要的属性数**：
// 全局并集（比如 stream 23 个属性）会把"解锁 5 个包"这件事说得比实际重。
const close = failing.filter((r) => r.dynCalls === 0).sort((a, b) => blockersOf(a, base).length - blockersOf(b, base).length);
console.log('\n离过闸最近的包（卡点从少到多，动态 require 的已排除）：');
for (const r of close) {
  const b = blockersOf(r, base);
  const detail = b
    .map((m) => {
      const n = r.propUse?.get(m)?.size ?? 0;
      return n ? `${m}(${n}属性)` : m;
    })
    .join(', ');
  const hope = b.every((m) => NEVER.includes(m)) ? '   ← 全是设计上不仿真的，救不了' : '';
  console.log(`  ${pad(r.name, 18)} 还差 ${b.length} 个：${detail}${hope}`);
}
const dynOnly = failing.filter((r) => r.dynCalls > 0);
console.log(`\n补模块也救不了（动态 require）：${dynOnly.map((r) => `${r.name}(动态×${r.dynCalls})`).join(', ') || '（无）'}`);

// ── 功能需求面：缺哪个模块 ≠ 缺多少功能 ──
// "需求面"只说有多少包引用它；这里回答"它们实际访问了它的哪些属性"——那才是要实现的量。
//
// ⚠️ **必须去噪**：`modulePropUse` 是用"绑定名 + `.属性`"的正则抽的，在**大 CJS 包里绑定名会撞名**，
// 于是把无关标识符算到该模块名下。实测（2026-09）：`systeminformation` 一个包就"贡献"了 54 个
// `util` 属性，其中 `isRaspberry` / `decodePiCpuinfo` / `powerShell` / `getValue` / `js` 全是
// **它自己的内部函数名**；`dockerode` 更夸张（74 个，含 `processArgs` / `Long` / `asPromise`）。
// 不去噪的后果很实际：规划会照着 61 这个数去设计实现范围，而真实需求只有 inspect/deprecate/format。
//
// 去噪判据：属性名必须**真的存在**于宿主该内建的属性集合里（own + 原型）。这不会误杀真实需求
// （真实需求一定是那个模块上存在的名字），且被过滤的名字**照原样打印出来**，不静默丢信息。
const BUILTIN_SHAPE = new Map(); // mod → Set(真实属性名) | null（拿不到就不筛）
async function builtinShape(mod) {
  if (!BUILTIN_SHAPE.has(mod)) {
    let shape = null;
    try {
      const m = await import(`node:${mod}`);
      shape = new Set([
        ...Object.getOwnPropertyNames(m),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(m) ?? {}),
        'default',
      ]);
    } catch {
      shape = null; // 拿不到就不筛（宁可多列，不可误杀）
    }
    BUILTIN_SHAPE.set(mod, shape);
  }
  return BUILTIN_SHAPE.get(mod);
}

const propAgg = new Map();
const propNoise = new Map();
for (const r of built) {
  for (const [mod, props] of r.propUse ?? []) {
    // 只列**真卡点**：内建且未仿真。非内建的解析不到的 specifier 会被自动 stub，不属此列
    if (!BUILTINS.has(mod) || base.has(mod)) continue;
    const shape = await builtinShape(mod);
    if (!propAgg.has(mod)) propAgg.set(mod, new Map());
    for (const p of props) {
      if (shape && !shape.has(p)) {
        // 疑似撞名误报：不计入需求，但留档
        if (!propNoise.has(mod)) propNoise.set(mod, new Set());
        propNoise.get(mod).add(p);
        continue;
      }
      propAgg.get(mod).set(p, (propAgg.get(mod).get(p) ?? 0) + 1);
    }
  }
}
console.log(`\n== 未仿真模块的"真实功能需求" ==（产物里对这些模块实际访问了哪些属性；已按"该内建真有这个属性"去噪）\n`);
const ranked = [...propAgg.entries()].sort((a, b) => b[1].size - a[1].size);
if (!ranked.length) {
  console.log('  （没有检测到属性访问——可能这些引用只出现在未被静态解析的分支里）');
} else {
  for (const [mod, props] of ranked) {
    const list = [...props.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => (n > 1 ? `${p}×${n}` : p));
    const head = list.slice(0, 14).join(' ');
    const noise = propNoise.get(mod);
    console.log(
      `  ${pad(mod, 20)} ${String(props.size).padStart(2)} 个属性  ${head}${list.length > 14 ? ` …(+${list.length - 14})` : ''}` +
        (noise ? `   〔已滤除 ${noise.size} 个撞名误报〕` : ''),
    );
  }
  console.log('\n  读法：属性数才是"要写多少代码"的量级；只有 1–3 个属性的模块，门槛可能远低于需求面暗示的。');
  console.log('  ⚠️ 这是**静态上限**：产物里出现过不等于运行期会执行到。真实验收仍以跑通为准。');
  if (propNoise.size) {
    console.log('  被滤除的撞名误报（供人工复核，取属性数最多的几个模块）：');
    for (const [mod, noise] of [...propNoise.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 4)) {
      console.log(`    ${pad(mod, 20)} ${[...noise].slice(0, 10).join(' ')}${noise.size > 10 ? ` …(+${noise.size - 10})` : ''}`);
    }
  }
}

if (asJson) {
  console.log('\n' + JSON.stringify({
    rows,
    coverage: Object.fromEntries(Object.keys(PRESETS).map((p) => {
      const emu = emulatedFor(p);
      return [p, {
        pass: built.filter((r) => passes(r, emu)).map((r) => r.name),
        blockers: Object.fromEntries(built.filter((r) => !passes(r, emu)).map((r) => [r.name, blockersOf(r, emu)])),
      }];
    })),
    nextBest: [...unblock.entries()].sort((a, b) => b[1].length - a[1].length).map(([mod, pkgs]) => ({ mod, unblocks: pkgs })),
  }, null, 2));
}
