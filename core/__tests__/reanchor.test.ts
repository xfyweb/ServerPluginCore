// 换源（reanchor）测试：docs/events-and-hooks-design.md §3.6
//
// 覆盖：预检计划 / 批量原子 / 授权点名重写 / 依赖方保护 / 名册搬家 / 数据与配置跟着走 /
//       运行中自动重启且能力登记不泄漏 / 审计 / 换源后的依赖提示（PLUGIN_DEPENDENCY_SOURCE_CHANGED）。
//
// 隔离：SPC_STATE_DIR / SPC_AUDIT_DIR / SPC_KEYRING_DIR 必须在**动态 import 之前**设好
// （core/audit.ts 的 AUDIT_DIR 是模块级常量）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-reanchor-'));
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_KEYRING_DIR = join(TMP, 'keyring');
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

const { initAudit } = await import('../audit.ts');
initAudit();
const { manager } = await import('../plugin/manager.ts');
const { addSource, setSourceAnchor } = await import('../sources/manage.ts');
const { keyring } = await import('../sources/keyring.ts');
const { findAuthor, loadAuthors } = await import('../sources/authors.ts');
const { pointSource } = await import('../permissions/source.ts');
const { pluginDataDir, pluginConfigPath, sanitizeOrigin } = await import('../config.ts');
const { savePluginConfig } = await import('../plugin/config.ts');
const { SpcError } = await import('../errors.ts');
const { newTestKey, signPluginDir } = await import('./helpers/signed-plugin.ts');
import type { TestKey } from './helpers/signed-plugin.ts';

// ---------------- 夹具 ----------------

const id = (name: string) => `@spc/${name}`;
const BUCKET = 'local:std-a';

interface PluginOpts {
  authorKey?: TestKey;
  endpoints?: string[];
  /** 依赖声明（原样进 manifest.dependencies.plugins） */
  deps?: Record<string, unknown>[];
  /** 入口模块里的顶层代码（缺省空） */
  code?: string;
  permissions?: string[];
  /** 声明 configSchema（**声明了才能带配置值**：没声明却塞了值 ⇒ `PLUGIN_CONFIG_INVALID`） */
  configSchema?: Record<string, unknown>;
  /** 让 start 抛错（造"已启用但没起来"的插件：`enabled=true` + `state=failed`） */
  startThrows?: boolean;
}

/** 造一个能装载的能力插件目录；`endpoints` 声明的路径会自动补出实现（装载期会核对） */
function makePlugin(name: string, opts: PluginOpts = {}): string {
  const dir = join(TMP, 'plugins', name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schema: 2,
    id: id(name),
    name: `Fixture ${name}`,
    version: { code: 1, name: '0.0.1' },
    runtime: { type: 'quickjs', esm: true },
    // schema 要求 `permissions` 至少一条（空数组会被拒）
    permissions: (opts.permissions ?? ['fs.read.data']).map((n) => ({ name: n })),
    ...(opts.configSchema ? { configSchema: opts.configSchema } : {}),
    ...(opts.endpoints
      ? { exports: { endpoints: opts.endpoints.map((p) => ({ path: p, callable: ['panel', 'plugins'] })) } }
      : {}),
    ...(opts.deps ? { dependencies: { plugins: opts.deps } } : {}),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const impls = (opts.endpoints ?? [])
    .map((p) => `  ${JSON.stringify(p)}: () => JSON.stringify({ path: ${JSON.stringify(p)} }),`)
    .join('\n');
  // 入口模块必须导出 `init`（装载期会找它；缺了就是 `PLUGIN_NO_ENTRY`）
  const source = `export function init() {}\n${
    opts.startThrows ? 'export function start() { throw new Error("boom"); }\n' : ''
  }${opts.code ?? ''}${impls ? `\nexport const endpoints = {\n${impls}\n};\n` : ''}`;
  writeFileSync(join(dir, 'main.ts'), source, 'utf8');
  if (opts.authorKey) signPluginDir(dir, opts.authorKey);
  return dir;
}

/** 装一个插件并返回它的完整引用（默认装进 `local:default`） */
async function install(name: string, opts: PluginOpts & { source?: string; grants?: string[] } = {}): Promise<string> {
  const view = await manager.install(makePlugin(name, opts), {
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.grants ? { grants: opts.grants } : {}),
  });
  return view.ref;
}

