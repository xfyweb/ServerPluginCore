// ⑥c 本地安装落桶测试（docs/plugin-signature-design.md §3bis 的"期望值解析" + §7.2 的本地安装流）
//
// 覆盖：按公钥自动落桶 / 显式 --source 必须指向真桶 / 多桶同锚歧义 / 源锚第一期望值（含"改锚不追溯"之后的
//       重装被拒）/ 无身份包与锚 / promote 建议的出现与消失。
//
// 隔离：SPC_STATE_DIR / SPC_KEYRING_DIR / SPC_AUDIT_DIR 必须在**动态 import 之前**设好。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-bucket-'));
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_KEYRING_DIR = join(TMP, 'keyring');
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

const { manager } = await import('../plugin/manager.ts');
const { SpcError } = await import('../errors.ts');
const { findAuthor } = await import('../sources/authors.ts');
const { loadRecords } = await import('../plugin/records.ts');
const { DEFAULT_LOCAL_SOURCE } = await import('../config.ts');
const { newTestKey, signPluginDir } = await import('./helpers/signed-plugin.ts');
const { ensureBucket } = await import('./helpers/buckets.ts');
import type { TestKey } from './helpers/signed-plugin.ts';

// ---------------- 夹具 ----------------

const id = (name: string, pub = 'spc') => `@${pub}/${name}`;

/** 造一个能力插件（可带作者信封） */
function makePlugin(dirName: string, pluginId: string, authorKey?: TestKey): string {
  const dir = join(TMP, 'plugins', dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        schema: 2,
        id: pluginId,
        name: `Fixture ${dirName}`,
        version: { code: 1, name: '0.0.1' },
        runtime: { type: 'quickjs', esm: true },
        permissions: [{ name: 'fs.read.data' }],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(dir, 'main.ts'), 'export function init() {}\n', 'utf8');
  if (authorKey) signPluginDir(dir, authorKey);
  return dir;
}

async function install(dir: string, opts: { source?: string } = {}): Promise<string> {
  const view = await manager.install(dir, opts.source ? { source: opts.source } : {});
  return view.ref;
}

const rejectCode = (code: string) => (e: unknown) => e instanceof SpcError && e.code === code;

// ---------------- 自动落桶 ----------------

test('不给 --source：按包的公钥自动落进**绑了同一把锚**的桶', async () => {
  const key = newTestKey();
  ensureBucket('local:std-a', key.pub);
  const ref = await install(makePlugin('auto-1', id('auto-1'), key));
  assert.equal(ref, `local:std-a/${id('auto-1')}`, '作者已有专属桶 ⇒ 不用管理员再指定');

  // 同一把钥的第二个包也自动落进去
  const second = await install(makePlugin('auto-2', id('auto-2'), key));
  assert.equal(second, `local:std-a/${id('auto-2')}`);
});

test('不给 --source 且没有专属桶 ⇒ 落杂桶 local:default（未带信封的包同样）', async () => {
  const key = newTestKey();
  assert.equal(await install(makePlugin('plain-1', id('plain-1'), key)), `${DEFAULT_LOCAL_SOURCE}/${id('plain-1')}`);
  // 没有作者身份 ⇒ 满足不了任何绑了锚的桶，只能进杂桶
  assert.equal(await install(makePlugin('unsigned-1', id('unsigned-1'))), `${DEFAULT_LOCAL_SOURCE}/${id('unsigned-1')}`);
});

test('显式 --source 指向不存在的桶 ⇒ SOURCE_NOT_CONFIGURED（提示先 spc source add），不落记录', async () => {
  const key = newTestKey();
  const dir = makePlugin('missing-bucket', id('missing-bucket'), key);
  await assert.rejects(() => manager.install(dir, { source: 'local:nope' }), rejectCode('SOURCE_NOT_CONFIGURED'));
  assert.equal(loadRecords().plugins.some((p) => p.id === id('missing-bucket')), false);
});

test('来源形状非法 ⇒ 仍是 PLUGIN_SOURCE_INVALID（老的码不变）', async () => {
  const dir = makePlugin('bad-source', id('bad-source'), newTestKey());
  await assert.rejects(() => manager.install(dir, { source: 'local:' }), rejectCode('PLUGIN_SOURCE_INVALID'));
  await assert.rejects(() => manager.install(dir, { source: 'Bad_Origin' }), rejectCode('PLUGIN_SOURCE_INVALID'));
});

test('两把不同的钥各自的桶 ⇒ 各回各家；同一把钥有两个桶 ⇒ 歧义拒（不猜）', async () => {
  const a = newTestKey();
  const b = newTestKey();
  ensureBucket('local:std-a', a.pub); // 这条用例自己的钥（前面的用例用过这个名字，锚会被改成 a）
  ensureBucket('local:std-b', b.pub);
  assert.equal(await install(makePlugin('two-a', id('two-a'), a)), `local:std-a/${id('two-a')}`);
  assert.equal(await install(makePlugin('two-b', id('two-b'), b)), `local:std-b/${id('two-b')}`);

  // 同一把钥绑在**两个**桶上（锚相同 = 同一组，但"装哪一个"说不清）
  ensureBucket('local:std-a2', a.pub);
  await assert.rejects(
    () => manager.install(makePlugin('two-amb', id('two-amb'), a)),
    (e: unknown) => e instanceof SpcError && e.code === 'PLUGIN_SOURCE_AMBIGUOUS',
  );
  // 显式指定就不歧义了
  assert.equal(
    await install(makePlugin('two-amb2', id('two-amb2'), a), { source: 'local:std-a2' }),
    `local:std-a2/${id('two-amb2')}`,
  );
});

