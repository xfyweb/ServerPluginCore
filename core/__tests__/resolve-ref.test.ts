// 管理面**引用解析器**的用例（`core/plugin/records.ts` 的 `resolveRecord`）。
//
// 判据（2026-10-14 维护者提："只要没有歧义，只传插件 ID 都可以"）：
//   ① 三级阶梯：完整引用 → 裸 `@作者/名字` → 裸**名字**；
//   ② 每一级**必须唯一**，不唯一就报 `PLUGIN_REF_AMBIGUOUS`（带候选）—— **绝不挑一个**：
//      挑错就是在动另一个插件的数据；
//   ③ 形状不对的输入不能被"猜"到（`local:default/x` 这种既不是合法 id 也不是合法名字）；
//   ④ 只认标识符，**不认** manifest 里的展示名。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveRecord, pluginRef } = await import('../plugin/records.ts');
const { SpcError } = await import('../errors.ts');

/** 造一条够用的记录（只填解析器会碰的字段；其余给安全默认） */
function rec(origin: string, id: string): unknown {
  return {
    origin,
    id,
    dir: `/tmp/${origin}/${id}`,
    version: { code: 1, name: '0.0.1' },
    enabled: true,
    grants: [],
    capabilities: [],
    configPath: '',
    state: 'running',
    installedAt: new Date(0).toISOString(),
    lastError: null,
    restartAttempts: 0,
    authorFingerprint: null,
    signedBy: null,
    hosted: false,
  };
}

const file = (records: unknown[]) => ({ pluginsSchema: 1, plugins: records }) as never;

test('① 完整引用：精确匹配（最具体的一级）', () => {
  const f = file([rec('local:default', '@a/one'), rec('local:other', '@a/one')]);
  assert.equal(pluginRef(resolveRecord(f, 'local:other/@a/one')!), 'local:other/@a/one');
});

test('① 完整引用优先于裸名字：即使名字也能唯一匹配，给的完整引用说了算', () => {
  const f = file([rec('local:default', '@a/one'), rec('local:other', '@b/one')]);
  assert.equal(pluginRef(resolveRecord(f, 'local:default/@a/one')!), 'local:default/@a/one');
});

test('② 裸 id `@作者/名字`：跨来源唯一时可用（既有行为）', () => {
  const f = file([rec('local:default', '@a/one'), rec('local:other', '@b/two')]);
  assert.equal(pluginRef(resolveRecord(f, '@a/one')!), 'local:default/@a/one');
});

test('③ 裸**名字**：跨作者与来源唯一时可用（这次新加的）', () => {
  const f = file([rec('local:default', '@xfy2412/counter'), rec('local:default', '@xfy2412/hello')]);
  assert.equal(pluginRef(resolveRecord(f, 'counter')!), 'local:default/@xfy2412/counter');
  assert.equal(pluginRef(resolveRecord(f, 'hello')!), 'local:default/@xfy2412/hello');
  // 前后空白也认（终端里手打常带空格）
  assert.equal(pluginRef(resolveRecord(f, '  counter  ')!), 'local:default/@xfy2412/counter');
});

test('② 裸 id 有歧义（同 id 两个来源）⇒ 报错并给候选，**不挑一个**', () => {
  const f = file([rec('local:default', '@a/one'), rec('local:other', '@a/one')]);
  assert.throws(
    () => resolveRecord(f, '@a/one'),
    (e: unknown) => {
      assert.ok(e instanceof SpcError);
      assert.equal((e as { code: string }).code, 'PLUGIN_REF_AMBIGUOUS');
      const params = (e as { params?: { refs?: string; form?: string } }).params ?? {};
      assert.equal(params.form, 'id', '要告诉渲染层"该写得更具体成什么样"');
      assert.match(String(params.refs), /local:default\/@a\/one/);
      assert.match(String(params.refs), /local:other\/@a\/one/);
      return true;
    },
  );
});

test('③ 裸名字有歧义（不同作者同名 / 不同来源同名）⇒ 同样报错', () => {
  const f = file([rec('local:default', '@a/dup'), rec('local:default', '@b/dup')]);
  assert.throws(
    () => resolveRecord(f, 'dup'),
    (e: unknown) => {
      const params = (e as { params?: { refs?: string; form?: string } }).params ?? {};
      assert.equal(params.form, 'name');
      assert.match(String(params.refs), /@a\/dup/);
      assert.match(String(params.refs), /@b\/dup/);
      return true;
    },
  );
});

test('④ 形状不对的输入不会被猜到：既不是 id 也不是名字 ⇒ undefined（上层报 NOT_FOUND）', () => {
  const f = file([rec('local:default', '@a/one')]);
  assert.equal(resolveRecord(f, 'local:default/one'), undefined, '来源+名字不是支持的缩写形式');
  assert.equal(resolveRecord(f, '@a/One'), undefined, '大写不是合法 id 段');
  assert.equal(resolveRecord(f, 'one two'), undefined, '带空格不是合法名字');
  assert.equal(resolveRecord(f, 'nope'), undefined, '不存在的名字');
});

test('④ 只认标识符，不认 manifest 的展示名（展示名可以重名/带空格/中文）', () => {
  // 展示名不在记录里（在 manifest 里）⇒ 解析器拿不到也不该去猜
  const f = file([rec('local:default', '@a/one')]);
  assert.equal(resolveRecord(f, '一'), undefined);
});
