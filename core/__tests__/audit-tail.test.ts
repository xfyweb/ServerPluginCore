// 审计尾部读的用例：**有界读**（不吞整个文件）、**半行**（从中间截断时丢掉第一条残行）、**坏行**（不让一行坏数据打哑读面）、
// 以及三个过滤器。判据都是"文件很大/很脏时读面还能用"。
// ⚠️ `AUDIT_FILE` 是模块常量（从环境变量解析），所以必须**先设 `SPC_AUDIT_DIR` 再 import**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'spc-audit-tail-'));
process.env.SPC_AUDIT_DIR = DIR;
mkdirSync(DIR, { recursive: true });
const { readAuditTail, AUDIT_FILE } = await import('../audit.ts');

let seq = 0;
function entry(over: Record<string, unknown> = {}): string {
  seq += 1;
  return JSON.stringify({
    ts: 1_700_000_000_000 + seq,
    pluginId: '@a/b',
    ref: 'local:default/@a/b',
    method: 'kv.get',
    paramsDigest: 'x',
    result: 'ok',
    ...over,
  });
}

test('基本：只给最近 N 条，按时间正序返回', () => {
  writeFileSync(AUDIT_FILE, '', 'utf8');
  for (let i = 0; i < 10; i += 1) appendFileSync(AUDIT_FILE, `${entry()}\n`, 'utf8');

  const r = readAuditTail({ limit: 3 });
  assert.equal(r.entries.length, 3, '只给 3 条');
  assert.deepEqual(
    r.entries.map((e) => e.ts),
    [...r.entries.map((e) => e.ts)].sort((a, b) => a - b),
    '返回时是时间正序（方便直接打给人看）',
  );
  assert.equal(r.truncatedFile, false);
  assert.equal(r.skipped, 0);
});

test('过滤器：来源 / 方法 / 结果（与关系）', () => {
  writeFileSync(AUDIT_FILE, '', 'utf8');
  appendFileSync(AUDIT_FILE, `${entry()}\n`, 'utf8'); // kv.get ok @a/b
  appendFileSync(AUDIT_FILE, `${entry({ method: 'fs.read', result: 'denied' })}\n`, 'utf8');
  appendFileSync(AUDIT_FILE, `${entry({ ref: 'local:default/@a/c', pluginId: '@a/c' })}\n`, 'utf8');

  assert.equal(readAuditTail({ plugin: 'local:default/@a/c' }).entries.length, 1);
  assert.equal(readAuditTail({ method: 'fs.read' }).entries.length, 1);
  assert.equal(readAuditTail({ result: 'denied' }).entries.length, 1);
  assert.equal(readAuditTail({ plugin: 'local:default/@a/b', method: 'fs.read' }).entries.length, 1);
  assert.equal(
    readAuditTail({ plugin: 'local:default/@a/c', result: 'denied' }).entries.length,
    0,
    '与关系：@a/c 那条是 ok ⇒ denied 过滤后为空',
  );
});

test('坏行不让读面打哑（计进 skipped，好行照读）', () => {
  writeFileSync(AUDIT_FILE, '', 'utf8');
  appendFileSync(AUDIT_FILE, `${entry()}\n`, 'utf8');
  appendFileSync(AUDIT_FILE, '这不是 JSON\n', 'utf8');
  appendFileSync(AUDIT_FILE, `${entry({ method: 'fs.write' })}\n`, 'utf8');

  const r = readAuditTail({ limit: 10 });
  assert.equal(r.entries.length, 2, '两条好行都读出来了');
  assert.equal(r.skipped, 1, '坏行被计数（不是静默丢掉）');
});

test('有界读：超过 maxBytes 时只读末尾一段，并**说出**前面还有（truncatedFile）', () => {
  writeFileSync(AUDIT_FILE, '', 'utf8');
  for (let i = 0; i < 50; i += 1) appendFileSync(AUDIT_FILE, `${entry()}\n`, 'utf8');

  const r = readAuditTail({ limit: 100, maxBytes: 1024 });
  assert.equal(r.truncatedFile, true, '从中间截过 ⇒ 调用方要能说出"窗口之前还有条目"');
  assert.ok(r.skipped >= 1, '截断处的半行被丢掉并计数');
  assert.ok(r.entries.length > 0, '窗口内的条目照读');
  assert.ok(r.entries.length < 50, '确实没把整个文件读完');
  for (const e of r.entries) assert.equal(e.method, 'kv.get', '窗口内的条目结构仍可用');
});

test('游标（字节偏移）：续读只给新条目、不重不漏；写了一半的半条**不消费**', () => {
  writeFileSync(AUDIT_FILE, '', 'utf8');
  appendFileSync(AUDIT_FILE, `${entry({ method: 'a.one' })}\n`, 'utf8');
  appendFileSync(AUDIT_FILE, `${entry({ method: 'a.two' })}\n`, 'utf8');

  const first = readAuditTail({ limit: 10 });
  assert.deepEqual(first.entries.map((e) => e.method), ['a.one', 'a.two']);
  assert.ok(first.nextOffset > 0, 'nextOffset 要能给出来');

  // 没有新内容 ⇒ 续读给空
  const again = readAuditTail({ since: first.nextOffset });
  assert.deepEqual(again.entries, [], '还没写新的，不该重复给');
  assert.equal(again.nextOffset, first.nextOffset, '游标原地不动');

  // 写两条新的 ⇒ 续读只给这两条
  appendFileSync(AUDIT_FILE, `${entry({ method: 'a.three' })}\n`, 'utf8');
  appendFileSync(AUDIT_FILE, `${entry({ method: 'a.four' })}\n`, 'utf8');
  const next = readAuditTail({ since: first.nextOffset });
  assert.deepEqual(next.entries.map((e) => e.method), ['a.three', 'a.four'], '只给新的（不重不漏）');
  assert.ok(next.nextOffset > first.nextOffset);

  // 半条（写了一半，没有换行）⇒ 不消费：游标停在它之前，下次补全了还能读到
  appendFileSync(AUDIT_FILE, '{"ts":1,"pluginId":"@a/b","method":"a.half"', 'utf8');
  const half = readAuditTail({ since: next.nextOffset });
  assert.deepEqual(half.entries, [], '半条读不出来（也没被当成坏行）');
  assert.equal(half.nextOffset, next.nextOffset, '游标不许推过半条 —— 推过去就永远丢了');
  appendFileSync(AUDIT_FILE, ',"paramsDigest":"x","result":"ok"}\n', 'utf8');
  const completed = readAuditTail({ since: next.nextOffset });
  assert.deepEqual(completed.entries.map((e) => e.method), ['a.half'], '补全之后读得到');
});

test('游标落后太多（早于窗口起点）⇒ 从窗口起点读，并置 truncatedFile 让调用方说出来', () => {
  writeFileSync(AUDIT_FILE, '', 'utf8');
  for (let i = 0; i < 50; i += 1) appendFileSync(AUDIT_FILE, `${entry()}\n`, 'utf8');
  const r = readAuditTail({ since: 0, maxBytes: 1024 });
  assert.equal(r.truncatedFile, true, '客户端要的位置已经被窗口甩掉了');
  assert.ok(r.entries.length > 0);
  assert.ok(r.nextOffset > 0);
});

test('文件不存在（还没写过审计）⇒ 空结果，不是错误', () => {
  writeFileSync(AUDIT_FILE, '', 'utf8');
  const r = readAuditTail({});
  assert.deepEqual(r.entries, []);
  assert.equal(r.skipped, 0);
});
