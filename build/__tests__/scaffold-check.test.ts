// ⑦a 脚手架与自检测试：`spcdev new` 生成的插件要**真的能用**（清单合规、自检通过、权限点存在）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkPlugin } from '../check';
import { generateAuthorKey, loadAuthorKey, saveAuthorKey } from '../keys';
import { listPermissions } from '../permissions';
import { scaffoldPlugin } from '../scaffold';
import { runDevCli, type CliIo } from '../cli';
import { loadWorkspace } from '../workspace';
import { registry } from '../../core/permissions/registry';
import { validateManifest } from '../../sdk/validate';
import { SpcError } from '../../core/errors';

const TMP = mkdtempSync(join(tmpdir(), 'spc-scaffold-'));

function workspace(name: string): ReturnType<typeof loadWorkspace> {
  const root = join(TMP, name);
  mkdirSync(root, { recursive: true });
  return loadWorkspace(root, { create: true });
}

/** 直接手搓一支插件（自检用例要造各种"错"） */
function writePlugin(dir: string, manifest: Record<string, unknown>, code: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(join(dir, 'main.ts'), code, 'utf8');
  return dir;
}

const baseManifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 2,
  id: '@spc/demo',
  name: 'Demo',
  version: { code: 1, name: '0.0.1' },
  runtime: { type: 'quickjs', esm: true },
  entry: 'main.ts',
  permissions: [{ name: 'fs.write.data', reason: '写自己的数据目录' }],
  ...over,
});

// ---------------- plugin new ----------------

