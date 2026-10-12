// 源（keyring）测试：本地桶条目 / 两类条目的校验 / TOFU 拉取 / 管理动作与审计
// 设计见 docs/plugin-signature-design.md §3bis / §5 / §6.3 / §7.3。
//
// 隔离：SPC_STATE_DIR / SPC_KEYRING_DIR / SPC_AUDIT_DIR 必须在**动态 import 之前**设好
// （core/audit.ts 的 AUDIT_DIR 是模块级常量，见其注释）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-sources-'));
const KEYRING_DIR = join(TMP, 'keyring');
const KEYRING_FILE = join(KEYRING_DIR, 'keyring.json');
const AUDIT_FILE = join(TMP, 'audit', 'audit.jsonl');
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_KEYRING_DIR = KEYRING_DIR;
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

const { Keyring, anchorOf, keyring, resetKeyring, validateSourceEntry } = await import('../sources/keyring.ts');
// 审计目录是模块级常量（import 时求值）⇒ 必须在设置了 SPC_AUDIT_DIR 之后再 import，
// 并显式 initAudit()（它负责建目录；没有目录时 audit() 会静默进内存缓冲，断言就会看到 0 条）
const { initAudit } = await import('../audit.ts');
initAudit();
const {
  addSource,
  getSource,
  listSources,
  removeSource,
  seedBuiltinSources,
  setSourceAlias,
  setSourceAnchor,
  setSourceEnabled,
  sourceUsage,
} = await import('../sources/manage.ts');
const { SpcError } = await import('../errors.ts');
const { fingerprintOf } = await import('../sources/keys.ts');
const { pluginsFile, DEFAULT_LOCAL_SOURCE } = await import('../config.ts');
const { newTestKey } = await import('./helpers/signed-plugin.ts');
const { DEFAULT_ORIGIN } = await import('../sources/keyring.ts');

// ---------------- 夹具 ----------------

/** 每次测试从**空 keyring** 开始（单例按目录缓存，所以清了文件还要丢缓存） */
function freshSources(): void {
  rmSync(KEYRING_FILE, { force: true });
  resetKeyring();
}

/** 写一条"某来源下已装了一个插件"的记录（`sourceUsage` / 删源保护的判据） */
function seedRecord(origin: string, id = '@spc/one'): void {
  const record = {
    id,
    dir: TMP,
    version: { code: 1, name: '0.0.1' },
    enabled: false,
    grants: [],
    capabilities: [],
    configPath: join(TMP, 'config.json'),
    state: 'installed',
    installedAt: new Date().toISOString(),
    lastError: null,
    restartAttempts: 0,
    origin,
    signedBy: null,
    authorFingerprint: null,
    verifiedMeta: null,
  };
  writeFileSync(pluginsFile(), JSON.stringify({ pluginsSchema: 1, plugins: [record] }, null, 2), 'utf8');
}

function readKeyringFile(): { keyringSchema: number; sources: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(KEYRING_FILE, 'utf8')) as {
    keyringSchema: number;
    sources: Record<string, unknown>[];
  };
}

function auditLines(method: string): string[] {
  if (!existsSync(AUDIT_FILE)) return [];
  return readFileSync(AUDIT_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.includes(`"${method}"`));
}

/** 造一个"状态文档端点"的假 fetch（`fetchKeyStatus` 只用到 status/ok/text） */
function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

// ---------------- 条目形状：本地桶与市场源 ----------------

test('本地桶：条目落盘为 kind=local、无源公钥、可带作者锚', async () => {
  freshSources();
  const author = newTestKey();
  const view = await addSource({ origin: 'local:std-a', alias: 'std（小A）', anchorPub: author.pub });

  assert.equal(view.kind, 'local');
  assert.equal(view.pub, null, '本地源不签包 ⇒ 没有源公钥');
  assert.equal(view.fingerprint, null);
  assert.equal(view.authorAnchor?.fingerprint, author.fingerprint);
  assert.equal(view.alias, 'std（小A）');

  const file = readKeyringFile();
  const entry = file.sources.find((s) => s.origin === 'local:std-a');
  assert.ok(entry, '条目要真的落盘');
  assert.equal(entry.kind, 'local');
  assert.equal('pub' in entry, false, '本地源不该写 pub 字段');
  const anchor = entry.authorAnchor as { pub: string; fingerprint: string };
  assert.equal(anchor.pub, author.pub);
  assert.equal(anchor.fingerprint, fingerprintOf(author.pub), '锚的指纹必须与公钥自洽（不是照抄的）');
  assert.deepEqual(auditLines('source.add').length, 1);
});

