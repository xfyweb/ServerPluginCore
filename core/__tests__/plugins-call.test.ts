// 跨插件调用 `plugins.call`（docs/events-and-hooks-design.md §3.7）
//
// 这一批要钉死的是**授权面与投递链**，不是端点内部的业务：
//   · 四条门槛（声明依赖 / `call` 里请求过该 path / 管理员逐点授予 / 对端 `callable` 含 plugins）；
//   · 锚定解析：代码里写**句柄**，判定与审计用**实际引用**（包内字节不含本地源名）；
//   · 投递：不排队、忙时有界重试、崩溃/卸载不重试、深度上限、超时不返回部分结果；
//   · 审计：一次交互一条 `callId`，串起调用方、被调方、以及对端内部那些宿主调用。
//
// ⚠️ 端点 path 是**全局唯一**的（先到先得，撞车即 PLUGIN_EXPORT_INVALID），所以每个用例用各自的 path。
//
// 隔离：SPC_STATE_DIR / SPC_AUDIT_DIR 必须在**动态 import 之前**设好（core/audit.ts 的模块级常量）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-call-'));
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

const { manager } = await import('../plugin/manager.ts');
const { capabilities } = await import('../plugin/capabilities.ts');
const { SpcError } = await import('../errors.ts');
const { callPointOf } = await import('../permissions/points.ts');
const { withBusyRetry } = await import('../plugin/call-retry.ts');
const { pluginDataDir } = await import('../config.ts');
const { signPluginDir, newTestKey } = await import('./helpers/signed-plugin.ts');
import type { TestKey } from './helpers/signed-plugin.ts';

// ---------------- 夹具 ----------------

interface FixtureOpts {
  authorKey?: TestKey;
  permissions?: string[];
  exports?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
}

const id = (name: string): string => `@spc/${name}`;
const ref = (name: string): string => `local:default/@spc/${name}`;

// 审计目录要**先建好**：`core/audit.ts` 写盘失败会静默转内存缓冲（那是运行期的容错），
// 于是"目录不存在"这件事在测试里表现为"一条审计都没有"，而根因跟被测行为无关。
mkdirSync(join(TMP, 'audit'), { recursive: true });

