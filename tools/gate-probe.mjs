// 两道闸的可行性探针（构建层设计 §5 的证据生成器）
//
// 回答这些问题——它们决定闸门怎么建，且都不能靠读文档回答：
//   ① 第一道闸返回 error 时，能拦住哪些形态？（ESM / CJS 顶层 / CJS try-catch）
//   ② 已登记的仿真模块，对外 CJS 依赖该"内联"还是"标记 external"？
//   ③ 第二道闸扫什么才不误报？（朴素正则 vs 标记字符串）
//
// 用法：node tools/gate-probe.mjs
// 自包含：样本现造，不需要安装任何 npm 包，可在 CI 里跑。
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builtinModules } from 'node:module';

const WORK = join(tmpdir(), 'spc-gate-probe');
const BUILTINS = new Set(builtinModules);
const ok = (b) => (b ? '✅' : '❌');

function makeFixtures() {
  rmSync(WORK, { recursive: true, force: true });
  const write = (rel, text) => {
    const p = join(WORK, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };

  // 仿真 shim：静态、无占位符——这是"可被内联"的前提（module-emulation §5）
  write('shim/node-util.js', `export function format() { return ''; }\nexport default { format };\n`);
  write('shim/node-fs.js', `export function readFileSync() { return ''; }\nexport default { readFileSync };\n`);
  write('shim/node-crypto.js', `export function randomUUID() { return ''; }\nexport default { randomUUID };\n`);

  // CJS 依赖包：覆盖四种形态
  write('node_modules/probe-cjs/package.json', JSON.stringify({ name: 'probe-cjs', version: '1.0.0', main: 'index.js' }));
  write(
    'node_modules/probe-cjs/index.js',
    [
      `const fs = require('fs');`, //                                        ← 顶层，未登记内建
      `let crypto; try { crypto = require('crypto'); } catch {}`, //          ← try/catch，未登记内建
      `let util; try { util = require('util'); } catch {}`, //                ← try/catch，已登记内建
      `let opt; try { opt = require('probe-missing-optional'); } catch {}`, // ← try/catch，解析不到
      `module.exports = { fs, crypto, util, opt };`,
    ].join('\n'),
  );

  write('src/esm-builtin.js', `import { readFileSync } from 'node:fs';\nexport const f = readFileSync;\n`);
  write('src/cjs-dep.js', `import dep from 'probe-cjs';\nexport { dep };\n`);
  write('src/dynamic-require.js', `export const load = (n) => require(n);\n`);
}

const BASE = { bundle: true, format: 'esm', platform: 'node', target: 'es2022', write: false, logLevel: 'silent', absWorkingDir: WORK };
const entry = (n) => [join(WORK, 'src', `${n}.js`)];

/** 第一道闸：已登记内建 → 内联 shim；未登记内建 → error（strict）/ 放行（否则） */
const gate = (registered = [], { strict = true, mode = 'inline' } = {}) => ({
  name: 'gate1',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      const bare = a.path.replace(/^node:/, '');
      if (registered.includes(bare)) {
        return mode === 'inline'
          ? { path: join(WORK, 'shim', `node-${bare}.js`) } // ← 内联仿真正文
          : { path: `node:${bare}`, external: true }; //       ← 留给沙箱 loader（只对 ESM 有效）
      }
      if (strict && BUILTINS.has(bare)) return { errors: [{ text: `沙箱尚未支持 ${a.path}` }] };
      return undefined;
    });
  },
});

/** 把解析不到的 specifier 换成"模块不可用"的 stub（抛 Node 形状的错误） */
const stubGate = (specs) => ({
  name: 'stub',
  setup(b) {
    b.onResolve({ filter: new RegExp(`^(${specs.join('|')})$`) }, () => ({ path: 'spc-stub', namespace: 'spc-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'spc-stub' }, (a) => ({
      contents: `const e = new Error("Cannot find module '${a.path}'"); e.code = 'MODULE_NOT_FOUND'; throw e;`,
      loader: 'js',
    }));
  },
});