test('本地桶不许带源公钥（SOURCE_PUB_NOT_APPLICABLE）', async () => {
  freshSources();
  const key = newTestKey();
  await assert.rejects(
    () => addSource({ origin: 'local:std-a', pub: key.pub }),
    (e: unknown) => e instanceof SpcError && e.code === 'SOURCE_PUB_NOT_APPLICABLE',
  );
  assert.equal(getSource('local:std-a'), undefined, '被拒就不该留下条目');
});

test('市场源不许带作者锚（SOURCE_ANCHOR_NOT_ALLOWED）', async () => {
  freshSources();
  const author = newTestKey();
  await assert.rejects(
    () => addSource({ origin: 'market.example.test', pub: newTestKey().pub, anchorPub: author.pub }),
    (e: unknown) => e instanceof SpcError && e.code === 'SOURCE_ANCHOR_NOT_ALLOWED',
  );
});

test('market + 缺省字段（alias 缺省 = origin）', async () => {
  freshSources();
  const key = newTestKey();
  const view = await addSource({ origin: 'market.example.test', pub: key.pub });
  assert.equal(view.kind, 'market');
  assert.equal(view.fingerprint, key.fingerprint);
  assert.equal(view.firstTrust, 'manual', '手填公钥 = manual（离线/无外网路径）');
  assert.equal(view.alias, 'market.example.test');
});

// ---------------- TOFU 拉取（§5 添加源的第 2 步）----------------

test('市场源不带 --pub ⇒ 远程 TOFU：取 current 公钥并落高水位', async () => {
  freshSources();
  const key = newTestKey();
  const doc = {
    statusSchema: 1,
    origin: 'market.example.test',
    rotatedAt: '2026-09-12T00:00:00Z',
    current: key.fingerprint,
    keys: [{ fingerprint: key.fingerprint, pub: key.pub, signedBy: null }],
    revoked: [],
  };
  const view = await addSource({ origin: 'market.example.test' }, { fetchImpl: fakeFetch(doc) });

  assert.equal(view.firstTrust, 'tofu');
  assert.equal(view.fingerprint, key.fingerprint);
  assert.equal(view.highWater?.fingerprint, key.fingerprint, 'TOFU 之后要能防回滚（§6.2）');
  assert.equal(view.highWater?.rotatedAt, '2026-09-12T00:00:00Z');
});

test('TOFU 失败（404）⇒ SOURCE_KEY_FETCH_FAILED，且**不添加**该源', async () => {
  freshSources();
  await assert.rejects(
    () => addSource({ origin: 'market.example.test' }, { fetchImpl: fakeFetch({}, 404) }),
    (e: unknown) => e instanceof SpcError && e.code === 'SOURCE_KEY_FETCH_FAILED',
  );
  assert.equal(getSource('market.example.test'), undefined, '"加一个公钥未知的源"等于加一个谁都验不了的源');
});

test('TOFU：状态文档的 current 不在 keys[] 里 ⇒ 拒（KEY_CHAIN_INVALID）', async () => {
  freshSources();
  const key = newTestKey();
  const doc = {
    statusSchema: 1,
    origin: 'market.example.test',
    rotatedAt: '2026-09-12T00:00:00Z',
    current: key.fingerprint,
    keys: [{ fingerprint: `sha256:${'0'.repeat(64)}`, pub: key.pub, signedBy: null }],
  };
  await assert.rejects(
    () => addSource({ origin: 'market.example.test' }, { fetchImpl: fakeFetch(doc) }),
    (e: unknown) => e instanceof SpcError && e.code === 'SOURCE_KEY_FETCH_FAILED',
  );
});

