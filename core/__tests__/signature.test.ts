// 签名与源：规范化 / 指纹 / keyring / 链式轮换 / 包校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalize, isCanonical, parseStrictJson } from '../sources/canonical';
import { assertFingerprint, ed25519Verify, fingerprintOf } from '../sources/keys';
import { Keyring, type SourceEntry } from '../sources/keyring';
import {
  parseKeyStatus,
  signableNodePayload,
  verifyRotation,
  type KeyNode,
  type KeyStatusDoc,
} from '../sources/status';
import { loadPackageDir, metaSigningBytes, sha256Hex, verifyPackage, type MetaDoc } from '../sources/verify';

// ---------- 工具 ----------

interface TestKey {
  pub: string;
  priv: KeyObject;
  fingerprint: string;
}

function newKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const pub = Buffer.from(jwk.x, 'base64url').toString('base64');
  return { pub, priv: privateKey, fingerprint: fingerprintOf(pub) };
}

/** 造一个链节点：sig 由前驱私钥签出（根节点无 sig） */
function makeNode(key: TestKey, signedBy: string | null, prevPriv?: KeyObject): KeyNode {
  const node: KeyNode = { fingerprint: key.fingerprint, pub: key.pub, signedBy, retiredAt: null };
  if (prevPriv) {
    node.sig = edSign(null, Buffer.from(signableNodePayload(node, ORIGIN), 'utf8'), prevPriv).toString('base64');
  }
  return node;
}

const ORIGIN = 'market.example.test';

function makeDoc(keys: KeyNode[], rotatedAt = '2026-09-12T00:00:00Z', revoked: KeyStatusDoc['revoked'] = []): KeyStatusDoc {
  return {
    statusSchema: 1,
    origin: ORIGIN,
    rotatedAt,
    current: keys[keys.length - 1].fingerprint,
    keys,
    revoked,
  };
}

function source(over: Partial<SourceEntry> = {}): SourceEntry {
  return {
    origin: ORIGIN,
    pub: undefined,
    fingerprint: undefined,
    alias: 'test',
    enabled: true,
    addedAt: '2026-08-01T00:00:00Z',
    firstTrust: 'manual',
    suspended: null,
    ...over,
  };
}

// ---------- 规范化 JSON（§4）----------

test('canonicalize：键按 UTF-8 字节序升序、无空白', () => {
  assert.equal(canonicalize({ b: 1, a: 2, A: 3 }), '{"A":3,"a":2,"b":1}');
  assert.equal(canonicalize({ nested: { y: [1, 2], x: null } }), '{"nested":{"x":null,"y":[1,2]}}');
});

test('canonicalize：只允许整数（浮点/-0 抛错）', () => {
  assert.throws(() => canonicalize({ n: 1.5 }), /PACKAGE_META_MALFORMED/);
  assert.throws(() => canonicalize({ n: -0 }), /PACKAGE_META_MALFORMED/);
  assert.equal(canonicalize({ n: 0 }), '{"n":0}');
});

test('canonicalize：字符串转义符合约定（控制字符走 \\u）', () => {
  assert.equal(canonicalize({ s: 'a"b\\c\nd\u0001' }), '{"s":"a\\"b\\\\c\\nd\\u0001"}');
});

test('parseStrictJson：拒绝重复键', () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /PACKAGE_META_MALFORMED/);
});

test('parseStrictJson：拒绝尾随逗号与注释', () => {
  assert.throws(() => parseStrictJson('{"a":1,}'), /PACKAGE_META_MALFORMED/);
  assert.throws(() => parseStrictJson('[1,2,/*x*/3]'), /PACKAGE_META_MALFORMED/);
});

test('parseStrictJson：拒绝浮点、前导零、-0、BOM、\\/ 转义', () => {
  assert.throws(() => parseStrictJson('{"n":1.0}'), /PACKAGE_META_MALFORMED/);
  assert.throws(() => parseStrictJson('{"n":01}'), /PACKAGE_META_MALFORMED/);
  assert.throws(() => parseStrictJson('{"n":-0}'), /PACKAGE_META_MALFORMED/);
  assert.throws(() => parseStrictJson('\ufeff{"a":1}'), /PACKAGE_META_MALFORMED/);
  assert.throws(() => parseStrictJson('{"s":"a\\/b"}'), /PACKAGE_META_MALFORMED/);
});

