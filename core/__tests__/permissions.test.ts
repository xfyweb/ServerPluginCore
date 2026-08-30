// 权限注册表 + 三态判定测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionRegistry } from '../permissions/registry';
import { checkPermission, effectiveLevel, matchGrant } from '../permissions/check';

function makeRegistry() {
  const r = new PermissionRegistry();
  r.register({
    name: 'fs.write.data',
    group: 'fs',
    description: 'test',
    protectionLevel: 'normal',
    confidentiality: 'sensitive',
    executionLevel: 'medium',
    defaults: { official: 'allow', thirdparty: 'allow' },
  });
  r.register({
    name: 'exec.template.nginx.reload',
    group: 'exec',
    description: 'test',
    protectionLevel: 'dangerous',
    confidentiality: 'secret',
    executionLevel: 'high',
    defaults: { official: 'allow', thirdparty: 'deny' },
  });
  r.register({
    name: 'exec.template.mc.start',
    group: 'exec',
    description: 'test secret-but-declared',
    protectionLevel: 'dangerous',
    confidentiality: 'secret',
    executionLevel: 'high',
    defaults: { official: 'allow', thirdparty: 'allow' }, // 声明允许，但等级仅官方
  });
  r.register({
    name: 'fs.read.public',
    group: 'fs',
    description: 'test public',
    protectionLevel: 'normal',
    confidentiality: 'public',
    executionLevel: 'low',
    defaults: { official: 'allow', thirdparty: 'allow' },
  });
  return r;
}

// ---- 匹配链（D2）----

test('matchGrant：精确匹配', () => {
  assert.equal(matchGrant('fs.write.data', ['fs.write.data']), true);
  assert.equal(matchGrant('fs.write.data', ['fs.read.data']), false);
});

test('matchGrant：前缀通配（fs.* 覆盖 fs.write.data）', () => {
  assert.equal(matchGrant('fs.write.data', ['fs.*']), true);
  assert.equal(matchGrant('fs.write.data', ['exec.*']), false);
});

test('matchGrant：全通配（*）', () => {
  assert.equal(matchGrant('anything.any', ['*']), true);
});

test('matchGrant：未声明 → false（无默认放行）', () => {
  assert.equal(matchGrant('docker.read', []), false);
  assert.equal(matchGrant('docker.read', ['fs.*']), false);
});

// ---- 三态判定（D1）----

test('checkPermission：未在注册表登记的权限点 → deny（未知即拒绝）', () => {
  const r = makeRegistry();
  const res = checkPermission(r, 'unknown.point', ['unknown.point'], 'official');
  assert.equal(res.decision, 'deny');
  assert.match(res.reason, /未知权限点/);
});

test('checkPermission：未声明 → deny（无默认放行）', () => {
  const r = makeRegistry();
  const res = checkPermission(r, 'fs.write.data', [], 'official');
  assert.equal(res.decision, 'deny');
  assert.match(res.reason, /未声明/);
});

test('checkPermission：official 档声明 + 默认 allow → allow', () => {
  const r = makeRegistry();
  const res = checkPermission(r, 'fs.write.data', ['fs.write.data'], 'official');
  assert.equal(res.decision, 'allow');
});

test('checkPermission：thirdparty 档对 dangerous 权限点 → deny（降级）', () => {
  const r = makeRegistry();
  // 即使声明了，thirdparty 档也按 defaults 降级拒绝
  const res = checkPermission(r, 'exec.template.nginx.reload', ['exec.template.nginx.reload'], 'thirdparty');
  assert.equal(res.decision, 'deny');
  assert.match(res.reason, /默认拒绝/);
});

test('checkPermission：official 档对 dangerous 权限点 → allow', () => {
  const r = makeRegistry();
  const res = checkPermission(r, 'exec.template.nginx.reload', ['exec.template.nginx.reload'], 'official');
  assert.equal(res.decision, 'allow');
});

test('checkPermission：通配声明 + 精确请求', () => {
  const r = makeRegistry();
  const res = checkPermission(r, 'fs.write.data', ['fs.*'], 'official');
  assert.equal(res.decision, 'allow');
});

test('registry：重复注册抛错', () => {
  const r = makeRegistry();
  assert.throws(() =>
    r.register({
      name: 'fs.write.data',
      group: 'fs',
      description: 'dup',
      protectionLevel: 'normal',
      confidentiality: 'sensitive',
      executionLevel: 'medium',
      defaults: { official: 'allow', thirdparty: 'allow' },
    }),
  );
});


// ---- 安全等级矩阵 ----