test('plugin new：生成的清单过 SDK 校验，默认权限点都是本机已注册的', () => {
  const ws = workspace('scaffold-ok');
  const result = scaffoldPlugin(ws, { name: 'demo', author: 'std' });
  assert.equal(result.id, '@std/demo');
  assert.equal(result.dir, join(ws.root, 'plugin', 'demo'));
  assert.deepEqual(result.files.sort(), ['README.md', 'main.ts', 'manifest.json', 'package.json', 'tsconfig.json', '.gitignore'].sort());
  for (const f of result.files) assert.ok(existsSync(join(result.dir, f)), f);

  const manifest = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  const points = (manifest.permissions as { name: string }[]).map((p) => p.name);
  assert.ok(points.length > 0);
  for (const point of points) assert.ok(registry.get(point), `${point} 应当在冻结表里`);

  // 插件目录里的短命令脚本要指向**作者工具**入口（`spcdev` 的语义）
  const pkg = JSON.parse(readFileSync(join(result.dir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.spcdev, 'tsx ../../core/cli-dev.ts');
});

test('plugin new：生成出来的插件**自己就能过 check**（无 error）', () => {
  const ws = workspace('scaffold-check');
  const result = scaffoldPlugin(ws, { name: 'demo', author: 'std' });
  const checked = checkPlugin(result.dir);
  assert.deepEqual(
    checked.findings.filter((f) => f.level === 'error'),
    [],
    `脚手架产物不该有 error：${JSON.stringify(checked.findings)}`,
  );
  assert.equal(checked.ok, true);
});

test('plugin new：目录已存在非空 ⇒ 拒（+ --force 才覆盖）；名字/id 非法 ⇒ 各自的码', () => {
  const ws = workspace('scaffold-guard');
  const result = scaffoldPlugin(ws, { name: 'demo', author: 'std' });
  writeFileSync(join(result.dir, 'keep.txt'), 'x', 'utf8');

  assert.throws(
    () => scaffoldPlugin(ws, { name: 'demo', author: 'std' }),
    (e: unknown) => e instanceof SpcError && e.code === 'PLUGIN_DIR_EXISTS',
  );
  assert.ok(existsSync(join(result.dir, 'keep.txt')), '被拒 ⇒ 原目录一个字节都不动');
  assert.doesNotThrow(() => scaffoldPlugin(ws, { name: 'demo', author: 'std', force: true }));

  assert.throws(
    () => scaffoldPlugin(ws, { name: 'Demo', author: 'std' }),
    (e: unknown) => e instanceof SpcError && e.code === 'PLUGIN_NAME_INVALID',
  );
  // 作者 ID 非法 ⇒ 自己的码（不是笼统的 PLUGIN_ID_INVALID：告诉作者**是哪一段**不对）
  assert.throws(
    () => scaffoldPlugin(ws, { name: 'demo', author: 'Bad' }),
    (e: unknown) => e instanceof SpcError && e.code === 'AUTHOR_ID_INVALID',
  );
});

test('permission list：列出冻结表，且与注册表的点数一致', () => {
  const rows = listPermissions();
  assert.equal(rows.length, registry.all().length);
  const fsRead = rows.find((r) => r.name === 'fs.read.data');
  assert.ok(fsRead);
  assert.equal(fsRead.scope, 'self');
  assert.equal(fsRead.grant, 'auto', 'self 档缺省推成 auto');
});

test('spcdev 分发：未落地的动词报"还没做"（不是"未知命令"），未知动词给用法', async () => {
  // ⑦b/⑦c 的动词现在就明确挡掉：作者不该等一个静默失败的动词
  assert.equal(await runDevCli('build', []), 1);
  assert.equal(await runDevCli('pack', []), 1);
  assert.equal(await runDevCli('watch', []), 1);
  assert.equal(await runDevCli('nope', []), 1);
  // 已落地的四个动词能被分发到（keygen 要作者 ID，非交互就得显式给）
  assert.equal(await runDevCli('keygen', ['--dir', join(TMP, 'devcli-keygen'), '--author', 'std']), 0);
});

test('spcdev 顶层兜底：抛出来的 SpcError 渲染成"码 + 参数"，不是整段堆栈', async (t) => {
  // 回归：以前 runDevCli 不接错误，抛出来的 SpcError 由 Node 打出 `SpcError: …` + 堆栈（内部路径、行号）——
  // 用户看不到"哪个值非法、该改成什么样"。这里用一份**坏掉的 config.json** 让它真抛一次。
  const ws = workspace('devcli-throw');
  writeFileSync(join(ws.dir, 'config.json'), '{ 这不是 json', 'utf8');
  const lines: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => {
    lines.push(a.map((x) => String(x)).join(' '));
  });

  const code = await runDevCli('new', ['demo', '--dir', ws.root]);
  const text = lines.join('\n');
  assert.equal(code, 1);
  assert.match(text, /工作区文件非法/, `应当渲染出码 + 参数：${text}`);
  assert.doesNotMatch(text, /SpcError|workspace\.ts|\bat\b/, `不该出现堆栈或内部路径：${text}`);
});

// ---------------- 作者 ID（keygen 问一次 → 写进配置 → new 默认用）----------------

/** 跑一次 dev CLI 并收集 console.log/console.error（用例要看它**说了什么**，不只是退出码） */
async function runDev(
  cmd: string,
  args: string[],
  io: CliIo = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(' '));
  try {
    const code = await runDevCli(cmd, args, io);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const configOf = (ws: { dir: string }): { author?: string } =>
  JSON.parse(readFileSync(join(ws.dir, 'config.json'), 'utf8')) as { author?: string };

test('keygen：作者 ID 写进 .spcdev/config.json（--author 是非交互下的唯一来路）', async () => {
  const ws = workspace('author-keygen');
  const r = await runDev('keygen', ['--dir', ws.root, '--author', 'std']);
  assert.equal(r.code, 0, r.err);
  assert.equal(configOf(ws).author, 'std');
  assert.ok(existsSync(join(ws.dir, 'keys', 'author.key')), '密钥也要生成');
  assert.match(r.out, /作者 ID：std/, '要把写进配置的作者 ID 明说一遍');
});

test('keygen：非交互又没给 --author ⇒ 拒，且**一个字节都不写**（身份不做默认值）', async () => {
  const ws = workspace('author-nontty');
  const r = await runDev('keygen', ['--dir', ws.root], { interactive: false });
  assert.equal(r.code, 1);
  assert.match(r.err, /还不知道作者 ID/, `该报 AUTHOR_ID_REQUIRED：${r.err}`);
  assert.equal(configOf(ws).author ?? '', '', '配置里不该冒出作者 ID');
  assert.equal(existsSync(join(ws.dir, 'keys', 'author.key')), false, '也不该产钥');
});

test('keygen：交互时回车用建议默认值，亲手输入以输入为准，非法输入即拒', async () => {
  // 回车 ⇒ 用 git 推断出来的建议值
  const a = workspace('author-enter');
  const asked: string[] = [];
  const r1 = await runDev('keygen', ['--dir', a.root], {
    interactive: true,
    suggest: () => 'suggested-name',
    ask: async (q) => {
      asked.push(q);
      return '';
    },
  });
  assert.equal(r1.code, 0, r1.err);
  assert.equal(configOf(a).author, 'suggested-name');
  assert.match(asked.join(''), /suggested-name/, '提示里要带上建议值');

  // 亲手输入 ⇒ 以输入为准（不是"默认值优先"）
  const b = workspace('author-typed');
  const r2 = await runDev('keygen', ['--dir', b.root], {
    interactive: true,
    suggest: () => 'suggested-name',
    ask: async () => '@typed',
  });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(configOf(b).author, 'typed', '允许写成 @typed，存下来的是裸段');

  // 非法输入 ⇒ 拒（不猜、不改写），且没写任何东西
  const c = workspace('author-bad');
  const r3 = await runDev('keygen', ['--dir', c.root], {
    interactive: true,
    suggest: () => '',
    ask: async () => 'Bad Name',
  });
  assert.equal(r3.code, 1);
  assert.match(r3.err, /作者 ID 非法：Bad Name/, r3.err);
  assert.equal(existsSync(join(c.dir, 'keys', 'author.key')), false);
});

test('new：作者 ID 取自配置；--author 可临时覆盖；两者都没有 ⇒ 拒（不猜）', async () => {
  const ws = workspace('author-new');
  assert.equal((await runDev('keygen', ['--dir', ws.root, '--author', 'std'])).code, 0);

  const r1 = await runDev('new', ['demo', '--dir', ws.root]);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /@std\/demo/, 'id 应当是 @<配置里的作者 ID>/<名字>');

  const r2 = await runDev('new', ['other', '--dir', ws.root, '--author', 'guest']);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, /@guest\/other/, '--author 只影响这一次');
  assert.equal(configOf(ws).author, 'std', '配置不该被 --author 改掉');

  // 没有任何来路 ⇒ 拒，且不建目录（宁可什么都不做，也不猜一个身份）
  const bare = workspace('author-new-bare');
  const r3 = await runDev('new', ['demo', '--dir', bare.root]);
  assert.equal(r3.code, 1);
  assert.match(r3.err, /还不知道作者 ID/, r3.err);
  assert.equal(existsSync(join(bare.root, 'plugin', 'demo')), false);
});

