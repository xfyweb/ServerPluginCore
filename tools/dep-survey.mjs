// 依赖面实测（构建层"依赖管控"设计的证据生成器）
//
// 回答的问题：真实 npm 生态里，哪些包在 platform=node + format=esm 打包后会留下
// "运行期才解析模块"的**欠条**（esbuild 的 __require 兜底）？这些欠条该怎么分类处置？
//
// 为什么需要它：依赖管控的规则（硬闸 / 自动 stub / 构建失败）如果靠"想象生态长什么样"
// 来定，就会误伤（实测发现：把欠条一律判失败会拒掉 debug 这类**包作者显式声明可选**的库）。
//
// 用法：
//   1) 准备一个仓库外的取样目录（工具不会替你装包，避免污染仓库）：
//        mkdir <dir> && cd <dir> && npm init -y
//        npm i --registry=https://registry.npmmirror.com esbuild <包清单>
//   2) SPC_SURVEY_DIR=<dir> node tools/dep-survey.mjs
//   3) 自定义清单：node tools/dep-survey.mjs --packages zod,lodash,ws
//      JSON 输出：node tools/dep-survey.mjs --json
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinModules } from 'node:module';

/** 默认样本：覆盖"纯计算 / IO / 服务端 / 带可选原生加速器"四类真实形态 */
const DEFAULT_PACKAGES = [
  'zod', 'nanoid', 'chalk', 'picocolors', 'ms', 'semver', 'dayjs', 'lodash', 'uuid', 'yaml', 'ini',
  'dotenv', 'fs-extra', 'glob', 'rimraf', 'mkdirp', 'ajv', 'express', 'ws', 'axios', 'pino',
  'winston', 'ioredis', 'mysql2', 'pg', 'ssh2', 'dockerode',
];

/** 沙箱设计上**永远不会提供**的内建（网络/进程类：外包给官方驱动插件） */
const NEVER = ['net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'child_process', 'worker_threads', 'cluster', 'vm', 'module', 'diagnostics_channel'];

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const pkgArg = args[args.indexOf('--packages') + 1];
const PKGS = args.includes('--packages') ? pkgArg.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_PACKAGES;
const DIR = process.env.SPC_SURVEY_DIR ?? join(process.cwd(), '..', '_deps-survey');
const SRC = join(DIR, 'entries');
const BUILTINS = new Set(builtinModules);

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

/** specifier 归属：决定"谁来处理它" */
function classify(row, spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) return '原生/相对路径';
  if (BUILTINS.has(spec) || BUILTINS.has(spec.replace(/^node:/, ''))) return '内建';
  if (row.optional.includes(spec)) return 'optionalDep';
  if (row.peerOptional.includes(spec)) return '可选peer';
  if (row.peer.includes(spec)) return 'peer';
  return '真缺失';
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
    // 去掉辅助函数定义行，避免把 `function __require() {` 当成调用点
    const body = text.split('\n').filter((l) => !/function\s+__\w+\s*\(/.test(l)).join('\n');
    row.ok = true;
    row.bytes = text.length;
    row.warnings = r.warnings.length;
    row.debt = text.includes('Dynamic require of ');
    // 两种口径分开报：**调用点数**（多少处会炸）与 **specifier 去重数**（要 stub 几个名字）
    const litCalls = [...body.matchAll(/__require\s*\(\s*["']([^"']+)["']\s*\)/g)];
    row.literal = [...new Set(litCalls.map((m) => m[1]))];
    row.litCalls = litCalls.length;
    row.dynCalls = (body.match(/__require\s*\(/g) || []).length - litCalls.length;
  } catch (e) {
    row.ok = false;
    row.err = (e.errors ?? [{ text: String(e) }]).map((x) => x.text).join('; ').slice(0, 120);
  }
  rows.push(row);
}

if (asJson) {
  console.log(JSON.stringify(rows.map((r) => ({ ...r, classified: r.literal?.map((s) => ({ spec: s, owner: classify(r, s) })) })), null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`取样目录：${DIR}\n`);
console.log(pad('包名', 14) + pad('格式', 6) + pad('版本', 12) + pad('体积', 11) + pad('欠条', 7) + '未解析的 specifier（归属）');
console.log('-'.repeat(118));
let debtCount = 0, litCalls = 0, dynCalls = 0;
for (const r of rows) {
  if (r.missing) { console.log(`${pad(r.name, 14)}(未安装，跳过)`); continue; }
  if (!r.ok) { console.log(`${pad(r.name, 14)}${pad(r.kind, 6)}${pad(r.version, 12)}构建失败：${r.err}`); continue; }
  if (r.debt) debtCount++;
  litCalls += r.litCalls; dynCalls += r.dynCalls;
  const specs = r.literal.map((s) => `${s}[${classify(r, s)}]`).join(' ');
  console.log(`${pad(r.name, 14)}${pad(r.kind, 6)}${pad(r.version, 12)}${pad(r.bytes + 'B', 11)}${pad(r.debt ? '有' : '·', 7)}${specs}${r.dynCalls ? `  +动态×${r.dynCalls}` : ''}`);
}
console.log('-'.repeat(118));

const built = rows.filter((r) => r.ok);
const nonBuiltin = new Map();
for (const r of built) for (const s of r.literal) if (classify(r, s) !== '内建') nonBuiltin.set(s, classify(r, s));

console.log(`\n共 ${rows.length} 个包：构建成功 ${built.length}，有欠条 ${debtCount}`);
console.log(`欠条调用点 ${litCalls + dynCalls} 处 = 字面量 ${litCalls} 处（按名 stub 即可）+ 动态 ${dynCalls} 处（无法自动处理 → 构建失败，要求作者改写法）`);
console.log(`\n非内建的欠条 specifier 共 ${nonBuiltin.size} 个（这些才是"依赖"问题，其余都是"仿真覆盖度"问题）：`);
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

const netBound = built.filter((r) => r.literal.some((s) => NEVER.includes(s.replace(/^node:/, ''))));
if (netBound.length) {
  console.log('\n需要网络/进程类内建（设计上外包给官方驱动，沙箱内结构性不可用）：');
  for (const r of netBound) {
    const hit = r.literal.map((s) => s.replace(/^node:/, '')).filter((s) => NEVER.includes(s));
    console.log(`  ${pad(r.name, 14)} ${[...new Set(hit)].join(', ')}`);
  }
}
