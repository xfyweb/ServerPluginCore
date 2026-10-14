// 维护模式 + 启动锁 + 控制台新动词的用例（2026-10-14）。
//
// 环境必须在 import 之前设好（`VERSION`/`stateDir` 都是模块级读一次）：沿用仓库既有写法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-maint-'));
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

const { initAudit } = await import('../audit.ts');
initAudit();
const { acquireLifecycleLock, readLock, releaseLifecycleLock, lockPath } = await import('../lifecycle-lock.ts');
const { buildConsoleHandlers } = await import('../console-handlers.ts');
const { parseConsoleLine } = await import('../console.ts');
const { manager } = await import('../plugin/manager.ts');

// ---------------- ① 启动锁 ----------------

test('锁：取到之后文件里写着我们的 pid 与形态', () => {
  const path = join(TMP, 'lock-a');
  const r = acquireLifecycleLock('normal', path);
  assert.equal(r.ok, true);
  const holder = readLock(path);
  assert.equal(holder?.pid, process.pid);
  assert.equal(holder?.mode, 'normal');
  releaseLifecycleLock(path);
  assert.equal(existsSync(path), false, '放锁要删文件');
});

test('锁：已有活着的持锁方 ⇒ 拒绝（维护模式与正常形态共用这一把）', () => {
  const path = join(TMP, 'lock-b');
  writeFileSync(path, JSON.stringify({ pid: process.pid, mode: 'maintenance', startedAt: Date.now() }));
  const r = acquireLifecycleLock('normal', path);
  assert.equal(r.ok, false, '自己持着锁时第二次取必须拒');
  assert.equal((r as { holder?: { mode?: string } }).holder?.mode, 'maintenance');
  assert.equal(readLock(path)?.mode, 'maintenance', '拒绝时不许动别人的锁');
});

test('锁：持锁进程已不在 ⇒ 接管（崩溃留下的锁不该把核心永久挡在门外）', () => {
  const path = join(TMP, 'lock-c');
  // 一个不可能存在的 pid：判活会拿到 ESRCH/EINVAL ⇒ 视为"进程没了"
  writeFileSync(path, JSON.stringify({ pid: 2_147_483_646, mode: 'normal', startedAt: 1 }));
  const r = acquireLifecycleLock('maintenance', path);
  assert.equal(r.ok, true);
  assert.equal((r as { tookOver?: boolean }).tookOver, true);
  assert.equal(readLock(path)?.pid, process.pid);
  releaseLifecycleLock(path);
});

test('锁：放锁只删自己那一把（别人的锁不动）', () => {
  const path = join(TMP, 'lock-d');
  writeFileSync(path, JSON.stringify({ pid: 2_147_483_646, mode: 'normal', startedAt: 1 }));
  releaseLifecycleLock(path);
  assert.equal(existsSync(path), true, '不是自己的锁，不许删');
});

// ---------------- ② 解析层：新动词 ----------------

test('解析：grant 要「引用 + 至少一个权限点」', () => {
  const ok = parseConsoleLine('grant @spc/x fs.read.data');
  assert.equal(ok.kind, 'plugin');
  assert.equal((ok as { verb?: string }).verb, 'grant');
  const short = parseConsoleLine('grant @spc/x');
  assert.equal(short.kind, 'usage');
  assert.equal((short as { need?: string }).need, 'ref-points');
});

test('解析：source 子命令与用法', () => {
  const add = parseConsoleLine('source add local:std-a');
  assert.equal(add.kind, 'source');
  assert.equal((add as { verb?: string }).verb, 'add');
  const bare = parseConsoleLine('source');
  assert.equal(bare.kind, 'usage');
  const bogus = parseConsoleLine('source frobnicate x');
  assert.equal(bogus.kind, 'usage', '不认识的子命令 ⇒ 报用法，不猜');
});

// ---------------- ③ 维护模式的语义（手柄工厂） ----------------

function makePlugin(name: string): string {
  const dir = join(TMP, 'src', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema: 2,
      id: `@spc/${name}`,
      name: `Fixture ${name}`,
      version: { code: 1, name: '0.0.1' },
      runtime: { type: 'quickjs', esm: true },
      permissions: [{ name: 'kv.read' }],
      entry: 'main.ts',
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'main.ts'), 'export function init(){}', 'utf8');
  return dir;
}

test('维护模式：install 只落记录（装载没发生）+ 明确提示', async () => {
  const handlers = buildConsoleHandlers({ mode: 'maintenance', stop: () => {} });
  const dir = makePlugin('maint-install');
  const lines = await handlers.plugin('install', [dir]);
  const ref = 'local:default/@spc/maint-install';
  assert.equal(manager.status(ref).enabled, true, '记录要落');
  assert.equal(manager.status(ref).state !== 'running', true, '维护模式里不许装载');
  assert.equal(
    lines.some((l) => l.includes('维护模式')),
    true,
    '必须提示"仅更新记录、未装载"：' + lines.join(' | '),
  );
  await manager.uninstall(ref);
});

test('维护模式：enable 只改记录；reload 明确拒绝', async () => {
  const handlers = buildConsoleHandlers({ mode: 'maintenance', stop: () => {} });
  const dir = makePlugin('maint-enable');
  await manager.install(dir, { start: false });
  const ref = 'local:default/@spc/maint-enable';
  const enableLines = await handlers.plugin('enable', [ref]);
  assert.equal(manager.status(ref).enabled, true);
  assert.equal(manager.status(ref).state !== 'running', true);
  assert.equal(enableLines.some((l) => l.includes('维护模式')), true);

  const reloadLines = await handlers.plugin('reload', [ref]);
  assert.equal(manager.status(ref).state !== 'running', true, 'reload 不许把插件装起来');
  assert.equal(reloadLines.length, 1);
  assert.equal(reloadLines[0]!.includes('reload'), true, '要说清 reload 不可用：' + reloadLines[0]);
  await manager.uninstall(ref);
});

test('维护模式：grant/revoke 走的就是 manager 的校验（不是第二份实现）', async () => {
  const handlers = buildConsoleHandlers({ mode: 'maintenance', stop: () => {} });
  const dir = makePlugin('maint-grant');
  await manager.install(dir, { start: false });
  const ref = 'local:default/@spc/maint-grant';
  await assert.rejects(
    () => handlers.plugin('grant', [ref, 'no.such.point']),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'UNKNOWN_POINT');
      return true;
    },
  );
  await manager.uninstall(ref);
});

test('维护模式：source 动词可用（list 走的是同一个源注册表）', async () => {
  const handlers = buildConsoleHandlers({ mode: 'maintenance', stop: () => {} });
  const lines = await handlers.source('list', []);
  assert.equal(Array.isArray(lines), true);
  assert.equal(lines.length >= 1, true, '空表也要有一行（"（无来源）"）');
});

test('正常形态：install 照常装载（对照组，证明模式判断真的生效）', async () => {
  const handlers = buildConsoleHandlers({ mode: 'normal', stop: () => {} });
  const dir = makePlugin('normal-install');
  await handlers.plugin('install', [dir]);
  const ref = 'local:default/@spc/normal-install';
  assert.equal(manager.status(ref).state, 'running', '正常形态必须装载');
  await manager.uninstall(ref);
});
