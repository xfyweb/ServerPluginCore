// 动态权限点（docs/events-and-hooks-design.md §3.4 点名规则 / §3.7 三道门槛 / §1.10 订阅点档位）
//
// 为什么这些用例必须存在：点名是**授权记录里的主键**。拼错了不会报错，只会让"管理员批准的那条路"
// 与"插件实际走的那条路"悄悄错开 —— 比如不带来源，两个同名插件就共用同一条授权（§3.2）。
// 所以这里同时钉两件事：**名字怎么拼**（纯函数，含单射与拒绝面）、**点跟着能力生灭**（装载/卸载/重载）。
//
// 隔离：SPC_STATE_DIR / SPC_AUDIT_DIR 必须在**动态 import 之前**设好（见 core/audit.ts 的模块级常量）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-dynpoints-'));
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

const { manager } = await import('../plugin/manager.ts');
const { capabilities } = await import('../plugin/capabilities.ts');
const { registry, PermissionRegistry } = await import('../permissions/registry.ts');
const { checkPermission } = await import('../permissions/check.ts');
const { callPointOf, subscribePointOf } = await import('../permissions/points.ts');
const { SpcError } = await import('../errors.ts');

// ---------------- 夹具 ----------------

interface FixtureOpts {
  permissions?: string[];
  exports?: Record<string, unknown>;
}

/** 造一个能力插件目录。`name` 只决定**目录名**，插件 id 单独给（同 id 两来源要用两个目录） */
function makePluginAt(dirName: string, pluginId: string, code: string, opts: FixtureOpts = {}): string {
  const dir = join(TMP, 'plugins', dirName);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schema: 2,
    id: pluginId,
    name: `Fixture ${dirName}`,
    version: { code: 1, name: '0.0.1' },
    runtime: { type: 'quickjs', esm: true },
    permissions: (opts.permissions ?? ['fs.write.data']).map((n) => ({ name: n })),
    ...(opts.exports ? { exports: opts.exports } : {}),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(join(dir, 'main.ts'), code, 'utf8');
  return dir;
}

const makePlugin = (name: string, code: string, opts: FixtureOpts = {}): string =>
  makePluginAt(name, `@spc/${name}`, code, opts);

const LOCAL = 'local:default';
const ref = (name: string) => `${LOCAL}/@spc/${name}`;

/** 断言被拒，并核验英文码（同步抛与异步拒一视同仁） */
async function rejects(fn: () => unknown, code: string): Promise<void> {
  let caught: unknown;
  let thrown = false;
  try {
    await fn();
  } catch (err) {
    caught = err;
    thrown = true;
  }
  assert.ok(thrown, `期望被拒（${code}），但调用成功了`);
  assert.ok(caught instanceof SpcError, `期望 SpcError，实际 ${String(caught)}`);
  assert.equal((caught as InstanceType<typeof SpcError>).code, code);
}

/** 注册表里属于某个插件的动态点（点名 → 点），按名字排序，便于整表比对 */
function pointsOf(owner: string): string[] {
  return registry
    .all()
    .filter((p) => p.owner === owner)
    .map((p) => p.name)
    .sort();
}

before(() => {
  mkdirSync(join(TMP, 'plugins'), { recursive: true });
  mkdirSync(join(TMP, 'audit'), { recursive: true });
});

after(async () => {
  await manager.stopAll('shutdown');
  manager.resetMemory();
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* Windows 上沙箱句柄未释放会 EPERM：只做尽力清理 */
  }
});

// ---------------- ① 点名怎么拼（纯函数） ----------------

test('点名 = 前缀 + 完整引用 + 尾段（字面拼接，可 grep、可与授权记录对照）', () => {
  assert.equal(
    callPointOf('market.spc.xfyweb.cn/@b/backup', '/api/backup/run'),
    'plugins.call.market.spc.xfyweb.cn/@b/backup./api/backup/run',
  );
  assert.equal(
    subscribePointOf('local:dev-a/@a/sqlite', 'sqlite.refresh.finished'),
    'events.subscribe.local:dev-a/@a/sqlite.sqlite.refresh.finished',
  );
});

test('单射：同 id 不同来源 = 两个点（点名不带源就会共用一条授权）', () => {
  const a = callPointOf('local:default/@spc/same', '/api/x');
  const b = callPointOf('local:dev-a/@spc/same', '/api/x');
  assert.notEqual(a, b);
  // 名字里能直接读出是哪个来源 —— 这正是"不带源就分不开"的反面
  assert.ok(a.includes('local:default/@spc/same'));
  assert.ok(b.includes('local:dev-a/@spc/same'));
});

test('调用点与订阅点不撞名（同一对 (引用, 尾段) 也分得开）', () => {
  assert.notEqual(callPointOf(ref('x'), 'a.b'), subscribePointOf(ref('x'), 'a.b'));
});

