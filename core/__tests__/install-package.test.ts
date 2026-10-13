// `.spc` 的**安装**入口（`docs/build-layer-design.md` §10.6 第二条）：装进**托管副本** `<STATE_DIR>/packages/<来源>/<id>/`。
//
// 与"目录就地安装"的分工（这份用例要钉住的正是这个差别）：
//   · 目录就地 ⇒ `record.dir` 指向**作者的目录**（我们一个字节都不动）；
//   · `.spc` ⇒ 解到**我们自己的副本**（作者把源码删了也不影响），管线其余部分完全一样。
//
// 另一半是**不可信输入**：解包器那些判定（路径 / 体积 / 重名…）在 install 路上的表现 ——
// 尤其要钉住"**被拒的包不能在名册里留下任何东西**"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-installpkg-'));
process.env.SPC_STATE_DIR = join(TMP, 'state');
process.env.SPC_AUDIT_DIR = join(TMP, 'state', 'audit');

const { manager } = await import('../../core/plugin/manager.ts');
const { SpcError } = await import('../../core/errors.ts');
const { packagesDir } = await import('../../core/config.ts');
const { runDevCli } = await import('../../build/cli.ts');
const { packPlugin } = await import('../../build/pack.ts');
const { generateAuthorKey, saveAuthorKey } = await import('../../build/keys.ts');
const { ensureWorkspaceConfig, loadWorkspace, patchWorkspaceConfig } = await import('../../build/workspace.ts');

/** 造插件 → build → pack，返回 `.spc` 路径（真链路，不用手搓的假包） */
async function makePackage(name: string): Promise<string> {
  const root = join(TMP, name);
  mkdirSync(root, { recursive: true });
  const ws = loadWorkspace(root, { create: true });
  ensureWorkspaceConfig(ws);
  patchWorkspaceConfig(ws, { author: 'std' });
  saveAuthorKey(ws, generateAuthorKey());
  const dir = join(root, 'plugin', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema: 2,
      id: `@std/${name}`,
      name: `Fixture ${name}`,
      version: { code: 1, name: '0.0.1' },
      runtime: { type: 'quickjs', esm: true },
      permissions: [{ name: 'fs.write.data' }],
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'main.ts'), 'export function init() {}\n', 'utf8');
  assert.equal(await runDevCli('build', [dir]), 0, '夹具构建应当成功');
  const packed = await packPlugin({ distDir: join(dir, 'dist'), file: join(dir, `${name}.spc`) });
  return packed.file;
}