/** 造桶（真实路径：`addSource`，这样锚的指纹是算出来的，不是手抄的）。已存在就改锚 —— 用例之间共用一份 keyring */
async function bucket(origin: string, anchorPub?: string): Promise<void> {
  if (keyring().get(origin)) {
    setSourceAnchor(origin, anchorPub ?? null);
    return;
  }
  await addSource({ origin, alias: origin, ...(anchorPub ? { anchorPub } : {}) });
}

function auditOf(method: string): Record<string, unknown>[] {
  const file = join(TMP, 'audit', 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.includes(`"${method}"`))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const dataFile = (origin: string, name: string) => join(pluginDataDir(origin, id(name)), 'state.txt');

// ---------------- 基本搬家 ----------------

test('换源：预检计划 + 执行（记录 / 数据目录 / 配置文件 / 名册 全跟着走）', async () => {
  const author = newTestKey();
  const from = await install('basic', {
    authorKey: author,
    // 声明了 configSchema 才允许带配置值（没声明却塞值 ⇒ PLUGIN_CONFIG_INVALID）
    configSchema: { type: 'object', properties: { keep: { type: 'string' } } },
  });
  // 数据目录与配置文件里各留一份"存量"，用来证明它们真的搬到新来源下了
  writeFileSync(dataFile('local:default', 'basic'), 'data-v1', 'utf8');
  savePluginConfig(
    'local:default',
    id('basic'),
    { type: 'object', properties: { keep: { type: 'string' } } },
    { keep: 'yes' },
  );

  await bucket(BUCKET, author.pub); // 桶绑的锚 = 这个插件的作者 => 允许搬进去

  const plan = manager.planReanchor([from], BUCKET);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].from, from);
  assert.equal(plan.moves[0].to, `${BUCKET}/${id('basic')}`);
  assert.equal(plan.target.anchorFingerprint, author.fingerprint);
  assert.equal(plan.moves[0].dataDir.exists, true);
  assert.equal(plan.moves[0].config.exists, true);
  // 预检**只读**：跑完计划什么都不该变
  assert.equal(manager.status(from).origin, 'local:default');

  const result = await manager.reanchor([from], BUCKET);
  assert.deepEqual(result.moved, [{ from, to: `${BUCKET}/${id('basic')}` }]);
  assert.deepEqual(result.failedToStart, []);

  const to = `${BUCKET}/${id('basic')}`;
  assert.equal(manager.status(to).origin, BUCKET);
  assert.equal(manager.status(to).state, 'running', '原本 enabled ⇒ 搬完自动重启');
  assert.throws(() => manager.status(from), (e: unknown) => e instanceof SpcError && e.code === 'PLUGIN_NOT_FOUND');

  // 数据 / 配置跟着走（旧位置不再有）
  assert.equal(readFileSync(dataFile(BUCKET, 'basic'), 'utf8'), 'data-v1');
  assert.equal(existsSync(dataFile('local:default', 'basic')), false);
  const conf = pluginConfigPath(BUCKET, id('basic'));
  assert.equal(existsSync(conf), true);
  assert.equal((JSON.parse(readFileSync(conf, 'utf8')) as { keep: string }).keep, 'yes');
  assert.equal(manager.status(to).configPath, conf, '记录里的 configPath 是存量副本，必须一起改');

  // 名册：记忆跟着插件走（写新键 + 删旧键）
  assert.equal(findAuthor(BUCKET, id('basic'))?.fingerprint, author.fingerprint);
  assert.equal(findAuthor('local:default', id('basic')), undefined);
  assert.equal(loadAuthors().authors.filter((a) => a.id === id('basic')).length, 1);

  // 审计：`pluginId` = 旧引用、`ref` = 新引用（旧新都在同一条里）
  const entries = auditOf('plugin.reanchor');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].pluginId, from);
  assert.equal(entries[0].ref, to);
});

// ---------------- 授权点名重写 ----------------

