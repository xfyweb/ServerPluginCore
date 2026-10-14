// 作者身份（v4）：本地包的信封 / 名册（TOFU 与换钥）/ 依赖的身份比对 / 本地范围匹配
// 设计：docs/plugin-signature-design.md §3bis、docs/events-and-hooks-design.md §3.5
//
// 为什么这些用例必须存在：依赖身份是"**这是不是我依赖的那个插件**"的**唯一**判据 ——
// 而 `id` 与 `author.id` **都不唯一**（同一把 `@a/x` 在两个源就是两个插件）。
// 判错的后果不是报错，而是**A 悄悄地接到了 B 上**：所以要钉住"比公钥、不比名字"，
// 以及"名册损坏一律拒"（否则已知作者会降级成首见 ⇒ 换一把钥就能静默装进来）。
//
// 隔离：SPC_STATE_DIR / SPC_AUDIT_DIR 必须在**动态 import 之前**设好（见 core/audit.ts 的模块级常量）。
import type { AuditEntry } from '../audit';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-author-'));

/**
 * 当天的审计文件：`<TMP>/audit/<YYYY-MM-DD>.jsonl`（**按天分文件**，见 `core/audit.ts` 头部）。
 *
 * ⚠️ 这里**故意本地算**、不走 `core/audit` 的 `currentAuditFile()`：本文件是"先设 `SPC_AUDIT_DIR`（临时目录）
 * 再 `await import(...)`"的写法，若用**静态** `import`，模块会在环境变量设好**之前**加载 ⇒ 路径解析成默认目录，
 * 既读到别的文件、又会往仓库的 `.spc/audit` 里写（2026-10-14 踩过）。
 */
function auditFileToday(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return join(TMP, 'audit', `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`);
}
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

const { manager } = await import('../plugin/manager.ts');
const { SpcError } = await import('../errors.ts');
const { authorsFilePath, loadAuthors } = await import('../sources/authors.ts');
const { AUTHOR_SIG_FILE, META_FILE } = await import('../sources/verify.ts');
const { newTestKey, signPluginDir } = await import('./helpers/signed-plugin.ts');
// ⑥c 起"显式 --source 必须指向 keyring 里真有的桶" ⇒ 用例要先建桶
const { ensureBucket, ensureMarketSource } = await import('./helpers/buckets.ts');

// ---------------- 夹具 ----------------

interface FixtureOpts {
  dependencies?: Record<string, unknown>;
  /** 不给就**不写信封**（= 这个包没有作者身份） */
  authorKey?: ReturnType<typeof newTestKey>;
  /** 装完信封后再改一个字节（模拟"包被改过"） */
  tamperAfterSign?: boolean;
}

/** 造一个插件目录；`dirName` 只决定目录名，plugin id 单独给（同一个 id 要装进两个源） */
function makePluginAt(dirName: string, pluginId: string, opts: FixtureOpts = {}): string {
  const dir = join(TMP, 'plugins', dirName);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schema: 2,
    id: pluginId,
    name: `Fixture ${dirName}`,
    version: { code: 1, name: '0.0.1' },
    runtime: { type: 'quickjs', esm: true },
    permissions: [{ name: 'fs.write.data' }],
    ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(join(dir, 'main.ts'), 'export function init(){}\n', 'utf8');
  if (opts.authorKey) signPluginDir(dir, opts.authorKey);
  if (opts.tamperAfterSign) writeFileSync(join(dir, 'main.ts'), 'export function init(){ /* tampered */ }\n', 'utf8');
  return dir;
}

const makePlugin = (name: string, opts: FixtureOpts = {}): string =>
  makePluginAt(name, `@spc/${name}`, opts);

const ref = (name: string, origin = 'local:default') => `${origin}/@spc/${name}`;

type SpcErrorT = InstanceType<typeof SpcError>;

async function rejects(fn: () => unknown, code: string): Promise<SpcErrorT> {
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
  assert.equal((caught as SpcErrorT).code, code);
  return caught as SpcErrorT;
}

function auditEntries(): AuditEntry[] {
  const file = auditFileToday();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEntry);
}

