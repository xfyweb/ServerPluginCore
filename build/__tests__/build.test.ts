// ⑦b 构建层测试（`docs/build-layer-design.md` §8 的 9 条 + 施工方案的 3 条补充 + 2026-09-27 的两条追加）
//
// 隔离：`SPC_STATE_DIR` / `SPC_AUDIT_DIR` 必须在**动态 import 核心之前**设好（manager/audit 有模块级常量）。
// 夹具全部造在 tmpdir 里：构建会写 `dist/`，不该在仓库工作树里留东西。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-build-'));
process.env.SPC_STATE_DIR = join(TMP, 'state');
process.env.SPC_AUDIT_DIR = join(TMP, 'state', 'audit');

const { manager } = await import('../../core/plugin/manager.ts');
const { loadLocalEnvelope } = await import('../../core/sources/verify.ts');
const { validateManifest } = await import('../../sdk/validate.ts');
const { SpcError } = await import('../../core/errors.ts');
const { runBuild, runDevCli } = await import('../cli.ts');
const { scanArtifact } = await import('../bundle.ts');
const { isExactVersion, reconcile, UNKNOWN_VERSION } = await import('../facts.ts');
const { generateAuthorKey, saveAuthorKey } = await import('../keys.ts');
const { ensureWorkspaceConfig, loadWorkspace, patchWorkspaceConfig } = await import('../workspace.ts');
import type { Workspace } from '../workspace.ts';

// ---------------- 夹具 ----------------

interface Fixture {
  root: string;
  dir: string;
  dist: string;
  ws: Workspace;
  fingerprint: string;
}

/** 造一个**带工作区与作者密钥**的插件目录（构建需要两者：作者对账 + 签名） */
function fixture(
  name: string,
  opts: { code?: string; manifest?: Record<string, unknown>; author?: string; files?: Record<string, string> } = {},
): Fixture {
  const root = join(TMP, name);
  mkdirSync(root, { recursive: true });
  const ws = loadWorkspace(root, { create: true });
  ensureWorkspaceConfig(ws);
  patchWorkspaceConfig(ws, { author: opts.author ?? 'std' });
  const saved = saveAuthorKey(ws, generateAuthorKey());

  const dir = join(root, 'plugin', name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schema: 2,
    id: `@${opts.author ?? 'std'}/${name}`,
    name: `Fixture ${name}`,
    version: { code: 1, name: '0.0.1' },
    runtime: { type: 'quickjs', esm: true },
    permissions: [{ name: 'fs.write.data' }],
    ...opts.manifest,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(join(dir, 'main.ts'), opts.code ?? 'export function init() {}\n', 'utf8');
  for (const [rel, text] of Object.entries(opts.files ?? {})) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return { root, dir, dist: join(dir, 'dist'), ws, fingerprint: saved.fingerprint };
}

/** 造一个真的能被 esbuild 解析的第三方包（`node_modules/<name>`） */
function npmPackage(dir: string, name: string, version: string, code: string): void {
  const pkgDir = join(dir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }), 'utf8');
  writeFileSync(join(pkgDir, 'index.js'), code, 'utf8');
}

/** 跑一次构建并**收走它打印的东西**（用例只断言关键行，不让日志淹掉测试输出） */
async function build(
  t: { mock: { method: (o: object, m: string, f: (...a: unknown[]) => void) => void } },
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => void out.push(a.map(String).join(' ')));
  t.mock.method(console, 'error', (...a: unknown[]) => void err.push(a.map(String).join(' ')));
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return { code: await runDevCli('build', args), out: out.join('\n'), err: err.join('\n') };
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/** 期望构建**抛**某个码（直接调 `runBuild`：走 CLI 会把码渲染成文案，就断言不到码了） */
async function rejects(
  fn: () => Promise<unknown>,
  code: string,
  extra: (e: InstanceType<typeof SpcError>) => void = () => {},
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof SpcError, `期望 SpcError(${code})，实际 ${String(e)}`);
    assert.equal(e.code, code, `错误码：${JSON.stringify(e.params)}`);
    extra(e);
    return;
  }
  assert.fail(`期望抛 ${code}，但它成功了`);
}