test('换源：别人的授权点名随源变（字符串前缀替换），旧点名当场消失', async () => {
  const author = newTestKey();
  const a = await install('dep-target', { authorKey: author, endpoints: ['/api/x/run'] });
  const b = await install('dep-caller', {
    authorKey: author,
    deps: [{ id: id('dep-target'), author: { pub: author.pub }, call: ['/api/x/run'] }],
  });
  const callPoint = `plugins.call.${a}./api/x/run`;
  assert.ok(pointSource.get(callPoint), '被调方的端点登记后，动态点应当存在');
  manager.grant(b, [callPoint]);
  assert.deepEqual(manager.status(b).grants, [callPoint]);

  await bucket(BUCKET, author.pub);
  const plan = manager.planReanchor([a, b], BUCKET); // 依赖方一起搬（单独搬被依赖方会被 PLUGIN_IN_USE 拦）
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.grantRewrites, [
    { ref: b, pairs: [{ from: callPoint, to: `plugins.call.${BUCKET}/${id('dep-target')}./api/x/run` }] },
  ]);
  // 批内的插件会被**重启**（不是只标 reload）⇒ needsReload 里不该有它
  assert.deepEqual(plan.needsReload, []);

  await manager.reanchor([a, b], BUCKET);
  const newPoint = `plugins.call.${BUCKET}/${id('dep-target')}./api/x/run`;
  assert.deepEqual(manager.status(`${BUCKET}/${id('dep-caller')}`).grants, [newPoint]);
  assert.equal(pointSource.get(callPoint), undefined, '旧点名随能力撤销而消失（fail-closed）');
  assert.ok(pointSource.get(newPoint));
  assert.equal(manager.status(`${BUCKET}/${id('dep-caller')}`).state, 'running');
});

