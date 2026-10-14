// 日志聚合器的用例：**有界**（淘汰最旧）、**截断**、**游标**（seq 而不是时间戳）、过滤。
// 这些都是"内存有界"与"续读不漏"的判据 —— 少了哪条，插件都能靠刷日志把核心拖垮或让排障读丢。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { LogRing, LOG_LEVEL_ORDER, asLogLevel } = await import('../logs.ts');

const ring = (max = 100, maxText = 4096) => new LogRing(max, maxText);

test('seq 单调递增、不回退；淘汰最旧的且把丢掉的条数说出来', () => {
  const r = ring(3);
  for (let i = 1; i <= 5; i += 1) r.append({ ref: 'local:default/@a/b', level: 'info', text: `m${i}`, ts: i });

  assert.equal(r.lastSeq, 5, 'seq 一路涨到 5');
  const { entries, dropped } = r.query();
  assert.deepEqual(
    entries.map((e) => e.text),
    ['m3', 'm4', 'm5'],
    '只留最近 3 条（最旧的被淘汰）',
  );
  assert.equal(dropped, 2, '淘汰了 2 条 —— 调用方要能说出"窗口之前有缺口"');
});

test('单条超长截断并标 truncated（内存有界的另一半）', () => {
  const r = ring(10, 8);
  const e = r.append({ ref: 'local:default/@a/b', level: 'warn', text: '一二三四五六七八九十' });
  assert.equal(e.text.length, 8);
  assert.equal(e.truncated, true);
  const ok = r.append({ ref: 'local:default/@a/b', level: 'warn', text: '短的' });
  assert.equal(ok.truncated, false, '没超长就不许标截断');
});

test('过滤：来源（完整引用）/ 等级（**至少**这个等级）/ 最近 N 条', () => {
  const r = ring();
  r.append({ ref: 'local:default/@a/one', level: 'debug', text: 'd1', ts: 1 });
  r.append({ ref: 'local:default/@a/one', level: 'info', text: 'i1', ts: 2 });
  r.append({ ref: 'local:default/@a/two', level: 'warn', text: 'w1', ts: 3 });
  r.append({ ref: 'local:default/@a/one', level: 'error', text: 'e1', ts: 4 });

  assert.deepEqual(
    r.query({ ref: 'local:default/@a/one' }).entries.map((e) => e.text),
    ['d1', 'i1', 'e1'],
    '按来源过滤（同 id 不同来源是两个插件，这里只认完整引用）',
  );
  assert.deepEqual(
    r.query({ level: 'warn' }).entries.map((e) => e.text),
    ['w1', 'e1'],
    '`--level warn` = 警告**以上**（排障想要的就是这个）',
  );
  assert.deepEqual(
    r.query({ limit: 2 }).entries.map((e) => e.text),
    ['w1', 'e1'],
    '`limit` = 最近 N 条',
  );
  assert.deepEqual(
    r.query({ ref: 'local:default/@a/one', level: 'error' }).entries.map((e) => e.text),
    ['e1'],
    '两个过滤是与关系',
  );
});

test('游标：`since` 续读不漏、不重；没有新条目时 nextSeq 原样回显', () => {
  const r = ring();
  r.append({ ref: 'r', level: 'info', text: 'a', ts: 1 });
  r.append({ ref: 'r', level: 'info', text: 'b', ts: 2 }); // 同一毫秒也可以有多条 —— 所以不能用时间戳续读

  const first = r.query({ limit: 1 });
  assert.deepEqual(first.entries.map((e) => e.text), ['b'], '先给最近的');
  const cursor = first.nextSeq;
  assert.equal(cursor, 2);

  const second = r.query({ since: cursor });
  assert.deepEqual(second.entries, [], '已经读到队尾了');
  assert.equal(second.nextSeq, cursor, '没有新条目时**原样回显**（客户端不会丢位置）');

  r.append({ ref: 'r', level: 'info', text: 'c', ts: 3 });
  const third = r.query({ since: cursor });
  assert.deepEqual(third.entries.map((e) => e.text), ['c'], '只给新来的那条（不重不漏）');
  assert.equal(third.nextSeq, 3);
});

test('等级表与解析：认不出就返回 undefined（别把拼错当合法等级）', () => {
  assert.deepEqual([...LOG_LEVEL_ORDER], ['debug', 'info', 'warn', 'error']);
  assert.equal(asLogLevel('warn'), 'warn');
  assert.equal(asLogLevel('warning'), undefined);
  assert.equal(asLogLevel(''), undefined);
});
