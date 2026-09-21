// 每插件句柄表（`core/plugin/handles.ts`）：随机 UUID + per-plugin 表 + 三种收口
//
// 为什么值得单测（不起沙箱）：这张表是"对象身份"的唯一真相，它的四条性质都是**安全属性**，
// 而且都在纯逻辑层就能钉死：
//   ① id 必须**随机**（不是自增）—— 自增 id 在"将来允许跨插件交接句柄"时会变成能力泄漏；
//   ② 别人的句柄在这张表里**根本查不到**（per-plugin = 结构上不可达，不是靠校验挡）；
//   ③ 到上限 fail-closed（否则"只开不关"能耗尽宿主内存）；
//   ④ 卸载强制回收，且**恰好释放一次**（重复 close 一个 fd 会关掉别人的文件，这条不能靠记性）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandleTable } from '../plugin/handles.ts';
import { SpcError } from '../errors.ts';

/** 造一张只关心逻辑的表（release 用计数器，方便断言"恰好一次"） */
function makeTable(maxPerKind?: Record<string, number>) {
  const released: string[] = [];
  const events: string[] = [];
  const table = new HandleTable<string>({
    pluginId: '@xfy2412/handles-test',
    ...(maxPerKind ? { maxPerKind } : {}),
    onEvent: (e) => events.push(`${e.type}:${e.kind}`),
  });
  const open = (kind: string, resource = 'r') =>
    table.open(kind, resource, () => released.push(resource));
  return { table, released, events, open };
}

test('id 是随机 UUID（不是自增整数）且逐条不同', () => {
  const { table, open } = makeTable();
  const ids = Array.from({ length: 50 }, () => open('hash').id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须逐条不同');
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, `不是 UUID v4：${id}`);
  }
  // 判别性：自增实现会给出可预测序列（这里连"排序后等于原序"都不允许）
  assert.notDeepEqual([...ids].sort(), ids, 'id 不该是可预测的递增序列');
});

test('未知名 / kind 不符 ⇒ INVALID_ARGS（fail-closed），且别家插件的 id 天然查不到', () => {
  const { table, open } = makeTable();
  const record = open('hash');
  // ① 不存在的 id
  assert.throws(
    () => table.require('hash', 'no-such-handle'),
    (err: unknown) => (err as SpcError).code === 'INVALID_ARGS',
  );
  // ② kind 不符（同一张表里 hash 的 id 冒充 hmac）
  assert.throws(
    () => table.require('hmac', record.id),
    (err: unknown) => {
      assert.equal((err as SpcError).code, 'INVALID_ARGS');
      assert.equal((err as SpcError).params.reason, 'unknown-handle');
      return true;
    },
  );
  // ③ 非字符串（插件可以传任何东西过来）
  assert.throws(() => table.require('hash', 42), /INVALID_ARGS/);
  // ④ **另一个插件的表**：同样的 id 在别家的表里查不到 —— 这是"per-plugin"的意义所在
  const other = makeTable();
  assert.throws(() => other.table.require('hash', record.id), /INVALID_ARGS/);
});

test('到上限 fail-closed（HANDLE_LIMIT_EXCEEDED 带 kind/limit/pluginId）', () => {
  const { table, open, events } = makeTable({ hash: 3 });
  const first = open('hash');
  open('hash');
  open('hash');
  assert.throws(
    () => open('hash'),
    (err: unknown) => {
      const e = err as SpcError;
      assert.equal(e.code, 'HANDLE_LIMIT_EXCEEDED');
      assert.equal(e.params.kind, 'hash');
      assert.equal(e.params.limit, '3');
      assert.equal(e.params.pluginId, '@xfy2412/handles-test');
      return true;
    },
  );
  // 上限是**按 kind** 算的：另一个 kind 不受影响（不同 kind 的"贵"不在一个量级）
  assert.doesNotThrow(() => open('hmac'));
  // 释放一个名额 ⇒ 立刻能再开（计"活着的"，不是累计创建数）
  assert.equal(table.closeById(first.id), true);
  assert.doesNotThrow(() => open('hash'));
  assert.ok(events.includes('limit:hash'), '到上限要留事件（审计靠它）');
});

test('closeById 幂等：真资源恰好释放一次，重复 close 返回 false（不抛）', () => {
  const { table, released, open } = makeTable();
  const record = open('hash', 'H1');
  assert.equal(table.closeById(record.id), true);
  assert.equal(table.closeById(record.id), false, '重复 close 必须是 no-op');
  assert.deepEqual(released, ['H1'], '真资源必须**恰好**释放一次');
  // 释放之后再按 id 解析 ⇒ 查不到（不留墓碑：终态语义由仿真层按 Node 合成）
  assert.throws(() => table.require('hash', record.id), /INVALID_ARGS/);
});

test('显式 id（fd 面用）：数字编号可用、重复登记会炸、隔离仍按插件', () => {
  const released: string[] = [];
  const table = new HandleTable<string>({ pluginId: '@xfy2412/handles-test' });
  // fd 面必须交出**数字**（Node 契约），所以允许显式 id；但同一个 id 重复登记是调用方的 bug
  const rec = table.open('fd', 'r1', () => released.push('r1'), { id: '3' });
  assert.equal(rec.id, '3');
  assert.throws(
    () => table.open('fd', 'r2', () => released.push('r2'), { id: '3' }),
    (err: unknown) => (err as SpcError).params.reason === 'handle-id-collision',
  );
  // 关掉之后**编号不复用**（fd 面的纪律：确定性 EBADF，而不是像 Node 那样可能悄悄换个文件）
  assert.equal(table.closeById('3'), true);
  assert.equal(table.peek('fd', '3'), undefined);
  assert.equal(table.closeById('3'), false);
  assert.deepEqual(released, ['r1']);
  // 隔离：别家插件的同一编号在别家的表里
  const other = new HandleTable<string>({ pluginId: '@xfy2412/other' });
  other.open('fd', 'x', () => {}, { id: '3' });
  assert.equal(other.peek('fd', '3')?.resource, 'x');
  assert.equal(new HandleTable<string>({ pluginId: '@xfy2412/third' }).peek('fd', '3'), undefined);
});

test('releaseAll（卸载强回收）：返回没被释放的句柄，且各自恰好释放一次', () => {
  const { table, released, events, open } = makeTable();
  const a = open('hash', 'H1');
  const b = open('hmac', 'H2');
  const c = open('hash', 'H3');
  table.closeById(b.id); // 插件自己释放过一个
  const leaked = table.releaseAll();
  assert.deepEqual([...leaked].sort(), [a.id, c.id].sort(), 'leaked 应当是"还开着的那两条"');
  assert.deepEqual([...released].sort(), ['H1', 'H2', 'H3'], '每条真资源恰好释放一次');
  assert.equal(table.count('hash'), 0);
  assert.equal(table.count('hmac'), 0);
  // 幂等：再调一次什么都不做
  assert.deepEqual(table.releaseAll(), []);
  assert.ok(events.filter((e) => e === 'release:hash').length >= 1, '强回收要留事件（审计靠它）');
});

test('release 抛异常不会让 releaseAll 半途而废（卸载路径不许被一条坏资源带崩）', () => {
  const table = new HandleTable<string>({ pluginId: '@xfy2412/handles-test' });
  const done: string[] = [];
  table.open('hash', 'bad', () => {
    throw new Error('boom');
  });
  table.open('hash', 'good', () => done.push('good'));
  const leaked = table.releaseAll();
  assert.equal(leaked.length, 2);
  assert.deepEqual(done, ['good'], '后面的句柄照样要释放');
  assert.equal(table.count('hash'), 0);
});
