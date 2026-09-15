// 生命周期与装载器测试（docs/plugin-lifecycle-design.md §11 的 17 条 + 记录/授权/冲突/主题）
//
// 隔离：SPC_STATE_DIR / SPC_AUDIT_DIR 必须在**动态 import 之前**设好
// （core/audit.ts 的 AUDIT_DIR 是模块级常量，见其注释）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-lifecycle-'));
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

const { manager } = await import('../plugin/manager.ts');
const { capabilities } = await import('../plugin/capabilities.ts');
const { SpcError } = await import('../errors.ts');
const { validatePluginConfig, loadPluginConfig, savePluginConfig } = await import('../plugin/config.ts');
const { loadRecords, validateRecord } = await import('../plugin/records.ts');

// ---------------- 夹具 ----------------

interface FixtureOpts {
  permissions?: string[];
  configSchema?: Record<string, unknown>;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  entry?: string;
}

/** 造一个能力插件目录（manifest 校验通过；插件代码写在 main.ts，entry 只影响 manifest） */
function makePlugin(name: string, code: string, opts: FixtureOpts = {}): string {
  const dir = join(TMP, 'plugins', name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schema: 2,
    id: `@spc/${name}`,
    name: `Fixture ${name}`,
    version: { code: 1, name: '0.0.1' },
    runtime: { type: 'quickjs', esm: true },
    permissions: (opts.permissions ?? ['fs.write.data', 'fs.read.data']).map((n) => ({ name: n })),
    ...(opts.configSchema ? { configSchema: opts.configSchema } : {}),
    ...(opts.exports ? { exports: opts.exports } : {}),
    ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
    ...(opts.entry ? { entry: opts.entry } : {}),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(join(dir, 'main.ts'), code, 'utf8');
  return dir;
}

/** 造一个主题包目录（无 runtime/permissions，入口 theme.json） */
function makeTheme(name: string, withEntry = true): string {
  const dir = join(TMP, 'plugins', name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schema: 2,
    type: 'theme',
    id: `@spc/${name}`,
    name: `Theme ${name}`,
    version: { code: 1, name: '0.1.0' },
    theme: 'theme.json',
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (withEntry) {
    writeFileSync(
      join(dir, 'theme.json'),
      JSON.stringify({ themeSchema: 1, id: `@spc/${name}`, name, tokens: { 'color.bg': '#000' } }),
      'utf8',
    );
  }
  return dir;
}

const id = (name: string) => `@spc/${name}`;
const sanitized = (pluginId: string) => pluginId.replace(/^@/, '').replace(/\//g, '__');
const dataPath = (pluginId: string, file: string) =>
  join(TMP, 'data', 'plugins', sanitized(pluginId), file);

function readData(pluginId: string, file: string): string {
  return readFileSync(dataPath(pluginId, file), 'utf8');
}

/** 读审计条目（只读 JSONL，不解析业务语义） */
function auditEntries(): Record<string, unknown>[] {
  const file = join(TMP, 'audit', 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 临时覆盖环境变量跑一段逻辑（配置在每次 loadConfig() 时重新求值，所以运行期生效） */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * 断言被拒，并核验英文码。
 * 注意 `assert.rejects(fn)` 不会捕获 **同步** 抛错（manager.status 这类同步方法会直接冒泡），
 * 所以这里自己包一层 try/catch —— 同步抛与异步拒一视同仁。
 */
async function rejects(fn: () => unknown, code: string): Promise<void> {
  let caught: unknown;
  let thrown = false;
  try {
    await fn();
  } catch (err) {
    caught = err;
    thrown = true;
  }
  assert.ok(thrown, `期望被拒（${code}），但调用成功了`);
  assert.ok(caught instanceof SpcError, `期望 SpcError，实际 ${String(caught)}`);
  assert.equal((caught as InstanceType<typeof SpcError>).code, code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(() => {
  mkdirSync(join(TMP, 'plugins'), { recursive: true });
  // 审计目录必须存在：audit() 写盘失败会退化成内存缓冲（审计链路"看起来正常但读不到"）
  mkdirSync(join(TMP, 'audit'), { recursive: true });
});

after(async () => {
  await manager.stopAll('shutdown');
  manager.resetMemory();
  // Windows 上沙箱句柄若未释放会 EPERM：这里只做尽力清理，失败不影响测试结论
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------- 1/2 状态机 ----------------

test('状态机：install → loading/running → stopAll → stopped；记录里的 state 同步', async () => {
  const dir = makePlugin('sm-basic', `export function init(ctx){ ctx.logger.info('up'); }`);
  const view = await manager.install(dir);
  assert.equal(view.id, id('sm-basic'));
  assert.equal(view.state, 'running');
  assert.equal(view.enabled, true);
  // 记录（磁盘）里的 state 必须同步——CLI/HTTP 读的就是它
  const rec = loadRecords().plugins.find((p) => p.id === id('sm-basic'));
  assert.equal(rec?.state, 'running');

  await manager.stopAll('shutdown');
  assert.equal(manager.status(id('sm-basic')).state, 'stopped');
});

test('状态机：非法迁移被拒（未知插件 / 已禁用 reload / 未知 uninstall）', async () => {
  await rejects(() => manager.reload(id('nope')), 'PLUGIN_NOT_FOUND');
  await rejects(() => manager.enable(id('nope')), 'PLUGIN_NOT_FOUND');
  await rejects(() => manager.uninstall(id('nope')), 'PLUGIN_NOT_FOUND');

  const dir = makePlugin('sm-disabled', `export function init(){}`);
  await manager.install(dir);
  await manager.disable(id('sm-disabled'));
  assert.equal(manager.status(id('sm-disabled')).state, 'disabled');
  await rejects(() => manager.reload(id('sm-disabled')), 'PLUGIN_DISABLED');
  // enable 把它拉回来
  assert.equal((await manager.enable(id('sm-disabled'))).state, 'running');
  await manager.disable(id('sm-disabled'));
});

// ---------------- 3/4 导出契约 ----------------

test('导出契约：缺 init → PLUGIN_NO_ENTRY（fail-closed）', async () => {
  const dir = makePlugin('no-init', `export function start(){}`);
  await rejects(() => manager.install(dir), 'PLUGIN_NO_ENTRY');
  // 记录已经写了（先写记录再装载），状态是 failed —— 管理面看得到这个坏插件
  const view = manager.status(id('no-init'));
  assert.equal(view.state, 'failed');
  assert.equal(view.lastError?.code, 'PLUGIN_NO_ENTRY');
});

test('导出契约：入口文件不存在 → PLUGIN_NO_ENTRY；非函数导出 → PLUGIN_NO_ENTRY', async () => {
  const dir = makePlugin('entry-missing', `export function init(){}`, { entry: 'nope.ts' });
  await rejects(() => manager.install(dir), 'PLUGIN_NO_ENTRY');

  const dir2 = makePlugin('init-not-fn', `export const init = 42;`);
  await rejects(() => manager.install(dir2), 'PLUGIN_NO_ENTRY');
});

// ---------------- 5/6 主题包豁免 ----------------

test('主题包：无 init、不建沙箱也能装载成功，且登记 theme: 能力', async () => {
  const dir = makeTheme('theme-ok');
  const view = await manager.install(dir);
  assert.equal(view.type, 'theme');
  assert.equal(view.state, 'running');
  assert.deepEqual(view.capabilities, ['theme:theme.json']);
  assert.equal(capabilities.snapshot().themes.length, 1);
  await manager.disable(id('theme-ok'));
});

test('主题包：theme.json 缺失 → PLUGIN_NO_ENTRY', async () => {
  const dir = makeTheme('theme-broken', false);
  await rejects(() => manager.install(dir), 'PLUGIN_NO_ENTRY');
});

// ---------------- 7/8 失败语义与能力回滚 ----------------

test('init 抛错 → PLUGIN_INIT_FAILED，核心不挂，状态 failed', async () => {
  const dir = makePlugin(
    'init-throws',
    `export function init(){ throw new Error('boom'); }`,
    { exports: { routes: [{ path: '/init-throws', title: 'x' }] } },
  );
  await rejects(() => manager.install(dir), 'PLUGIN_INIT_FAILED');
  const view = manager.status(id('init-throws'));
  assert.equal(view.state, 'failed');
  // 能力登记必须已回滚（不留半装载状态）
  assert.deepEqual(view.capabilities, []);
  assert.equal(capabilities.snapshot().routes.filter((r) => r.pluginId === id('init-throws')).length, 0);
});

test('start 抛错 → PLUGIN_START_FAILED，能力登记回滚', async () => {
  const dir = makePlugin(
    'start-throws',
    `export function init(){}
     export function start(){ throw new Error('nope'); }`,
    { exports: { webApis: [{ path: '/api/start-throws' }] } },
  );
  await rejects(() => manager.install(dir), 'PLUGIN_START_FAILED');
  assert.equal(manager.status(id('start-throws')).state, 'failed');
  assert.equal(capabilities.snapshot().webApis.filter((w) => w.pluginId === id('start-throws')).length, 0);
});

// ---------------- 9/10 CPU 中断 ----------------

test('死循环 → PLUGIN_INIT_TIMEOUT（300ms 内中断），进程存活', async () => {
  const dir = makePlugin('loop', `export function init(){ while (true) {} }`);
  await withEnv({ SPC_PLUGIN_INIT_TIMEOUT_MS: '300' }, async () => {
    const started = Date.now();
    await rejects(() => manager.install(dir), 'PLUGIN_INIT_TIMEOUT');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `中断太慢：${elapsed}ms`);
  });
  // 核心还活着：后续操作正常
  assert.equal(manager.status(id('loop')).state, 'failed');
});

test('灾难性正则回溯同样被中断 → PLUGIN_INIT_TIMEOUT', async () => {
  // 关键：必须有**匹配失败的尾巴**（`(a+)+$` 对全 a 串会立即命中，不触发回溯）
  const dir = makePlugin(
    'redos',
    `export function init(){ new RegExp('(a+)+$').test('a'.repeat(40) + '!'); }`,
  );
  await withEnv({ SPC_PLUGIN_INIT_TIMEOUT_MS: '300' }, async () => {
    await rejects(() => manager.install(dir), 'PLUGIN_INIT_TIMEOUT');
  });
});

// ---------------- 11/12 内存与栈 ----------------

test('内存超限 → PLUGIN_MEMORY_LIMIT（InternalError: out of memory）', async () => {
  // 用**一次**超大分配，而不是"碎分配 + 累积"：后者会在限额边缘反复触发 GC，
  // 把 CPU deadline 先耗掉，于是报成 TIMEOUT —— 两条防线被混淆，测试就失去了判别力。
  const dir = makePlugin(
    'oom',
    `export function init(){ const s = 'x'.repeat(10 * 1024 * 1024); if (s.length === 0) throw new Error('unreachable'); }`,
  );
  await withEnv({ SPC_PLUGIN_MEMORY_LIMIT: String(4 * 1024 * 1024) }, async () => {
    await rejects(() => manager.install(dir), 'PLUGIN_MEMORY_LIMIT');
  });
});

test('栈超限 → PLUGIN_STACK_LIMIT（深递归被拦）', async () => {
  const dir = makePlugin(
    'stack',
    `function f(n){ return f(n + 1); }
     export function init(){ f(0); }`,
  );
  await withEnv({ SPC_PLUGIN_MAX_STACK_BYTES: String(128 * 1024) }, async () => {
    await rejects(() => manager.install(dir), 'PLUGIN_STACK_LIMIT');
  });
});

// ---------------- 13/14 job 泵 ----------------

test('未回收的异步任务 → PLUGIN_JOB_PENDING（永不 settle 的 await）', async () => {
  const dir = makePlugin(
    'job-pending',
    `export async function init(){ await new Promise(() => {}); }`,
  );
  await rejects(() => manager.install(dir), 'PLUGIN_JOB_PENDING');
});

test('job 泵：async init 里 await 之后续体真的执行', async () => {
  const dir = makePlugin(
    'job-pump',
    `import { fs } from '@host/api';
     export async function init(ctx){
       await Promise.resolve();
       fs.write('after-await.txt', 'ok');
       await Promise.resolve();
       fs.write('after-await2.txt', 'ok2');
     }`,
  );
  const view = await manager.install(dir);
  assert.equal(view.state, 'running');
  assert.equal(readData(id('job-pump'), 'after-await.txt'), 'ok');
  assert.equal(readData(id('job-pump'), 'after-await2.txt'), 'ok2');
  await manager.disable(id('job-pump'));
});

// ---------------- 15/16 stop 与 dispose ----------------

test('stop 超时 → PLUGIN_STOP_TIMEOUT，但卸载继续到 stopped', async () => {
  const dir = makePlugin(
    'stop-timeout',
    `export function init(){}
     export function start(){}
     export function stop(){ while (true) {} }`,
  );
  await manager.install(dir);
  await withEnv({ SPC_PLUGIN_STOP_TIMEOUT_MS: '300' }, async () => {
    const started = Date.now();
    const view = await manager.disable(id('stop-timeout'));
    assert.equal(view.state, 'disabled');
    assert.ok(Date.now() - started < 5_000, 'stop 超时后没有及时继续卸载');
  });
});

test('dispose 不崩：抛错 / 超时 / 提前 return 三种插件反复装载卸载都不命中 GC 断言', async () => {
  const dirs = {
    thrown: makePlugin('dispose-throw', `export function init(){ throw new Error('x'); }`),
    timeout: makePlugin('dispose-timeout', `export function init(){ while (true) {} }`),
    early: makePlugin('dispose-early', `export function init(){ return; }`),
  };
  await withEnv({ SPC_PLUGIN_INIT_TIMEOUT_MS: '300' }, async () => {
    for (const dir of Object.values(dirs)) {
      try {
        await manager.install(dir);
      } catch {
        /* 预期失败 */
      }
    }
  });
  assert.equal(manager.status(id('dispose-early')).state, 'running');
  // 反复 reload 一个健康插件（每次都要完整 dispose 一次沙箱）
  for (let i = 0; i < 3; i++) {
    assert.equal((await manager.reload(id('dispose-early'))).state, 'running');
  }
  await manager.stopAll('shutdown');
  assert.equal(manager.status(id('dispose-early')).state, 'stopped');
});

// ---------------- 17/18 记录与启动装载 ----------------

test('记录：install 写 plugins.json（结构合法）、重复 install 保留 installedAt', async () => {
  const dir = makePlugin('record', `export function init(){}`);
  const first = await manager.install(dir);
  const file = loadRecords();
  const rec = file.plugins.find((p) => p.id === id('record'));
  assert.ok(rec);
  assert.deepEqual(validateRecord(rec), []);
  assert.equal(rec.origin, null);
  assert.equal(rec.signedBy, null);
  assert.equal(rec.verifiedMeta, null);
  assert.equal(rec.reserved, false);
  assert.equal(rec.configPath.endsWith(`config/plugins/${sanitized(first.id)}.json`) || rec.configPath.endsWith(`config\\plugins\\${sanitized(first.id)}.json`), true);

  const second = await manager.install(dir);
  assert.equal(second.state, 'running');
  assert.equal(second.id, first.id);
  assert.equal(loadRecords().plugins.find((p) => p.id === id('record'))?.installedAt, rec.installedAt);
  await manager.disable(id('record'));
});

test('启动自动装载：只装载 enabled 的插件，禁用的连 bundle 都不加载', async () => {
  const enabled = makePlugin(
    'boot-on',
    `import { fs } from '@host/api';
     export function init(){ fs.write('boot-on.txt', 'yes'); }`,
  );
  const disabled = makePlugin(
    'boot-off',
    `import { fs } from '@host/api';
     export function init(){ fs.write('boot-off.txt', 'should-not-happen'); }`,
  );
  await manager.install(enabled);
  await manager.install(disabled);
  await manager.stopAll('shutdown');
  await manager.disable(id('boot-off'));
  rmSync(dataPath(id('boot-off'), 'boot-off.txt'), { force: true });
  rmSync(dataPath(id('boot-on'), 'boot-on.txt'), { force: true });

  const rows = await withEnv({ SPC_PLUGIN_INIT_TIMEOUT_MS: '300' }, () => manager.startAll());
  assert.equal(rows.find((r) => r.id === id('boot-on'))?.state, 'running');
  assert.equal(rows.find((r) => r.id === id('boot-off'))?.state, 'disabled');
  // 失败隔离：前面那些坏插件（死循环 / 内存炸）仍是 failed，却没有拦住 boot-on 起来
  assert.equal(rows.find((r) => r.id === id('loop'))?.state, 'failed');
  assert.equal(readData(id('boot-on'), 'boot-on.txt'), 'yes');
  assert.equal(existsSync(dataPath(id('boot-off'), 'boot-off.txt')), false);
  await manager.stopAll('shutdown');
});

// ---------------- 19/20 能力登记 ----------------

test('能力登记幂等：连续两次 reload 后登记表与 capabilities 完全一致（不叠加）', async () => {
  const dir = makePlugin('caps-idem', `export function init(){}`, {
    exports: {
      routes: [{ path: '/caps-idem', title: 'x' }],
      webApis: [{ path: '/api/caps-idem' }],
      events: { publish: [{ topic: 'caps.idem', classification: 'public' }] },
    },
  });
  const view = await manager.install(dir);
  const expected = view.capabilities.filter((c) => c !== 'subscribe:caps.idem').sort();
  await manager.reload(id('caps-idem'));
  const after = await manager.reload(id('caps-idem'));
  assert.deepEqual([...after.capabilities].sort(), expected);
  const snap = capabilities.snapshot();
  assert.equal(snap.routes.filter((r) => r.pluginId === id('caps-idem')).length, 1);
  assert.equal(snap.webApis.filter((w) => w.pluginId === id('caps-idem')).length, 1);
  assert.equal(snap.publishedEvents.filter((e) => e.pluginId === id('caps-idem')).length, 1);
  await manager.disable(id('caps-idem'));
});

test('能力冲突：两个插件抢同一路由 → PLUGIN_EXPORT_INVALID，且不留半登记', async () => {
  const a = makePlugin('caps-a', `export function init(){}`, {
    exports: { routes: [{ path: '/shared', title: 'A' }] },
  });
  const b = makePlugin('caps-b', `export function init(){}`, {
    exports: { routes: [{ path: '/shared', title: 'B' }] },
  });
  await manager.install(a);
  await rejects(() => manager.install(b), 'PLUGIN_EXPORT_INVALID');
  const routes = capabilities.snapshot().routes.filter((r) => r.path === '/shared');
  assert.equal(routes.length, 1);
  assert.equal(routes[0].pluginId, id('caps-a'));
  assert.deepEqual(manager.status(id('caps-b')).capabilities, []);
  await manager.disable(id('caps-a'));
});

// ---------------- 21 依赖检查 ----------------

test('依赖检查：声明的插件未安装 → PLUGIN_DEPENDENCY_MISSING', async () => {
  const dir = makePlugin('dep-needs', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/dep-provider' }] },
  });
  await rejects(() => manager.install(dir), 'PLUGIN_DEPENDENCY_MISSING');

  // 依赖装好之后就能起来
  const dep = makePlugin('dep-provider', `export function init(){}`);
  await manager.install(dep);
  const ok = await manager.install(dir);
  assert.equal(ok.state, 'running');
  await manager.disable(id('dep-needs'));
  await manager.disable(id('dep-provider'));
});

test('反向依赖：被运行中的插件依赖时，uninstall / disable 都被拒（PLUGIN_IN_USE）', async () => {
  const provider = makePlugin('inuse-provider', `export function init(){}`);
  const consumer = makePlugin('inuse-consumer', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/inuse-provider' }] },
  });
  await manager.install(provider);
  await manager.install(consumer);

  // 错误信息要能直接告诉管理员"谁在依赖它"，否则只会在日志里猜
  for (const op of ['uninstall', 'disable'] as const) {
    let caught: unknown;
    try {
      await (op === 'uninstall' ? manager.uninstall(id('inuse-provider')) : manager.disable(id('inuse-provider')));
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof SpcError, `${op} 应被拒`);
    assert.equal((caught as InstanceType<typeof SpcError>).code, 'PLUGIN_IN_USE');
    assert.equal((caught as InstanceType<typeof SpcError>).params.dependents, id('inuse-consumer'));
    assert.equal((caught as InstanceType<typeof SpcError>).params.action, op);
  }
  // provider 仍在运行（拒绝是"什么都没发生"，不是"半途卸载"）
  assert.equal(manager.status(id('inuse-provider')).state, 'running');

  // 依赖方禁用之后，卸载放行
  await manager.disable(id('inuse-consumer'));
  await manager.uninstall(id('inuse-provider'));
  await rejects(() => manager.status(id('inuse-provider')), 'PLUGIN_NOT_FOUND');
});

test('反向保护只管运行态：全部卸载后（维护态）同一个卸载操作放行', async () => {
  const provider = makePlugin('maint-provider', `export function init(){}`);
  const consumer = makePlugin('maint-consumer', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/maint-provider' }] },
  });
  await manager.install(provider);
  await manager.install(consumer);
  // 运行中 → 拦
  await rejects(() => manager.uninstall(id('maint-provider')), 'PLUGIN_IN_USE');

  // 全部停掉（= 维护模式守护进程的形态：不装载任何插件）→ 不拦。
  // 注意 enabled 仍是 true：判据是"有没有在跑"，不是记录里的意图。
  await manager.stopAll('shutdown');
  assert.equal(manager.status(id('maint-consumer')).enabled, true);
  await manager.uninstall(id('maint-provider'));
  await rejects(() => manager.status(id('maint-provider')), 'PLUGIN_NOT_FOUND');

  await manager.disable(id('maint-consumer'));
});

test('装载顺序：记录顺序把依赖方排在前面，startAll 仍按拓扑序（依赖先 init）', async () => {
  const consumer = makePlugin('topo-consumer', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/topo-provider' }] },
  });
  const provider = makePlugin('topo-provider', `export function init(){}`);
  // 先装依赖方：它会因依赖未满足而失败（但记录已写入，且 enabled=true）
  try {
    await manager.install(consumer);
  } catch {
    /* 预期 */
  }
  await manager.install(provider);
  await manager.stopAll('shutdown'); // 两者都卸载，enabled 保持 true

  // 前提：记录顺序确实是"依赖方在前"——否则这个用例测不到拓扑排序
  const order = loadRecords()
    .plugins.map((p) => p.id)
    .filter((i) => i.startsWith('@spc/topo-'));
  assert.deepEqual(order, [id('topo-consumer'), id('topo-provider')]);

  const rows = await withEnv({ SPC_PLUGIN_INIT_TIMEOUT_MS: '300' }, () => manager.startAll());
  assert.equal(rows.find((r) => r.id === id('topo-consumer'))?.state, 'running');
  assert.equal(rows.find((r) => r.id === id('topo-provider'))?.state, 'running');

  // 顺序证据：审计里最后两次 init 必须是"提供方 → 依赖方"
  const inits = auditEntries()
    .filter((e) => e.method === 'lifecycle.init')
    .filter((e) => e.pluginId === id('topo-consumer') || e.pluginId === id('topo-provider'))
    .map((e) => e.pluginId);
  assert.deepEqual(
    inits.slice(-2),
    [id('topo-provider'), id('topo-consumer')],
    `依赖必须先 init，实际序列：${inits.join(' → ')}`,
  );
  await manager.stopAll('shutdown');
});

test('依赖已启用但没在跑（failed）→ PLUGIN_DEPENDENCY_NOT_LOADED，而不是 MISSING', async () => {
  const broken = makePlugin('depbroken', `export function init(){ throw new Error('boom'); }`);
  try {
    await manager.install(broken);
  } catch {
    /* 预期失败：enabled=true 但 state=failed */
  }
  assert.equal(manager.status(id('depbroken')).enabled, true);
  assert.equal(manager.status(id('depbroken')).state, 'failed');

  const user = makePlugin('depbroken-user', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/depbroken' }] },
  });
  let caught: unknown;
  try {
    await manager.install(user);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof SpcError, '应被拒');
  assert.equal((caught as InstanceType<typeof SpcError>).code, 'PLUGIN_DEPENDENCY_NOT_LOADED');
  assert.equal((caught as InstanceType<typeof SpcError>).params.state, 'failed');
});

test('依赖环：环上插件直接判 failed（PLUGIN_DEPENDENCY_CYCLE），不互相报"依赖缺失"', async () => {
  const x = makePlugin('cyc-x', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/cyc-y' }] },
  });
  const y = makePlugin('cyc-y', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/cyc-x' }] },
  });
  for (const dir of [x, y]) {
    try {
      await manager.install(dir);
    } catch {
      /* 预期：互为依赖时装不起来 */
    }
  }
  await manager.stopAll('shutdown');

  const rows = await withEnv({ SPC_PLUGIN_INIT_TIMEOUT_MS: '300' }, () => manager.startAll());
  for (const pid of ['cyc-x', 'cyc-y']) {
    const view = rows.find((r) => r.id === id(pid));
    assert.equal(view?.state, 'failed', `${pid} 应为 failed`);
    assert.equal(view?.lastError?.code, 'PLUGIN_DEPENDENCY_CYCLE', `${pid} 的错误码`);
  }
});

// ---------------- 22 插件配置 ----------------

test('插件配置：默认值填充、非法值被拒、ctx.config 是只读快照', async () => {
  const schema = {
    type: 'object',
    required: ['greeting'],
    additionalProperties: false,
    properties: {
      greeting: { type: 'string', default: 'hello' },
      retries: { type: 'integer', default: 3, minimum: 1, maximum: 10 },
    },
  };
  // 纯函数层
  const filled = validatePluginConfig(schema, {});
  assert.equal(filled.ok, true);
  assert.deepEqual(filled.values, { greeting: 'hello', retries: 3 });
  assert.equal(validatePluginConfig(schema, { retries: 99 }).ok, false);
  assert.equal(validatePluginConfig(schema, { unexpected: 1 }).ok, false);
  assert.equal(validatePluginConfig(undefined, { any: 1 }).ok, false);

  const dir = makePlugin(
    'cfg',
    `import { fs } from '@host/api';
     export function init(ctx){
       let mutation = 'no-throw';
       try { ctx.config.greeting = 'HACKED'; } catch (e) { mutation = 'threw'; }
       fs.write('cfg.txt', String(ctx.config.greeting) + '|' + String(ctx.config.retries) + '|' + mutation);
     }`,
    { configSchema: schema },
  );
  const view = await manager.install(dir);
  assert.equal(view.state, 'running');
  const [greeting, retries, mutation] = readData(id('cfg'), 'cfg.txt').split('|');
  assert.equal(greeting, 'hello', 'ctx.config 被插件改掉了（不是只读快照）');
  assert.equal(retries, '3');
  assert.equal(mutation, 'threw', '严格模式下改冻结对象应当抛错');

  // 落盘层：非法值拒绝保存
  assert.throws(() => savePluginConfig(id('cfg'), schema, { retries: 100 }), (e: unknown) => {
    assert.equal((e as InstanceType<typeof SpcError>).code, 'PLUGIN_CONFIG_INVALID');
    return true;
  });
  savePluginConfig(id('cfg'), schema, { greeting: 'hi' });
  assert.equal(loadPluginConfig(id('cfg'), schema).greeting, 'hi');
  await manager.disable(id('cfg'));
});

// ---------------- 23 失败重启（auto） ----------------

test('failedRestart=auto：连续失败到上限后停在 failed，审计记 lifecycle.restart', async () => {
  const dir = makePlugin('restart-auto', `export function init(){ throw new Error('always'); }`);
  await withEnv(
    {
      SPC_PLUGIN_FAILED_RESTART: 'auto',
      SPC_PLUGIN_MAX_RESTART_ATTEMPTS: '2',
      SPC_PLUGIN_RESTART_BACKOFF_MS: '20',
    },
    async () => {
      try {
        await manager.install(dir);
      } catch {
        /* 预期：首次装载失败 */
      }
      await sleep(500); // 等线性退避重试跑完（20ms、40ms）
    },
  );
  const view = manager.status(id('restart-auto'));
  assert.equal(view.state, 'failed');
  assert.equal(view.restartAttempts, 3, `重试次数应为 maxAttempts+1=3，实际 ${view.restartAttempts}`);
  const restarts = auditEntries().filter(
    (e) => e.pluginId === id('restart-auto') && e.method === 'lifecycle.restart',
  );
  assert.ok(restarts.length >= 3, `审计里应有 >=3 条 lifecycle.restart，实际 ${restarts.length}`);
  assert.ok(restarts.some((e) => String(e.paramsDigest).length > 0));
});

// ---------------- 24 并发 ----------------

test('并发：同一插件的两个 reload 同时发起 → 锁串行，终态一致且能力不叠加', async () => {
  const dir = makePlugin('concurrent', `export function init(){}`, {
    exports: { routes: [{ path: '/concurrent', title: 'x' }] },
  });
  await manager.install(dir);
  const [a, b] = await Promise.all([manager.reload(id('concurrent')), manager.reload(id('concurrent'))]);
  assert.equal(a.state, 'running');
  assert.equal(b.state, 'running');
  assert.equal(capabilities.snapshot().routes.filter((r) => r.path === '/concurrent').length, 1);
  assert.deepEqual(
    [...manager.status(id('concurrent')).capabilities].sort(),
    ['route:/concurrent'],
  );
  await manager.disable(id('concurrent'));
});

// ---------------- 25 reserved ----------------

test('reserved 插件：可 disable，uninstall 被拒（PLUGIN_RESERVED）', async () => {
  const dir = makePlugin('reserved', `export function init(){}`);
  await manager.install(dir, { reserved: true });
  assert.equal(manager.status(id('reserved')).reserved, true);
  assert.equal((await manager.disable(id('reserved'))).state, 'disabled');
  await rejects(() => manager.uninstall(id('reserved')), 'PLUGIN_RESERVED');
  // 非 reserved 的可以卸载（记录消失）
  const normal = makePlugin('uninstallable', `export function init(){}`);
  await manager.install(normal);
  await manager.uninstall(id('uninstallable'));
  await rejects(() => manager.status(id('uninstallable')), 'PLUGIN_NOT_FOUND');
});

// ---------------- 26 授予 ----------------

test('grant：拒绝通配/未知点/未声明点；合法授予写入记录，运行中需要 reload 才生效', async () => {
  const dir = makePlugin('grantable', `export function init(){}`, {
    permissions: ['kv.read'],
  });
  await manager.install(dir);
  assert.throws(() => manager.grant(id('grantable'), ['kv.*']), (e: unknown) => {
    assert.equal((e as InstanceType<typeof SpcError>).code, 'GRANT_WILDCARD');
    return true;
  });
  assert.throws(() => manager.grant(id('grantable'), ['nope.point']), (e: unknown) => {
    assert.equal((e as InstanceType<typeof SpcError>).code, 'UNKNOWN_POINT');
    return true;
  });
  assert.throws(() => manager.grant(id('grantable'), ['exec.template.git.version']), (e: unknown) => {
    assert.equal((e as InstanceType<typeof SpcError>).code, 'NOT_DECLARED');
    return true;
  });
  assert.throws(() => manager.grant(id('grantable'), []), (e: unknown) => {
    assert.equal((e as InstanceType<typeof SpcError>).code, 'INVALID_ARGS');
    return true;
  });

  const view = manager.grant(id('grantable'), ['kv.read']);
  assert.deepEqual(view.grants, ['kv.read']);
  assert.equal(view.reloadRequired, true, '运行中的插件授权后应提示需要 reload');
  const after = await manager.reload(id('grantable'));
  assert.equal(after.reloadRequired, false);

  const revoked = manager.revoke(id('grantable'), ['kv.read']);
  assert.deepEqual(revoked.grants, []);
  await manager.disable(id('grantable'));
});

// ---------------- 27 清单与记录一致性 ----------------

test('清单 id 与记录不一致 → PLUGIN_MANIFEST_INVALID（装的是 A、跑的是 B 必须拒载）', async () => {
  const dir = makePlugin('mismatch', `export function init(){}`);
  await manager.install(dir);
  // 运行中改掉目录里的 manifest id：reload 必须先 stop 再重新读清单 → 一致性检查命中
  const manifestPath = join(dir, 'manifest.json');
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id: string };
  raw.id = '@spc/other';
  writeFileSync(manifestPath, JSON.stringify(raw, null, 2), 'utf8');
  await rejects(() => manager.reload(id('mismatch')), 'PLUGIN_MANIFEST_INVALID');
});

// ---------------- 28 生命周期审计 ----------------

test('审计：生命周期条目按 lifecycle.init/start/stop/unload 落账（带 result 与 durationMs）', async () => {
  const dir = makePlugin(
    'audited',
    `export function init(){}
     export function start(){}
     export function stop(){}`,
  );
  await manager.install(dir);
  await manager.disable(id('audited'));
  const methods = auditEntries()
    .filter((e) => e.pluginId === id('audited'))
    .map((e) => e.method);
  for (const m of ['lifecycle.init', 'lifecycle.start', 'lifecycle.stop', 'lifecycle.unload']) {
    assert.ok(methods.includes(m), `审计缺少 ${m}（实际：${methods.join(',')}）`);
  }
  const unload = auditEntries().find(
    (e) => e.pluginId === id('audited') && e.method === 'lifecycle.unload',
  );
  assert.equal(unload?.result, 'ok');
  assert.equal(typeof unload?.durationMs, 'number');
});