test('非法输入一律拒（fail-closed）：来源/ id 形状、空尾段、空白、`*`', () => {
  const badRefs = [
    '@spc/x', // 缺来源
    'local:default', // 缺 id
    'local:default/@Spc/x', // id 含大写
    'local:default/spc/x', // id 缺 `@`
    'local:default/@spc/x/y', // id 多一段
    'Local:default/@spc/x', // 来源含大写
    '', // 空
  ];
  for (const bad of badRefs) {
    assert.throws(
      () => callPointOf(bad, '/api/x'),
      (err: unknown) =>
        err instanceof SpcError &&
        err.code === 'PERMISSION_POINT_INVALID' &&
        err.params.reason === 'ref-shape',
      `引用 ${JSON.stringify(bad)} 应当被拒`,
    );
  }
  // 尾段：空白进不了 permissions[].name 的 schema（会生成一个**谁都声明不了**的点）；
  //       `*` 会被 matchDeclaration 当通配（一次声明预授权对方将来新增的端点）
  for (const badTail of ['', 'a b', 'a\tb', '/api/x*y', '*']) {
    assert.throws(
      () => subscribePointOf('local:default/@spc/x', badTail),
      (err: unknown) =>
        err instanceof SpcError &&
        err.code === 'PERMISSION_POINT_INVALID' &&
        err.params.reason === 'tail-shape',
      `尾段 ${JSON.stringify(badTail)} 应当被拒`,
    );
  }
});

// ---------------- ② 注册表的 owner 语义 ----------------

test('unregisterOwnedBy：只撤 owner 精确匹配的点，幂等，静态点不受影响', () => {
  const r = new PermissionRegistry();
  r.register({
    name: 'fs.read.data',
    group: 'fs',
    description: '静态点（无 owner）',
    scope: 'self',
    confidentiality: 'public',
    executionLevel: 'low',
  });
  r.register({
    name: callPointOf('local:default/@a/b', '/api/x'),
    group: 'plugins',
    description: '动态点（A 的端点）',
    scope: 'host',
    grant: 'install',
    owner: 'local:default/@a/b',
    confidentiality: 'public',
    executionLevel: 'low',
  });
  r.register({
    name: subscribePointOf('local:default/@c/d', 'e.f'),
    group: 'events',
    description: '动态点（C 的事件）',
    scope: 'host',
    grant: 'install',
    owner: 'local:default/@c/d',
    confidentiality: 'sensitive',
    executionLevel: 'medium',
  });

  assert.equal(r.unregisterOwnedBy('local:default/@a/b'), 1);
  assert.equal(r.unregisterOwnedBy('local:default/@a/b'), 0, '幂等：第二次无可撤');
  assert.equal(r.get(callPointOf('local:default/@a/b', '/api/x')), undefined);
  // ⛔ 静态点是核心契约的一部分，不能被任何插件的生命周期拖走
  assert.ok(r.get('fs.read.data'), '静态点必须还在');
  assert.ok(r.get(subscribePointOf('local:default/@c/d', 'e.f')), '别的插件的点必须还在');
});

test('注册表仍拒绝重复登记（所以"先撤后登"是重载幂等的唯一路径）', () => {
  const r = new PermissionRegistry();
  const point = {
    name: 'events.publish',
    group: 'events',
    description: 'x',
    scope: 'self' as const,
    confidentiality: 'public' as const,
    executionLevel: 'low' as const,
  };
  r.register(point);
  assert.throws(
    () => r.register(point),
    (err: unknown) => err instanceof SpcError && err.code === 'DUPLICATE_POINT',
  );
});

// ---------------- ③ 点跟着能力生灭（装载 → 卸载 → 重载） ----------------

const PUB_ENDPOINT = '/api/points-pub/one';
// ⚠️ topic 的 schema 是 `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`：分段只许小写字母与数字（连字符、下划线都不行）
const PUB_TOPICS = ['points.public', 'points.sensitive', 'points.secret'] as const;

function pubFixture(name = 'points-pub'): string {
  return makePlugin(name, `export function init(){}`, {
    exports: {
      endpoints: [{ path: PUB_ENDPOINT }],
      events: {
        publish: [
          { topic: PUB_TOPICS[0], classification: 'public' },
          { topic: PUB_TOPICS[1], classification: 'sensitive' },
          { topic: PUB_TOPICS[2], classification: 'secret' },
        ],
      },
    },
  });
}