before(() => {
  mkdirSync(join(TMP, 'plugins'), { recursive: true });
  mkdirSync(join(TMP, 'audit'), { recursive: true });
});

after(async () => {
  await manager.stopAll('shutdown');
  manager.resetMemory();
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* Windows 上沙箱句柄未释放会 EPERM：只做尽力清理 */
  }
});

// ---------------- ① 本地包的信封 → 记录 + 名册 ----------------

test('本地包带信封：写 authorFingerprint + 首见即记名册（TOFU）', async () => {
  const key = newTestKey();
  const dir = makePlugin('authored', { authorKey: key });
  const view = await manager.install(dir, { start: false });

  assert.equal(view.authorFingerprint, key.fingerprint, '记录里要留下作者指纹');
  const roster = loadAuthors();
  const entry = roster.authors.find((a) => a.origin === 'local:default' && a.id === '@spc/authored');
  assert.ok(entry, '名册要记下首见');
  assert.equal(entry.pub, key.pub, '名册里存的是**公钥**（判定比公钥，指纹只用于展示）');
  assert.equal(entry.fingerprint, key.fingerprint);
  await manager.uninstall(ref('authored'));
});

test('本地包不带信封：authorFingerprint = null（它满足不了任何带 author.pub 的依赖声明）', async () => {
  const dir = makePlugin('unsigned');
  const view = await manager.install(dir, { start: false });
  assert.equal(view.authorFingerprint, null);
  assert.equal(loadAuthors().authors.find((a) => a.id === '@spc/unsigned'), undefined);
  await manager.uninstall(ref('unsigned'));
});

test('信封只给一半（meta 或 sig 缺一个）⇒ PACKAGE_ENVELOPE_INCOMPLETE（不是"没有信封"）', async () => {
  const key = newTestKey();
  const dir = makePlugin('half-envelope', { authorKey: key });
  rmSync(join(dir, AUTHOR_SIG_FILE));
  await rejects(() => manager.install(dir, { start: false }), 'PACKAGE_ENVELOPE_INCOMPLETE');
});

test('包被改过（签名覆盖的载荷变了）⇒ PACKAGE_FILE_MISMATCH（fail-closed）', async () => {
  const key = newTestKey();
  const dir = makePlugin('tampered', { authorKey: key, tamperAfterSign: true });
  await rejects(() => manager.install(dir, { start: false }), 'PACKAGE_FILE_MISMATCH');
});

// ---------------- ② 连续性与换钥 ----------------

test('同 (origin,id) 换了作者公钥 ⇒ 拒装；显式接受后覆盖名册并落 plugin.key-change 审计', async () => {
  const k1 = newTestKey();
  const k2 = newTestKey();
  const v1 = makePlugin('key-rotate', { authorKey: k1 });
  await manager.install(v1, { start: false });

  // 同一个 (origin,id)、另一把钥 ⇒ 拒（机器分不清"作者换钥"还是"另一个人"）
  const v2 = makePlugin('key-rotate', { authorKey: k2 });
  const err = await rejects(() => manager.install(v2, { start: false }), 'PLUGIN_AUTHOR_MISMATCH');
  assert.equal(err.params.expected, k1.fingerprint);
  assert.equal(err.params.actual, k2.fingerprint);
  // 记录与名册都没被动过（拒绝是"什么都没发生"）
  assert.equal(manager.status(ref('key-rotate')).authorFingerprint, k1.fingerprint);
  assert.equal(loadAuthors().authors.find((a) => a.id === '@spc/key-rotate')?.pub, k1.pub);

  // 管理员显式接受
  const view = await manager.install(v2, { start: false, acceptKeyChange: true });
  assert.equal(view.authorFingerprint, k2.fingerprint);
  assert.equal(loadAuthors().authors.find((a) => a.id === '@spc/key-rotate')?.fingerprint, k2.fingerprint);
  assert.ok(
    auditEntries().some((e) => e.method === 'plugin.key-change' && e.detail?.fingerprint === k2.fingerprint),
    '换钥必须留痕（谁在什么时候把哪把钥换成了哪把）',
  );
  await manager.uninstall(ref('key-rotate'));
});