test('new：--id 明确被拒（而不是静默忽略 —— id 决定插件挂在谁名下）', async () => {
  const ws = workspace('author-id-removed');
  assert.equal((await runDev('keygen', ['--dir', ws.root, '--author', 'std'])).code, 0);
  const r = await runDev('new', ['demo', '--id', '@other/demo', '--dir', ws.root]);
  assert.equal(r.code, 1);
  assert.match(r.out, /不再接受 --id/, r.out);
  assert.equal(existsSync(join(ws.root, 'plugin', 'demo')), false, '被拒 ⇒ 不建目录');
});

test('keygen：钥在但作者 ID 没登记 ⇒ 只登记，**密钥一个字节不动**（拷 keys/ 换机器的场景）', async () => {
  const ws = workspace('author-record');
  const saved = saveAuthorKey(ws, generateAuthorKey());
  const before = readFileSync(saved.keyPath, 'utf8');

  const r = await runDev('keygen', ['--dir', ws.root, '--author', 'alice']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /作者 ID 已登记：alice/, r.out);
  assert.equal(configOf(ws).author, 'alice');
  assert.equal(readFileSync(saved.keyPath, 'utf8'), before, '密钥必须原样（登记身份不该换钥）');
  assert.equal(loadAuthorKey(saved.keyPath).fingerprint, saved.fingerprint);

  // 登记完再跑（配置里已有作者 ID、钥也在）⇒ 回到"换钥要 --force"的老规矩
  const again = await runDev('keygen', ['--dir', ws.root]);
  assert.equal(again.code, 1);
  assert.match(again.err, /已有作者密钥/, again.err);
});