const read = (p: string): string => readFileSync(p, 'utf8');
const distManifestOf = (f: Fixture): Record<string, unknown> =>
  JSON.parse(read(join(f.dist, 'manifest.json'))) as Record<string, unknown>;

// ---------------- §8-1 / §8-7：产物能装进核心并跑起来 ----------------

test('§8-1/§8-7 样板插件经**构建产物**走通 install → 装载 → init/start', async (t) => {
  const f = fixture('e2e', {
    // 照脚手架模板的写法：宿主 API 的 fs 是**同步**的（`fs.write` / `fs.read`，不是 Node 的 promises 面），
    // 顺带 import 一个 node 内建 —— 它会被**内联成宿主仿真源码**进产物，正好把这条链也真跑一遍
    manifest: {
      permissions: [{ name: 'fs.write.data' }, { name: 'fs.read.data' }, { name: 'lifecycle.version' }],
    },
    code: [
      "import { lifecycle, fs } from '@host/api';",
      "import { join } from 'node:path';",
      'export function init() {',
      '  const v = lifecycle.version();',
      "  console.log('E2E contract=' + v.contract + ' api=' + v.api);",
      "  fs.write('out.txt', 'hi');",
      "  console.log('E2E read=' + fs.read('out.txt').content);",
      "  console.log('E2E join=' + join('a', 'b'));",
      '}',
      '',
    ].join('\n'),
  });

  const r = await build(t, [f.dir]);
  assert.equal(r.code, 0, r.err);

  // §8-7：产物清单的入口指向**产物文件**，而且自己得先过 schema；产物事实要写进去
  const distManifest = distManifestOf(f);
  assert.equal(distManifest.entry, 'bundle.js');
  assert.deepEqual(validateManifest(distManifest), { ok: true, errors: [] });
  const facts = distManifest.build as { closure: unknown[]; builtins: string[]; bytes: number };
  assert.deepEqual(facts.closure, []);
  assert.deepEqual(facts.builtins, ['path'], '用到的已登记内建要记进产物事实');
  assert.ok(facts.bytes > 0);

  // install → 装载 → init/start 真的跑起来（含内联进产物的 path 仿真）
  const logs: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  const view = await manager.install(f.dist);
  assert.equal(view.state, 'running');
  assert.equal(view.id, '@std/e2e');
  assert.equal(view.authorFingerprint, f.fingerprint, '信封里的公钥指纹应当被记下来');
  assert.ok(
    logs.some((l) => l.includes('E2E contract=')),
    `插件的 init 应当跑过：${logs.join(' | ')}`,
  );
  assert.ok(
    logs.some((l) => l.includes('E2E read=hi')),
    `数据目录读写应当通：${logs.join(' | ')}`,
  );
  assert.ok(
    logs.some((l) => l.includes('E2E join=a/b') || l.includes('E2E join=a\\b')),
    `内联进产物的 path 仿真应当在沙箱里跑得起来：${logs.join(' | ')}`,
  );
  await manager.stopAll('shutdown');
});

test('构建产物被核心自己的校验器验过（sign.ts ⟷ verify.ts 同一口径）', async (t) => {
  const f = fixture('envelope');
  assert.equal((await build(t, [f.dir])).code, 0);

  const env = loadLocalEnvelope(f.dist);
  assert.equal(env.kind, 'ok', JSON.stringify(env));
  assert.equal(env.kind === 'ok' ? env.authorPub : '', readAuthorPub(f));
  assert.equal(env.kind === 'ok' ? env.meta.releasedAt.length > 0 : false, true);
});

/** 工作区里的作者公钥（`author.pub` 是**裸 base64 一行**，不是 JSON —— 别按 JSON 读） */
function readAuthorPub(f: Fixture): string {
  return read(f.ws.pubPath).trim();
}

// ---------------- §8-2 / §8-3：第一道闸 ----------------

