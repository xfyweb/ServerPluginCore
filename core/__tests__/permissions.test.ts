// 权限注册表 + 三态判定测试（v3：scope + 逐点授予；来源与等级都不参与 allow/deny）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionRegistry } from '../permissions/registry';
import {
  checkPermission,
  effectiveLevel,
  isValidGrantPoint,
  matchDeclaration,
} from '../permissions/check';

function makeRegistry() {
  const r = new PermissionRegistry();
  r.register({
    name: 'fs.write.data',
    group: 'fs',
    description: 'self 作用域',
    scope: 'self',
    confidentiality: 'sensitive',
    executionLevel: 'medium',
  });
  r.register({
    name: 'exec.template.nginx.reload',
    group: 'exec',
    description: 'host 作用域 + secret/high',
    scope: 'host',
    confidentiality: 'secret',
    executionLevel: 'high',
  });
  r.register({
    name: 'fs.read.public',
    group: 'fs',
    description: 'self + public/low',
    scope: 'self',
    confidentiality: 'public',
    executionLevel: 'low',
  });
  return r;
}

// ---- 声明匹配链（D2）----

test('matchDeclaration：精确匹配', () => {
  assert.equal(matchDeclaration('fs.write.data', ['fs.write.data']), true);
  assert.equal(matchDeclaration('fs.write.data', ['fs.read.data']), false);
});

test('matchDeclaration：前缀通配（fs.* 覆盖 fs.write.data）', () => {
  assert.equal(matchDeclaration('fs.write.data', ['fs.*']), true);
  assert.equal(matchDeclaration('fs.write.data', ['exec.*']), false);
});

test('matchDeclaration：全通配（*）', () => {
  assert.equal(matchDeclaration('anything.any', ['*']), true);
});

test('matchDeclaration：未声明 → false（无默认放行）', () => {
  assert.equal(matchDeclaration('docker.read', []), false);
  assert.equal(matchDeclaration('docker.read', ['fs.*']), false);
});

// ---- 判定链（D1：未登记 / 未声明 / 未授予 / 通过）----

test('未在注册表登记 → UNKNOWN_POINT', () => {
  const res = checkPermission(makeRegistry(), 'unknown.point', ['unknown.point'], []);
  assert.equal(res.decision, 'deny');
  assert.equal(res.code, 'UNKNOWN_POINT');
});

test('manifest 未声明 → NOT_DECLARED', () => {
  const res = checkPermission(makeRegistry(), 'fs.write.data', [], []);
  assert.equal(res.decision, 'deny');
  assert.equal(res.code, 'NOT_DECLARED');
});

test('self 作用域：声明即批准，不需要授予', () => {
  const res = checkPermission(makeRegistry(), 'fs.write.data', ['fs.write.data']);
  assert.equal(res.decision, 'allow');
  assert.equal(res.code, 'ALLOWED');
  assert.equal(res.params?.scope, 'self');
});

test('host 作用域：未授予 → NOT_GRANTED', () => {
  const res = checkPermission(makeRegistry(), 'exec.template.nginx.reload', ['exec.template.nginx.reload'], []);
  assert.equal(res.decision, 'deny');
  assert.equal(res.code, 'NOT_GRANTED');
  assert.equal(res.params?.scope, 'host');
});

test('host 作用域：管理员逐点授予 → ALLOWED', () => {
  const res = checkPermission(
    makeRegistry(),
    'exec.template.nginx.reload',
    ['exec.template.nginx.reload'],
    ['exec.template.nginx.reload'],
  );
  assert.equal(res.decision, 'allow');
  assert.equal(res.code, 'ALLOWED');
});

test('授权必须精确：通配授予（* / exec.*）一律无效', () => {
  const r = makeRegistry();
  for (const grants of [['*'], ['exec.*'], ['exec.template.*']]) {
    const res = checkPermission(r, 'exec.template.nginx.reload', ['exec.template.nginx.reload'], grants);
    assert.equal(res.decision, 'deny', `grants=${JSON.stringify(grants)} 不应放行`);
    assert.equal(res.code, 'NOT_GRANTED');
  }
});