// ---------------- 源锚是第一期望值 ----------------

test('桶的锚与包不符 ⇒ PLUGIN_ANCHOR_MISMATCH（--accept-key-change 也绕不过去）', async () => {
  const owner = newTestKey();
  const other = newTestKey();
  ensureBucket('local:std-c', owner.pub);
  const dir = makePlugin('anchor-mismatch', id('anchor-mismatch'), other);

  await assert.rejects(() => manager.install(dir, { source: 'local:std-c' }), rejectCode('PLUGIN_ANCHOR_MISMATCH'));
  // 显式接受换钥也没用：锚是管理员对**这个桶**的断言，要换得改锚
  await assert.rejects(
    () => manager.install(dir, { source: 'local:std-c', acceptKeyChange: true }),
    rejectCode('PLUGIN_ANCHOR_MISMATCH'),
  );
  assert.equal(loadRecords().plugins.some((p) => p.id === id('anchor-mismatch')), false, '被拒不留记录');
  assert.equal(findAuthor('local:std-c', id('anchor-mismatch')), undefined, '被拒也不动名册');
});

test('没有作者身份的包进不了绑了锚的桶（actual = none）', async () => {
  const owner = newTestKey();
  ensureBucket('local:std-d', owner.pub);
  // 只关心"抛了哪条码、参数是什么"，所以这里不引入 SpcError 的类型（它是动态 import 的值）
  const err = await manager.install(makePlugin('anchor-none', id('anchor-none')), { source: 'local:std-d' }).then(
    () => undefined,
    (e: { code?: string; params?: Record<string, string> }) => e,
  );
  assert.equal(err?.code, 'PLUGIN_ANCHOR_MISMATCH');
  assert.equal(err?.params?.actual, 'none');
});

test('改锚不追溯：桶改锚后，用**旧钥**重装同一个包被拒（锚是第一期望值）', async () => {
  const k1 = newTestKey();
  const k2 = newTestKey();
  ensureBucket('local:std-e', k1.pub);
  const dir = makePlugin('rekey', id('rekey'), k1);
  const view = await manager.install(dir, { source: 'local:std-e' });
  assert.equal(view.authorFingerprint, k1.fingerprint);

  ensureBucket('local:std-e', k2.pub); // 改锚（只影响后续安装）
  assert.equal(manager.status(view.ref).authorFingerprint, k1.fingerprint, '已装插件的指纹一个字不动');
  assert.equal(findAuthor('local:std-e', id('rekey'))?.fingerprint, k1.fingerprint, '名册也不动');

  // 重装（"后续安装"）⇒ 锚说了算 ⇒ 旧钥的包被拒
  await assert.rejects(() => manager.install(dir, { source: 'local:std-e' }), rejectCode('PLUGIN_ANCHOR_MISMATCH'));
});

// ---------------- promote 建议 ----------------

test('promote 建议：同一把钥的第二例出现 ⇒ 给出"建桶 + 一起搬"两条现成命令', async () => {
  const key = newTestKey();
  // 两个包都在杂桶里（同一作者）⇒ 该给他单独建桶了
  const first = await install(makePlugin('promo-1', id('promo-1'), key));
  assert.equal(manager.promoteSuggestion(first), undefined, '只有一例时不必建桶');
  const second = await install(makePlugin('promo-2', id('promo-2'), key));

  const s = manager.promoteSuggestion(second);
  assert.ok(s, '第二例出现 ⇒ 必须有建议');
  assert.match(s.origin, /^local:spc/, '桶名由发布者段推出来（@spc/… ⇒ local:spc）');
  assert.equal(s.anchor, key.fingerprint);
  assert.equal(s.pub, key.pub, '建桶命令要用作者公钥');
  assert.deepEqual(s.refs, [first, second].sort(), '建议把这一组一起搬过去');
});

test('promote 建议：桶建好并搬过去之后自己消失', async () => {
  const key = newTestKey();
  const a = await install(makePlugin('promo-a', id('promo-a'), key));
  const b = await install(makePlugin('promo-b', id('promo-b'), key));
  const s = manager.promoteSuggestion(b);
  assert.ok(s);

  // 照建议做：建带锚的桶 → 批量搬（reanchor 已经是原子的）
  ensureBucket(s.origin, key.pub);
  await manager.reanchor(s.refs, s.origin);
  assert.equal(manager.promoteSuggestion(`${s.origin}/${id('promo-a')}`), undefined, '已经在自己桶里 ⇒ 不再建议');
  assert.equal(manager.promoteSuggestion(`${s.origin}/${id('promo-b')}`), undefined);

  // 而且下一个同钥的包会**自动**落进这个桶（闭环）
  assert.equal(await install(makePlugin('promo-c', id('promo-c'), key)), `${s.origin}/${id('promo-c')}`);
  // 旧引用**不存在了**：换源是搬家，不是"复制一份"
  assert.throws(
    () => manager.status(a),
    (e: unknown) => e instanceof SpcError && e.code === 'PLUGIN_NOT_FOUND',
  );
});

test('promote 建议：已经装在专属桶里 / 没有作者身份 ⇒ 都不建议', async () => {
  const key = newTestKey();
  ensureBucket('local:std-f', key.pub);
  const inBucket = await install(makePlugin('promo-d', id('promo-d'), key));
  await install(makePlugin('promo-e', id('promo-e'), key)); // 同钥第二个，也自动落同一个桶
  assert.equal(manager.promoteSuggestion(inBucket), undefined);

  const unsigned = await install(makePlugin('promo-unsigned', id('promo-unsigned')));
  assert.equal(manager.promoteSuggestion(unsigned), undefined, '没作者身份 ⇒ 无从分组');
});