test('§8-2 未登记内建 ⇒ 构建期失败，文案是"沙箱尚未支持"（不是"装错包了"）', async () => {
  const f = fixture('unreg-builtin', { code: "import { request } from 'node:http';\nexport { request };\n" });
  await rejects(
    () => runBuild([f.dir]),
    'BUILD_BUILTIN_UNSUPPORTED',
    (e) => assert.equal(e.params.specifier, 'node:http'),
  );
  assert.ok(!existsSync(f.dist), '构建失败不该留下产物目录');
});

test('§8-3 CJS 包内部 require 未登记内建 ⇒ 第一道闸拦住，且报出依赖包内的行号', async () => {
  const f = fixture('cjs-builtin', {
    code: "import dep from 'probe-cjs';\nexport { dep };\n",
  });
  npmPackage(f.dir, 'probe-cjs', '1.0.0', "const http = require('http');\nmodule.exports = { http };\n");
  await rejects(
    () => runBuild([f.dir]),
    'BUILD_BUILTIN_UNSUPPORTED',
    (e) => {
      assert.equal(e.params.specifier, 'http');
      assert.match(e.params.where, /^node_modules\/probe-cjs\/index\.js:1$/, `要指到依赖包里那一行：${e.params.where}`);
    },
  );
});

test('§8-4 引入 .node ⇒ 构建期失败（配置里永远不出现 .node loader）', async () => {
  const f = fixture('native', {
    code: "import './native.node';\nexport const x = 1;\n",
    files: { 'native.node': 'not really a native module' },
  });
  await rejects(() => runBuild([f.dir]), 'BUILD_NATIVE_MODULE');
});

test('入口不存在 ⇒ BUILD_ENTRY_MISSING（清单说 entry=other.ts 而文件不在）', async () => {
  const f = fixture('no-entry', { manifest: { entry: 'other.ts' } });
  await rejects(() => runBuild([f.dir]), 'BUILD_ENTRY_MISSING');
});

// ---------------- §8-5 / §8-6：第二道闸与自动 stub ----------------

test('§8-5 带 try/catch 可选依赖的 CJS 包 ⇒ 构建成功，欠条换成 stub，行为与 Node 一致', async (t) => {
  const f = fixture('optional-dep', {
    code: [
      "import dep from 'probe-opt';",
      'export function init() {',
      "  console.log('OPT ' + dep.seen);",
      '}',
      '',
    ].join('\n'),
  });
  npmPackage(
    f.dir,
    'probe-opt',
    '1.0.0',
    [
      "let seen = 'none';",
      "try { require('probe-missing-optional'); seen = 'loaded'; } catch (e) { seen = e.code; }",
      'module.exports = { seen };',
      '',
    ].join('\n'),
  );

  const r = await build(t, [f.dir]);
  assert.equal(r.code, 0, `构建应当成功：${r.err}`);
  assert.match(r.out, /probe-missing-optional/, '被 stub 的模块要打给作者看');

  // 产物里不许再有运行期 require 的调用点（欠条已换成 stub）
  const code = read(join(f.dist, 'bundle.js'));
  assert.equal(scanArtifact(code).calls.length, 0, '产物里不该残留 require 调用点');

  // 真跑一遍：stub 在**取用时**抛 MODULE_NOT_FOUND，于是 try/catch 照常接住（与 Node 一致）
  const logs: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  const view = await manager.install(f.dist);
  assert.equal(view.state, 'running');
  assert.ok(
    logs.some((l) => l.includes('OPT MODULE_NOT_FOUND')),
    `可选依赖应当以 MODULE_NOT_FOUND 被接住：${logs.join(' | ')}`,
  );
  await manager.stopAll('shutdown');
});

test('§8-6 `require(变量)` ⇒ 构建期失败（stub 不了：不知道要 stub 什么）', async () => {
  const f = fixture('dynamic-req', { code: "import load from 'probe-dyn';\nexport const x = () => load('x');\n" });
  npmPackage(f.dir, 'probe-dyn', '1.0.0', 'module.exports = (n) => require(n);\n');
  await rejects(() => runBuild([f.dir]), 'BUILD_ARTIFACT_DEBT');
});