// ---------------- 读文件宽松 / 写入口严格 ----------------

test('老文件没有 kind ⇒ 归一化成 market（只增不改）', () => {
  freshSources();
  writeFileSync(
    KEYRING_FILE,
    JSON.stringify({
      keyringSchema: 1,
      sources: [
        {
          origin: DEFAULT_ORIGIN,
          alias: '官方市场',
          enabled: true,
          addedAt: '2026-08-01T00:00:00Z',
          firstTrust: 'manual',
          suspended: null,
        },
      ],
    }),
    'utf8',
  );
  resetKeyring();
  const entry = keyring().get(DEFAULT_ORIGIN);
  assert.equal(entry?.kind, 'market');
});

test('单条非法 ⇒ 忽略该条 + 保留合法的（一项坏配置不该把核心挡在门外）', () => {
  freshSources();
  writeFileSync(
    KEYRING_FILE,
    JSON.stringify({
      keyringSchema: 1,
      sources: [
        // ① origin 不是合法域名（且没有 kind 声明为本地） ② 锚的指纹与公钥不自洽
        { origin: 'not a domain', alias: 'x', enabled: true, addedAt: '', firstTrust: 'manual', suspended: null },
        {
          origin: 'local:bad-anchor',
          kind: 'local',
          alias: 'x',
          enabled: true,
          addedAt: '',
          firstTrust: 'manual',
          suspended: null,
          authorAnchor: { pub: newTestKey().pub, fingerprint: `sha256:${'1'.repeat(64)}` },
        },
        { origin: 'market.ok.test', alias: 'ok', enabled: true, addedAt: '', firstTrust: 'manual', suspended: null },
      ],
    }),
    'utf8',
  );
  resetKeyring();
  const kr = keyring();
  assert.equal(kr.get('market.ok.test')?.alias, 'ok');
  assert.equal(kr.get('not a domain'), undefined);
  assert.equal(kr.get('local:bad-anchor'), undefined, '锚不自洽的桶等于"我认定的是哪把钥"说不清 ⇒ 不采用');
  assert.equal(kr.list().length, 1);
});

test('文件级非法 ⇒ KEYRING_INVALID（fail-closed，不当空 keyring 继续跑）', () => {
  freshSources();
  writeFileSync(KEYRING_FILE, '{ not json', 'utf8');
  assert.throws(
    () => Keyring.open(KEYRING_DIR),
    (e: unknown) => e instanceof SpcError && e.code === 'KEYRING_INVALID',
  );
  writeFileSync(KEYRING_FILE, JSON.stringify({ keyringSchema: 2, sources: [] }), 'utf8');
  assert.throws(
    () => Keyring.open(KEYRING_DIR),
    (e: unknown) => e instanceof SpcError && e.code === 'KEYRING_INVALID',
  );
});

test('写入口严格：kind 与 origin 形状必须自洽', () => {
  freshSources();
  const kr = keyring();
  // 声明成市场源却写了本地形状的 origin ⇒ 起源形状的专码（不是笼统的"文件非法"）
  assert.throws(
    () =>
      kr.add({
        origin: 'local:x',
        kind: 'market',
        alias: 'x',
        enabled: true,
        addedAt: '',
        firstTrust: 'manual',
        suspended: null,
      }),
    (e: unknown) => e instanceof SpcError && e.code === 'SOURCE_ORIGIN_INVALID',
  );
  // 形状合法但字段配置错误（本地源带源公钥）⇒ 通用条目码
  assert.throws(
    () =>
      kr.add({
        origin: 'local:x',
        kind: 'local',
        pub: newTestKey().pub,
        alias: 'x',
        enabled: true,
        addedAt: '',
        firstTrust: 'manual',
        suspended: null,
      }),
    (e: unknown) => e instanceof SpcError && e.code === 'KEYRING_INVALID',
  );
  // 校验函数本身：市场源带锚是范畴错误（§3bis）
  const problems = validateSourceEntry({
    origin: 'market.x.test',
    kind: 'market',
    alias: 'x',
    enabled: true,
    addedAt: '',
    firstTrust: 'manual',
    suspended: null,
    authorAnchor: anchorOf(newTestKey().pub),
  });
  assert.ok(problems.some((p) => p.includes('authorAnchor')));
});