test('撤回授权不影响身份：升级时作者公钥一致才放行（同一把钥 = 同一个插件）', async () => {
  const key = newTestKey();
  await manager.install(makePlugin('stable-author', { authorKey: key }), { start: false });
  // 同一个作者出了新版本（同一把钥）⇒ 正常升级
  const view = await manager.install(makePlugin('stable-author', { authorKey: key }), { start: false });
  assert.equal(view.authorFingerprint, key.fingerprint);
  await manager.uninstall(ref('stable-author'));
});

// ---------------- ③ 依赖身份（比公钥，不比名字） ----------------

test('依赖解析：作者公钥一致 ⇒ 放行；另一把钥 ⇒ PLUGIN_DEPENDENCY_IDENTITY（不是"没装"）', async () => {
  const providerKey = newTestKey();
  const otherKey = newTestKey();
  await manager.install(makePlugin('dep-ok', { authorKey: providerKey }));

  // ① 声明里写对了公钥 ⇒ 起得来
  const good = makePlugin('dep-ok-user', {
    dependencies: { plugins: [{ id: '@spc/dep-ok', author: { pub: providerKey.pub } }] },
  });
  assert.equal((await manager.install(good)).state, 'running');

  // ② 声明里写了**别的一把钥** ⇒ 身份不符（装了同名插件，但不是这个作者）
  const wrong = makePlugin('dep-wrong-key', {
    dependencies: { plugins: [{ id: '@spc/dep-ok', author: { pub: otherKey.pub } }] },
  });
  const err = await rejects(() => manager.install(wrong), 'PLUGIN_DEPENDENCY_IDENTITY');
  assert.equal(err.params.reason, 'author-mismatch');
  assert.equal(err.params.expected, otherKey.fingerprint);
  assert.equal(err.params.actual, providerKey.fingerprint, '错误里要能看出"实际是谁"');
  await manager.disable(ref('dep-ok-user'));
  await manager.disable(ref('dep-ok'));
});

test('被依赖方没有作者身份 ⇒ author-unknown（不能拿"没自报家门"当满足）', async () => {
  await manager.install(makePlugin('dep-nokey')); // 不带信封
  const user = makePlugin('dep-nokey-user', {
    dependencies: { plugins: [{ id: '@spc/dep-nokey', author: { pub: newTestKey().pub } }] },
  });
  const err = await rejects(() => manager.install(user), 'PLUGIN_DEPENDENCY_IDENTITY');
  assert.equal(err.params.reason, 'author-unknown');
  await manager.disable(ref('dep-nokey'));
});

// ---------------- ④ origin 的四格：本地目标省略 ⇒ 本地范围唯一匹配（promote 安全的根据） ----------------

test('本地目标省略 origin：在**本地源范围**内按 (author.pub, id) 唯一匹配（于是 promote 不打断依赖）', async () => {
  const key = newTestKey();
  // 被依赖方装在**另一个**本地源里（不是依赖方自己的桶）—— 正是 promote 之后的形态
  ensureBucket('local:std-a');
  await manager.install(makePluginAt('promoted', '@spc/shared-lib', { authorKey: key }), {
    source: 'local:std-a',
  });

  const consumer = makePlugin('promoted-user', {
    // 声明里**不写 origin**（作者签名时不可能知道装机的人会把桶起成什么名字）
    dependencies: { plugins: [{ id: '@spc/shared-lib', author: { pub: key.pub } }] },
  });
  const view = await manager.install(consumer);
  assert.equal(view.state, 'running', '跨桶也能解析到（靠公钥，不靠桶名）');

  await manager.disable(ref('promoted-user'));
  await manager.disable('local:std-a/@spc/shared-lib');
});