test('第二道闸的**负面样本**：手造的欠条必须被判出来（证明闸门真在拦，而不是样本恰好干净）', () => {
  // 辅助函数**定义**的参数为空 ⇒ 不算调用点（这就是为什么不能拿朴素正则去数 `__require(`）
  const clean = 'var __commonJS = (cb, mod) => function __require() {\n  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod);\n};\n';
  assert.deepEqual(scanArtifact(clean).calls, []);
  assert.equal(scanArtifact(clean).marker, false);

  const residue = 'var x = __require("tty");\n';
  assert.deepEqual(scanArtifact(residue).calls, ['"tty"']);
  assert.deepEqual(scanArtifact(residue).literals, ['tty']);

  const dynamic = 'var f = (n) => __require(n);\n';
  assert.equal(scanArtifact(dynamic).dynamic, true);
  assert.deepEqual(scanArtifact(dynamic).dynamicArgs, ['n']);
});

// ---------------- §8-8：确定性（限载荷） ----------------

test('§8-8 同一输入两次构建：载荷（bundle.js + manifest.json）字节一致', async (t) => {
  const f = fixture('deterministic', {
    code: "import { join } from 'node:path';\nexport const p = join('a', 'b');\n",
  });
  const at = '2026-09-27T00:00:00Z';
  assert.equal((await build(t, [f.dir], { SPC_RELEASED_AT: at })).code, 0);
  const first = { bundle: read(join(f.dist, 'bundle.js')), manifest: read(join(f.dist, 'manifest.json')) };

  // 换个 releasedAt 再构建：**载荷**必须一模一样（meta 本来就不在承诺内，见 §2.1）
  assert.equal((await build(t, [f.dir], { SPC_RELEASED_AT: '2026-09-28T00:00:00Z' })).code, 0);
  assert.equal(read(join(f.dist, 'bundle.js')), first.bundle, 'bundle 字节应当一致');
  assert.equal(read(join(f.dist, 'manifest.json')), first.manifest, '清单字节应当一致');

  // 而 meta 含 releasedAt，本来就**不**承诺一致 —— 这里顺手把这条边界也钉住
  const meta = JSON.parse(read(join(f.dist, 'plugin.meta.json'))) as { releasedAt: string };
  assert.equal(meta.releasedAt, '2026-09-28T00:00:00.000Z');
});

// ---------------- 追加：构建前先校验清单 + 作者对账 ----------------

test('构建前先跑 schema 校验：清单缺失 / 坏 JSON / 不合规 ⇒ 各自的码，且都不产出任何产物', async () => {
  const f = fixture('bad-manifest', { manifest: { id: '@BadAuthor/x' } }); // 大写：schema 的 id pattern 拒
  await rejects(
    () => runBuild([f.dir]),
    'BUILD_MANIFEST_INVALID',
    (e) => assert.match(e.params.detail, /id/, `要指出是哪条不合规：${e.params.detail}`),
  );
  assert.ok(!existsSync(f.dist), '清单都不合规就不该产出 dist');

  // 缺清单 / 坏 JSON 是**另外两种**失败（与 `spcdev check` 的三种 finding 同一套词汇），别都塌成一个码
  const missing = join(TMP, 'no-manifest');
  mkdirSync(missing, { recursive: true });
  await rejects(() => runBuild([missing]), 'BUILD_MANIFEST_MISSING');

  const malformed = fixture('malformed');
  writeFileSync(join(malformed.dir, 'manifest.json'), '{ 这不是 json', 'utf8');
  await rejects(() => runBuild([malformed.dir]), 'BUILD_MANIFEST_MALFORMED');
});

