// esbuild 行为矩阵探针（构建层设计 §3/§7 的证据生成器）
//
// 为什么需要它：esbuild 在"引用内建""CJS 依赖""原生模块"这几件事上的行为
// **不能靠读文档猜**——它会静默通过、静默降级、静默换实现。本工具把行为打成矩阵，
// 让"该配哪个 platform""为什么必须有产物断言"这类决定有据可依。
//
// 用法：node tools/esbuild-probe.mjs
// 自包含：全部样本是现造的，不需要安装任何 npm 包，可在 CI 里跑。
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const WORK = join(tmpdir(), 'spc-esbuild-probe');

/** 造样本：一个 src/ + 三个假的 node_modules 包 */
function makeFixtures() {
  rmSync(WORK, { recursive: true, force: true });
  const src = join(WORK, 'src');
  mkdirSync(src, { recursive: true });

  const write = (rel, text) => {
    const p = join(WORK, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };

  // ① 纯 ESM，不碰任何内建
  write('src/pure-esm.js', `export const ok = 'x'.toUpperCase();\n`);

  // ② ESM 引用 node: 前缀内建
  write('src/builtin-esm.js', `import { readFileSync } from 'node:fs';\nexport const f = readFileSync;\n`);

  // ③ ESM 引用裸名内建（"是不是内建"取决于 platform）
  write('src/builtin-bare.js', `import { join } from 'path';\nexport const j = join('a', 'b');\n`);

  // ④ CJS 依赖包：顶层裸 require（应可被 onResolve 拦）+ try/catch 可选 require（会留欠条）
  write('node_modules/probe-cjs/package.json', JSON.stringify({ name: 'probe-cjs', version: '1.0.0', main: 'index.js' }));
  write(
    'node_modules/probe-cjs/index.js',
    [
      `const util = require('util');`, //                            ← 顶层，非 try/catch
      `let opt; try { opt = require('probe-missing-optional'); } catch {}`, // ← 解析不到 → 欠条
      `module.exports = { util, opt };`,
    ].join('\n'),
  );
  write('src/cjs-dep.js', `import dep from 'probe-cjs';\nexport { dep };\n`);

  // ⑤ 带 browser 分支的包：platform=browser 会静默换实现
  write('node_modules/probe-browser/package.json', JSON.stringify({ name: 'probe-browser', version: '1.0.0', main: 'node.js', browser: 'browser.js' }));
  write('node_modules/probe-browser/node.js', `module.exports = { impl: 'node', tty: require('tty') };\n`);
  write('node_modules/probe-browser/browser.js', `module.exports = { impl: 'browser' };\n`);
  write('src/browser-branch.js', `import dep from 'probe-browser';\nexport { dep };\n`);

  // ⑥ 原生模块（.node）
  write('node_modules/probe-native/package.json', JSON.stringify({ name: 'probe-native', version: '1.0.0', main: 'index.js', gypfile: true }));
  write('node_modules/probe-native/index.js', `module.exports = require('./build/Release/addon.node');\n`);
  write('node_modules/probe-native/build/Release/addon.node', '\x7fELF fake binary placeholder');
  write('src/native.js', `import addon from 'probe-native';\nexport { addon };\n`);
}

const SAMPLES = ['pure-esm', 'builtin-esm', 'builtin-bare', 'cjs-dep', 'browser-branch', 'native'];
const PLATFORMS = ['browser', 'neutral', 'node'];

/** 扫产物：欠条信号 + 残留 specifier */
function scan(text) {
  const body = text.split('\n').filter((l) => !/function\s+__\w+\s*\(/.test(l)).join('\n');
  return {
    // 可靠判据：esbuild 自己的运行期兜底错误文案。有它 = 产物里有"运行期才解析模块"的代码
    debt: text.includes('Dynamic require of '),
    specs: [...new Set([...text.matchAll(/__require\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]))],
    esmSpecs: [...new Set([...text.matchAll(/(?:from|import)\s*"([^"]+)"/g)].map((m) => m[1]))],
    requireCalls: (body.match(/__require\s*\(/g) || []).length,
  };
}

makeFixtures();
console.log(`样本目录：${WORK}\n`);
console.log('参数矩阵：format=esm, bundle=true, target=es2022\n');

const rows = [];
for (const platform of PLATFORMS) {
  for (const name of SAMPLES) {
    let r;
    try {
      const out = await build({
        entryPoints: [join(WORK, 'src', `${name}.js`)],
        bundle: true,
        format: 'esm',
        platform,
        target: 'es2022',
        write: false,
        logLevel: 'silent',
        absWorkingDir: WORK,
      });
      const text = out.outputFiles[0].text;
      r = { platform, name, ok: true, bytes: text.length, ...scan(text), warnings: out.warnings.length };
    } catch (e) {
      r = { platform, name, ok: false, err: (e.errors ?? [{ text: String(e) }]).map((x) => x.text).join('; ') };
    }
    rows.push(r);
  }
}

const label = (r) => {
  if (!r.ok) return `FAIL  ${r.err.replace(/\s+/g, ' ').slice(0, 62)}`;
  const bits = [`${String(r.bytes).padStart(7)}B`];
  if (r.debt) bits.push(`欠条:${r.specs.length ? r.specs.join(',') : '(动态)'}`);
  if (r.esmSpecs.length) bits.push(`遗留spec:${r.esmSpecs.join(',')}`);
  if (!r.debt && !r.esmSpecs.length) bits.push('干净');
  return `ok    ${bits.join('  ')}`;
};

for (const platform of PLATFORMS) {
  console.log(`── platform: ${platform} ──`);
  for (const r of rows.filter((x) => x.platform === platform)) {
    console.log(`  ${r.name.padEnd(16)} ${label(r)}`);
  }
  console.log('');
}

console.log('读法：');
console.log('  · platform=node 下内建被 externalize，构建**静默通过**（builtin-* 两行就是证据）');
console.log('  · browser 的"通过"是假象：probe-browser 走了 browser 分支，实现被静默替换');
console.log('  · neutral 解析不了 CJS 包与裸名内建');
console.log('  · 原生的"必失败"来自"No loader is configured"，**不是自动保证**——配上 .node loader 就能过');
console.log('  · 欠条(try/catch 可选依赖)只在 node 下出现，且 esbuild 连 warning 都不给');
