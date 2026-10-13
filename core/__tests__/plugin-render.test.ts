// 授权面：**"还差哪些"的计算**（`missingHostGrants`）+ **渲染**（`pluginPermissionLines`）。
// 两者分属不同层：
//   · 计算在**点表层**（`core/permissions/source.ts`）—— 只有守护进程那本表里才有 `exec.template.*`
//     与跨插件点（客户端进程里没有，所以这个计算**绝不能**放在渲染/客户端那侧，2026-10-13 踩过）；
//   · 渲染只看视图里算好的字段（`permissions` / `grants` / `missingGrants`）。
// ⚠️ 注册表**由调用方自己播**（与 `lifecycle.test.ts` 同一模式）：不去挑生产表里的点，免得表一变用例就骗人。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { missingHostGrants } = await import('../permissions/source.ts');
const { registry } = await import('../permissions/registry.ts');
const { pluginPermissionLines, pluginDetailLines } = await import('../plugin/render.ts');

const HOST_POINT = 'demo.host.read'; // scope=host、未授予 ⇒ 应当报成"未授予"
const SELF_POINT = 'demo.self.read'; // scope=self ⇒ 声明即可用，**绝不报**
for (const [name, scope] of [
  [HOST_POINT, 'host'],
  [SELF_POINT, 'self'],
] as const) {
  if (!registry.get(name)) {
    registry.register({
      name,
      group: 'demo',
      description: '渲染用例的合成点',
      scope,
      confidentiality: 'public',
      executionLevel: 'low',
    });
  }
}

/** 造一个合成视图（只填渲染用得到的字段） */
function view(over: Record<string, unknown> = {}) {
  return {
    ref: 'local:default/@a/b',
    id: '@a/b',
    origin: 'local:default',
    dir: 'D:/x',
    version: { code: 1, name: '0.0.1' },
    type: 'ability',
    enabled: true,
    state: 'running',
    grants: [],
    permissions: [],
    missingGrants: [],
    capabilities: [],
    lastError: null,
    restartAttempts: 0,
    dataDir: 'D:/data',
    configPath: 'D:/x/config.json',
    authorFingerprint: null,
    reloadRequired: false,
    ...over,
  } as never;
}

test('missingHostGrants：只算 host 且未授予的点（self 与查不到的点都不算）', () => {
  assert.deepEqual(missingHostGrants([HOST_POINT], []), [HOST_POINT], 'host 且未授 ⇒ 报');
  assert.deepEqual(missingHostGrants([HOST_POINT], [HOST_POINT]), [], '已授 ⇒ 不报');
  assert.deepEqual(missingHostGrants([SELF_POINT], []), [], 'self ⇒ **绝不报**（假警报）');
  assert.deepEqual(missingHostGrants(['this.point.does.not.exist'], []), [], '查不到的点不判');
  assert.deepEqual(missingHostGrants([SELF_POINT, HOST_POINT], [SELF_POINT]), [HOST_POINT]);
});

test('missingHostGrants：**跨插件点**（只有能力快照才知道）也算 host 未授予', async () => {
  // 这条是判别力所在：跨插件点**不在静态注册表里**，是由"谁发布了端点"派生的。
  // 只查 `registry.get` 的实现会在这里返回 []（第一版就是这么错的：真机上"未授予"那行根本不出现）。
  const { capabilities } = await import('../plugin/capabilities.ts');
  const { callPointOf } = await import('../permissions/points.ts');
  const ref = 'local:default/@a/caller';
  const path = '/api/demo/run';
  capabilities.register(ref, {
    schema: 2,
    id: '@a/caller',
    name: 'caller',
    version: { code: 1, name: '0.0.1' },
    runtime: { type: 'quickjs', esm: true },
    exports: { endpoints: [{ path }] },
  } as never);

  const point = callPointOf(ref, path);
  assert.equal(registry.get(point), undefined, '跨插件点不该出现在静态注册表里（前提）');
  assert.deepEqual(missingHostGrants([point], []), [point], '动态 host 点未授予 ⇒ 必须报出来');
  assert.deepEqual(missingHostGrants([point], [point]), [], '授了就闭嘴');
});

test('渲染：声明 / 已授予 / 未授予三行，空的不打；详情里带上目录', () => {
  const lines = pluginPermissionLines(
    view({ permissions: [SELF_POINT, HOST_POINT], grants: [SELF_POINT], missingGrants: [HOST_POINT] }),
  );
  assert.equal(lines.length, 3, `声明/已授予/未授予都该有：${lines.join(' | ')}`);
  assert.match(lines[0]!, /声明：/);
  assert.ok(lines[0]!.includes(SELF_POINT) && lines[0]!.includes(HOST_POINT), '声明要原样列出两个点');
  assert.match(lines[1]!, /已授予：/);
  assert.ok(lines[1]!.includes(SELF_POINT));
  assert.match(lines[2]!, /未授予：/);
  assert.ok(lines[2]!.includes(HOST_POINT), '"未授予"必须点名 host 那个点');

  // 什么都没有 ⇒ 一行都不打（列表/详情里不许出现空壳行）
  assert.deepEqual(pluginPermissionLines(view()), []);

  const detail = pluginDetailLines(view());
  assert.match(detail[0]!, /local:default\/@a\/b@0\.0\.1/, '第一行是摘要');
  assert.ok(
    detail.some((l) => /目录：/.test(l)),
    `详情要有目录行：${detail.join(' | ')}`,
  );
});