test('作者对账：清单的作者段必须等于工作区作者 ID；工作区没声明作者 ⇒ 复用 AUTHOR_ID_REQUIRED', async () => {
  const mismatch = fixture('author-mismatch', { manifest: { id: '@someone-else/x' } });
  await rejects(
    () => runBuild([mismatch.dir]),
    'BUILD_AUTHOR_MISMATCH',
    (e) => {
      assert.equal(e.params.reason, 'id-namespace');
      assert.equal(e.params.expected, 'std');
      assert.equal(e.params.actual, 'someone-else');
    },
  );

  // manifest.author.id 写了也必须一致（与 AUTHOR_MISMATCH 同一口径）
  const authorId = fixture('author-id-mismatch', { manifest: { author: { id: 'other@market.example' } } });
  await rejects(
    () => runBuild([authorId.dir]),
    'BUILD_AUTHOR_MISMATCH',
    (e) => assert.equal(e.params.reason, 'author-id'),
  );

  // 工作区没声明作者：不猜身份，复用已有的 AUTHOR_ID_REQUIRED（非 TTY 也走这条）
  // ⚠️ 清单本身要**合法**（id 写死 @std/…），否则会先撞 schema 校验 —— 那是另一条闸，别混进来
  const noAuthor = fixture('no-author', { author: '', manifest: { id: '@std/no-author' } });
  await rejects(
    () => runBuild([noAuthor.dir]),
    'AUTHOR_ID_REQUIRED',
    (e) => assert.match(e.params.file, /config\.json$/, '要告诉作者去哪儿补'),
  );
});

// ---------------- 追加：声明 ⟷ 真实闭包 对账 ----------------

test('对账：声明了却没打进闭包 ⇒ BUILD_DEP_UNUSED；精确版本不符 ⇒ BUILD_DEP_MISMATCH', async () => {
  const unused = fixture('dep-unused', {
    manifest: { dependencies: { npm: [{ name: 'probe-unused', version: '1.0.0' }] } },
  });
  npmPackage(unused.dir, 'probe-unused', '1.0.0', 'module.exports = 1;\n'); // 装了但入口没引用
  await rejects(
    () => runBuild([unused.dir]),
    'BUILD_DEP_UNUSED',
    (e) => assert.equal(e.params.name, 'probe-unused'),
  );

  const badVer = fixture('dep-version', {
    manifest: { dependencies: { npm: [{ name: 'probe-v', version: '9.9.9' }] } },
    code: "import v from 'probe-v';\nexport { v };\n",
  });
  npmPackage(badVer.dir, 'probe-v', '1.0.0', 'module.exports = 1;\n');
  await rejects(
    () => runBuild([badVer.dir]),
    'BUILD_DEP_MISMATCH',
    (e) => {
      assert.equal(e.params.declared, '9.9.9');
      assert.equal(e.params.resolved, '1.0.0');
    },
  );
});

test('对账：区间按 semver 判定（满足 ⇒ 过），真实闭包 + resolved 写进产物清单', async (t) => {
  const f = fixture('dep-range', {
    manifest: { dependencies: { npm: [{ name: 'probe-r', version: '^1.0.0' }] } },
    code: "import r from 'probe-r';\nexport { r };\n",
  });
  npmPackage(f.dir, 'probe-r', '1.4.2', 'module.exports = 1;\n');
  const res = await build(t, [f.dir]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /1\.4\.2/, '区间要打出来（判过也一样打，作者能看见这次用的是哪个版本）');
  assert.match(res.out, /区间已按声明判定：probe-r \^1\.0\.0 → 1\.4\.2/);

  const dist = distManifestOf(f) as { dependencies: { npm: { name: string; version: string; resolved?: string }[] }; build: { closure: { name: string; version: string; bytes: number }[] } };
  assert.equal(dist.dependencies.npm[0].resolved, '1.4.2', 'resolved 要写进产物清单');
  assert.equal(dist.dependencies.npm[0].version, '^1.0.0', '作者声明的原样保留');
  assert.deepEqual(
    dist.build.closure.map((c) => `${c.name}@${c.version}`),
    ['probe-r@1.4.2'],
  );
  assert.ok(dist.build.closure[0].bytes > 0, '体积要算出来（产物里占的字节）');
});