test('装载带出动态点：调用点 host/install，订阅点等级取发布方分类，secret 不设点', async () => {
  await manager.install(pubFixture());
  const R = ref('points-pub');

  const call = registry.get(callPointOf(R, PUB_ENDPOINT));
  assert.ok(call, '端点应当带出一个调用点');
  assert.equal(call.owner, R, '点必须记着是谁带出来的（撤销靠它，不靠解析点名）');
  assert.equal(call.scope, 'host');
  assert.equal(call.grant, 'install', '安装清单即生效、可收回（§3.7 第 3 条门槛的档位）');

  const pub = registry.get(subscribePointOf(R, PUB_TOPICS[0]));
  assert.equal(pub?.confidentiality, 'public');
  assert.equal(pub?.executionLevel, 'low');
  const sen = registry.get(subscribePointOf(R, PUB_TOPICS[1]));
  assert.equal(sen?.confidentiality, 'sensitive', '等级必须与发布方声明的分类同源');
  assert.equal(sen?.executionLevel, 'medium');
  // §1.12-2：secret 的 topic 禁止跨插件 ⇒ 不设点（设了就是承诺一条永远走不通的路）
  assert.equal(registry.get(subscribePointOf(R, PUB_TOPICS[2])), undefined);

  assert.deepEqual(pointsOf(R), [
    subscribePointOf(R, PUB_TOPICS[0]),
    subscribePointOf(R, PUB_TOPICS[1]),
    callPointOf(R, PUB_ENDPOINT),
  ].sort());
});

test('判定链接得上：调用方声明即放行（install 档免逐点授予），不声明即拒', async () => {
  const point = callPointOf(ref('points-pub'), PUB_ENDPOINT);
  assert.equal(checkPermission(registry, point, [point]).code, 'ALLOWED');
  assert.equal(checkPermission(registry, point, []).code, 'NOT_DECLARED');
  // 别的插件（哪怕同 id 不同源）声明同样的尾段也不算 —— 点名里带的是完整引用
  assert.equal(
    checkPermission(registry, point, [callPointOf('local:dev-a/@spc/points-pub', PUB_ENDPOINT)]).code,
    'NOT_DECLARED',
  );
});

test('卸载 → 点随之消失，同一个点名从 ALLOWED 变 UNKNOWN_POINT（fail-closed）', async () => {
  const point = callPointOf(ref('points-pub'), PUB_ENDPOINT);
  assert.equal(checkPermission(registry, point, [point]).code, 'ALLOWED');
  await manager.disable(ref('points-pub'));
  assert.deepEqual(pointsOf(ref('points-pub')), [], '能力没了，派生点必须一起没');
  assert.equal(checkPermission(registry, point, [point]).code, 'UNKNOWN_POINT');
});

test('重载幂等：连续两次 reload 后动态点不叠加、也不报重复登记', async () => {
  await manager.enable(ref('points-pub'));
  const before = pointsOf(ref('points-pub'));
  await manager.reload(ref('points-pub'));
  await manager.reload(ref('points-pub'));
  assert.deepEqual(pointsOf(ref('points-pub')), before);
  await manager.disable(ref('points-pub'));
});

test('同 id 两来源：两套点各自独立，停掉其中一个不牵连另一个', async () => {
  const a = 'local:src-a';
  const b = 'local:src-b';
  await manager.install(
    makePluginAt('two-source-a', '@spc/same', `export function init(){}`, {
      exports: { endpoints: [{ path: '/api/same-a' }] },
    }),
    { source: a },
  );
  await manager.install(
    makePluginAt('two-source-b', '@spc/same', `export function init(){}`, {
      exports: { endpoints: [{ path: '/api/same-b' }] },
    }),
    { source: b },
  );
  const refA = `${a}/@spc/same`;
  const refB = `${b}/@spc/same`;
  const pointA = callPointOf(refA, '/api/same-a');
  const pointB = callPointOf(refB, '/api/same-b');
  assert.ok(registry.get(pointA) && registry.get(pointB));

  await manager.disable(refA);
  assert.equal(registry.get(pointA), undefined);
  assert.ok(registry.get(pointB), '撤销按 owner 精确回收 —— 同 id 的另一个来源不受牵连');
  await manager.disable(refB);
});

// ---------------- ④ 失败面：不留半登记 ----------------

test('init 失败：已经登记过的派生点必须回滚（否则留下"点还在、插件没了"的悬挂授权）', async () => {
  const dir = makePlugin('points-boom', `export function init(){ throw new Error('boom'); }`, {
    exports: { endpoints: [{ path: '/api/points-boom' }] },
  });
  await rejects(() => manager.install(dir), 'PLUGIN_INIT_FAILED');
  assert.deepEqual(pointsOf(ref('points-boom')), []);
  assert.equal(capabilities.snapshot().endpoints.filter((e) => e.ref === ref('points-boom')).length, 0);
});

test('端点 path 进不了点名 ⇒ 装载失败，且不留半登记（路由也不能留下）', async () => {
  const dir = makePlugin('points-badpath', `export function init(){}`, {
    exports: {
      routes: [{ path: '/points-badpath', title: 'x' }],
      endpoints: [{ path: '/api/bad path' }], // 空白进不了 permissions[].name 的 schema
    },
  });
  await rejects(() => manager.install(dir), 'PERMISSION_POINT_INVALID');
  assert.deepEqual(pointsOf(ref('points-badpath')), []);
  // 全有或全无：同一个清单里的路由不许单独留下
  assert.equal(capabilities.snapshot().routes.filter((r) => r.ref === ref('points-badpath')).length, 0);
});
