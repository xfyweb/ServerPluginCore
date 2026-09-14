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
    webApis: [{ path: '/api/docker/containers', permission: 'docker.read' }],
    routes: [{ path: '/docker', title: 'Docker', icon: 'container', order: 10 }],
    events: {
      publish: [{ topic: 'backup.done', classification: 'public' }],
      subscribe: [{ topic: 'docker.container.crash', mode: 'notify' }],
    },
  },
  dependencies: {
    npm: [{ name: 'zod', version: '3.x', tier: 'whitelist' }],
    plugins: [{ id: '@xfy2412/panel', version: '>=0.1.0' }],
  },
};

/** 最小合法清单（仅必填字段，spike 插件形态） */
const validMinimal = {
  schema: 2,
  id: '@xfy2412/sample',
  name: 'Sample Plugin',
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

test('非法：dependencies.npm.tier 枚举外', () => {
  const r = validateManifest({
    ...validMinimal,
    dependencies: { npm: [{ name: 'x', version: '1.0.0', tier: 'admin' }] },
  });
  assert.equal(r.ok, false);
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

test('非法：非对象输入', () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest('str').ok, false);
  assert.equal(validateManifest([]).ok, false);
});