test('isCanonical：规范形式通过，美化过的文本不通过', () => {
  const canonical = canonicalize({ a: 1, b: [true, null] });
  assert.equal(isCanonical(canonical), true);
  assert.equal(isCanonical(`${JSON.stringify({ a: 1, b: [true, null] }, null, 2)}`), false);
});

// ---------- 公钥指纹与验签（§4）----------

test('fingerprintOf：对裸 32 字节公钥求 sha256（不是对 base64 文本）', () => {
  const k = newKey();
  const raw = Buffer.from(k.pub, 'base64');
  const expected = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  assert.equal(k.fingerprint, expected);
  assert.notEqual(k.fingerprint, `sha256:${createHash('sha256').update(k.pub).digest('hex')}`);
});

test('assertFingerprint：不一致时抛 KEY_FINGERPRINT_MISMATCH', () => {
  const k = newKey();
  assert.doesNotThrow(() => assertFingerprint(k.pub, k.fingerprint));
  assert.throws(() => assertFingerprint(k.pub, 'sha256:deadbeef'), /KEY_FINGERPRINT_MISMATCH/);
});

test('ed25519Verify：正确签名通过，篡改字节与错误公钥失败', () => {
  const k = newKey();
  const data = Buffer.from('hello', 'utf8');
  const sig = edSign(null, data, k.priv).toString('base64');
  assert.equal(ed25519Verify(k.pub, data, sig), true);
  assert.equal(ed25519Verify(k.pub, Buffer.from('hello!', 'utf8'), sig), false);
  assert.equal(ed25519Verify(newKey().pub, data, sig), false);
});

// ---------- keyring（§5）----------

test('keyring：增删改查与暂停状态落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spc-keyring-'));
  try {
    const kr = Keyring.open(dir);
    const k = newKey();
    kr.add(source({ pub: k.pub, fingerprint: k.fingerprint, alias: '自建市场' }));
    assert.equal(kr.get(ORIGIN)?.alias, '自建市场');

    kr.suspend(ORIGIN, 'KEY_CHAIN_INVALID');
    const reopened = Keyring.open(dir);
    assert.equal(reopened.get(ORIGIN)?.suspended?.reason, 'KEY_CHAIN_INVALID');

    reopened.clearSuspended(ORIGIN);
    assert.equal(reopened.get(ORIGIN)?.suspended, null);
    assert.equal(reopened.setEnabled(ORIGIN, false).enabled, false);
    assert.equal(reopened.remove(ORIGIN), true);
    assert.equal(reopened.get(ORIGIN), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keyring：非法 origin 与 pub/fingerprint 不一致都被拒', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spc-keyring-'));
  try {
    const kr = Keyring.open(dir);
    assert.throws(() => kr.add(source({ origin: 'Bad_Origin' })), /SOURCE_ORIGIN_INVALID/);
    const k = newKey();
    assert.throws(() => kr.add(source({ pub: k.pub, fingerprint: 'sha256:nope' })), /KEY_FINGERPRINT_MISMATCH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keyring：内置官方源按需补齐', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spc-keyring-'));
  try {
    const kr = Keyring.open(dir);
    const entry = kr.ensureDefaultOrigin();
    assert.equal(entry.origin, 'market.spc.xfyweb.cn');
    assert.equal(kr.get('market.spc.xfyweb.cn')?.pub, undefined); // 首次使用再 TOFU 拉取
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 链式轮换（§6.1）----------

test('轮换：k0 → k1 → k2 逐跳验通，且吊销记录不参与判定', () => {
  const k0 = newKey();
  const k1 = newKey();
  const k2 = newKey();
  const doc = makeDoc(
    [makeNode(k0, null), makeNode(k1, k0.fingerprint, k0.priv), makeNode(k2, k1.fingerprint, k1.priv)],
    '2026-09-12T00:00:00Z',
    // 吊销条目是纯数据：即使完全没有签名也不影响验证（§6.1.1）
    [{ fingerprint: k0.fingerprint, revokedAt: '2026-07-01T00:00:00Z', reason: 'PRIVATE_KEY_LEAK' }],
  );

  const res = verifyRotation(doc, { fingerprint: k0.fingerprint, pub: k0.pub });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.current.fingerprint, k2.fingerprint);
  assert.deepEqual(res.highWater.revoked, [k0.fingerprint]);
});

