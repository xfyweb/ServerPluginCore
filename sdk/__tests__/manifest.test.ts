// Manifest schema 校验测试（node:test，零额外依赖）
// 运行：pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../validate.ts';

/** 合法完整清单（ability 类型） */
const validFull = {
  schema: 2,
  type: 'ability',
  id: '@xfy2412/docker',
  name: 'Docker Management',
  version: { code: 12, name: '1.2.0' },
  compat: { minCore: '0.1.0', targetCore: '0.3.0' },
  author: { id: 'xfy2412@market.spc.xfyweb.cn', name: 'SPC Team', homepage: 'https://spc.xfyweb.cn' },
  description: 'Docker 容器/镜像/网络/卷管理（薄适配器）',
  runtime: { type: 'quickjs', esm: true },
  permissions: [
    { name: 'docker.read', reason: '列出容器与镜像' },
    { name: 'docker.write' },
  ],
  exports: {
    endpoints: [{ path: '/api/docker/containers', permission: 'docker.read' }],
    routes: [{ path: '/docker', title: 'Docker', icon: 'container', order: 10 }],
    events: {
      publish: [{ topic: 'backup.done', classification: 'public' }],
      subscribe: [{ topic: 'docker.container.crash', mode: 'notify' }],
    },
  },
  dependencies: {
    npm: [{ name: 'zod', version: '3.x' }],
    plugins: [
      { id: '@xfy2412/base', version: '>=0.1.0', author: { pub: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } },
    ],
  },
};

/** 最小合法清单（仅必填字段，spike 插件形态） */
const validMinimal = {
  schema: 2,
  id: '@xfy2412/hello',
  name: 'Hello Plugin',
  version: { code: 1, name: '0.0.1' },
  runtime: { type: 'quickjs' },
  permissions: [{ name: 'fs.write.data' }],
};

test('合法：完整清单通过', () => {
  const r = validateManifest(validFull);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);
});

test('合法：最小清单通过（type 缺省视为 ability，esm 缺省视为 true）', () => {
  const r = validateManifest(validMinimal);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('非法：runtime.type 只有 quickjs（子进程档已砍）⇒ node-child 被 schema 拒', () => {
  const r = validateManifest({ ...validMinimal, runtime: { type: 'node-child' } });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.includes('/runtime/type')),
    `期望报 /runtime/type，实际：${r.errors.join('; ')}`,
  );
});

test('合法：type=driver / hook 在 **schema 层是合法的**（拒绝发生在核心装载期，不在语法闸）', () => {
  // 为什么这条也要钉住：driver/hook 是**将来合法**的类型，市场与构建层共用的清单校验器不该永久拒绝它们；
  // "核心支持不了"是宿主能力问题 ⇒ 由 `core/plugin/loader.ts` 的 `readManifestFromDir` 报
  // `PLUGIN_MANIFEST_INVALID` + `reason=unsupported-type`（见 core/__tests__/lifecycle.test.ts）。
  // 谁把这条 gate 挪进 schema，这条用例就会红。
  for (const type of ['driver', 'hook'] as const) {
    const r = validateManifest({ ...validMinimal, type });
    assert.equal(r.ok, true, `schema 不该拒 ${type}：${r.errors.join('; ')}`);
  }
});