test('kind 不可改（SOURCE_KIND_IMMUTABLE）', () => {
  freshSources();
  const kr = keyring();
  kr.add({
    origin: 'local:x',
    kind: 'local',
    alias: 'x',
    enabled: true,
    addedAt: '',
    firstTrust: 'manual',
    suspended: null,
  });
  assert.throws(
    () => kr.update('local:x', { kind: 'market' }),
    (e: unknown) => e instanceof SpcError && e.code === 'SOURCE_KIND_IMMUTABLE',
  );
});

// ---------------- 内置条目与删源保护 ----------------

test('内置条目：官方市场 + 杂桶 local:default，播种幂等', () => {
  freshSources();
  const first = seedBuiltinSources();
  const second = seedBuiltinSources();
  assert.equal(first.length, 2);
  assert.equal(second.length, 2, '重复播种不报错、不重复添加');
  const origins = listSources().map((s) => s.origin);
  assert.deepEqual(origins, [DEFAULT_LOCAL_SOURCE, DEFAULT_ORIGIN].sort());
  const bucket = getSource(DEFAULT_LOCAL_SOURCE);
  assert.equal(bucket?.kind, 'local');
  assert.equal(bucket?.authorAnchor, null, '杂桶不绑锚：绑了就等于宣称这台机器上只有一个作者');
});

test('内置混合来源的别名：旧默认值跟着改名，管理员自己起的标签一个字不动', () => {
  freshSources();
  seedBuiltinSources();
  assert.equal(getSource(DEFAULT_LOCAL_SOURCE)?.alias, '本地混合来源', '新种的别名就是新默认值');

  // ⚠️ 摆状态走 keyring **低层** API：`setSourceAlias` 会往审计里写字，
  // 而本文件后面有用例在**数** `source.alias` 的条数（"改的是条目，落的是审计"那条）。
  const kr = keyring();
  kr.setAlias(DEFAULT_LOCAL_SOURCE, '杂桶'); // 旧种（早期默认别名）
  seedBuiltinSources();
  assert.equal(getSource(DEFAULT_LOCAL_SOURCE)?.alias, '本地混合来源', '旧默认别名要被改掉');

  kr.setAlias(DEFAULT_LOCAL_SOURCE, '我们机房'); // 管理员自己起的名字
  seedBuiltinSources();
  assert.equal(getSource(DEFAULT_LOCAL_SOURCE)?.alias, '我们机房', '自定义标签不许被播种覆盖');
});

test('删源：内置拒 / 有插件归属拒 / 干净可删', async () => {
  freshSources();
  seedBuiltinSources();
  assert.throws(
    () => removeSource(DEFAULT_LOCAL_SOURCE),
    (e: unknown) => e instanceof SpcError && e.code === 'SOURCE_BUILTIN',
  );

  await addSource({ origin: 'local:std-a', alias: 'A', anchorPub: newTestKey().pub });
  assert.equal(sourceUsage('local:std-a'), 0);
  seedRecord('local:std-a');
  assert.equal(sourceUsage('local:std-a'), 1);
  assert.throws(
    () => removeSource('local:std-a'),
    (e: unknown) => e instanceof SpcError && e.code === 'SOURCE_IN_USE',
  );
  assert.ok(getSource('local:std-a'), '被拒 ⇒ 条目还在');

  rmSync(pluginsFile(), { force: true });
  removeSource('local:std-a');
  assert.equal(getSource('local:std-a'), undefined);
  assert.equal(auditLines('source.remove').length, 1);
});

