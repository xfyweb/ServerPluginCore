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
const { registry } = await import('../permissions/registry.ts');
const { signPluginDir, newTestKey } = await import('./helpers/signed-plugin.ts');
import type { TestKey } from './helpers/signed-plugin.ts';
const { pluginDataDir, DEFAULT_LOCAL_SOURCE, sanitizeOrigin } = await import('../config.ts');
// ⑥c 起"显式 --source 必须指向 keyring 里真有的桶" ⇒ 用例要先建桶
const { ensureBucket } = await import('./helpers/buckets.ts');

// ---------------- 夹具 ----------------

interface FixtureOpts {
  permissions?: string[];
  configSchema?: Record<string, unknown>;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  entry?: string;
  /** 清单里的 `type`（缺省不写 = ability）；用来验"尚未实现的类型被拒" */
  type?: 'ability' | 'driver' | 'hook' | 'theme';
  /** 给这个夹具写作者信封（v4：被依赖方必须有可验证的作者身份） */
  authorKey?: TestKey;
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
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.configSchema ? { configSchema: opts.configSchema } : {}),
    ...(opts.exports ? { exports: opts.exports } : {}),
    ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
    ...(opts.entry ? { entry: opts.entry } : {}),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  // ⑤ 起装载期核对「清单声明的端点 ⟺ 模块里的 `endpoints` 映射」：夹具按声明自动补出实现
  writeFileSync(join(dir, 'main.ts'), code + endpointImpls(opts.exports), 'utf8');
  if (opts.authorKey) signPluginDir(dir, opts.authorKey);
  return dir;
}