test('本地范围内同一把钥 + 同一个 id 出现在两个源 ⇒ PLUGIN_REF_AMBIGUOUS（不猜）', async () => {
  const key = newTestKey();
  ensureBucket('local:dup-a');
  ensureBucket('local:dup-b');
  await manager.install(makePluginAt('dup-a', '@spc/dup-lib', { authorKey: key }), { source: 'local:dup-a' });
  await manager.install(makePluginAt('dup-b', '@spc/dup-lib', { authorKey: key }), { source: 'local:dup-b' });

  const consumer = makePlugin('dup-user', {
    dependencies: { plugins: [{ id: '@spc/dup-lib', author: { pub: key.pub } }] },
  });
  await rejects(() => manager.install(consumer), 'PLUGIN_REF_AMBIGUOUS');

  // 写明是哪一个就不歧义了
  const pinned = makePlugin('dup-user-pinned', {
    dependencies: { plugins: [{ id: '@spc/dup-lib', origin: 'local:dup-b', author: { pub: key.pub } }] },
  });
  assert.equal((await manager.install(pinned)).state, 'running');
  await manager.disable(ref('dup-user-pinned'));
  await manager.disable('local:dup-a/@spc/dup-lib');
  await manager.disable('local:dup-b/@spc/dup-lib');
});

test('市场包不许依赖本地源 ⇒ PLUGIN_DEPENDENCY_SOURCE（那种声明在别的机器上永远不成立）', async () => {
  const key = newTestKey();
  await manager.install(makePluginAt('local-only', '@spc/local-only', { authorKey: key }), {
    source: 'local:default',
  });
  // ⑥c 起"装到某个来源"要求那个来源已在 keyring 里 ⇒ 市场来源要先配上（这里验的是依赖声明规则）
  ensureMarketSource('market.example.test', newTestKey().pub);
  const market = makePlugin('market-consumer', {
    dependencies: {
      plugins: [{ id: '@spc/local-only', origin: 'local:default', author: { pub: key.pub } }],
    },
  });
  const err = await rejects(
    () => manager.install(market, { source: 'market.example.test' }),
    'PLUGIN_DEPENDENCY_SOURCE',
  );
  assert.equal(err.params.reason, 'market-depends-on-local');
  await manager.disable(ref('local-only'));
});

// ---------------- ⑤ 名册 fail-closed ----------------

test('名册损坏 ⇒ AUTHORS_INVALID（绝不"当空名册继续跑"：那会把已知作者降级成首见）', async () => {
  const file = authorsFilePath();
  const backup = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  try {
    writeFileSync(file, '{ not json', 'utf8');
    await rejects(
      () => manager.install(makePlugin('roster-broken', { authorKey: newTestKey() }), { start: false }),
      'AUTHORS_INVALID',
    );
    // 结构合法但指纹与公钥不自洽：同样拒（记了一把对不上的钥 ⇒ 判定会跟着错）
    writeFileSync(
      file,
      JSON.stringify({
        authorsSchema: 1,
        authors: [
          {
            origin: 'local:default',
            id: '@spc/x',
            pub: newTestKey().pub,
            fingerprint: 'sha256:' + '0'.repeat(64),
            firstSeenAt: '2026-09-25T00:00:00Z',
          },
        ],
      }),
      'utf8',
    );
    await rejects(
      () => manager.install(makePlugin('roster-bad-fp', { authorKey: newTestKey() }), { start: false }),
      'AUTHORS_INVALID',
    );
  } finally {
    if (backup !== undefined) writeFileSync(file, backup, 'utf8');
    else rmSync(file, { force: true });
  }
});

test('元数据缺 authorPub / metaSchema 不是 2 ⇒ 装载前就拒（信封缺失的那一半）', async () => {
  const key = newTestKey();
  const dir = makePlugin('bad-meta', { authorKey: key });
  // 把 authorPub 从 meta 里删掉（签名自然也对不上 ⇒ 任一码都算拒，这里断言"不是通过"）
  const meta = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')) as Record<string, unknown>;
  delete meta.authorPub;
  writeFileSync(join(dir, META_FILE), JSON.stringify(meta), 'utf8');
  let caught: unknown;
  try {
    await manager.install(dir, { start: false });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof SpcError, '缺 authorPub 必须被拒');
  assert.equal((caught as SpcErrorT).code, 'PACKAGE_META_MALFORMED');
  assert.equal((caught as SpcErrorT).params.reason, 'authorPub');
});