test('合法：esm 显式 true 通过', () => {
  const r = validateManifest({ ...validMinimal, runtime: { type: 'quickjs', esm: true } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ---- 非法族 ----

test('非法：schema 版本不符（非 2）', () => {
  const r = validateManifest({ ...validMinimal, schema: 1 });
  assert.equal(r.ok, false);
});

test('非法：permissions 缺失（无默认放行）', () => {
  const { permissions, ...rest } = validMinimal;
  const r = validateManifest(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('permissions')));
});

test('非法：permissions 空数组', () => {
  const r = validateManifest({ ...validMinimal, permissions: [] });
  assert.equal(r.ok, false);
});

test('非法：permissions 项缺 name', () => {
  const r = validateManifest({ ...validMinimal, permissions: [{ reason: 'x' }] });
  assert.equal(r.ok, false);
});

test('非法：权限点命名不符合层级规范', () => {
  const r = validateManifest({ ...validMinimal, permissions: [{ name: 'Docker.Read' }] });
  assert.equal(r.ok, false);
});

// ---- 动态权限点（docs/events-and-hooks-design.md §3.4）----
//
// 两种动态点由核心按**完整引用**生成：`plugins.call.<origin>/@user/name.<path>`、
// `events.subscribe.<origin>/@user/name.<topic>`。它们必须能被**声明**（否则核心登记了一个谁都申请不了的点），
// 而 `*` 必须继续被挡在门外（通配声明 = 把对方将来新增的端点/订阅一次性全授）。

const withPermissions = (...names: string[]) => ({
  ...validMinimal,
  permissions: names.map((name) => ({ name })),
});

test('合法：动态点（跨插件调用 / 订阅）可以直接声明', () => {
  for (const name of [
    'plugins.call.market.spc.xfyweb.cn/@b/backup./api/backup/run',
    'plugins.call.local:dev-a/@b/backup./api/x',
    'events.subscribe.local:default/@a/sqlite.refresh.finished',
    'plugins.call.localhost:8080/@b/backup./api/x',
  ]) {
    const r = validateManifest(withPermissions(name));
    assert.equal(r.ok, true, `${name} 应当合法：${JSON.stringify(r.errors)}`);
  }
});

test('非法：动态点里出现 `*`（通配声明会绕过"新增端点走增量同意"）', () => {
  for (const name of [
    'plugins.call.local:default/@b/backup.*',
    'plugins.call.*',
    'events.subscribe.local:default/@a/sqlite.*',
    '*',
  ]) {
    const r = validateManifest(withPermissions(name));
    assert.equal(r.ok, false, `${name} 不应通过`);
  }
});

test('非法：动态点只有前缀、没有引用与尾段', () => {
  // ⚠️ 裸的 `plugins.call` 不在此列：它**恰好也是**一个合法的静态点名字（`plugins` + `.call`），
  // schema 拦不住它 —— 拦它的是语义闸（没登记过 ⇒ UNKNOWN_POINT）。schema 只描述语法。
  for (const name of ['plugins.call.', 'events.subscribe.']) {
    const r = validateManifest(withPermissions(name));
    assert.equal(r.ok, false, `${name} 不应通过`);
  }
});

test('静态点的既有约束不变（动态点分支没有把闸门一起放宽）', () => {
  for (const name of ['Docker.Read', 'fs', 'fs.', '.fs.read', 'plugins.Call.a.b']) {
    const r = validateManifest(withPermissions(name));
    assert.equal(r.ok, false, `${name} 不应通过`);
  }
});

test('非法：runtime.esm 为 false（ESM-only 硬约束）', () => {
  const r = validateManifest({ ...validMinimal, runtime: { type: 'quickjs', esm: false } });
  assert.equal(r.ok, false);
});

test('非法：runtime.type 枚举外', () => {
  const r = validateManifest({ ...validMinimal, runtime: { type: 'python' } });
  assert.equal(r.ok, false);
});

test('非法：id 无命名空间', () => {
  const r = validateManifest({ ...validMinimal, id: 'docker' });
  assert.equal(r.ok, false);
});

test('非法：id 含大写', () => {
  const r = validateManifest({ ...validMinimal, id: '@xfy2412/Docker' });
  assert.equal(r.ok, false);
});

test('非法：version.code 为 0', () => {
  const r = validateManifest({ ...validMinimal, version: { code: 0, name: '0.0.1' } });
  assert.equal(r.ok, false);
});

test('非法：version.name 非 semver', () => {
  const r = validateManifest({ ...validMinimal, version: { code: 1, name: 'v1' } });
  assert.equal(r.ok, false);
});

test('非法：未知字段（additionalProperties: false）', () => {
  const r = validateManifest({ ...validMinimal, foo: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('foo')));
});

test('合法：dependencies.npm 只声明 name/version（v2 起无 tier）', () => {
  const ok = validateManifest({
    ...validMinimal,
    dependencies: { npm: [{ name: 'x', version: '1.0.0' }] },
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  // `tier` 已随"依赖不分信任档"删除（ADR-005 §7 v2）：再写它 = 未知字段
  const stale = validateManifest({
    ...validMinimal,
    dependencies: { npm: [{ name: 'x', version: '1.0.0', tier: 'whitelist' }] },
  });
  assert.equal(stale.ok, false);
});

test('合法：dependencies.plugins[].origin 接受 `local:<名字>` 与市场域名（身份 = (origin, id)）', () => {
  const ok = validateManifest({
    ...validMinimal,
    dependencies: {
      plugins: [
        { id: '@xfy2412/base', origin: 'local:dev-a', author: { pub: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } },
        { id: '@xfy2412/driver', origin: 'market.spc.xfyweb.cn', author: { pub: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } },
        { id: '@xfy2412/localhost', origin: 'localhost:8080', author: { pub: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } },
        { id: '@xfy2412/same-source', author: { pub: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } }, // 省略 origin = 同源简写（市场目标）
      ],
    },
  });
  assert.equal(ok.ok, true, (ok.errors ?? []).join('; '));

  // **来源是身份的一半**，不能是任意字符串：这些都必须被 schema 拦住
  for (const bad of ['local:', '../etc', 'Bogus Origin', 'a/b', '']) {
    const r = validateManifest({
      ...validMinimal,
      dependencies: { plugins: [{ id: '@xfy2412/base', origin: bad, author: { pub: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } }] },
    });
    assert.equal(r.ok, false, `origin=${JSON.stringify(bad)} 应被拒`);
  }
});

test('非法：manifest 里出现 signature 字段（v2 起签名属于交付信封）', () => {
  const r = validateManifest({
    ...validMinimal,
    // v2：签名不在 manifest 里（见 docs/plugin-signature-design.md）
    signature: { algorithm: 'ed25519', keyId: 'k', digest: 'd', sig: 's' },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('signature')));
});

test('非法：type 枚举外', () => {
  const r = validateManifest({ ...validMinimal, type: 'magic' });
  assert.equal(r.ok, false);
});

test('非法：panel 已移除（v3 面板插件降级为主题包）', () => {
  const r = validateManifest({ ...validMinimal, type: 'panel' });
  assert.equal(r.ok, false);
});

test('合法：主题包（type=theme）不需要 runtime / permissions，但必须给 theme 入口', () => {
  const ok = validateManifest({
    schema: 2,
    type: 'theme',
    id: '@xfy2412/nord',
    name: 'Nord',
    version: { code: 1, name: '0.0.1' },
    theme: 'theme.json',
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));

  const missingEntry = validateManifest({
    schema: 2,
    type: 'theme',
    id: '@xfy2412/nord',
    name: 'Nord',
    version: { code: 1, name: '0.0.1' },
  });
  assert.equal(missingEntry.ok, false);
});

test('合法：frontend.mode 与 intent[] 声明', () => {
  const ok = validateManifest({
    ...validMinimal,
    frontend: { mode: 'iframe' },
    intent: [
      { name: 'pickFile', kind: 'selection', resource: 'path', types: ['file'], maxBytes: 512 },
      { name: 'mode', kind: 'enum', values: ['fast', 'safe'] },
    ],
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));

  assert.equal(validateManifest({ ...validMinimal, frontend: { mode: 'magic' } }).ok, false);
  assert.equal(validateManifest({ ...validMinimal, intent: [{ name: 'x', kind: 'magic' }] }).ok, false);
});

test('合法：configSchema（默认值 / 描述 / 枚举 / secret）', () => {
  const ok = validateManifest({
    ...validMinimal,
    configSchema: {
      type: 'object',
      required: ['greeting'],
      additionalProperties: false,
      properties: {
        greeting: { type: 'string', default: 'hello', description: '启动问候语' },
        retries: { type: 'integer', default: 3, minimum: 1, maximum: 10 },
        mode: { type: 'string', enum: ['fast', 'safe'] },
        token: { type: 'string', secret: true },
        hosts: { type: 'array', items: { type: 'string' } },
      },
    },
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('非法：configSchema 结构不对（缺 properties / 类型枚举外 / 未知字段）', () => {
  // 必须有 properties（否则"声明了配置"却没有字段可渲染）
  assert.equal(validateManifest({ ...validMinimal, configSchema: { type: 'object' } }).ok, false);
  // 顶层 type 只能是 object
  assert.equal(
    validateManifest({ ...validMinimal, configSchema: { type: 'array', properties: {} } }).ok,
    false,
  );
  // 字段类型限 string|number|integer|boolean|array（嵌套对象留给后续版本）
  assert.equal(
    validateManifest({
      ...validMinimal,
      configSchema: { type: 'object', properties: { a: { type: 'object' } } },
    }).ok,
    false,
  );
  // 未支持的关键字（如 format）直接拒——避免"写了不生效"的静默失败
  assert.equal(
    validateManifest({
      ...validMinimal,
      configSchema: { type: 'object', properties: { a: { type: 'string', format: 'uri' } } },
    }).ok,
    false,
  );
  // 字段名必须是 lowerCamel
  assert.equal(
    validateManifest({
      ...validMinimal,
      configSchema: { type: 'object', properties: { 'Bad-Name': { type: 'string' } } },
    }).ok,
    false,
  );
});

test('非法：非对象输入', () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest('str').ok, false);
  assert.equal(validateManifest([]).ok, false);
});