async function tryBuild(name, plugins) {
  try {
    const r = await build({ ...BASE, entryPoints: entry(name), plugins, metafile: true });
    const text = r.outputFiles[0].text;
    const body = text.split('\n').filter((l) => !/function\s+__\w+\s*\(/.test(l)).join('\n');
    return {
      ok: true, bytes: text.length, warnings: r.warnings.length,
      marker: text.includes('Dynamic require of '), //          ← 可靠判据
      naive: (text.match(/__require\s*\(/g) || []).length, //     ← 朴素正则（含辅助函数定义）
      realCalls: (body.match(/__require\s*\(/g) || []).length,
      specs: [...new Set([...text.matchAll(/__require\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]))],
      shimInlined: /isatty|randomUUID|readFileSync\(\)/.test(text),
    };
  } catch (e) {
    return { ok: false, errors: (e.errors ?? [{ text: String(e) }]).map((x) => `${x.text}  @ ${(x.location?.file ?? '').replace(WORK, '').replace(/\\/g, '/')}:${x.location?.line ?? '?'}`) };
  }
}

makeFixtures();
console.log(`样本目录：${WORK}\n`);

// ── ① 第一道闸能拦住哪些形态 ──
console.log('① 第一道闸（未登记内建 → error）能拦住哪些形态？');
const a1 = await tryBuild('esm-builtin', [gate([])]);
console.log(`   ${ok(!a1.ok)} ESM import 'node:fs'          → ${a1.ok ? '没拦住' : a1.errors.join(' | ')}`);
const a2 = await tryBuild('cjs-dep', [gate(['util'])]);
console.log(`   ${ok(!a2.ok)} CJS 依赖内部                   → ${a2.ok ? '没拦住' : `${a2.errors.length} 处报错`}`);
if (!a2.ok) for (const e of a2.errors) console.log(`        · ${e}`);
console.log('   → try/catch 里的 require 也会触发 onResolve，因此**同样被拦住**（不是盲区）。\n');

// ── ② 内联 shim vs external ──
console.log('② 已登记的仿真模块，对外 CJS 依赖该内联还是 external？');
const ALL = ['fs', 'crypto', 'util'];
const inlined = await tryBuild('cjs-dep', [gate(ALL), stubGate(['probe-missing-optional'])]);
console.log(`   ${ok(!inlined.marker && inlined.realCalls === 0)} 内联 shim  ：欠条=${inlined.marker ? '有' : '无'}  残留调用=${inlined.realCalls}  仿真已进产物=${inlined.shimInlined}  体积=${inlined.bytes}B`);
const ext = await tryBuild('cjs-dep', [gate(ALL, { mode: 'external' }), stubGate(['probe-missing-optional'])]);
console.log(`   ${ok(!ext.marker && ext.realCalls === 0)} 标 external：欠条=${ext.marker ? '有' : '无'}  残留调用=${ext.realCalls}  残留 spec=[${ext.specs}]`);
console.log('   → external 对 CJS 形态无效（CJS-in-ESM 无法提升成 import，退化成运行期欠条）。');
console.log('   → 必须内联。推论：shim 要写成"静态、无占位符"，否则内联不了（module-emulation §5 要改）。\n');

// ── ③ 第二道闸的判据 ──
console.log('③ 第二道闸扫什么才不误报？');
console.log('   场景                          朴素正则   真调用点   标记字符串');
for (const [tag, plugins] of [
  ['全部处理干净', [gate(ALL), stubGate(['probe-missing-optional'])]],
  ['只处理内建（留可选依赖）', [gate(ALL)]],
  ['只 external（不内联）', [gate(ALL, { mode: 'external' })]],
  ['完全不处理', []],
  ['动态 require（变量）', [gate(ALL), stubGate(['probe-missing-optional'])]],
]) {
  const n = tag === '动态 require（变量）' ? 'dynamic-require' : 'cjs-dep';
  const r = await tryBuild(n, plugins);
  console.log(`   ${tag.padEnd(26)} ${String(r.naive).padStart(8)} ${String(r.realCalls).padStart(10)}   ${r.marker ? '有 ⚠' : '无'}`);
}
console.log('   → 朴素正则会命中**辅助函数定义行** `function __require() {` → 误报。');
console.log('   → 标记字符串只在"确实留下运行期解析"时出现（含动态 require），不受辅助函数命名影响。');
console.log('   → 代价：依赖 esbuild 文案 ⇒ 锁 esbuild 版本，并用本工具做回归。');
