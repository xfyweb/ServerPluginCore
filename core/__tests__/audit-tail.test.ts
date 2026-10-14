// 审计读面的用例（**按天分文件**方案，2026-10-14）：
// ① 当天文件里的尾部读与过滤；② 游标（`"<日期>#<seq>"`）续读不重不漏；③ 跨日 gzip 与回看；
// ④ 旧单文件（v1）被挪走且不进读面；⑤ 坏行不让读面打哑。
// ⚠️ `AUDIT_DIR` 是模块常量（从环境变量解析），所以必须**先设 `SPC_AUDIT_DIR` 再 import**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'spc-audit-day-'));
process.env.SPC_AUDIT_DIR = DIR;
mkdirSync(DIR, { recursive: true });
const { audit, initAudit, pluginActor, readAuditTail, rollAuditDay, auditFileFor, LEGACY_FILE } = await import('../audit.ts');

initAudit();

const p = (n: number): string => String(n).padStart(2, '0');
const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const TODAY = dayOf(Date.now());
const YESTERDAY = dayOf(Date.now() - 24 * 3600 * 1000);

/** 造一条审计（用模块自己的 `audit()` ⇒ `v`/`seq` 由写入层生成，和真实路径一致） */
function write(over: Record<string, unknown> = {}): void {
  audit({
    ts: Date.now(),
    actor: pluginActor('local:default/@a/b'),
    subject: { kind: 'plugin', ref: 'local:default/@a/b' },
    method: 'kv.get',
    paramsDigest: 'x',
    result: 'ok',
    timing: { ms: 1 },
    ...over,
  } as never);
}

test('当天文件：落在 `<日期>.jsonl` 里，条目带 v/seq，尾部读给最近 N 条（时间正序）', () => {
  assert.ok(existsSync(auditFileFor(TODAY)), '当天的文件应当已建好');
  for (let i = 0; i < 5; i += 1) write({ method: `m.${i}` });

  const r = readAuditTail({ limit: 3 });
  assert.deepEqual(
    r.entries.map((e) => e.method),
    ['m.2', 'm.3', 'm.4'],
    '只给最近 3 条，且按时间正序',
  );
  assert.equal((r.entries[2] as { v?: number }).v, 2, '条目带结构版本');
  assert.equal(typeof (r.entries[2] as { seq?: number }).seq, 'number', '条目带文件内序号');
  assert.match(r.nextCursor, new RegExp(`^${TODAY}#\\d+$`), '游标形如 <日期>#<seq>');
});

test('过滤器：来源 / 方法 / 结果（与关系）', () => {
  write({ method: 'fs.read', result: 'denied' });
  write({ actor: pluginActor('local:default/@a/c'), subject: { kind: 'plugin', ref: 'local:default/@a/c' }, method: 'kv.get' });

  assert.ok(readAuditTail({ plugin: 'local:default/@a/c' }).entries.length >= 1);
  assert.equal(readAuditTail({ plugin: 'local:default/@a/c', method: 'fs.read' }).entries.length, 0, '与关系');
  assert.ok(readAuditTail({ method: 'fs.read' }).entries.length >= 1);
  assert.ok(readAuditTail({ result: 'denied' }).entries.length >= 1);
});

test('游标续读：不重不漏；没有新条目时 nextCursor 原样回显', () => {
  const before = readAuditTail({ limit: 1 });
  const cursor = before.nextCursor;

  const again = readAuditTail({ since: cursor });
  assert.deepEqual(again.entries, [], '还没写新的，不该重复给');
  assert.equal(again.nextCursor, cursor, '游标原地不动（客户端不会丢位置）');

  write({ method: 'after.cursor' });
  const after = readAuditTail({ since: cursor });
  assert.deepEqual(after.entries.map((e) => e.method), ['after.cursor'], '只给新来的那条');
  assert.notEqual(after.nextCursor, cursor, '游标往前走');
});

test('跨日：往日文件被 gzip 打包、原文件删除，读面靠回看仍能读到', () => {
  write({ ts: Date.now() - 24 * 3600 * 1000, method: 'yesterday.one' });
  write({ ts: Date.now() - 24 * 3600 * 1000, method: 'yesterday.two' });
  assert.ok(existsSync(auditFileFor(YESTERDAY)), '昨天的条目先落在昨天的明文文件里');

  rollAuditDay(); // 跨日处理（写路径与午夜定时器都调它）
  assert.equal(existsSync(auditFileFor(YESTERDAY)), false, '往日明文文件已被打包');
  assert.ok(existsSync(`${auditFileFor(YESTERDAY)}.gz`), 'gz 包在');

  const r = readAuditTail({ limit: 100 });
  const methods = r.entries.map((e) => e.method);
  assert.ok(methods.includes('yesterday.one') && methods.includes('yesterday.two'), '读面回看到昨天（gz）');
  assert.ok(methods.includes('after.cursor'), '今天的也在（两个文件一起给）');
});

test('回看边界：只允许 1 天时说出"已到边界"（不让"审计里没有"被误读成"没发生"）', () => {
  const r = readAuditTail({ limit: 5, maxLookbackDays: 1 });
  assert.equal(r.lookbackExhausted, true, '还有更早的条目没读 ⇒ 必须说出来');
});

test('坏行不让读面打哑（计进 skipped，好行照读）', () => {
  const before = readAuditTail({ limit: 1 }).entries[0]!.method;
  appendFileSync(auditFileFor(TODAY), '这不是 JSON\n', 'utf8');
  write({ method: 'after.bad' });
  const r = readAuditTail({ limit: 5 });
  assert.ok(r.skipped >= 1, '坏行被计数');
  assert.equal(r.entries.at(-1)!.method, 'after.bad');
  assert.ok(before, '读面没被坏行打断');
});

test('迁移**不覆盖**已有留档：已经有一份 legacy-v1.jsonl.gz 时，退到带日期的档名', () => {
  // 场景：同一状态目录被迁移第二次（先被测试跑迁移过，之后旧代码的进程又往旧路径写了新内容）。
  // 无条件写 `legacy-v1.jsonl.gz` 会把上一次的留档抹掉 —— 本地历史只有一份，抹了就没了。
  writeFileSync(join(DIR, 'legacy-v1.jsonl.gz'), 'PREVIOUS', 'utf8');
  writeFileSync(
    LEGACY_FILE,
    '{"ts":1,"pluginId":"@old/x","method":"second.migration","paramsDigest":"x","result":"ok","durationMs":0}\n',
    'utf8',
  );

  initAudit();

  assert.equal(existsSync(LEGACY_FILE), false, '旧文件挪走了');
  assert.equal(readFileSync(join(DIR, 'legacy-v1.jsonl.gz'), 'utf8'), 'PREVIOUS', '老留档**一个字节没动**');
  assert.equal(
    readdirSync(DIR).filter((n) => /^legacy-v1-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(n)).length,
    1,
    '新留档退到带日期的名字',
  );
});

test('旧的单文件（v1）被挪走留档，且它的条目不进读面（读面只维护一套代码）', () => {
  writeFileSync(
    LEGACY_FILE,
    '{"ts":1,"pluginId":"@old/x","method":"legacy.thing","paramsDigest":"x","result":"ok","durationMs":0}\n',
    'utf8',
  );
  initAudit(); // 启动路径负责迁移
  assert.equal(existsSync(LEGACY_FILE), false, '旧文件挪走了');
  assert.ok(
    !readAuditTail({ limit: 500 }).entries.some((e) => e.method === 'legacy.thing'),
    'v1 条目不进读面',
  );
});