test('reconcile 单元：传递依赖不算不一致；精确判等、区间按 semver 判（口径同 npm）', () => {
  const closure = [
    { name: 'debug', version: '4.4.3', bytes: 10 },
    { name: 'ms', version: '2.1.3', bytes: 5 },
    { name: 'weird', version: UNKNOWN_VERSION, bytes: 1 },
  ];
  const r = reconcile([{ name: 'debug', version: '4.4.3' }], closure);
  assert.deepEqual(r.unused, []);
  assert.deepEqual(r.versionMismatch, []);
  assert.deepEqual(r.transitive, ['ms', 'weird'], '传递依赖只是记录，不是不一致');
  assert.deepEqual(r.unknownVersion, ['weird']);
  assert.equal(r.resolved.get('debug'), '4.4.3');

  // 区间：满足的进 rangesChecked，不满足的进 rangeUnsatisfied（构建期据此失败）
  const ranges = reconcile(
    [
      { name: 'ok', version: '^1.0.0' },
      { name: 'bad', version: '^2.0.0' },
      { name: 'pre', version: '^1.0.0' },
    ],
    [
      { name: 'ok', version: '1.4.2', bytes: 1 },
      { name: 'bad', version: '1.5.0', bytes: 1 },
      { name: 'pre', version: '1.5.0-beta.1', bytes: 1 },
    ],
  );
  assert.deepEqual(ranges.rangesChecked, [{ name: 'ok', declared: '^1.0.0', bundled: '1.4.2' }]);
  assert.deepEqual(
    ranges.rangeUnsatisfied.map((u) => u.name),
    ['bad', 'pre'],
    'pre-release 不满足普通区间 —— 与 npm 同口径（`npm i foo@^1.0.0` 也不会挑到 beta）',
  );

  for (const v of ['1.2.3', '1.2.3-beta.1']) assert.equal(isExactVersion(v), true, v);
  for (const v of ['^1.2.3', '~1.2.3', '>=1.2.3', '1.x', '1.2', '*', 'latest']) {
    assert.equal(isExactVersion(v), false, v);
  }
});

test('区间声明而真实版本不满足 ⇒ BUILD_DEP_RANGE_UNSATISFIED（清单在说谎就不该出货）', async () => {
  // 这条是**实测出来的洞**的回归：原先只比"锁 pin == 产物"，于是清单写 ^2.0.0、锁与产物都是 1.5.0 时
  // 还会打印"区间已核过"（假保证）。现在区间判定交给 semver ⇒ 直接失败。
  const f = fixture('range-unsatisfied', {
    manifest: { dependencies: { npm: [{ name: 'probe-bad', version: '^2.0.0' }] } },
    code: "import v from 'probe-bad';\nexport { v };\n",
  });
  npmPackage(f.dir, 'probe-bad', '1.5.0', 'module.exports = 1;\n');
  npmLock(f.dir, { 'probe-bad': '1.5.0' }); // 锁与产物一致（可复现），但都不满足声明
  await rejects(
    () => runBuild([f.dir]),
    'BUILD_DEP_RANGE_UNSATISFIED',
    (e) => {
      assert.equal(e.params.name, 'probe-bad');
      assert.equal(e.params.declared, '^2.0.0');
      assert.equal(e.params.bundled, '1.5.0');
    },
  );
});

// ---------------- 追加：锁文件（§9-3，2026-10-12 用户定：上 lockfile，"有利于插件本身 CI"）----------------

/** 造一份 npm 的 `package-lock.json` v3（构建层只读 `packages` 段的 `node_modules/<名字>`） */
function npmLock(dir: string, pins: Record<string, string>): void {
  const packages: Record<string, { version: string }> = { '': { version: '0.0.0' } };
  for (const [name, version] of Object.entries(pins)) packages[`node_modules/${name}`] = { version };
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages }, null, 2),
    'utf8',
  );
}

