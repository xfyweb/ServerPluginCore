// 权限点两张表：**冻结表**（注册表）与**临时表**（动态点）
// 设计：docs/events-and-hooks-design.md §3.4/§3.7、docs/api-contract.md §6/§6.1
//
// 为什么这些用例必须存在：点名是**授权记录里的主键**，拼错了不会报错，只会让"管理员批准的那条路"
// 与"插件实际走的那条路"悄悄错开 —— 比如不带来源，两个同名插件就共用同一条授权（§3.2）。
// 另一半是**表的分工**：注册表是冻结的（核心启动阶段写完就固化），跨插件调用/订阅的点是**派生的临时表**。
// 混在一起过一次：那时 `permissions-meta.test.ts` 那份显式清单必须"跳过动态点"才能对齐 —— 那是污染的症状。
//
// 隔离：SPC_STATE_DIR / SPC_AUDIT_DIR 必须在**动态 import 之前**设好（见 core/audit.ts 的模块级常量）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-dynpoints-'));
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

const { manager } = await import('../plugin/manager.ts');
const { capabilities } = await import('../plugin/capabilities.ts');
// ⑥c 起"显式 --source 必须指向 keyring 里真有的桶" ⇒ 用例要先建桶
const { ensureBucket } = await import('./helpers/buckets.ts');
const { registry } = await import('../permissions/registry.ts');
const { pointSource, dynamicPointNames, resolveDynamicPoint } = await import('../permissions/source.ts');
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
  writeFileSync(join(dir, 'main.ts'), code + endpointImpls(opts.exports), 'utf8');
  return dir;
}

/**
 * ⑤ 起装载期会核对「清单声明的端点 ⟺ 模块里的 `endpoints` 映射」，所以夹具按声明**自动补出实现**
 * （这些用例关心的是点表/登记，不是端点行为；真正要验端点行为的用例自己写映射）。
 * 键用原样的 path（含空格也照写）—— 这样"path 进不了点名"那条用例仍然走到 `PERMISSION_POINT_INVALID`。
 */