test('启停与别名：改的是条目，落的是审计', async () => {
  freshSources();
  await addSource({ origin: 'local:std-a', alias: 'A' });
  assert.equal(setSourceEnabled('local:std-a', false).enabled, false);
  assert.equal(setSourceEnabled('local:std-a', true).enabled, true);
  assert.equal(setSourceAlias('local:std-a', 'std（小A）').alias, 'std（小A）');
  assert.equal(auditLines('source.disable').length, 1);
  assert.equal(auditLines('source.enable').length, 1);
  assert.equal(auditLines('source.alias').length, 1);
});

// ---------------- 改锚不追溯（§3bis）----------------

test('改锚：只影响后续安装，已装插件仍按旧锚记录（staleCount 报出来）', async () => {
  freshSources();
  const k1 = newTestKey();
  const k2 = newTestKey();
  await addSource({ origin: 'local:std-a', alias: 'A', anchorPub: k1.pub });
  seedRecord('local:std-a');

  const change = setSourceAnchor('local:std-a', k2.pub);
  assert.equal(change.view.authorAnchor?.fingerprint, k2.fingerprint);
  assert.equal(change.staleCount, 1, '"还有 N 个按旧锚记录"必须报给管理员');

  // 记录里的作者指纹一个字都不动（改锚不追溯，与"加载时不重验签名"一致）
  const rec = (JSON.parse(readFileSync(pluginsFile(), 'utf8')) as { plugins: { authorFingerprint: unknown }[] })
    .plugins[0];
  assert.equal(rec.authorFingerprint, null);

  const cleared = setSourceAnchor('local:std-a', null);
  assert.equal(cleared.view.authorAnchor, null, '不带 --pub 就是解绑');
  assert.equal('authorAnchor' in (readKeyringFile().sources[0] as object), false, '解绑后字段不该留在盘上');
  assert.equal(auditLines('source.anchor').length, 2);
});

test('只有本地桶能改锚（市场源 ⇒ SOURCE_ANCHOR_NOT_ALLOWED）', async () => {
  freshSources();
  await addSource({ origin: 'market.example.test', pub: newTestKey().pub });
  assert.throws(
    () => setSourceAnchor('market.example.test', newTestKey().pub),
    (e: unknown) => e instanceof SpcError && e.code === 'SOURCE_ANCHOR_NOT_ALLOWED',
  );
});

test('来源形状非法 ⇒ SOURCE_ORIGIN_INVALID', async () => {
  freshSources();
  await assert.rejects(
    () => addSource({ origin: 'Local:Bad' }),
    (e: unknown) => e instanceof SpcError && e.code === 'SOURCE_ORIGIN_INVALID',
  );
});

/**
 * 判别用例：keyring 的位置必须**跟着 `SPC_STATE_DIR` 走**（`SPC_KEYRING_DIR` 只是覆盖项）。
 *
 * 少了这条，那处修复就没有东西护着：`sources.test.ts` 自己显式设了 `SPC_KEYRING_DIR`，
 * 而 e2e 里 daemon 与 CLI 用的是**同一个** `keyringDir()` —— 退回"自己拼 `<repo>/.spc`"时
 * 两边仍会看到同一份文件（测试照样绿），代价只是**往仓库里写状态**（`.spc/` 被 gitignore，
 * 所以连 `git status` 都不会提醒你）。
 */
test('keyring 跟随 SPC_STATE_DIR（覆盖项 SPC_KEYRING_DIR 才另指）', async () => {
  const { keyringDir } = await import('../sources/keyring.ts');
  const savedKeyring = process.env.SPC_KEYRING_DIR;
  const savedState = process.env.SPC_STATE_DIR;
  try {
    delete process.env.SPC_KEYRING_DIR;
    process.env.SPC_STATE_DIR = join(TMP, 'state-elsewhere');
    assert.equal(keyringDir(), join(TMP, 'state-elsewhere'));
    process.env.SPC_KEYRING_DIR = KEYRING_DIR;
    assert.equal(keyringDir(), KEYRING_DIR, '覆盖项在时优先');
  } finally {
    process.env.SPC_STATE_DIR = savedState;
    if (savedKeyring === undefined) delete process.env.SPC_KEYRING_DIR;
    else process.env.SPC_KEYRING_DIR = savedKeyring;
    resetKeyring();
  }
});