test('锁文件：pin == 产物 ⇒ 这次构建可复现；区间另由声明判定', async (t) => {
  const f = fixture('lock-ok', {
    manifest: { dependencies: { npm: [{ name: 'probe-lock', version: '^1.0.0' }] } },
    code: "import v from 'probe-lock';\nexport { v };\n",
  });
  npmPackage(f.dir, 'probe-lock', '1.2.3', 'module.exports = 1;\n');
  npmLock(f.dir, { 'probe-lock': '1.2.3' });

  const res = await build(t, [f.dir]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /锁文件：package-lock\.json（1 个包的版本按它核对可复现性）/);
  assert.match(res.out, /区间已按声明判定：probe-lock \^1\.0\.0 → 1\.2\.3/);
  assert.doesNotMatch(res.out, /可复现性未核/, '锁住了且一致 ⇒ 不该说可复现性未核');

  const dist = distManifestOf(f) as { dependencies: { npm: { resolved?: string; version: string }[] } };
  assert.equal(dist.dependencies.npm[0].resolved, '1.2.3');
  assert.equal(dist.dependencies.npm[0].version, '^1.0.0', '作者声明的原样保留');
});

test('锁文件：装了与锁不符 ⇒ BUILD_LOCKFILE_DRIFT（这次构建不可复现）', async () => {
  const f = fixture('lock-drift', {
    manifest: { dependencies: { npm: [{ name: 'probe-drift', version: '^1.0.0' }] } },
    code: "import v from 'probe-drift';\nexport { v };\n",
  });
  npmPackage(f.dir, 'probe-drift', '1.2.3', 'module.exports = 1;\n');
  npmLock(f.dir, { 'probe-drift': '1.0.0' }); // 锁还停在旧版本
  await rejects(
    () => runBuild([f.dir]),
    'BUILD_LOCKFILE_DRIFT',
    (e) => {
      assert.equal(e.params.name, 'probe-drift');
      assert.equal(e.params.pinned, '1.0.0');
      assert.equal(e.params.bundled, '1.2.3');
    },
  );
});

test('锁文件：pnpm 的 packages / snapshots 两段都认（v9 形状，且只扫了该扫的段）', async (t) => {
  const f = fixture('lock-pnpm', {
    manifest: { dependencies: { npm: [{ name: 'probe-pnpm', version: '^2.0.0' }] } },
    code: "import v from 'probe-pnpm';\nexport { v };\n",
  });
  npmPackage(f.dir, 'probe-pnpm', '2.1.0', 'module.exports = 1;\n');
  writeFileSync(
    join(f.dir, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      "  'probe-pnpm@2.1.0':",
      '    resolution: {integrity: sha512-xxx}',
      '',
      'snapshots:',
      '',
      "  'probe-pnpm@2.1.0':",
      '    resolution: {}',
      '',
    ].join('\n'),
    'utf8',
  );

  const res = await build(t, [f.dir]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /锁文件：pnpm-lock\.yaml（1 个包的版本按它核对可复现性）/);
  assert.match(res.out, /区间已按声明判定：probe-pnpm/);
});

test('锁文件：声明了但锁里没有 ⇒ 出声"可复现性未核"（区间照旧按声明判定）', async (t) => {
  const f = fixture('lock-unlocked', {
    manifest: { dependencies: { npm: [{ name: 'probe-unlocked', version: '^1.0.0' }] } },
    code: "import v from 'probe-unlocked';\nexport { v };\n",
  });
  npmPackage(f.dir, 'probe-unlocked', '1.0.0', 'module.exports = 1;\n');
  npmLock(f.dir, { 'some-other-pkg': '1.0.0' }); // 锁是认得的，只是没锁住这个包

  const res = await build(t, [f.dir]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /可复现性未核）：probe-unlocked/);
  assert.match(res.out, /区间已按声明判定：probe-unlocked \^1\.0\.0 → 1\.0\.0/, '没锁住不影响声明判定');
});

test('锁文件：没有锁文件 ⇒ 可复现性未核（区间已按声明判定）', async (t) => {
  const f = fixture('lock-none', {
    manifest: { dependencies: { npm: [{ name: 'probe-nolock', version: '^1.0.0' }] } },
    code: "import v from 'probe-nolock';\nexport { v };\n",
  });
  npmPackage(f.dir, 'probe-nolock', '1.0.0', 'module.exports = 1;\n');

  const res = await build(t, [f.dir]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /锁文件：无（区间已按声明判定；这次构建的可复现性未核）/);
  assert.match(res.out, /区间已按声明判定：probe-nolock/);
});