test('等级：public/low 无需额外授权（thirdparty 也可）', () => {
  const r = makeRegistry();
  const res = checkPermission(r, 'fs.read.public', ['fs.read.public'], 'thirdparty');
  assert.equal(res.decision, 'allow');
});

test('等级：sensitive/medium 官方直接允许', () => {
  const r = makeRegistry();
  const res = checkPermission(r, 'fs.write.data', ['fs.write.data'], 'official');
  assert.equal(res.decision, 'allow');
});

test('等级：sensitive/medium thirdparty 无显式授权 → deny', () => {
  const r = makeRegistry();
  const res = checkPermission(r, 'fs.write.data', ['fs.write.data'], 'thirdparty');
  assert.equal(res.decision, 'deny');
  assert.match(res.reason, /显式授权/);
});

test('等级：sensitive/medium thirdparty + 显式授权 → allow', () => {
  const r = makeRegistry();
  const res = checkPermission(r, 'fs.write.data', ['fs.write.data'], 'thirdparty', {
    explicitGrants: { confidentiality: ['sensitive'], executionLevel: ['medium'] },
  });
  assert.equal(res.decision, 'allow');
});

test('等级：secret/high 仅官方（thirdparty 声明也拒绝）', () => {
  const r = makeRegistry();
  const res = checkPermission(r, 'exec.template.mc.start', ['exec.template.mc.start'], 'thirdparty', {
    explicitGrants: { confidentiality: ['secret'], executionLevel: ['high'] },
  });
  assert.equal(res.decision, 'deny');
  assert.match(res.reason, /仅官方/);
});

test('等级：secret/high 官方允许', () => {
  const r = makeRegistry();
  const res = checkPermission(r, 'exec.template.nginx.reload', ['exec.template.nginx.reload'], 'official');
  assert.equal(res.decision, 'allow');
});

test('等级覆盖：用户配置高于调用方声明 → 升级（只升不降）', () => {
  const r = makeRegistry();
  // 调用方声明 public，但用户对目录配置了 secret → effective = secret
  const res = checkPermission(r, 'fs.read.public', ['fs.read.public'], 'thirdparty', {
    meta: { confidentiality: 'public', executionLevel: 'low' },
    userOverride: { confidentiality: 'secret', executionLevel: 'high' },
  });
  assert.equal(res.decision, 'deny'); // 被用户配置升级到 secret → 仅官方
  assert.match(res.reason, /仅官方/);
});

test('等级覆盖：用户配置低于调用方声明 → 尊重调用方（不降级）', () => {
  const r = makeRegistry();
  // 调用方声明 secret，用户配置 public → effective 仍为 secret
  const res = checkPermission(r, 'fs.read.public', ['fs.read.public'], 'official', {
    meta: { confidentiality: 'secret', executionLevel: 'high' },
    userOverride: { confidentiality: 'public', executionLevel: 'low' },
  });
  assert.equal(res.decision, 'allow'); // official + secret 允许
});

test('effectiveLevel：三者取最高（调用方 > 权限点默认）', () => {
  const r = makeRegistry();
  const point = r.get('fs.write.data')!;
  const level = effectiveLevel(point, { meta: { confidentiality: 'secret' } });
  assert.equal(level.confidentiality, 'secret'); // 调用方 secret > 默认 sensitive
});


// ---- 一致性约束（executionLevel >= confidentiality）----

test('一致性：register 时执行等级低于保密等级 → 抛错', () => {
  const r = new PermissionRegistry();
  assert.throws(() =>
    r.register({
      name: 'bad.point',
      group: 'bad',
      description: 'e < c',
      protectionLevel: 'normal',
      confidentiality: 'secret',
      executionLevel: 'low',
      defaults: { official: 'allow', thirdparty: 'allow' },
    }),
    /执行等级.*低于保密等级/,
  );
});

test('一致性：调用声明 e < c → 自动校正提升 e', () => {
  const r = makeRegistry();
  const point = r.get('fs.read.public')!;
  // 调用方声明 secret 保密 + low 执行（e < c）→ 校正后 e 提升到与 c 同级
  const level = effectiveLevel(point, { meta: { confidentiality: 'secret', executionLevel: 'low' } });
  assert.equal(level.confidentiality, 'secret');
  assert.ok(['medium', 'high'].includes(level.executionLevel));
});

test('一致性：校正后的判定（secret 信息 → 裁决门槛被提升）', () => {
  const r = makeRegistry();
  // thirdparty 想用 low 裁决权订阅 secret 事件 → 校正后执行门槛提升 → 拒绝
  const res = checkPermission(r, 'fs.read.public', ['fs.read.public'], 'thirdparty', {
    meta: { confidentiality: 'secret', executionLevel: 'low' },
  });
  assert.equal(res.decision, 'deny');
});