test('轮换：本端节点不在 keys[] → KEY_ROTATION_UNVERIFIABLE（暂停）', () => {
  const k0 = newKey();
  const k1 = newKey();
  const gone = newKey();
  const doc = makeDoc([makeNode(k0, null), makeNode(k1, k0.fingerprint, k0.priv)]);
  const res = verifyRotation(doc, { fingerprint: gone.fingerprint, pub: gone.pub });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'KEY_ROTATION_UNVERIFIABLE');
});

test('轮换：篡改后继节点 → KEY_CHAIN_INVALID', () => {
  const k0 = newKey();
  const k1 = newKey();
  const node1 = makeNode(k1, k0.fingerprint, k0.priv);
  node1.retiredAt = '2026-09-12T00:00:00Z'; // 篡改被签内容（sig 不再匹配）
  const res = verifyRotation(makeDoc([makeNode(k0, null), node1]), { fingerprint: k0.fingerprint, pub: k0.pub });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'KEY_CHAIN_INVALID');
});

test('轮换：pub 与 fingerprint 不自洽 → KEY_CHAIN_INVALID', () => {
  const k0 = newKey();
  const other = newKey();
  const bad: KeyNode = { fingerprint: k0.fingerprint, pub: other.pub, signedBy: null, retiredAt: null };
  const res = verifyRotation(makeDoc([bad]), { fingerprint: k0.fingerprint, pub: k0.pub });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'KEY_CHAIN_INVALID');
});

