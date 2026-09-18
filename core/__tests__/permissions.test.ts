// 权限注册表 + 三态判定测试
// v3：scope + 逐点授予；来源与等级都不参与 allow/deny
// v4（第四批 B）：新增 `grant` 三档，**判定链第 2/3 步只看 grant**——`self`（= auto）免声明免授予，
//   `host` 必须声明，只有 `explicit` 要逐点授予。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionRegistry, resolveGrant } from '../permissions/registry';
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
    description: 'self 作用域（缺省 grant ⇒ auto）',
    scope: 'self',
    confidentiality: 'sensitive',
    executionLevel: 'medium',
  });
  r.register({
    name: 'exec.template.nginx.reload',
    group: 'exec',
    description: 'host 作用域 + secret/high（缺省 grant ⇒ explicit，fail-closed）',
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
  r.register({
    name: 'fs.read.host',
    group: 'fs',
    description: 'host + install（要声明、免逐点授予）',
    scope: 'host',
    grant: 'install',
    confidentiality: 'sensitive',
    executionLevel: 'medium', // 不变式：executionLevel >= confidentiality
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

test('`auto` 档（self）：**未声明也放行**（v4 免声明——够不着别人的能力不该要一次声明仪式）', () => {
  const res = checkPermission(makeRegistry(), 'fs.write.data', [], []);
  assert.equal(res.decision, 'allow');
  assert.equal(res.code, 'ALLOWED');
  assert.equal(res.params?.grant, 'auto');
});

test('`auto` 档：未声明时也不看授予列表（本来就免授予）', () => {
  const res = checkPermission(makeRegistry(), 'fs.read.public', [], []);
  assert.equal(res.decision, 'allow');
});

test('`host` + `install`：**仍要声明**，但**免逐点授予**', () => {
  const r = makeRegistry();
  // 未声明 → 拒绝（host 资源要在安装时被看见）
  const undeclared = checkPermission(r, 'fs.read.host', [], []);
  assert.equal(undeclared.decision, 'deny');
  assert.equal(undeclared.code, 'NOT_DECLARED');
  assert.equal(undeclared.params?.grant, 'install');
  // 已声明、无授予 → 放行（install 档读安装清单即生效）
  const declared = checkPermission(r, 'fs.read.host', ['fs.read.host'], []);
  assert.equal(declared.decision, 'allow');
  assert.equal(declared.params?.grant, 'install');
});

test('`host` + `explicit`：未声明 → NOT_DECLARED（先报声明这一关）', () => {
  const res = checkPermission(makeRegistry(), 'exec.template.nginx.reload', [], []);
  assert.equal(res.decision, 'deny');
  assert.equal(res.code, 'NOT_DECLARED');
});

test('self 作用域：声明即批准，不需要授予（v3 起成立，v4 连声明都不要了）', () => {
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

test('一致性（v4）：`self` + `grant != auto` → SCOPE_GRANT_INVALID', () => {
  const r = new PermissionRegistry();
  for (const grant of ['install', 'explicit'] as const) {
    assert.throws(
      () =>
        r.register({
          name: `bad.self.${grant}`,
          group: 'bad',
          description: 'self 点不该要授予仪式',
          scope: 'self',
          grant,
          confidentiality: 'public',
          executionLevel: 'low',
        }),
      (err: any) => err.code === 'SCOPE_GRANT_INVALID',
      `self + ${grant} 应当抛 SCOPE_GRANT_INVALID`,
    );
  }
  // `self` + `auto` 是合法（也是唯一的 self 档）
  r.register({
    name: 'ok.self',
    group: 'ok',
    description: 'self + auto',
    scope: 'self',
    grant: 'auto',
    confidentiality: 'public',
    executionLevel: 'low',
  });
  assert.equal(r.get('ok.self')?.grant, 'auto');
});

test('`grant` 缺省推导：self → auto、host → explicit（偏保守；install 必须显式写）', () => {
  assert.equal(resolveGrant('self'), 'auto');
  assert.equal(resolveGrant('host'), 'explicit');
  assert.equal(resolveGrant('host', 'install'), 'install');
  // 注册后**存的是解析结果**（判定链只读这一处，不各自推导）
  const r = makeRegistry();
  assert.equal(r.get('fs.write.data')?.grant, 'auto');
  assert.equal(r.get('exec.template.nginx.reload')?.grant, 'explicit');
  assert.equal(r.get('fs.read.host')?.grant, 'install');
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