// ---------------- check ----------------

test('check：好插件 ⇒ 无 error（未使用的声明只是 warn）', () => {
  const dir = writePlugin(
    join(TMP, 'good', 'main.ts').replace(/main\.ts$/, ''),
    baseManifest({ permissions: [{ name: 'fs.write.data' }, { name: 'kv.read' }] }),
    `import { fs } from '@host/api';\nexport function init(){ fs.write('a.txt', 'x'); }\n`,
  );
  const res = checkPlugin(dir);
  assert.equal(res.ok, true);
  assert.deepEqual(res.findings.filter((f) => f.level === 'error'), []);
  assert.ok(res.findings.some((f) => f.code === 'POINT_UNUSED' && f.params.families.includes('kv.read')));
});

test('check：代码用了但清单没声明 ⇒ POINT_NOT_DECLARED（且指出是哪些方法）', () => {
  const dir = writePlugin(
    join(TMP, 'undeclared'),
    baseManifest({ permissions: [{ name: 'kv.read' }] }),
    `import { fs, kv } from '@host/api';\nexport function init(){ kv.get('x'); fs.write('a.txt', 'x'); }\n`,
  );
  const res = checkPlugin(dir);
  assert.equal(res.ok, false);
  const f = res.findings.find((x) => x.code === 'POINT_NOT_DECLARED');
  assert.ok(f, JSON.stringify(res.findings));
  assert.match(f.params.families, /fs\.write/);
  assert.match(f.params.methods, /fs\.write/);
});

test('check：别名导入也算（`import { fs as f }`）', () => {
  const dir = writePlugin(
    join(TMP, 'alias'),
    baseManifest({ permissions: [{ name: 'fs.write.data' }] }),
    `import { fs as f } from '@host/api';\nexport function init(){ f.write('a.txt', 'x'); }\n`,
  );
  const res = checkPlugin(dir);
  assert.equal(res.ok, true, JSON.stringify(res.findings));
  assert.equal(res.summary.inferred, 1);
});

test('check：动态族（exec 模板 / plugins.call）只提示不判', () => {
  const dir = writePlugin(
    join(TMP, 'dynamic'),
    baseManifest({
      permissions: [
        { name: 'exec.template.git.version' },
        { name: 'plugins.call.local:default/@spc/other./api/x' },
      ],
    }),
    `export function init(){}\n`,
  );
  const res = checkPlugin(dir);
  const codes = res.findings.map((f) => f.code);
  assert.equal(codes.filter((c) => c === 'POINT_DYNAMIC').length, 2);
  assert.ok(!codes.includes('POINT_UNKNOWN'), '动态族不该被判成未知点');
});

test('check：不存在的权限点 ⇒ POINT_UNKNOWN', () => {
  const dir = writePlugin(join(TMP, 'unknown-point'), baseManifest({ permissions: [{ name: 'nope.nope' }] }), 'export function init(){}\n');
  const res = checkPlugin(dir);
  assert.equal(res.ok, false);
  assert.equal(res.findings.find((f) => f.code === 'POINT_UNKNOWN')?.params.point, 'nope.nope');
});