async function rejects(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof SpcError, `期望 SpcError(${code})，实际 ${String(e)}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`没有抛 ${code}`);
}

/** 数一棵目录树里的文件总数（用来判断"有没有多出/少掉东西"） */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur)) {
      const abs = join(cur, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else n += 1;
    }
  };
  walk(dir);
  return n;
}

test('装 .spc：载荷落到托管副本（不是作者的目录），记录指向副本，插件真起来', async () => {
  const spc = await makePackage('hosted');
  const view = await manager.installPackage(spc);

  assert.equal(view.state, 'running', '与目录安装同一条管线：装完就该起来');
  assert.ok(
    view.dir.startsWith(join(packagesDir(), '')),
    `record.dir 要在托管副本根下：${view.dir}`,
  );
  assert.ok(view.dir.includes('hosted'), '副本目录名里带插件名（sanitize 过的 id 段）');
  assert.ok(existsSync(join(view.dir, 'manifest.json')), '副本里要有清单');
  assert.ok(existsSync(join(view.dir, 'bundle.js')), '副本里要有 bundle');
  assert.ok(existsSync(join(view.dir, 'plugin.author.sig')), '信封也随副本');

  // 暂存目录要被搬空（不留垃圾）
  const staging = join(packagesDir(), '.staging');
  assert.deepEqual(existsSync(staging) ? readdirSync(staging) : [], [], '暂存目录应当被搬空');
});

test('重装同一份 .spc：托管副本**整体替换**（升级路径），不叠加、不报错', async () => {
  const spc = await makePackage('reinstall');
  const first = await manager.installPackage(spc);
  writeFileSync(join(first.dir, '手工留下的.txt'), '下一次安装应当把它清掉（副本是我们的）', 'utf8');
  const second = await manager.installPackage(spc);
  assert.equal(second.dir, first.dir, '同一个 (来源,id) ⇒ 同一个副本目录');
  assert.ok(!existsSync(join(second.dir, '手工留下的.txt')), '副本整体替换，旧内容不残留');
  assert.equal(second.state, 'running');
});

test('卸载：**托管副本一起删**（记录都没了，副本就是孤儿）', async () => {
  const spc = await makePackage('uninstall-hosted');
  const view = await manager.installPackage(spc);
  const hosted = view.dir;
  assert.ok(existsSync(hosted));

  await manager.uninstall(view.ref);

  assert.equal(manager.list().filter((v) => v.ref === view.ref).length, 0, '记录要没了');
  assert.ok(!existsSync(hosted), `托管副本要删掉：${hosted}`);
  // 空的来源目录会被顺手收掉；这里不断言它消失（同来源下可能还有别的插件，那就是**不该**收）
  const originDir = dirname(hosted);
  const left = existsSync(originDir) ? readdirSync(originDir) : [];
  assert.ok(!left.includes(basename(hosted)), `来源目录里不该还留着它：${left.join(', ')}`);
});

test('卸载：**就地安装的目录永不动**（那是作者的目录，我们无权删）', async () => {
  const spc = await makePackage('uninstall-inplace');
  const authorDir = dirname(spc); // <box>/plugin/<name> —— 作者的插件目录
  assert.ok(existsSync(join(authorDir, 'manifest.json')), '夹具先确实是个插件目录');
  const view = await manager.install(authorDir);
  assert.equal(view.dir, authorDir, '就地安装 ⇒ 记录指着作者的目录');
  assert.ok(!view.dir.startsWith(packagesDir()), '不在托管副本根下');

  await manager.uninstall(view.ref);

  assert.ok(existsSync(join(authorDir, 'manifest.json')), '卸载**不许**碰作者的目录');
  assert.ok(existsSync(join(authorDir, 'dist', 'bundle.js')), '产物也原样留着');
});

test('reanchor：**托管副本跟着来源搬家**（`record.dir` 一起改，旧位置不留残迹）', async () => {
  const spc = await makePackage('reanchor-move');
  const before = await manager.installPackage(spc);
  assert.ok(before.dir.startsWith(packagesDir()));

  // 造第二个本地桶（reanchor 的目标）
  const { keyring } = await import('../../core/sources/keyring.ts');
  keyring().add({
    origin: 'local:second',
    kind: 'local',
    alias: '第二桶',
    enabled: true,
    addedAt: new Date().toISOString(),
    firstTrust: 'manual',
    suspended: null,
  });

  const res = await manager.reanchor(['local:default/@std/reanchor-move'], 'local:second');
  assert.equal(res.plan.moves[0].pkg.exists, true, '计划里要标出"副本要搬"');
  assert.equal(res.plan.moves[0].pkg.to, join(packagesDir(), 'local_second', 'std__reanchor-move'));

  const after = manager.status('local:second/@std/reanchor-move');
  assert.equal(after.dir, res.plan.moves[0].pkg.to, 'record.dir 要指到新位置');
  assert.ok(existsSync(join(after.dir, 'bundle.js')), '副本确实搬过去了');
  assert.ok(!existsSync(before.dir), '旧位置不留残迹（否则就是孤儿副本）');
  assert.equal(after.state, 'running', '原本在跑 ⇒ 换源后要重启起来');
});

test('reanchor：**就地安装的目录不搬**（计划里 `pkg.exists = false`，作者的目录原地不动）', async () => {
  const spc = await makePackage('reanchor-inplace');
  const authorDir = dirname(spc);
  await manager.install(authorDir);
  const { keyring } = await import('../../core/sources/keyring.ts');
  keyring().add({
    origin: 'local:third',
    kind: 'local',
    alias: '第三桶',
    enabled: true,
    addedAt: new Date().toISOString(),
    firstTrust: 'manual',
    suspended: null,
  });
  const plan = manager.planReanchor(['local:default/@std/reanchor-inplace'], 'local:third');
  assert.equal(plan.moves[0].pkg.exists, false, '就地安装 ⇒ 没有副本可搬');
  await manager.reanchor(['local:default/@std/reanchor-inplace'], 'local:third');
  assert.ok(existsSync(join(authorDir, 'manifest.json')), '作者的目录原地不动');
  assert.equal(manager.status('local:third/@std/reanchor-inplace').dir, authorDir, '记录仍指着作者的目录');
});

test('被拒的包：名册里**一个字都不留**，托管副本也不留', async () => {
  await makePackage('rejected'); // 先造一份**好的**同名包（证明"拒的是这份坏的"，不是"这名字装不了"）
  const goodSpc = join(TMP, 'rejected', 'plugin', 'rejected', 'rejected.spc');
  assert.equal((await manager.installPackage(goodSpc)).state, 'running', '好的那份能装');

  const spcDirCount = () => countFiles(packagesDir());
  const before = spcDirCount();
  const refsBefore = new Set(manager.list().map((v) => v.ref));

  // 把好包换成带 `../escape.txt` 的坏包（手搓最小 zip：正规库打不出这种条目名）
  const evil = join(TMP, 'evil.spc');
  writeFileSync(evil, craftZipWithEscape());
  await rejects(() => manager.installPackage(evil), 'PACKAGE_ARCHIVE_INVALID');

  assert.deepEqual(new Set(manager.list().map((v) => v.ref)), refsBefore, '名册不许被改动');
  assert.equal(spcDirCount(), before, '被拒 ⇒ 托管副本文件数不变（没留孤儿副本）');
  assert.ok(!existsSync(join(TMP, 'escape.txt')), '当然也没写出托管根外面去');
});

/** 手搓一个含 `../escape.txt` 的最小 zip（夹具专用：正规库不会让你打出这种名字） */
function craftZipWithEscape(): Buffer {
  const name = Buffer.from('../escape.txt', 'utf8');
  const data = Buffer.from('escape!', 'utf8');
  const crc = crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0o644 << 16, 38);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}