test('通配声明 + 精确请求（self）→ allow', () => {
  const res = checkPermission(makeRegistry(), 'fs.write.data', ['fs.*']);
  assert.equal(res.decision, 'allow');
});

test('等级不参与判定：secret/high 只要被授予即可用（来源与等级都不决定 deny/allow）', () => {
  const res = checkPermission(
    makeRegistry(),
    'exec.template.nginx.reload',
    ['exec.template.nginx.reload'],
    ['exec.template.nginx.reload'],
    { meta: { confidentiality: 'secret', executionLevel: 'high' } },
  );
  assert.equal(res.decision, 'allow');
  assert.equal(res.params?.confidentiality, 'secret');
});

test('判定结果携带 scope 与 effective 等级（供审计与渲染）', () => {
  const res = checkPermission(makeRegistry(), 'fs.write.data', ['fs.write.data'], [], {
    meta: { confidentiality: 'secret' },
  });
  assert.equal(res.params?.scope, 'self');
  assert.equal(res.params?.confidentiality, 'secret'); // 调用方声明高于默认
  assert.equal(res.params?.executionLevel, 'high');    // e < c → 自动校正
});

// ---- 注册表一致性 ----

test('registry：重复注册抛错', () => {
  const r = makeRegistry();
  assert.throws(
    () =>
      r.register({
        name: 'fs.write.data',
        group: 'fs',
        description: 'dup',
        scope: 'self',
        confidentiality: 'sensitive',
        executionLevel: 'medium',
      }),
    /DUPLICATE_POINT/,
  );
});

test('一致性：register 时执行等级低于保密等级 → 抛错', () => {
  const r = new PermissionRegistry();
  assert.throws(
    () =>
      r.register({
        name: 'bad.point',
        group: 'bad',
        description: 'e < c',
        scope: 'host',
        confidentiality: 'secret',
        executionLevel: 'low',
      }),
    /LEVEL_ORDER_INVALID/,
  );
});

// ---- 授权记录校验（安装流写入前）----

test('isValidGrantPoint：精确权限点通过；通配与空串不通过', () => {
  assert.equal(isValidGrantPoint('docker.write'), true);
  assert.equal(isValidGrantPoint('exec.template.nginx.reload'), true);
  assert.equal(isValidGrantPoint('*'), false);
  assert.equal(isValidGrantPoint('docker.*'), false);
  assert.equal(isValidGrantPoint(''), false);
});

// ---- 等级合成（effective）----

test('effectiveLevel：取三者最高（调用方 > 权限点默认）', () => {
  const point = makeRegistry().get('fs.write.data')!;
  const level = effectiveLevel(point, { meta: { confidentiality: 'secret' } });
  assert.equal(level.confidentiality, 'secret');
});

test('一致性：调用声明 e < c → 自动校正提升 e', () => {
  const point = makeRegistry().get('fs.read.public')!;
  const level = effectiveLevel(point, { meta: { confidentiality: 'secret', executionLevel: 'low' } });
  assert.equal(level.confidentiality, 'secret');
  assert.ok(['medium', 'high'].includes(level.executionLevel));
});

test('等级覆盖：用户配置高于调用方声明 → 只升不降', () => {
  const point = makeRegistry().get('fs.read.public')!;
  const level = effectiveLevel(point, {
    meta: { confidentiality: 'public', executionLevel: 'low' },
    userOverride: { confidentiality: 'secret', executionLevel: 'high' },
  });
  assert.equal(level.confidentiality, 'secret');
  assert.equal(level.executionLevel, 'high');
});

test('等级覆盖：用户配置低于调用方声明 → 尊重调用方（不降级）', () => {
  const point = makeRegistry().get('fs.read.public')!;
  const level = effectiveLevel(point, {
    meta: { confidentiality: 'secret', executionLevel: 'high' },
    userOverride: { confidentiality: 'public', executionLevel: 'low' },
  });
  assert.equal(level.confidentiality, 'secret');
  assert.equal(level.executionLevel, 'high');
});