test('reconcile 单元：声明判定与可复现性判定是**两条独立的路**', () => {
  const closure = [
    { name: 'ok', version: '1.2.3', bytes: 1 },
    { name: 'drift', version: '1.2.3', bytes: 1 },
    { name: 'unlocked', version: '1.2.3', bytes: 1 },
    { name: 'bad', version: '1.2.3', bytes: 1 },
  ];
  const declared = [
    { name: 'ok', version: '^1.0.0' },
    { name: 'drift', version: '^1.0.0' },
    { name: 'unlocked', version: '^1.0.0' },
    { name: 'bad', version: '^2.0.0' },
  ];
  const pinned = new Map([
    ['ok', '1.2.3'],
    ['drift', '1.0.0'], // 锁旧了
    ['bad', '1.2.3'],
  ]);
  const r = reconcile(declared, closure, { kind: 'npm', file: 'package-lock.json', pinned });
  assert.deepEqual(
    r.rangesChecked.map((x) => x.name),
    ['ok', 'drift', 'unlocked'],
    '区间判定与锁无关：锁旧了、没锁住，都不影响"这个版本满不满足声明"',
  );
  assert.deepEqual(r.rangeUnsatisfied.map((x) => x.name), ['bad']);
  assert.deepEqual(r.lockfileDrift, [{ name: 'drift', pinned: '1.0.0', bundled: '1.2.3' }]);
  assert.deepEqual(r.unlocked, ['unlocked']);
});

test('构建时清掉上一次的陈旧产物：本次没变的文件也重写，载荷哈希与信封一致', async (t) => {
  const f = fixture('rewrite');
  assert.equal((await build(t, [f.dir])).code, 0);
  const h1 = JSON.parse(read(join(f.dist, 'plugin.meta.json'))) as { files: { path: string; sha256: string }[] };
  assert.equal((await build(t, [f.dir])).code, 0);
  const h2 = JSON.parse(read(join(f.dist, 'plugin.meta.json'))) as { files: { path: string; sha256: string }[] };
  assert.deepEqual(
    h2.files.map((x) => x.path),
    ['bundle.js', 'manifest.json'],
    '信封只覆盖载荷（信封自己不进 files[]）',
  );
  assert.deepEqual(h2.files, h1.files, '同输入 ⇒ 载荷哈希一致');
});

// ---------------- 追加：退出码契约（cli-contract.md） ----------------

test('退出码：门禁失败（BUILD_*）是 3，与一般失败（1）分开 —— CI 才分得清"我写错了"和"环境缺东西"', async (t) => {
  const gateFail = fixture('exit3', { code: "import x from 'node:http';\nexport { x };\n" });
  const r1 = await build(t, [gateFail.dir]);
  assert.equal(r1.code, 3, 'BUILD_* ⇒ 3');
  assert.match(r1.err, /沙箱尚未支持/, '文案要说清是宿主能力问题');

  // 非门禁的失败（这里是"没找到工作区"）仍然是 1：CI 才分得清"我写错了"与"环境缺东西"
  const noWs = join(TMP, 'no-workspace');
  const noWsPlugin = join(noWs, 'plugin');
  mkdirSync(noWsPlugin, { recursive: true });
  writeFileSync(
    join(noWsPlugin, 'manifest.json'),
    JSON.stringify({
      schema: 2,
      id: '@std/x',
      name: 'X',
      version: { code: 1, name: '0.0.1' },
      runtime: { type: 'quickjs' },
      permissions: [{ name: 'fs.write.data' }],
    }),
    'utf8',
  );
  writeFileSync(join(noWsPlugin, 'main.ts'), 'export function init() {}\n', 'utf8');
  const r2 = await build(t, [noWsPlugin]);
  assert.equal(r2.code, 1, `非 BUILD_* 的失败仍是 1：${r2.err}`);
});