test('换源：手里有**陈旧授权**的运行中插件 ⇒ 只标 reload（它已经不是依赖方了）', async () => {
  const author = newTestKey();
  const a = await install('stale-target', { authorKey: author, endpoints: ['/api/stale/run'] });
  const c = await install('stale-holder', {
    authorKey: author,
    deps: [{ id: id('stale-target'), author: { pub: author.pub }, call: ['/api/stale/run'] }],
  });
  const callPoint = `plugins.call.${a}./api/stale/run`;
  manager.grant(c, [callPoint]);

  // 把依赖方清单里的依赖**删掉**再 reload：授权记录留在记录里（陈旧授权），但它不再是依赖方
  // ⇒ 单独搬 A 不再被"被依赖者不许单独搬"拦，可是 C 手里那份点名快照已经过时 ⇒ 要 reload
  const manifestPath = join(TMP, 'plugins', 'stale-holder', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  delete manifest.dependencies;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  await manager.reload(c);
  assert.equal(manager.status(c).reloadRequired, false);

  await bucket(BUCKET, author.pub);
  const plan = manager.planReanchor([a], BUCKET);
  assert.deepEqual(plan.errors, [], 'C 已不是依赖方 ⇒ 不拦');
  assert.deepEqual(plan.needsReload, [c]);
  assert.deepEqual(plan.grantRewrites, [
    { ref: c, pairs: [{ from: callPoint, to: `plugins.call.${BUCKET}/${id('stale-target')}./api/stale/run` }] },
  ]);

  await manager.reanchor([a], BUCKET);
  assert.deepEqual(manager.status(c).grants, [`plugins.call.${BUCKET}/${id('stale-target')}./api/stale/run`]);
  assert.equal(manager.status(c).reloadRequired, true, '跑着的插件手里还是旧快照 ⇒ 提示 reload');
  assert.equal(manager.status(c).state, 'running');
});

test('换源：不在名单里的已装载依赖方 ⇒ 拒（且**一个字节都没改**）', async () => {
  const author = newTestKey();
  const a = await install('kept-target', { authorKey: author });
  const b = await install('kept-caller', {
    authorKey: author,
    deps: [{ id: id('kept-target'), author: { pub: author.pub } }],
  });
  await bucket(BUCKET, author.pub);

  const before = JSON.stringify(manager.list());
  const auditsBefore = auditOf('plugin.reanchor').length;
  await assert.rejects(
    () => manager.reanchor([a], BUCKET),
    (e: unknown) => e instanceof SpcError && e.code === 'PLUGIN_IN_USE',
  );
  // 原子性：被拒之后记录一模一样（含 grants / origin / 状态）
  assert.equal(JSON.stringify(manager.list()), before);
  assert.equal(existsSync(pluginDataDir(BUCKET, id('kept-target'))), false);
  assert.equal(findAuthor(BUCKET, id('kept-target')), undefined);
  assert.equal(manager.status(b).reloadRequired, false);
  assert.equal(auditOf('plugin.reanchor').length, auditsBefore, '被拒 ⇒ 一条审计都不该落');
});

test('换源：批量原子（依赖方与被依赖方一起搬）', async () => {
  const author = newTestKey();
  const a = await install('batch-target', { authorKey: author });
  const b = await install('batch-caller', {
    authorKey: author,
    deps: [{ id: id('batch-target'), author: { pub: author.pub } }],
  });
  await bucket(BUCKET, author.pub);

  // 单独搬被依赖的那个 ⇒ 拒（上一条用例已判）；两个一起搬 ⇒ 通
  const auditsBefore = auditOf('plugin.reanchor').length;
  const result = await manager.reanchor([a, b], BUCKET);
  assert.equal(result.moved.length, 2);
  assert.equal(manager.status(`${BUCKET}/${id('batch-target')}`).state, 'running');
  assert.equal(manager.status(`${BUCKET}/${id('batch-caller')}`).state, 'running');
  assert.equal(auditOf('plugin.reanchor').length - auditsBefore, 2, '一条一插件');
});

test('换源：被依赖方**已启用但没起来**时只提示，不拦', async () => {
  const author = newTestKey();
  const a = await install('idle-target', { authorKey: author });
  // 依赖方 start 抛错 ⇒ 记录留在 `enabled: true` + `state: failed`（**已启用但没在跑**的那一格）
  await assert.rejects(() =>
    install('idle-caller', {
      authorKey: author,
      deps: [{ id: id('idle-target'), author: { pub: author.pub } }],
      startThrows: true,
    }),
  );
  const b = `local:default/${id('idle-caller')}`;
  assert.equal(manager.status(b).enabled, true);
  assert.notEqual(manager.status(b).state, 'running');
  await bucket(BUCKET, author.pub);

  const plan = manager.planReanchor([a], BUCKET);
  assert.deepEqual(plan.errors, [], '它没在跑 ⇒ 没有"运行被悄悄打断"这回事，不拦');
  assert.deepEqual(plan.idleDependents, [b]);
  assert.ok(plan.warnings.some((w) => w.code === 'REANCHOR_IDLE_DEPENDENTS'));
  await manager.reanchor([a], BUCKET);
  assert.equal(manager.status(`${BUCKET}/${id('idle-target')}`).origin, BUCKET);
  // 依赖方仍是失败态（本来就没起来），它下一次启动才会看到"依赖换了来源"
  assert.equal(manager.status(b).enabled, true);
  assert.equal(manager.status(b).state, 'failed');
});

// ---------------- 各种拒法 ----------------

test('换源：目标桶必须先存在（`spc source add`），来源形状也要合法', async () => {
  const author = newTestKey();
  const a = await install('gate', { authorKey: author });

  const missing = manager.planReanchor([a], 'local:nope');
  assert.equal(missing.errors[0]?.code, 'SOURCE_NOT_CONFIGURED');
  await assert.rejects(
    () => manager.reanchor([a], 'local:nope'),
    (e: unknown) => e instanceof SpcError && e.code === 'SOURCE_NOT_CONFIGURED',
  );

  const bad = manager.planReanchor([a], 'Local:Bad');
  assert.equal(bad.errors[0]?.code, 'SOURCE_ORIGIN_INVALID');

  assert.equal(keyring().get('local:nope'), undefined);
});

test('换源：目标桶的作者锚与插件不符 ⇒ 拒（PLUGIN_ANCHOR_MISMATCH）', async () => {
  const author = newTestKey();
  const other = newTestKey();
  const a = await install('anchor-gate', { authorKey: author });
  await bucket(BUCKET, other.pub); // 桶属于**另一个**作者

  const plan = manager.planReanchor([a], BUCKET);
  assert.equal(plan.errors[0]?.code, 'PLUGIN_ANCHOR_MISMATCH');
  await assert.rejects(
    () => manager.reanchor([a], BUCKET),
    (e: unknown) => e instanceof SpcError && e.code === 'PLUGIN_ANCHOR_MISMATCH',
  );
  assert.equal(manager.status(a).origin, 'local:default');

  // 改锚之后就能搬（改锚不追溯，但这里本来就还没搬）
  setSourceAnchor(BUCKET, author.pub);
  assert.deepEqual(manager.planReanchor([a], BUCKET).errors, []);
});

test('换源：没有作者身份的插件搬不进绑了锚的桶', async () => {
  const author = newTestKey();
  const a = await install('no-identity'); // 没带作者信封 ⇒ authorFingerprint = null
  await bucket(BUCKET, author.pub);
  const plan = manager.planReanchor([a], BUCKET);
  assert.equal(plan.errors[0]?.code, 'PLUGIN_ANCHOR_MISMATCH');
  assert.equal(plan.errors[0]?.params.actual, 'none');
});

test('换源：目标位置被占用/自撞/同源 ⇒ 拒，且不合并', async () => {
  const author = newTestKey();
  await bucket(BUCKET, author.pub); // 锚必须与下面这些插件一致，否则先撞的是"锚不符"
  const a = await install('taken', { authorKey: author, source: 'local:src-a' });
  // 目标桶里已经有同名插件（同 id 不同来源是**两个插件**）
  await install('taken', { authorKey: author, source: BUCKET });
  const plan = manager.planReanchor([a], BUCKET);
  assert.equal(plan.errors[0]?.code, 'PLUGIN_REANCHOR_CONFLICT');
  assert.equal(plan.errors[0]?.params.reason, 'target-occupied');

  // 同源 ⇒ 也是冲突（换个名字的 no-op 只会让人以为"搬成功了"）
  const same = manager.planReanchor([`${BUCKET}/${id('taken')}`], BUCKET);
  assert.equal(same.errors[0]?.params.reason, 'same-origin');

  // 数据目录已存在（上次卸载留下的）⇒ 拒：静默合并两份数据是事故
  const c = await install('leftover', { authorKey: author, source: 'local:src-b' });
  mkdirSync(pluginDataDir(BUCKET, id('leftover')), { recursive: true });
  const leftover = manager.planReanchor([c], BUCKET);
  assert.equal(leftover.errors[0]?.params.reason, 'data-dir-exists');
});

// ---------------- 换源之后的依赖解析 ----------------

test('换源：依赖方显式写死旧来源 ⇒ 装载时给"可能是换源导致"的提示', async () => {
  const author = newTestKey();
  const a = await install('moved-dep', { authorKey: author });
  // 依赖声明里**写明了** origin（四格表第 3 行：作者自愿承担"对不上"的风险）
  const b = await install('explicit-caller', {
    authorKey: author,
    deps: [{ id: id('moved-dep'), origin: 'local:default', author: { pub: author.pub } }],
  });
  await manager.disable(b);
  await bucket(BUCKET, author.pub);
  await manager.reanchor([a], BUCKET);

  // 依赖方启动 ⇒ 精确来源下找不到 ⇒ 但同名同作者的在别的源里 ⇒ 专门的码（不是笼统的"没装"）
  await assert.rejects(
    () => manager.enable(b),
    (e: unknown) => e instanceof SpcError && e.code === 'PLUGIN_DEPENDENCY_SOURCE_CHANGED',
  );
  const view = manager.status(b);
  assert.equal(view.state, 'failed');
  assert.equal(view.lastError?.code, 'PLUGIN_DEPENDENCY_SOURCE_CHANGED');
});

// ---------------- 运行态与能力登记 ----------------

test('换源：运行中搬完自动重启，能力登记不残留旧引用', async () => {
  const author = newTestKey();
  const a = await install('caps', { authorKey: author, endpoints: ['/api/caps/ping'] });
  const oldPoint = `plugins.call.${a}./api/caps/ping`;
  assert.ok(pointSource.get(oldPoint));
  await bucket(BUCKET, author.pub);

  await manager.reanchor([a], BUCKET);
  const to = `${BUCKET}/${id('caps')}`;
  const view = manager.status(to);
  assert.equal(view.state, 'running');
  assert.ok(view.capabilities.some((c) => c === 'endpoint:/api/caps/ping'), '能力要按新引用重新登记');
  assert.equal(pointSource.get(oldPoint), undefined, '旧引用下的点不能留在临时表里（否则是一条幽灵授权）');
  assert.ok(pointSource.get(`plugins.call.${to}./api/caps/ping`));
  assert.equal(
    manager.list().filter((p) => p.id === id('caps')).length,
    1,
    '换源不是"装出第二个"，记录必须只有一条',
  );
  // 数据目录的目录段也要换（`local:default` → `local_std-a`）
  assert.equal(view.dataDir, pluginDataDir(BUCKET, id('caps')));
  assert.ok(view.dataDir.includes(sanitizeOrigin(BUCKET)));
});