test('轮换：回放更旧的状态文档 → KEY_STATUS_ROLLBACK', () => {
  const k0 = newKey();
  const k1 = newKey();
  const doc = makeDoc([makeNode(k0, null), makeNode(k1, k0.fingerprint, k0.priv)], '2026-08-01T00:00:00Z');
  const res = verifyRotation(doc, { fingerprint: k0.fingerprint, pub: k0.pub }, {
    rotatedAt: '2026-09-12T00:00:00Z',
    fingerprint: k0.fingerprint,
    revoked: [],
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'KEY_STATUS_ROLLBACK');
});

test('轮换：文档结构非法 / origin 不符 → KEY_STATUS_MALFORMED', () => {
  assert.equal(parseKeyStatus('not json', ORIGIN).ok, false);
  assert.equal(parseKeyStatus(canonicalize({ statusSchema: 1 }), ORIGIN).ok, false);
  const k = newKey();
  const doc = makeDoc([makeNode(k, null)]);
  assert.equal(parseKeyStatus(canonicalize({ ...doc, origin: 'other.test' }), ORIGIN).ok, false);
  const parsed = parseKeyStatus(canonicalize(doc), ORIGIN);
  assert.equal(parsed.ok, true);
});

// ---------- 包校验（§7.1）----------

function writePackage(dir: string, k: TestKey, over: { manifestId?: string; authorId?: string; extraFile?: boolean; breakMain?: boolean; metaType?: string } = {}) {
  const manifest = {
    schema: 2,
    id: over.manifestId ?? '@xfy2412/demo',
    name: 'Demo',
    version: { code: 1, name: '0.0.1' },
    compat: { minCore: '0.1.0' },
    runtime: { type: 'quickjs' },
    permissions: [{ name: 'fs.write.data' }],
    ...(over.authorId ? { author: { id: over.authorId } } : {}),
  };
  const manifestBytes = Buffer.from(canonicalize(manifest), 'utf8');
  const mainBytes = Buffer.from('export const x = 1;\n', 'utf8');
  const meta: MetaDoc = {
    metaSchema: 1,
    id: manifest.id,
    version: { code: 1, name: '0.0.1' },
    type: over.metaType ?? 'ability',
    compat: { minCore: '0.1.0' },
    releasedAt: '2026-09-01T00:00:00Z',
    files: [
      { path: 'manifest.json', sha256: sha256Hex(manifestBytes), size: manifestBytes.length },
      { path: 'main.js', sha256: sha256Hex(over.breakMain ? Buffer.from('tampered') : mainBytes), size: mainBytes.length },
    ],
  };
  const metaBytes = metaSigningBytes(meta);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.meta.json'), metaBytes);
  writeFileSync(join(dir, 'plugin.meta.sig'), edSign(null, metaBytes, k.priv));
  writeFileSync(join(dir, 'manifest.json'), manifestBytes);
  writeFileSync(join(dir, 'main.js'), mainBytes);
  if (over.extraFile) writeFileSync(join(dir, 'sneaky.js'), '// 不在清单里');
  return metaBytes;
}

test('包校验：合法包通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spc-pkg-'));
  try {
    const k = newKey();
    writePackage(dir, k);
    const res = verifyPackage(loadPackageDir(dir), source({ pub: k.pub, fingerprint: k.fingerprint }));
    assert.equal(res.ok, true, JSON.stringify(res));
    if (res.ok) assert.equal(res.meta.id, '@xfy2412/demo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('包校验：换一把私钥签名 → META_SIGNATURE_INVALID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spc-pkg-'));
  try {
    const other = newKey();
    writePackage(dir, other);
    const mine = newKey();
    const res = verifyPackage(loadPackageDir(dir), source({ pub: mine.pub, fingerprint: mine.fingerprint }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'META_SIGNATURE_INVALID');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('包校验：清单外的文件 → PACKAGE_EXTRA_FILE；内容被改 → PACKAGE_FILE_MISMATCH', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'spc-pkg-'));
  const dirB = mkdtempSync(join(tmpdir(), 'spc-pkg-'));
  try {
    const k = newKey();
    const src = source({ pub: k.pub, fingerprint: k.fingerprint });
    writePackage(dirA, k, { extraFile: true });
    const resA = verifyPackage(loadPackageDir(dirA), src);
    assert.equal(resA.ok, false);
    if (!resA.ok) assert.equal(resA.code, 'PACKAGE_EXTRA_FILE');

    writePackage(dirB, k, { breakMain: true });
    const resB = verifyPackage(loadPackageDir(dirB), src);
    assert.equal(resB.ok, false);
    if (!resB.ok) assert.equal(resB.code, 'PACKAGE_FILE_MISMATCH');
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('包校验：meta 与 manifest 不一致 → META_MANIFEST_MISMATCH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spc-pkg-'));
  try {
    const k = newKey();
    writePackage(dir, k, { metaType: 'driver' }); // manifest 是 ability
    const res = verifyPackage(loadPackageDir(dir), source({ pub: k.pub, fingerprint: k.fingerprint }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'META_MANIFEST_MISMATCH');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('包校验：作者 ID 与命名空间/源域名不一致 → AUTHOR_MISMATCH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spc-pkg-'));
  try {
    const k = newKey();
    writePackage(dir, k, { authorId: 'someone-else@market.example.test' });
    const res = verifyPackage(loadPackageDir(dir), source({ pub: k.pub, fingerprint: k.fingerprint }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'AUTHOR_MISMATCH');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('包校验：源停用 / 暂停 / 未取到公钥 → 各自的码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spc-pkg-'));
  try {
    const k = newKey();
    writePackage(dir, k);
    const pkg = loadPackageDir(dir);
    const cases: Array<[SourceEntry, string]> = [
      [source({ pub: k.pub, fingerprint: k.fingerprint, enabled: false }), 'SOURCE_DISABLED'],
      [source({ pub: k.pub, fingerprint: k.fingerprint, suspended: { at: 'x', reason: 'KEY_CHAIN_INVALID' } }), 'SOURCE_SUSPENDED'],
      [source(), 'SOURCE_NOT_CONFIGURED'],
    ];
    for (const [src, expected] of cases) {
      const res = verifyPackage(pkg, src);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('包校验：缺信封文件 → PACKAGE_META_MISSING', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spc-pkg-'));
  try {
    mkdirSync(dir, { recursive: true });
    assert.throws(() => loadPackageDir(dir), /PACKAGE_META_MISSING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