function endpointImpls(exports: Record<string, unknown> | undefined): string {
  const declared = (exports?.endpoints as { path: string }[] | undefined) ?? [];
  if (declared.length === 0) return '';
  const entries = declared
    .map((e) => `  ${JSON.stringify(e.path)}: () => JSON.stringify({ path: ${JSON.stringify(e.path)} }),`)
    .join('\n');
  return `\nexport const endpoints = {\n${entries}\n};\n`;
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

/** 读审计条目（JSONL；只读业务语义需要的字段） */
function auditEntries(): Record<string, unknown>[] {
  const file = join(TMP, 'audit', 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
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

// ---------------- ② 冻结表：注册表在运行期不被插件改动 ----------------

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

test('**注册表是冻结的**：装载/卸载带端点与事件的插件，都不改 `registry.all()`', async () => {
  const before = registry.all().map((p) => p.name).sort();
  await manager.install(pubFixture());
  const R = ref('points-pub');
  assert.deepEqual(registry.all().map((p) => p.name).sort(), before, '装载不许往冻结表里加东西');
  // 动态点**不在**冻结表里 —— 它在临时表（这就是"两张表"的意义）
  assert.equal(registry.get(callPointOf(R, PUB_ENDPOINT)), undefined);
  assert.ok(pointSource.get(callPointOf(R, PUB_ENDPOINT)), '但点表里查得到（冻结 ∪ 临时）');

  await manager.disable(R);
  assert.deepEqual(registry.all().map((p) => p.name).sort(), before, '卸载同样不许动冻结表');
});

// ---------------- ③ 临时表：跟着"谁在跑"生灭 ----------------

test('临时表：点存在（host/explicit），订阅点等级取发布方分类，secret 不设点', async () => {
  await manager.install(pubFixture());
  const R = ref('points-pub');

  const call = pointSource.get(callPointOf(R, PUB_ENDPOINT));
  assert.ok(call, '端点应当派生出调用点');
  assert.equal(call.scope, 'host');
  // 跨插件一律 explicit：插件之间默认隔离 ⇒ 跨过去要管理员逐条点头
  assert.equal(call.grant, 'explicit');

  const pub = pointSource.get(subscribePointOf(R, PUB_TOPICS[0]));
  assert.equal(pub?.confidentiality, 'public');
  assert.equal(pub?.executionLevel, 'low');
  assert.equal(pub?.grant, 'explicit', '订阅也是跨插件 —— 同一档');
  const sen = pointSource.get(subscribePointOf(R, PUB_TOPICS[1]));
  assert.equal(sen?.confidentiality, 'sensitive', '等级必须与发布方声明的分类同源');
  assert.equal(sen?.executionLevel, 'medium');
  // §1.12-2：secret 的 topic 禁止跨插件 ⇒ 不设点（设了就是承诺一条永远走不通的路）
  assert.equal(pointSource.get(subscribePointOf(R, PUB_TOPICS[2])), undefined);

  assert.deepEqual([...dynamicPointNames()].sort(), [
    subscribePointOf(R, PUB_TOPICS[0]),
    subscribePointOf(R, PUB_TOPICS[1]),
    callPointOf(R, PUB_ENDPOINT),
  ].sort());

  await manager.disable(R);
});

test('临时表随卸载消失：同一个点名从 ALLOWED 变 UNKNOWN_POINT（fail-closed）', async () => {
  await manager.install(pubFixture());
  const R = ref('points-pub');
  const point = callPointOf(R, PUB_ENDPOINT);
  assert.equal(checkPermission(pointSource, point, [point], [point]).code, 'ALLOWED');
  await manager.disable(R);
  assert.equal(pointSource.get(point), undefined);
  assert.equal(resolveDynamicPoint(point), undefined);
  assert.deepEqual(dynamicPointNames(), []);
  assert.equal(checkPermission(pointSource, point, [point], [point]).code, 'UNKNOWN_POINT');
});

// ---------------- ④ 判定链接得上（声明 + 授予） ----------------

test('判定链接得上：声明 + **逐条授予**才放行；少一样都拒', async () => {
  await manager.install(pubFixture());
  const point = callPointOf(ref('points-pub'), PUB_ENDPOINT);
  assert.equal(checkPermission(pointSource, point, [point], [point]).code, 'ALLOWED');
  assert.equal(checkPermission(pointSource, point, [point], []).code, 'NOT_GRANTED', '没批准 ⇒ 拒');
  assert.equal(checkPermission(pointSource, point, [], [point]).code, 'NOT_DECLARED', '没声明 ⇒ 拒');
  // 别的插件（哪怕同 id 不同源）声明同样的尾段也不算 —— 点名里带的是完整引用
  assert.equal(
    checkPermission(pointSource, point, [callPointOf('local:dev-a/@spc/points-pub', PUB_ENDPOINT)], []).code,
    'NOT_DECLARED',
  );
  await manager.disable(ref('points-pub'));
});

test('同 id 两来源：两套临时点各自独立，停掉一个不牵连另一个', async () => {
  const a = 'local:src-a';
  const b = 'local:src-b';
  ensureBucket(a); // ⑥c 起显式 --source 必须指向真桶
  ensureBucket(b);
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
  const pointA = callPointOf(`${a}/@spc/same`, '/api/same-a');
  const pointB = callPointOf(`${b}/@spc/same`, '/api/same-b');
  assert.ok(pointSource.get(pointA) && pointSource.get(pointB));

  await manager.disable(`${a}/@spc/same`);
  assert.equal(pointSource.get(pointA), undefined);
  assert.ok(pointSource.get(pointB), '派生的表按 ref 分开 —— 同 id 的另一个来源不受牵连');
  await manager.disable(`${b}/@spc/same`);
});

// ---------------- ⑤ 授权：撤回就是把点移出白名单（+ 落审计） ----------------

test('管理员授予/撤回跨插件授权：白名单一条道，撤回后判定即拒，且审计留痕', async () => {
  await manager.install(pubFixture());
  const callee = ref('points-pub');
  const point = callPointOf(callee, PUB_ENDPOINT);
  // 批准是**调用方**的事（被调方只负责把点派生出来）：造一个声明了"我要调 B 的这个端点"的插件 A
  const caller = ref('points-caller');
  await manager.install(
    makePlugin('points-caller', `export function init(){}`, { permissions: [point] }),
    { start: false },
  );
  assert.equal(checkPermission(pointSource, point, [point], manager.status(caller).grants).code, 'NOT_GRANTED');

  const granted = manager.grant(caller, [point]);
  assert.deepEqual(granted.grants, [point]);
  assert.equal(checkPermission(pointSource, point, [point], granted.grants).code, 'ALLOWED');

  const revoked = manager.revoke(caller, [point]);
  assert.deepEqual(revoked.grants, [], '撤回 = 移出白名单（install 与 explicit 同一条道）');
  assert.equal(
    checkPermission(pointSource, point, [point], revoked.grants).code,
    'NOT_GRANTED',
    '撤回之后判定必须真的拒（修之前 install 档这里是"照旧放行"）',
  );

  // 授权变更**留痕**：谁在什么时候撤的，从审计里回答（不靠记录里的状态字段）
  const authz = auditEntries().filter(
    (e) => e.method === 'plugin.grant' || e.method === 'plugin.revoke',
  );
  assert.deepEqual(
    authz.map((e) => [e.method, e.target, e.pluginId]),
    [
      ['plugin.grant', point, caller],
      ['plugin.revoke', point, caller],
    ],
  );

  await manager.uninstall(caller);
  await manager.disable(callee);
});

// ---------------- ⑥ 失败面：不留半登记 ----------------

test('init 失败：临时点不能留下（否则就是一条指向不存在端点的授权）', async () => {
  const dir = makePlugin('points-boom', `export function init(){ throw new Error('boom'); }`, {
    exports: { endpoints: [{ path: '/api/points-boom' }] },
  });
  await rejects(() => manager.install(dir), 'PLUGIN_INIT_FAILED');
  assert.deepEqual(dynamicPointNames(), []);
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
  assert.deepEqual(dynamicPointNames(), []);
  // 全有或全无：同一个清单里的路由不许单独留下
  assert.equal(capabilities.snapshot().routes.filter((r) => r.ref === ref('points-badpath')).length, 0);
});