test('check：内建分两种 —— 已仿真的放行，未登记的报 BUILTIN_NOT_EMULATED', () => {
  const ok = writePlugin(
    join(TMP, 'builtin-ok'),
    baseManifest(),
    `import { join } from 'node:path';\nimport { fs } from '@host/api';\nexport function init(){ join('a','b'); fs.write('a.txt','x'); }\n`,
  );
  assert.equal(checkPlugin(ok).ok, true, JSON.stringify(checkPlugin(ok).findings));

  const bad = writePlugin(
    join(TMP, 'builtin-bad'),
    baseManifest({ permissions: [{ name: 'fs.write.data' }] }),
    `import { createSocket } from 'node:dgram';\nimport { fs } from '@host/api';\nexport function init(){ createSocket; fs.write('a.txt','x'); }\n`,
  );
  const res = checkPlugin(bad);
  assert.equal(res.ok, false);
  assert.equal(res.findings.find((f) => f.code === 'BUILTIN_NOT_EMULATED')?.params.spec, 'node:dgram');
});

test('check：解析不到的第三方依赖 ⇒ DEPENDENCY_UNRESOLVED；解析得到但没声明 ⇒ warn', () => {
  const missing = writePlugin(
    join(TMP, 'dep-missing'),
    baseManifest(),
    `import { fs } from '@host/api';\nimport x from 'definitely-not-installed-pkg';\nexport function init(){ x; fs.write('a.txt','x'); }\n`,
  );
  const res = checkPlugin(missing);
  assert.equal(res.findings.find((f) => f.code === 'DEPENDENCY_UNRESOLVED')?.params.spec, 'definitely-not-installed-pkg');

  // "解析得到但没声明"：在夹具目录里造一个**本地依赖**（不依赖本体 node_modules 的解析路径）
  const undeclaredDir = join(TMP, 'dep-undeclared');
  const fakeDep = join(undeclaredDir, 'node_modules', 'fake-dep');
  mkdirSync(fakeDep, { recursive: true });
  writeFileSync(join(fakeDep, 'package.json'), JSON.stringify({ name: 'fake-dep', version: '1.0.0', main: 'index.js' }), 'utf8');
  writeFileSync(join(fakeDep, 'index.js'), 'export default 1;\n', 'utf8');
  writePlugin(
    undeclaredDir,
    baseManifest(),
    `import { fs } from '@host/api';\nimport fake from 'fake-dep';\nexport function init(){ fake; fs.write('a.txt','x'); }\n`,
  );
  const res2 = checkPlugin(undeclaredDir);
  assert.equal(res2.ok, true, JSON.stringify(res2.findings));
  assert.equal(res2.findings.find((f) => f.code === 'NPM_NOT_DECLARED')?.params.pkg, 'fake-dep');
});

test('check：清单本身的问题（缺 id / 不是 JSON / 缺入口）各报各的码', () => {
  const noId = writePlugin(join(TMP, 'bad-manifest'), baseManifest({ id: undefined }), 'export function init(){}\n');
  const res = checkPlugin(noId);
  assert.equal(res.ok, false);
  assert.equal(res.findings[0]?.code, 'MANIFEST_INVALID');

  const badJson = join(TMP, 'bad-json');
  mkdirSync(badJson, { recursive: true });
  writeFileSync(join(badJson, 'manifest.json'), '{ not json', 'utf8');
  assert.equal(checkPlugin(badJson).findings[0]?.code, 'MANIFEST_MALFORMED');

  const noEntry = writePlugin(join(TMP, 'no-entry'), baseManifest({ entry: 'nope.ts' }), 'export function init(){}\n');
  assert.equal(checkPlugin(noEntry).findings.find((f) => f.code === 'ENTRY_MISSING')?.params.entry, 'nope.ts');

  const noManifest = join(TMP, 'empty-dir');
  mkdirSync(noManifest, { recursive: true });
  assert.equal(checkPlugin(noManifest).findings[0]?.code, 'MANIFEST_MISSING');
});

test('check：driver/hook 类型合法但本核心装不了 ⇒ 只警告', () => {
  const dir = writePlugin(join(TMP, 'driver-type'), baseManifest({ type: 'driver' }), 'export function init(){}\n');
  const res = checkPlugin(dir);
  assert.equal(res.ok, true, JSON.stringify(res.findings));
  assert.equal(res.findings.find((f) => f.code === 'TYPE_NOT_LOADABLE')?.params.type, 'driver');
});
