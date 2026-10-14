// 渲染层的用例：契约要求"核心只记码、本地化在渲染层"（api-contract §8），所以这一层必须钉住两件事 ——
// ① 码**照旧出现在行里**（它是契约）；② 认得的部分给中文标签；③ 认不得的**原样回退**（不许编名字）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { auditLine, logLine, clockOf } = await import('../log-render.ts');

function audit(over: Record<string, unknown> = {}) {
  return {
    ts: new Date(2026, 0, 2, 3, 4, 5).getTime(),
    actor: { kind: 'plugin', ref: 'local:default/@a/b' },
    method: 'kv.set',
    paramsDigest: 'x',
    result: 'ok',
    ...over,
  } as never;
}

test('审计行：结果词本地化、方法带组标签、码照旧在行里', () => {
  const line = auditLine(audit({ subject: { kind: 'point', ref: 'kv.write' }, timing: { ms: 7 } }));
  assert.match(line, /^03:04:05/);
  assert.match(line, /成功/, '结果要本地化（不是裸 ok）');
  assert.match(line, /local:default\/@a\/b/);
  assert.match(line, /KV（kv\.set）/, '组标签 + 原码都在');
  assert.match(line, /→ 权限点 kv\.write/, '对象那一列要说清是权限点');
  assert.match(line, /7ms/);
  assert.equal(clockOf(new Date(2026, 0, 2, 3, 4, 5).getTime()), '03:04:05');
});

test('结果词：denied / error 也有说法；未知结果**原样回退**', () => {
  assert.match(auditLine(audit({ result: 'denied' })), /被拒/);
  assert.match(auditLine(audit({ result: 'error', error: { code: 'PERMISSION_DENIED' } })), /出错/);
  assert.match(auditLine(audit({ result: 'error', error: { code: 'PERMISSION_DENIED' } })), /PERMISSION_DENIED/, '错误码照打');
  assert.match(auditLine(audit({ result: 'weird' })), /weird/, '未知结果原样回退，不许编');
});

test('未知的组名原样回退（不编标签）；没有目标/时长就不占位', () => {
  const line = auditLine(audit({ method: 'nosuchgroup.thing' }));
  assert.match(line, /nosuchgroup（nosuchgroup\.thing）/, '认不得的组就用原码');
  assert.doesNotMatch(line, /→/, '没有 subject 就不该出现箭头');
  assert.doesNotMatch(line, /ms/, '没有 timing 就不该出现耗时');
});

test('日志行：级别/来源照打，截断有标记', () => {
  const line = logLine({
    seq: 1,
    ts: new Date(2026, 0, 2, 3, 4, 5).getTime(),
    ref: 'local:default/@a/b',
    level: 'warn',
    text: '磁盘快满了',
    truncated: false,
  } as never);
  assert.match(line, /03:04:05\s+\[warn\]/);
  assert.match(line, /local:default\/@a\/b/);
  assert.match(line, /磁盘快满了/);
  const cut = logLine({ seq: 2, ts: 0, ref: 'r', level: 'info', text: '很长', truncated: true } as never);
  assert.match(cut, /截断/, '截断要说出来');
});