/** 见上：把清单声明的端点补成 `export const endpoints = {…}`（没声明端点就原样返回空串） */
function endpointImpls(exports: Record<string, unknown> | undefined): string {
  const declared = (exports?.endpoints as { path: string }[] | undefined) ?? [];
  if (declared.length === 0) return '';
  const entries = declared
    .map((e) => `  ${JSON.stringify(e.path)}: () => JSON.stringify({ path: ${JSON.stringify(e.path)} }),`)
    .join('\n');
  return `\nexport const endpoints = {\n${entries}\n};\n`;
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

/**
 * 夹具插件默认装在 **`local:default`** 这个来源下（`manager.install` 不传 `source` 时）。
 * 身份是 `(origin, id)` ⇒ 记录 / 能力登记 / 依赖 / 生命周期审计里用的是**完整引用**；
 * 管理命令仍可传裸 id（唯一匹配才认），所以下面大量 `manager.xxx(id('x'))` 照旧能用。
 */
const ref = (name: string) => `${DEFAULT_LOCAL_SOURCE}/${id(name)}`;
const sanitized = (pluginId: string) => pluginId.replace(/^@/, '').replace(/\//g, '__');
// 数据目录按 **(origin, id)** 分层（见 core/config.ts 的 pluginDataDir）
const dataPath = (pluginId: string, file: string) =>
  join(TMP, 'data', 'plugins', sanitizeOrigin(DEFAULT_LOCAL_SOURCE), sanitized(pluginId), file);

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

/**
 * 轮询到某个条件成立（带截止时间）。
 *
 * 为什么不用固定 `sleep(500)`：退避重试是**墙钟**驱动的，而机器速度会变——
 * 实测换到 4 核 i3 之后，原来那句 `sleep(500)` 不够长，状态停在 `loading`，
 * 于是用例红在"等得不够久"而不是"逻辑不对"（这类红灯最难判：看着像功能坏）。
 * 轮询把"等多久"从**猜**变成**等到达**；超时仍然失败，不掩盖真问题。
 */
async function waitFor(cond: () => boolean, timeoutMs = 10_000, what = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${what} 在 ${timeoutMs}ms 内未成立`);
    await sleep(10);
  }
}

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
  assert.equal(capabilities.snapshot().routes.filter((r) => r.ref === ref('init-throws')).length, 0);
});

test('start 抛错 → PLUGIN_START_FAILED，能力登记回滚', async () => {
  const dir = makePlugin(
    'start-throws',
    `export function init(){}
     export function start(){ throw new Error('nope'); }`,
    { exports: { endpoints: [{ path: '/api/start-throws' }] } },
  );
  await rejects(() => manager.install(dir), 'PLUGIN_START_FAILED');
  assert.equal(manager.status(id('start-throws')).state, 'failed');
  assert.equal(capabilities.snapshot().endpoints.filter((w) => w.ref === ref('start-throws')).length, 0);
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
  // 身份 = (origin, id)：不传 `--source` 时就落在**默认本地来源**上（v4 起不再是 null）
  assert.equal(rec.origin, DEFAULT_LOCAL_SOURCE);
  assert.equal(first.ref, ref('record'));
  assert.equal(rec.signedBy, null);
  assert.equal(rec.verifiedMeta, null);
  // 配置路径也带**来源层**（同 id 不同源是两个插件，各存各的）
  const wantCfg = `config/plugins/${sanitizeOrigin(DEFAULT_LOCAL_SOURCE)}/${sanitized(first.id)}.json`;
  assert.equal(
    rec.configPath.endsWith(wantCfg) || rec.configPath.endsWith(wantCfg.replace(/\//g, '\\')),
    true,
  );

  const second = await manager.install(dir);
  assert.equal(second.state, 'running');
  assert.equal(second.id, first.id);
  assert.equal(loadRecords().plugins.find((p) => p.id === id('record'))?.installedAt, rec.installedAt);
  await manager.disable(id('record'));
});

// ---------------- 身份 = (origin, id)（v4）----------------

test('同 id 不同来源 = 两个插件：两条记录、两个数据目录、互不影响', async () => {
  const dir = makePlugin(
    'dup-id',
    `import { fs } from '@host/api';
     export function init(){ fs.write('marker.txt', 'here'); }`,
  );
  ensureBucket('local:dev-a');
  ensureBucket('local:dev-b');
  const a = await manager.install(dir, { source: 'local:dev-a' });
  const b = await manager.install(dir, { source: 'local:dev-b' });
  assert.equal(a.ref, `local:dev-a/${id('dup-id')}`);
  assert.equal(b.ref, `local:dev-b/${id('dup-id')}`);

  // 记录按 (origin, id) 分开：同一个 id 有两条，配置路径各不相同
  const recs = loadRecords().plugins.filter((p) => p.id === id('dup-id'));
  assert.equal(recs.length, 2);
  assert.deepEqual(
    recs.map((r) => r.origin).sort(),
    ['local:dev-a', 'local:dev-b'],
  );
  assert.notEqual(recs[0].configPath, recs[1].configPath);

  // 数据目录也分开：往 a 的数据目录里放东西，b 的目录里不该有
  const aDir = pluginDataDir('local:dev-a', id('dup-id'));
  const bDir = pluginDataDir('local:dev-b', id('dup-id'));
  assert.notEqual(aDir, bDir);
  assert.ok(existsSync(join(aDir, 'marker.txt')), 'a 的 init 应写入自己的数据目录');
  assert.ok(existsSync(join(bDir, 'marker.txt')), 'b 的 init 应写入自己的数据目录');
  writeFileSync(join(aDir, 'only-a.txt'), 'x');
  assert.equal(existsSync(join(bDir, 'only-a.txt')), false, 'b 不该看到 a 的数据文件');

  await manager.disable(a.ref);
  await manager.disable(b.ref);
});

test('管理命令传**裸 id** 且有两个来源 ⇒ PLUGIN_REF_AMBIGUOUS（不猜），完整引用照常', async () => {
  const dir = makePlugin('amb', `export function init(){}`);
  ensureBucket('local:dev-a');
  ensureBucket('local:dev-b');
  const a = await manager.install(dir, { source: 'local:dev-a' });
  await manager.install(dir, { source: 'local:dev-b' });

  // 裸 id 歧义：报错而不是"随便挑一个"（挑错了就是在动另一个插件的数据）
  await rejects(() => manager.disable(id('amb')), 'PLUGIN_REF_AMBIGUOUS');
  // 完整引用可以精确操作
  const view = manager.status(a.ref);
  assert.equal(view.state, 'running');
  await manager.disable(a.ref);
  assert.equal(manager.status(a.ref).state, 'disabled');
  // 另一个来源的副本不受影响
  assert.equal(manager.status(`local:dev-b/${id('amb')}`).state, 'running');
  // 裸 id **仍然**歧义：歧义看的是"有几个同名插件"（记录还在），不是"有几个在跑"
  await rejects(() => manager.status(id('amb')), 'PLUGIN_REF_AMBIGUOUS');
  await manager.disable(`local:dev-b/${id('amb')}`);
});

test('审计消歧（②b）：同 id 两个来源的**宿主调用**条目，裸 id 相同但 ref 分得开', async () => {
  const dir = makePlugin(
    'audit-ref',
    `import { fs } from '@host/api';
     export function init(){ fs.write('a.txt', 'x'); }`,
  );
  ensureBucket('local:dev-a');
  ensureBucket('local:dev-b');
  await manager.install(dir, { source: 'local:dev-a' });
  await manager.install(dir, { source: 'local:dev-b' });

  const mine = auditEntries().filter(
    (e) => e.method === 'fs.write' && (e.ref === `local:dev-a/${id('audit-ref')}` || e.ref === `local:dev-b/${id('audit-ref')}`),
  );
  assert.equal(mine.length, 2, `两次装载各应有一条 fs.write 审计，实际 ${mine.length}`);
  // 裸 `pluginId` 是历史字段：两条**一样**（这正是需要 ref 的原因）
  assert.deepEqual([...new Set(mine.map((e) => e.pluginId))], [id('audit-ref')]);
  assert.deepEqual(
    [...new Set(mine.map((e) => e.ref))].sort(),
    [`local:dev-a/${id('audit-ref')}`, `local:dev-b/${id('audit-ref')}`],
  );

  await manager.disable(`local:dev-a/${id('audit-ref')}`);
  await manager.disable(`local:dev-b/${id('audit-ref')}`);
});

test('来源非法 ⇒ PLUGIN_SOURCE_INVALID（`local:` 必须带合法名字；不接受路径分隔）', async () => {
  const dir = makePlugin('bad-src', `export function init(){}`);
  await rejects(() => manager.install(dir, { source: 'local:' }), 'PLUGIN_SOURCE_INVALID');
  await rejects(() => manager.install(dir, { source: '../etc' }), 'PLUGIN_SOURCE_INVALID');
  await rejects(() => manager.install(dir, { source: 'has space' }), 'PLUGIN_SOURCE_INVALID');
});

test('依赖按 (origin, id)：声明里的 origin 决定找哪个来源的副本', async () => {
  const devX = newTestKey();
  const provider = makePlugin('dep-src-provider', `export function init(){}`, { authorKey: devX });
  ensureBucket('local:dev-x');
  await manager.install(provider, { source: 'local:dev-x' });

  // 依赖声明写明 origin=local:dev-x ⇒ 找得到（副本的作者公钥与声明一致）
  const consumer = makePlugin('dep-src-consumer', `export function init(){}`, {
    dependencies: { plugins: [{ id: id('dep-src-provider'), origin: 'local:dev-x', author: { pub: devX.pub } }] },
  });
  const view = await manager.install(consumer);
  assert.equal(view.state, 'running');

  // 同样声明但指向另一个来源 ⇒ 那个来源没有这个插件 ⇒ 依赖未满足（哪怕同名副本存在于 dev-x）
  // ⚠️ 2026-09-25 起这个子情形有**专门的码**：解析不到目标、但同名同作者的插件在别的来源下
  // ⇒ `PLUGIN_DEPENDENCY_SOURCE_CHANGED`（把"它搬到哪去了"报出来）。**仍然拒绝，不回落**：
  // 语义还是"声明里的 origin 说了算"，只是错误信息从"没装"精确到"多半是换过源"。
  const consumer2 = makePlugin('dep-src-consumer2', `export function init(){}`, {
    dependencies: { plugins: [{ id: id('dep-src-provider'), origin: 'local:dev-y', author: { pub: devX.pub } }] },
  });
  await rejects(() => manager.install(consumer2), 'PLUGIN_DEPENDENCY_SOURCE_CHANGED');

  await manager.disable(id('dep-src-consumer'));
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
      endpoints: [{ path: '/api/caps-idem' }],
      events: { publish: [{ topic: 'caps.idem', classification: 'public' }] },
    },
  });
  const view = await manager.install(dir);
  const expected = view.capabilities.filter((c) => c !== 'subscribe:caps.idem').sort();
  await manager.reload(id('caps-idem'));
  const after = await manager.reload(id('caps-idem'));
  assert.deepEqual([...after.capabilities].sort(), expected);
  const snap = capabilities.snapshot();
  assert.equal(snap.routes.filter((r) => r.ref === ref('caps-idem')).length, 1);
  assert.equal(snap.endpoints.filter((w) => w.ref === ref('caps-idem')).length, 1);
  assert.equal(snap.publishedEvents.filter((e) => e.ref === ref('caps-idem')).length, 1);
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
  assert.equal(routes[0].ref, ref('caps-a'));
  assert.deepEqual(manager.status(id('caps-b')).capabilities, []);
  await manager.disable(id('caps-a'));
});

// ---------------- 21 依赖检查 ----------------

test('尚未实现的类型（driver / hook）⇒ 装载期拒绝，且不落记录（绝不静默按能力插件跑）', async () => {
  // 文档口径：`api-contract.md` §9/§10 —— driver 要核心进程内特权、hook 是"核心回调它"的方向，
  // 两者塞进沙箱只会得到一个"看着装上了、实际完全不对"的东西 ⇒ 宿主必须 fail-closed。
  for (const type of ['driver', 'hook'] as const) {
    const name = `unsupported-${type}`;
    const dir = makePlugin(name, `export function init(){}`, { type });
    let caught: unknown;
    try {
      await manager.install(dir);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof SpcError, `${type} 应当被拒`);
    assert.equal((caught as InstanceType<typeof SpcError>).code, 'PLUGIN_MANIFEST_INVALID');
    assert.equal((caught as InstanceType<typeof SpcError>).params.reason, 'unsupported-type');
    // 拒绝发生在**写记录之前** ⇒ 不留任何痕迹（不出现一个 failed 的假记录）
    assert.equal(
      loadRecords().plugins.some((r) => r.id === id(name)),
      false,
      `${type} 不该在安装记录里留下条目`,
    );
  }
});

test('依赖检查：声明的插件未安装 → PLUGIN_DEPENDENCY_MISSING', async () => {
  const key = newTestKey();
  const dir = makePlugin('dep-needs', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/dep-provider', author: { pub: key.pub } }] },
  });
  await rejects(() => manager.install(dir), 'PLUGIN_DEPENDENCY_MISSING');

  // 依赖装好之后就能起来（v4：被依赖方要带作者信封，声明里的 author.pub 才验得过）
  const dep = makePlugin('dep-provider', `export function init(){}`, { authorKey: key });
  await manager.install(dep);
  const ok = await manager.install(dir);
  assert.equal(ok.state, 'running');
  await manager.disable(id('dep-needs'));
  await manager.disable(id('dep-provider'));
});

test('反向依赖：被运行中的插件依赖时，uninstall / disable 都被拒（PLUGIN_IN_USE）', async () => {
  const key = newTestKey();
  const provider = makePlugin('inuse-provider', `export function init(){}`, { authorKey: key });
  const consumer = makePlugin('inuse-consumer', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/inuse-provider', author: { pub: key.pub } }] },
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
    assert.equal((caught as InstanceType<typeof SpcError>).params.dependents, ref('inuse-consumer'));
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
  const key = newTestKey();
  const provider = makePlugin('maint-provider', `export function init(){}`, { authorKey: key });
  const consumer = makePlugin('maint-consumer', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/maint-provider', author: { pub: key.pub } }] },
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
  const topoKey = newTestKey();
  const consumer = makePlugin('topo-consumer', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/topo-provider', author: { pub: topoKey.pub } }] },
  });
  const provider = makePlugin('topo-provider', `export function init(){}`, { authorKey: topoKey });
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
  // 注意：生命周期审计的 `pluginId` 字段现在承载**完整引用**（身份 = (origin, id)，见设计 §3.2）
  const inits = auditEntries()
    .filter((e) => e.method === 'lifecycle.init')
    .filter((e) => e.pluginId === ref('topo-consumer') || e.pluginId === ref('topo-provider'))
    .map((e) => e.pluginId);
  assert.deepEqual(
    inits.slice(-2),
    [ref('topo-provider'), ref('topo-consumer')],
    `依赖必须先 init，实际序列：${inits.join(' → ')}`,
  );
  await manager.stopAll('shutdown');
});

test('依赖已启用但没在跑（failed）→ PLUGIN_DEPENDENCY_NOT_LOADED，而不是 MISSING', async () => {
  const brokenKey = newTestKey();
  const broken = makePlugin('depbroken', `export function init(){ throw new Error('boom'); }`, {
    authorKey: brokenKey,
  });
  try {
    await manager.install(broken);
  } catch {
    /* 预期失败：enabled=true 但 state=failed */
  }
  assert.equal(manager.status(id('depbroken')).enabled, true);
  assert.equal(manager.status(id('depbroken')).state, 'failed');

  const user = makePlugin('depbroken-user', `export function init(){}`, {
    dependencies: { plugins: [{ id: '@spc/depbroken', author: { pub: brokenKey.pub } }] },
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
  const xKey = newTestKey();
  const yKey = newTestKey();
  const x = makePlugin('cyc-x', `export function init(){}`, {
    authorKey: xKey,
    dependencies: { plugins: [{ id: '@spc/cyc-y', author: { pub: yKey.pub } }] },
  });
  const y = makePlugin('cyc-y', `export function init(){}`, {
    authorKey: yKey,
    dependencies: { plugins: [{ id: '@spc/cyc-x', author: { pub: xKey.pub } }] },
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
  assert.throws(() => savePluginConfig(DEFAULT_LOCAL_SOURCE, id('cfg'), schema, { retries: 100 }), (e: unknown) => {
    assert.equal((e as InstanceType<typeof SpcError>).code, 'PLUGIN_CONFIG_INVALID');
    return true;
  });
  savePluginConfig(DEFAULT_LOCAL_SOURCE, id('cfg'), schema, { greeting: 'hi' });
  assert.equal(loadPluginConfig(DEFAULT_LOCAL_SOURCE, id('cfg'), schema).greeting, 'hi');
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
      // 等**终态**，不是"等到看见 failed"。
      //
      // ⚠️ 这里踩过一个坑（换到慢机器后才稳定复现）：`failed` 在重试链**中间也会短暂出现**
      // —— 每次重试失败到下一次定时器触发之间就是 `failed`（`loadAndStart` 失败即落 failed，
      // 下一次重试开始时才变 `loading`）。所以"等 `state === 'failed'`"会**在中间态提前返回**，
      // 断言就红在"次数=1"；而慢机器只是让这个窗口更容易被轮询撞上。
      // 正确判据：**放弃**那一次 —— manager 的行为是 `attempts > maxRestartAttempts` 才放弃
      // （见 `scheduleRestartIfConfigured`），所以终态是 `failed` 且 `restartAttempts === max+1`。
      await waitFor(
        () => {
          const v = manager.status(id('restart-auto'));
          return v.state === 'failed' && v.restartAttempts >= 3;
        },
        15_000,
        'restart-auto 走到放弃（failed 且 attempts>=3）',
      );
    },
  );
  const view = manager.status(id('restart-auto'));
  assert.equal(view.state, 'failed');
  assert.equal(view.restartAttempts, 3, `重试次数应为 maxAttempts+1=3，实际 ${view.restartAttempts}`);
  const restarts = auditEntries().filter(
    (e) => e.pluginId === ref('restart-auto') && e.method === 'lifecycle.restart',
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

// ---------------- 25 内置插件（v2：没有 reserved 例外）----------------

test('内置插件同样是普通插件：可 disable、可 uninstall（v2 取消 reserved）', async () => {
  const dir = makePlugin('builtin', `export function init(){}`);
  await manager.install(dir);
  assert.equal((await manager.disable(id('builtin'))).state, 'disabled');
  // v1 这里会被 PLUGIN_RESERVED 拒绝；v2 起"内置"只表示随核心分发，不构成卸载豁免
  await manager.uninstall(id('builtin'));
  await rejects(() => manager.status(id('builtin')), 'PLUGIN_NOT_FOUND');
  // 普通插件的卸载路径不变（记录消失）
  const normal = makePlugin('uninstallable', `export function init(){}`);
  await manager.install(normal);
  await manager.uninstall(id('uninstallable'));
  await rejects(() => manager.status(id('uninstallable')), 'PLUGIN_NOT_FOUND');
});

// ---------------- 26 授予 ----------------

/**
 * 授予/撤回的用例要点：**必须挑一个 `explicit` 或 `install` 档的点**。
 * 2026-09-23 之前这里用的是 `kv.read`（`self/auto`）—— 那一档本该"免授予、也撤不动"，
 * 而当时的代码对它的 `grant`/`revoke` 一律返回成功（CLI 打印"已授予/已撤销"、判定毫无变化）。
 * 现在 `auto` 档会直接抛 `GRANT_NOT_APPLICABLE`，所以下面自带一条那样的断言。
 *
 * 2026-09-24 起 `install` 与 `explicit` **判定上完全一样**（白名单），差别只在"谁写第一条"：
 * `install` 档的点**首次安装时按清单播种**（下一个用例专门测它），`explicit` 只能管理员授予。
 */
test('grant/revoke：拒绝通配/未知点/未声明点/**auto 档**；授予与撤回都改白名单', async () => {
  // 合成一个 install 档的点（生产注册表里今天没有 install 点；这条用例同时守住"install 撤得动"）
  const POINT = 'demo.read';
  if (!registry.get(POINT)) {
    registry.register({
      name: POINT,
      group: 'demo',
      description: '合成 install 档点（测试用）',
      scope: 'host',
      grant: 'install',
      confidentiality: 'sensitive',
      executionLevel: 'medium',
    });
  }

  const dir = makePlugin('grantable', `export function init(){}`, {
    permissions: ['kv.read', POINT],
  });
  // `start: false`：授权只动记录。首次安装会把这一个 install 档点播种进来
  await manager.install(dir, { start: false });
  assert.deepEqual(manager.status(id('grantable')).grants, [POINT], '首次安装播种 install 档的点');

  assert.throws(() => manager.grant(id('grantable'), ['demo.*']), (e: unknown) => {
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
  // `auto` 档（kv.read 是 self/auto）：既不用授予、也撤不动 ⇒ 两条命令都必须**明确报错**，
  // 不能再"成功但什么都不发生"
  for (const op of ['grant', 'revoke'] as const) {
    assert.throws(
      () => manager[op](id('grantable'), ['kv.read']),
      (e: unknown) => {
        assert.equal((e as InstanceType<typeof SpcError>).code, 'GRANT_NOT_APPLICABLE');
        return true;
      },
      `${op} auto 档应当抛 GRANT_NOT_APPLICABLE`,
    );
  }

  // 撤回 = 移出白名单（install 与 explicit 同一条道）
  const revokedView = manager.revoke(id('grantable'), [POINT]);
  assert.deepEqual(revokedView.grants, []);
  assert.equal(revokedView.reloadRequired, false, '没装载 ⇒ 不需要 reload');
  // 撤回**不要求当前声明**（插件升级删了声明也要能把陈旧授权清掉）
  assert.deepEqual(manager.revoke(id('grantable'), [POINT]).grants, []);

  // 再授予 = 放回白名单
  assert.deepEqual(manager.grant(id('grantable'), [POINT]).grants, [POINT]);

  // 一旦装载过，授权变更就要提示 reload（沙箱持有的是装载时快照）
  await manager.enable(id('grantable'));
  assert.equal(manager.revoke(id('grantable'), [POINT]).reloadRequired, true);
  const after = await manager.reload(id('grantable'));
  assert.equal(after.reloadRequired, false);
  assert.deepEqual(after.grants, [], '撤回在 reload 之后依然有效（不是快照一刷就回来）');
  await manager.disable(id('grantable'));
});

test('授权播种：install 档只在**首次安装**播一次；升级新增的点要管理员授予（增量同意）', async () => {
  const SEEDED = 'demo.seeded';
  const LATER = 'demo.later';
  for (const name of [SEEDED, LATER]) {
    if (!registry.get(name)) {
      registry.register({
        name,
        group: 'demo',
        description: `合成 install 档点（测试用）：${name}`,
        scope: 'host',
        grant: 'install',
        confidentiality: 'public',
        executionLevel: 'low',
      });
    }
  }

  const v1 = makePlugin('seedable', `export function init(){}`, { permissions: [SEEDED] });
  await manager.install(v1, { start: false });
  assert.deepEqual(manager.status(id('seedable')).grants, [SEEDED]);
  // 播种要留痕（谁写的这条授权：安装清单，不是管理员手工点的）
  assert.ok(
    auditEntries().some((e) => e.method === 'plugin.grant' && String(e.target).includes(SEEDED)),
    '播种必须落一条 plugin.grant 审计',
  );

  // 管理员撤回它 —— 授权是管理员的决定，不该被下一次升级冲掉
  manager.revoke(id('seedable'), [SEEDED]);
  // 升级 = 同一个目录换一份新清单（新增了 LATER 这个 install 档点）
  const v2 = makePlugin('seedable', `export function init(){}`, { permissions: [SEEDED, LATER] });
  await manager.install(v2, { start: false });
  assert.deepEqual(
    manager.status(id('seedable')).grants,
    [],
    '重装既不重播已撤回的点，也不自动放行新增的 install 档点（增量同意）',
  );

  // 新增的点由管理员显式授予
  assert.deepEqual(manager.grant(id('seedable'), [LATER]).grants, [LATER]);
  await manager.disable(id('seedable'));
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
    .filter((e) => e.pluginId === ref('audited'))
    .map((e) => e.method);
  for (const m of ['lifecycle.init', 'lifecycle.start', 'lifecycle.stop', 'lifecycle.unload']) {
    assert.ok(methods.includes(m), `审计缺少 ${m}（实际：${methods.join(',')}）`);
  }
  const unload = auditEntries().find(
    (e) => e.pluginId === ref('audited') && e.method === 'lifecycle.unload',
  );
  assert.equal(unload?.result, 'ok');
  assert.equal(typeof unload?.durationMs, 'number');
});

test('审计：lifecycle.<hook> 条目带 suspendedMs —— 钩子里等宿主 I/O 的时间要能单独看出来', async () => {
  // 为什么要这条：`durationMs` 里同时含着"插件自己算的"与"等宿主 I/O 的"两段时间，而处置完全不同
  // （前者调预算/改代码，后者看宿主实现）。挂起期间解释器没在跑 ⇒ 既不吃 CPU 预算也不落中断，
  // 只有这个字段能把它单列出来（见 `AuditEntry.suspendedMs` 的注释）。
  // 这里用的是**真异步宿主方法** `fs.readTextAsync`（`fs.promises.readFile` 那条真异步通道）。
  const dir = makePlugin(
    'suspended',
    `import fsp from 'node:fs/promises';
     export async function init() {
       // 连读多次、且文件不小：让"等宿主"的累计量明显大于计时噪声
       // （单次小文件读可能不到 1ms ⇒ 30 次的总和理论上仍可能取整成 0，那样断言就变成掷骰子）
       for (let i = 0; i < 30; i++) await fsp.readFile('a.bin', 'utf8');
     }
     export function start() {}
     export function stop() {}`,
  );
  // 数据目录是宿主建的（`pluginDataDir`），这里先自己建好并放一个文件：装载时会跑 init，读的就是它
  const pluginData = pluginDataDir(DEFAULT_LOCAL_SOURCE, id('suspended'));
  mkdirSync(pluginData, { recursive: true });
  writeFileSync(join(pluginData, 'a.bin'), 'x'.repeat(256 * 1024), 'utf8');
  await manager.install(dir);
  const init = auditEntries().find(
    (e) => e.pluginId === ref('suspended') && e.method === 'lifecycle.init',
  );
  assert.equal(init?.result, 'ok', `init 审计缺失或失败：${JSON.stringify(init)}`);
  const suspended = init?.suspendedMs;
  assert.equal(typeof suspended, 'number', `lifecycle.init 没记 suspendedMs：${JSON.stringify(init)}`);
  assert.ok(
    (suspended as number) > 0,
    `30 次真异步读的挂起墙钟不该是 0（实际 ${String(suspended)}）`,
  );
  assert.ok(
    (suspended as number) <= (init?.durationMs as number),
    '挂起墙钟是阶段总时长的一部分，不该超过它',
  );
});