function makePlugin(name: string, code: string, opts: FixtureOpts = {}): string {
  const dir = join(TMP, 'plugins', name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schema: 2,
    id: id(name),
    name: `Call fixture ${name}`,
    version: { code: 1, name: '0.0.1' },
    runtime: { type: 'quickjs', esm: true },
    // schema 要求 permissions 至少 1 条（无默认放行）；`fs.write.data` 是 self 档、声明即用，
    // 正好给"把结果写回自己的数据目录"这条夹具通路用
    permissions: (opts.permissions ?? ['fs.write.data']).map((n) => ({ name: n })),
    ...(opts.exports ? { exports: opts.exports } : {}),
    ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(join(dir, 'main.ts'), code, 'utf8');
  if (opts.authorKey) signPluginDir(dir, opts.authorKey);
  return dir;
}

/**
 * 依赖声明（v4：`author.pub` 必填）。
 * ⚠️ **调用面的请求写在 `call` 里，不写进 `permissions[]`** —— 这就是"声明不带源、授权带源"：
 * 包内被签名的字节里只有句柄与 path，实际引用由宿主锚定解析出来。
 */
function depOn(target: string, pub: string, opts: { as?: string; call?: string[] } = {}): Record<string, unknown> {
  return {
    plugins: [
      {
        id: id(target),
        ...(opts.as ? { as: opts.as } : {}),
        ...(opts.call ? { call: opts.call } : {}),
        author: { pub },
      },
    ],
  };
}

/** 被调方：一个回显端点（把收到的 params 与字节长度原样返回） */
const echoCode = (path: string): string => `export function init(){}
export const endpoints = {
  ${JSON.stringify(path)}: (ctx, paramsJson, bytes) => JSON.stringify({
    got: JSON.parse(paramsJson),
    bytes: bytes === undefined ? null : bytes.length,
    who: ctx.pluginId,
  }),
};`;

/** 调用方：调一次，把**结果或错误码**写进自己的数据目录（测试从宿主侧读回来） */
function callerCode(handle: string, path: string, params = '{}', bytes = false): string {
  const call = `plugins.call(${JSON.stringify(handle)}, ${JSON.stringify(path)}, ${JSON.stringify(params)}${
    bytes ? ', new Uint8Array([1,2,3,4])' : ''
  })`;
  return `import { fs, plugins } from '@host/api';
export function init() {
  try {
    fs.write('out.json', ${call});
  } catch (e) {
    fs.write('out.json', JSON.stringify({ code: e.code, params: e.params ?? null }));
  }
}`;
}

function readOut(name: string): Record<string, unknown> {
  const p = join(pluginDataDir('local:default', id(name)), 'out.json');
  assert.ok(existsSync(p), `期望 ${name} 写出 out.json，但它不在`);
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

/** 同上，但文件不存在/不是 JSON 时给 `null`（轮询用） */
function readOutOrNull(name: string): Record<string, unknown> | null {
  try {
    return readOut(name);
  } catch {
    return null;
  }
}

/** 轮询等待（带上限：**等一条永不到来的东西会把整个进程挂死** —— 工作区 AGENTS.md §2.3 的教训） */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
}

/** 审计条目（JSONL；只按需取字段） */
function auditEntries(): Record<string, unknown>[] {
  const file = join(TMP, 'audit', 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 装一对（被调方 + 调用方）；`grants` 由调用方决定给不给 */
async function pair(opts: {
  tag: string;
  path: string;
  calleeCode: string;
  callable: boolean;
  callerHandle?: string;
  callerCallPath?: string;
  grants?: boolean;
  callerBytes?: boolean;
}): Promise<{ callee: string; caller: string }> {
  const bKey = newTestKey();
  const calleeName = `${opts.tag}-b`;
  const callerName = `${opts.tag}-a`;
  await manager.install(
    makePlugin(calleeName, opts.calleeCode, {
      authorKey: bKey,
      exports: {
        endpoints: [{ path: opts.path, ...(opts.callable ? { callable: ['panel', 'plugins'] } : {}) }],
      },
    }),
  );
  const caller = makePlugin(
    callerName,
    callerCode(opts.callerHandle ?? 'b', opts.callerCallPath ?? opts.path, '{}', opts.callerBytes),
    {
      authorKey: newTestKey(),
      dependencies: depOn(calleeName, bKey.pub, { as: 'b', call: [opts.path] }),
    },
  );
  await manager.install(caller, opts.grants === false ? {} : { grants: [callPointOf(ref(calleeName), opts.path)] });
  return { callee: calleeName, caller: callerName };
}

after(async () => {
  await manager.stopAll('shutdown');
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------- ① 装载期：声明 ⟺ 实现 ----------------

test('声明了端点却没有实现 ⇒ 装载失败，且能力登记回滚（不登记一个"谁都调不通"的端点）', async () => {
  const dir = makePlugin('missing-impl', `export function init(){}`, {
    exports: { endpoints: [{ path: '/api/missing-impl/one' }] },
  });
  let caught: unknown;
  try {
    await manager.install(dir);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof SpcError, '应当装载失败');
  assert.equal((caught as InstanceType<typeof SpcError>).code, 'PLUGIN_EXPORT_INVALID');
  assert.equal((caught as InstanceType<typeof SpcError>).params.kind, 'endpoint-handler');
  // 回滚：capabilities 里不许留下这个端点（否则临时表会派生出它的调用点）
  assert.equal(capabilities.snapshot().endpoints.filter((e) => e.ref === ref('missing-impl')).length, 0);
});

test('两条依赖指向同一个 id 而都没写 `as` ⇒ 清单校验期就拒（代码里的句柄必须无歧义）', async () => {
  const key = newTestKey();
  const dir = makePlugin('dup-handle', `export function init(){}`, {
    authorKey: key,
    dependencies: {
      plugins: [
        { id: '@spc/other', author: { pub: key.pub } },
        { id: '@spc/other', author: { pub: key.pub } },
      ],
    },
  });
  let caught: unknown;
  try {
    await manager.install(dir);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof SpcError, '应当被拒');
  assert.equal((caught as InstanceType<typeof SpcError>).code, 'PLUGIN_MANIFEST_INVALID');
  assert.match(String((caught as InstanceType<typeof SpcError>).params.detail), /handle must be unique/);
});

// ---------------- ② 四条门槛 ----------------

test('门槛①②：句柄不在依赖表 / path 没在 `call` 里 ⇒ 各自的码（不是笼统的 PERMISSION_DENIED）', async () => {
  const bKey = newTestKey();
  await manager.install(
    makePlugin('gate-b', echoCode('/api/gate-b/echo'), {
      authorKey: bKey,
      exports: { endpoints: [{ path: '/api/gate-b/echo', callable: ['panel', 'plugins'] }] },
    }),
  );
  // 句柄写错（清单里叫 'b'）
  const wrongHandle = makePlugin('gate-handle', callerCode('nope', '/api/gate-b/echo'), {
    authorKey: newTestKey(),
    dependencies: depOn('gate-b', bKey.pub, { as: 'b', call: ['/api/gate-b/echo'] }),
  });
  await manager.install(wrongHandle);
  assert.equal(readOut('gate-handle').code, 'PLUGIN_CALL_HANDLE_UNKNOWN');

  // path 没在 `call` 里请求过
  const wrongPath = makePlugin('gate-path', callerCode('b', '/api/gate-b/other'), {
    authorKey: newTestKey(),
    dependencies: depOn('gate-b', bKey.pub, { as: 'b', call: ['/api/gate-b/echo'] }),
  });
  await manager.install(wrongPath);
  assert.equal(readOut('gate-path').code, 'PLUGIN_CALL_PATH_NOT_DECLARED');
});

test('门槛④：端点没声明 `callable` 含 plugins ⇒ PLUGIN_CALL_NOT_CALLABLE（缺省只有 panel）', async () => {
  const { caller } = await pair({
    tag: 'panelonly',
    path: '/api/panelonly/echo',
    calleeCode: echoCode('/api/panelonly/echo'),
    callable: false,
  });
  assert.equal(readOut(caller).code, 'PLUGIN_CALL_NOT_CALLABLE');
});

test('门槛③：管理员没授予那个带源的点 ⇒ PERMISSION_DENIED（reason=NOT_GRANTED）', async () => {
  const { caller } = await pair({
    tag: 'denied',
    path: '/api/denied/echo',
    calleeCode: echoCode('/api/denied/echo'),
    callable: true,
    grants: false,
  });
  const out = readOut(caller);
  assert.equal(out.code, 'PERMISSION_DENIED');
  assert.equal((out.params as Record<string, string>).reason, 'NOT_GRANTED');
  assert.equal(
    (out.params as Record<string, string>).permission,
    callPointOf(ref('denied-b'), '/api/denied/echo'),
  );
});

// ---------------- ③ 成功路径：信封、参数、字节、锚定 ----------------

test('调用成功：拿到 JSON 文本信封（callee/callId/path/result），参数与字节原样送到对端', async () => {
  const bKey = newTestKey();
  await manager.install(
    makePlugin('ok-b', echoCode('/api/ok/echo'), {
      authorKey: bKey,
      exports: { endpoints: [{ path: '/api/ok/echo', callable: ['panel', 'plugins'] }] },
    }),
  );
  const caller = makePlugin('ok-a', callerCode('b', '/api/ok/echo', JSON.stringify({ n: 7 }), true), {
    authorKey: newTestKey(),
    dependencies: depOn('ok-b', bKey.pub, { as: 'b', call: ['/api/ok/echo'] }),
  });
  await manager.install(caller, { grants: [callPointOf(ref('ok-b'), '/api/ok/echo')] });

  const env = readOut('ok-a');
  assert.equal(env.ok, true, `期望成功信封，实际：${JSON.stringify(env)}`);
  assert.equal(typeof env.callId, 'string');
  assert.equal(env.path, '/api/ok/echo');
  assert.deepEqual(env.callee, { origin: 'local:default', id: id('ok-b'), version: '0.0.1' });
  // `bytes: 4` 证明字节槽真的过了桥（没声明 binaryArgs 的话 ArrayBuffer 会被 JSON 化成 "{}"）
  assert.deepEqual(env.result, { got: { n: 7 }, bytes: 4, who: id('ok-b') });
});

// ---------------- ④ 失败语义 ----------------

test('对端返回值不是合法 JSON 文本 ⇒ PLUGIN_CALL_BAD_RESULT（不把半成品当成功）', async () => {
  const { caller } = await pair({
    tag: 'badjson',
    path: '/api/badjson/echo',
    calleeCode: `export function init(){}
export const endpoints = { '/api/badjson/echo': () => 'not json at all' };`,
    callable: true,
  });
  assert.equal(readOut(caller).code, 'PLUGIN_CALL_BAD_RESULT');
});

test('对端处理器返回非字符串 ⇒ 同样 PLUGIN_CALL_BAD_RESULT（reason 区分）', async () => {
  const { caller } = await pair({
    tag: 'badtype',
    path: '/api/badtype/echo',
    calleeCode: `export function init(){}
export const endpoints = { '/api/badtype/echo': () => 42 };`,
    callable: true,
  });
  const out = readOut(caller);
  assert.equal(out.code, 'PLUGIN_CALL_BAD_RESULT');
  assert.equal((out.params as Record<string, string>).reason, 'result-not-text');
});

test('对端处理器抛错 ⇒ **它自己的码**原样回传（不是笼统的 PLUGIN_CALL_FAILED）', async () => {
  const { caller } = await pair({
    tag: 'throws',
    path: '/api/throws/echo',
    calleeCode: `export function init(){}
export const endpoints = { '/api/throws/echo': () => { const e = new Error('nope'); e.code = 'MY_OWN_CODE'; throw e; } };`,
    callable: true,
  });
  assert.equal(readOut(caller).code, 'MY_OWN_CODE');
});

test('对端超时（自己跑不完）⇒ PLUGIN_CALL_TIMEOUT，且不返回部分结果、对端不被判死', async () => {
  const bKey = newTestKey();
  await manager.install(
    makePlugin(
      'slow-b',
      `export function init(){}
export const endpoints = { '/api/slow/echo': () => { for(;;){} } };`,
      {
        authorKey: bKey,
        exports: { endpoints: [{ path: '/api/slow/echo', callable: ['panel', 'plugins'] }] },
      },
    ),
  );
  const caller = makePlugin('slow-a', callerCode('b', '/api/slow/echo'), {
    authorKey: newTestKey(),
    dependencies: depOn('slow-b', bKey.pub, { as: 'b', call: ['/api/slow/echo'] }),
  });
  process.env.SPC_PLUGIN_CALL_TIMEOUT_MS = '300';
  try {
    await manager.install(caller, { grants: [callPointOf(ref('slow-b'), '/api/slow/echo')] });
  } finally {
    delete process.env.SPC_PLUGIN_CALL_TIMEOUT_MS;
  }
  assert.equal(readOut('slow-a').code, 'PLUGIN_CALL_TIMEOUT');
  // 一次超时不该把对端判死：它仍在跑
  assert.equal(manager.status(id('slow-b')).state, 'running');
});

test('对端不在跑（重载失败 ⇒ failed）⇒ PLUGIN_CALL_TARGET_UNAVAILABLE，且不重试', async () => {
  const bKey = newTestKey();
  const B_PATH = '/api/gone/echo';
  // B 的 init 在"数据目录里有 boom 文件"时抛错 —— 用来制造"B 掉线、A 仍在跑"的真实情形
  const bCode = `import { fs } from '@host/api';
export function init() {
  let boom = false;
  try { fs.read('boom'); boom = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (boom) throw new Error('boom on purpose');
}
export const endpoints = { ${JSON.stringify(B_PATH)}: () => JSON.stringify({ ok: 1 }) };`;
  await manager.install(
    makePlugin('gone-b', bCode, {
      authorKey: bKey,
      exports: { endpoints: [{ path: B_PATH, callable: ['panel', 'plugins'] }] },
    }),
  );
  // 调用方**用定时器反复调**：B 掉线后 A 没法 reload（依赖不满足），所以只能让它自己继续跑着调
  const aCode = `import { fs, plugins, timers } from '@host/api';
export function init() {
  timers.every(100, () => {
    try { fs.write('out.json', plugins.call('b', ${JSON.stringify(B_PATH)}, '{}')); }
    catch (e) { fs.write('out.json', JSON.stringify({ code: e.code, params: e.params ?? null })); }
  });
}`;
  const caller = makePlugin('gone-a', aCode, {
    authorKey: newTestKey(),
    permissions: ['fs.write.data', 'timers.schedule'],
    dependencies: depOn('gone-b', bKey.pub, { as: 'b', call: [B_PATH] }),
  });
  await manager.install(caller, { grants: [callPointOf(ref('gone-b'), B_PATH)] });
  await waitFor(() => readOutOrNull('gone-a')?.ok === true, '第一次调用成功');

  // 让 B 掉线：写 boom 标记 → reload 失败（reload 会把失败抛出来，这里正要看那个失败）
  writeFileSync(join(pluginDataDir('local:default', id('gone-b')), 'boom'), 'x', 'utf8');
  await manager.reload(id('gone-b')).catch(() => undefined);
  assert.notEqual(manager.status(id('gone-b')).state, 'running');

  // ⚠️ 掉线后调用方看到的是 **PERMISSION_DENIED / UNKNOWN_POINT**，不是 TARGET_UNAVAILABLE：
  // 对端一卸载，它登记的能力就被撤了 ⇒ 那个动态点**当场消失** ⇒ 判定链第 1 步就拒（fail-closed）。
  // 这正是 api-contract §6.1 写的那条（"点会消失"与"授权还在"分开看）。
  // `PLUGIN_CALL_TARGET_UNAVAILABLE` 是留给"记录还在、沙箱不在"的防御性分支（例如主题包声明了端点）。
  await waitFor(
    () => readOutOrNull('gone-a')?.code === 'PERMISSION_DENIED',
    'B 掉线后的那次调用被拒',
  );
  const out = readOut('gone-a');
  assert.equal((out.params as Record<string, string>).reason, 'UNKNOWN_POINT');
});

// ---------------- ⑤ 重入 / 深度 ----------------
//
// ⚠️ **为什么没有"A→B→A 回环"的集成用例**：调用图 ⊆ 依赖图（X 要调 Y 就必须声明依赖 Y），
// 而互相依赖的两个插件在装载期就被判成依赖环（`PLUGIN_DEPENDENCY_CYCLE`，都起不来）⇒
// 回环在真实系统里**声明不出来**。"第二次进同一个插件必然撞上忙"于是只剩"对端自己的定时器/监视
// 回调正在飞"这一条路径 —— 那条要造出可控的时间窗，写成集成用例就是时序赌博。
// 所以：**重试策略**用下面的单元用例判别（`core/plugin/call-retry.ts`），**忙的码要原样透传给调用方**
// 由上面"对端处理器抛错 ⇒ 它自己的码原样回传"那条覆盖（PLUGIN_BUSY 走的是同一条路）。

test('重试策略：两次忙之后成功 ⇒ 试 3 次、等 150ms（50+100）', async () => {
  let calls = 0;
  const outcome = await withBusyRetry(async () => {
    calls += 1;
    if (calls < 3) throw new SpcError('PLUGIN_BUSY', { busyWith: 'timers.tick' });
    return 'ok';
  });
  assert.equal(outcome.value, 'ok');
  assert.equal(outcome.attempts, 3);
  assert.equal(outcome.waitedMs, 150);
});

test('重试策略：一直忙 ⇒ 用尽 3 次后抛 PLUGIN_BUSY（不无限等、不排队）', async () => {
  let calls = 0;
  let caught: unknown;
  try {
    await withBusyRetry(async () => {
      calls += 1;
      throw new SpcError('PLUGIN_BUSY', { busyWith: 'plugins.call' });
    });
  } catch (err) {
    caught = err;
  }
  assert.equal(calls, 3, '恰好 3 次尝试（含首次）');
  assert.ok(caught instanceof SpcError && caught.code === 'PLUGIN_BUSY');
});

test('重试策略：**非忙**错误一次都不重试（崩溃/卸载/拒绝/超时都不该反复去叫）', async () => {
  for (const code of ['PLUGIN_CALL_TARGET_UNAVAILABLE', 'PLUGIN_CALL_TIMEOUT', 'PERMISSION_DENIED']) {
    let calls = 0;
    let caught: unknown;
    try {
      await withBusyRetry(async () => {
        calls += 1;
        throw new SpcError(code, {});
      });
    } catch (err) {
      caught = err;
    }
    assert.equal(calls, 1, `${code} 不该重试`);
    assert.ok(caught instanceof SpcError && caught.code === code);
  }
});

test('重试策略：等待预算封顶（deadline 已过 ⇒ 立刻放弃，不睡那 50ms）', async () => {
  let slept = 0;
  const t0 = 1_000_000;
  let now = t0;
  const outcome = withBusyRetry(
    async () => {
      now += 5; // 每次尝试"花掉"5ms
      throw new SpcError('PLUGIN_BUSY', { busyWith: 'x' });
    },
    {
      now: () => now,
      deadline: t0 + 1, // 已经越过
      sleep: async (ms) => {
        slept += ms;
      },
    },
  );
  await assert.rejects(() => outcome, (err: unknown) => (err as { code?: string }).code === 'PLUGIN_BUSY');
  assert.equal(slept, 0, '越过截止时刻就不该再等');
});

test('嵌套深度上限（SPC_PLUGIN_MAX_CALL_DEPTH=1）⇒ 第二层调用被拒', async () => {
  const cKey = newTestKey();
  const bKey = newTestKey();
  const C_PATH = '/api/depth-c/leaf';
  const B_PATH = '/api/depth-b/echo';
  await manager.install(
    makePlugin('depth-c', `export function init(){}
export const endpoints = { ${JSON.stringify(C_PATH)}: () => JSON.stringify({ leaf: true }) };`, {
      authorKey: cKey,
      exports: { endpoints: [{ path: C_PATH, callable: ['panel', 'plugins'] }] },
    }),
  );
  const bCode = `import { plugins } from '@host/api';
export function init(){}
export const endpoints = {
  ${JSON.stringify(B_PATH)}: () => plugins.call('c', ${JSON.stringify(C_PATH)}, '{}'),
};`;
  await manager.install(
    makePlugin('depth-b', bCode, {
      authorKey: bKey,
      exports: { endpoints: [{ path: B_PATH, callable: ['panel', 'plugins'] }] },
      dependencies: depOn('depth-c', cKey.pub, { as: 'c', call: [C_PATH] }),
    }),
    { grants: [callPointOf(ref('depth-c'), C_PATH)] },
  );
  const caller = makePlugin('depth-a', callerCode('b', B_PATH), {
    authorKey: newTestKey(),
    dependencies: depOn('depth-b', bKey.pub, { as: 'b', call: [B_PATH] }),
  });
  process.env.SPC_PLUGIN_MAX_CALL_DEPTH = '1';
  try {
    await manager.install(caller, { grants: [callPointOf(ref('depth-b'), B_PATH)] });
  } finally {
    delete process.env.SPC_PLUGIN_MAX_CALL_DEPTH;
  }
  // A→B 是第 1 层（放行），B→C 是第 2 层（超限）⇒ 错误从 B 的端点原样冒到 A
  assert.equal(readOut('depth-a').code, 'PLUGIN_CALL_DEPTH_EXCEEDED');
});

// ---------------- ⑥ 审计串联 ----------------

test('审计：一次调用一条 callId，串起调用方、被调方与对端内部那些宿主调用', async () => {
  const bKey = newTestKey();
  const B_PATH = '/api/audit/echo';
  // B 的端点内部做一次 kv 写（那条审计是 hostApi 写的 —— 它必须也带上同一个 callId）
  const bCode = `import { kv } from '@host/api';
export function init(){}
export const endpoints = {
  ${JSON.stringify(B_PATH)}: () => { kv.set('called', 1); return JSON.stringify({ ok: 1 }); },
};`;
  await manager.install(
    makePlugin('audit-b', bCode, {
      authorKey: bKey,
      permissions: ['fs.write.data', 'kv.write'],
      exports: { endpoints: [{ path: B_PATH, callable: ['panel', 'plugins'] }] },
    }),
  );
  const caller = makePlugin('audit-a', callerCode('b', B_PATH), {
    authorKey: newTestKey(),
    dependencies: depOn('audit-b', bKey.pub, { as: 'b', call: [B_PATH] }),
  });
  await manager.install(caller, { grants: [callPointOf(ref('audit-b'), B_PATH)] });

  const callId = readOut('audit-a').callId as string;
  assert.equal(typeof callId, 'string');
  const related = auditEntries().filter((e) => e.callId === callId);
  const methods = related.map((e) => e.method);
  assert.ok(
    methods.includes('plugins.call'),
    `期望有 plugins.call 条目，callId=${callId}，全部条目：${JSON.stringify(
      auditEntries().map((e) => ({ m: e.method, ref: e.ref, callId: e.callId })),
    )}`,
  );
  assert.ok(methods.includes('kv.set'), `对端内部的宿主调用也要带同一个 callId，实际 ${methods.join(',')}`);
  // 调用方那一条（ref=A）带 attempts/waitedMs；被调方那一条 ref=B
  assert.ok(related.some((e) => e.ref === ref('audit-a') && e.attempts === 1 && e.waitedMs === 0));
  assert.ok(related.some((e) => e.ref === ref('audit-b') && e.method === 'plugins.call'));
});
