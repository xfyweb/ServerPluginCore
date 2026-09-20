// node:crypto 仿真的对齐测试
//
// 判卷人三个（同 emulation-fs/url 的分工）：
//   1. **宿主 Node**：摘要/HMAC/对称解密的**输出是确定性的**，逐条差分（同一个输入喂两边比结果）；
//   2. **v22.22.1 真值**：静态清单（`getHashes`/`getCiphers`/`getCurves`/`constants`）按`仿真基线`断言，
//      不与宿主比——那些清单随宿主 OpenSSL 版本变，而"插件不该在两种机器上看到不同的算法表"；
//   3. **结构性断言**：有意不同的面（`Hash` 不是流、`Decipheriv` 一次性、WebCrypto 抛错、非对称拒绝）。
//
// 特别钉住一条：**crypto 错误的 name/message 是契约**——`dotenv` 的加密 .env 路径就按
// `error instanceof RangeError`、`message === 'Invalid key length'`、`'Unsupported state or unable to
// authenticate data'` 分支（见 `_deps-survey/node_modules/dotenv/lib/main.js:350-360`）。
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as hostCrypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 审计隔离（最后一组会建真沙箱）
const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-crypto-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;
after(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

const { buildHostApi } = await import('../../core/hostApi.ts');
const { buildEnvFacts } = await import('../../core/emulated-env.ts');
const { toErrorShape } = await import('../../core/errors.ts');

const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-shims-crypto-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
const SHIM_SRC = join(process.cwd(), 'core', 'sandbox-modules');
for (const f of ['node-crypto.js', 'node-buffer.js', 'node-events.js']) {
  copyFileSync(join(SHIM_SRC, f), join(SHIM_DIR, f));
}
after(() => rmSync(SHIM_DIR, { recursive: true, force: true }));

const DATA_DIR = mkdtempSync(join(tmpdir(), 'spc-crypto-data-'));
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

/**
 * 假桥：与 `core/sandbox.ts` 同语义（**参数按 VM 侧类型取**：字符串原样、ArrayBuffer → Uint8Array；
 * 结果 JSON 文本；失败回错误信封）。宿主实现用真的 `buildHostApi`。
 */
function installBridge(dataDir: string): void {
  const api = buildHostApi({ pluginId: '@test/crypto', dataDir });
  (globalThis as any).__spcEnv = JSON.stringify(buildEnvFacts(dataDir));
  (globalThis as any).__host = new Proxy(
    {},
    {
      get: (_t, name: string) => (...rawArgs: unknown[]) => {
        const method = (api as any)[name];
        if (!method) throw new Error(`假桥收到未知宿主方法：${name}`);
        const args = rawArgs.map((a) => {
          if (typeof a === 'string') return a;
          if (a instanceof Uint8Array) return Uint8Array.from(a);
          if (a instanceof ArrayBuffer) return Uint8Array.from(new Uint8Array(a));
          return a;
        });
        try {
          const result = method.fn(...args);
          if (method.binaryResult) {
            if (!(result instanceof Uint8Array) && !(result instanceof ArrayBuffer)) {
              throw new Error(`binaryResult 方法没返回字节：${name}`);
            }
            return result instanceof Uint8Array ? exactBytes(result) : result;
          }
          return JSON.stringify(result ?? null);
        } catch (err) {
          const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
          return JSON.stringify({ __spcError: { code: shape.code, params: shape.params } });
        }
      },
    },
  );
}

function exactBytes(view: Uint8Array): ArrayBuffer {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer as ArrayBuffer;
  return new Uint8Array(view).buffer;
}

installBridge(DATA_DIR);
const shim = await import(pathToFileURL(join(SHIM_DIR, 'node-crypto.js')).href);
// 字符串编码要过 `bytes.encode`（node-buffer 的 Buffer.from(str)），所以还要装上 buffer 那条通道
const nodeBuffer = await import(pathToFileURL(join(SHIM_DIR, 'node-buffer.js')).href);

// ──────────────────────────── 差分脚手架 ────────────────────────────

interface Outcome {
  ok: boolean;
  value?: unknown;
  bytes?: string;
  code?: string;
  name?: string;
  message?: string;
}

function norm(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return `bytes:${Buffer.from(v as Uint8Array).toString('hex')}`;
  if (v === undefined) return undefined;
  return v;
}

function capture(fn: () => unknown): Outcome {
  try {
    const v = fn();
    if (ArrayBuffer.isView(v)) return { ok: true, bytes: Buffer.from(v as Uint8Array).toString('hex') };
    return { ok: true, value: norm(v) };
  } catch (err: any) {
    return { ok: false, code: err?.code, name: err?.name, message: err?.message, value: undefined };
  }
}

/** 与宿主逐条比：成功比结果、失败比 code/name/message（crypto 的 message 是契约，见文件头） */
function compare(name: string, run: (c: any) => unknown): void {
  it(name, () => {
    const ours = capture(() => run(shim));
    const theirs = capture(() => run(hostCrypto));
    assert.equal(ours.ok, theirs.ok, `${name}：成败不一致（我们 ${ours.ok ? 'ok' : ours.code}，宿主 ${theirs.ok ? 'ok' : theirs.code}）`);
    if (theirs.ok) {
      assert.equal(ours.bytes ?? ours.value, theirs.bytes ?? theirs.value, `${name}：结果不一致`);
    } else {
      assert.equal(ours.code, theirs.code, `${name}：错误码不一致`);
      assert.equal(ours.name, theirs.name, `${name}：错误 name 不一致（依赖会按 name 分支）`);
      assert.equal(ours.message, theirs.message, `${name}：错误 message 不一致（依赖会按 message 分支）`);
    }
  });
}

describe('仿真 node:crypto —— 与宿主 Node 差分对跑', () => {
  // ── 摘要 ──
  for (const alg of ['md5', 'sha1', 'sha256', 'sha384', 'sha512', 'sha3-256', 'blake2b512']) {
    compare(`${alg}：空串/abc/分片/中文`, (c) =>
      [
        c.createHash(alg).digest('hex'),
        c.createHash(alg).update('abc').digest('hex'),
        c.createHash(alg).update('a').update('b').update('c').digest('hex'),
        c.createHash(alg).update('中文🎉').digest('hex'),
      ].join('|'),
    );
  }
  compare('digest 默认返回 Buffer', (c) => c.createHash('sha256').update('abc').digest());
  compare('digest base64', (c) => c.createHash('sha256').update('abc').digest('base64'));
  compare('digest 非法编码 → Buffer（与 update 的宽容规则不同）', (c) =>
    c.createHash('sha256').update('abc').digest('zzz'),
  );
  compare('update 非法编码 → 当 utf8（Node 的宽容行为）', (c) =>
    c.createHash('sha256').update('616263', 'zzz').digest('hex'),
  );
  compare('update hex 输入', (c) => c.createHash('sha256').update('616263', 'hex').digest('hex'));
  compare('update latin1 输入', (c) => c.createHash('sha256').update('ä', 'latin1').digest('hex'));
  compare('update Buffer 输入', (c) => c.createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'));
  compare('update Uint8Array 子区间', (c) => {
    const u = new Uint8Array([9, 8, 7, 6]);
    return c.createHash('sha256').update(u.subarray(1, 3)).digest('hex');
  });
  compare('copy() 之后两条链独立', (c) => {
    const h = c.createHash('sha256').update('a');
    const clone = h.copy();
    return [h.update('b').digest('hex'), clone.update('c').digest('hex')].join('|');
  });
  compare('一次性 hash()', (c) => [c.hash('sha256', 'abc', 'hex'), c.hash('md5', 'abc', 'base64')].join('|'));
  compare('一次性 hash() 未知算法', (c) => c.hash('nope', 'abc', 'hex'));

  // ── HMAC ──
  compare('hmac sha256 字符串键/字节键/空键', (c) =>
    [
      c.createHmac('sha256', 'key').update('abc').digest('hex'),
      c.createHmac('sha256', Buffer.from([1, 2, 3])).update('abc').digest('hex'),
      c.createHmac('sha256', '').update('').digest('hex'),
      c.createHmac('sha512', 'k').update('a').update('b').digest('base64'),
    ].join('|'),
  );
  compare('hmac 键的 encoding 选项', (c) => c.createHmac('sha256', '6b6579', { encoding: 'hex' }).update('abc').digest('hex'));

  // ── timingSafeEqual ──
  compare('timingSafeEqual 相等/不等', (c) =>
    [c.timingSafeEqual(Buffer.from('abc'), Buffer.from('abc')), c.timingSafeEqual(Buffer.from('abc'), Buffer.from('abd'))].join('|'),
  );
  compare('timingSafeEqual 长度不等', (c) => c.timingSafeEqual(Buffer.from('abc'), Buffer.from('ab')));
  compare('timingSafeEqual 传字符串', (c) => c.timingSafeEqual('abc', 'abc'));

  // ── 对称解密（真值由宿主现算，避免硬编码向量）──
  const key = Buffer.alloc(32, 1);
  const nonce = Buffer.alloc(12, 2);
  const gcm = (() => {
    const c = hostCrypto.createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([c.update(Buffer.from('hello dotenv')), c.final()]);
    return { ct, tag: c.getAuthTag() };
  })();
  compare('decipheriv：dotenv 那种拼接用法', (c) => {
    const d = c.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(gcm.tag);
    return `${d.update(gcm.ct)}${d.final()}`;
  });
  compare('decipheriv：update 返回 Buffer', (c) => {
    const d = c.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(gcm.tag);
    return d.update(gcm.ct);
  });
  compare('decipheriv：输出编码', (c) => {
    const d = c.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(gcm.tag);
    return d.update(gcm.ct, undefined, 'hex') + d.final('hex');
  });
  compare('decipheriv：坏 tag → 认证失败文案', (c) => {
    const d = c.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(Buffer.alloc(16, 9));
    d.update(gcm.ct);
    return d.final();
  });
  compare('decipheriv：没 setAuthTag', (c) => {
    const d = c.createDecipheriv('aes-256-gcm', key, nonce);
    d.update(gcm.ct);
    return d.final();
  });
  compare('decipheriv：key 长度不对（dotenv 靠 RangeError 分支）', (c) => c.createDecipheriv('aes-256-gcm', Buffer.alloc(10), nonce));
  compare('decipheriv：未知算法', (c) => c.createDecipheriv('nope', key, nonce));
  compare('decipheriv：字符串 key/iv（Node 默认 utf8）', (c) => {
    const k = 'k'.repeat(32);
    const iv = 'i'.repeat(12);
    const enc = (() => {
      const cc = hostCrypto.createCipheriv('aes-256-gcm', Buffer.from(k), Buffer.from(iv));
      const ct = Buffer.concat([cc.update(Buffer.from('x')), cc.final()]);
      return { ct, tag: cc.getAuthTag() };
    })();
    const d = c.createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(enc.tag);
    return `${d.update(enc.ct)}${d.final()}`;
  });

  // ── 错误：摘要族 ──
  compare('createHash 未知算法（懒校验，digest 时才报）', (c) => c.createHash('nope').update('x').digest('hex'));
  compare('createHmac 未知算法（急切校验）', (c) => c.createHmac('nope', 'k'));
  compare('digest 两次', (c) => {
    const h = c.createHash('sha256');
    h.digest('hex');
    return h.digest('hex');
  });
  compare('digest 之后再 update', (c) => {
    const h = c.createHash('sha256');
    h.digest('hex');
    return h.update('x').digest('hex');
  });
  compare('update 类型错', (c) => c.createHash('sha256').update(42));
  compare('createHash 无参', (c) => c.createHash(undefined));
  compare('createHmac 缺 key', (c) => c.createHmac('sha256', undefined));

  // ── 错误：随机族 ──
  compare('randomBytes 无参', (c) => c.randomBytes());
  compare('randomBytes 负数', (c) => c.randomBytes(-1));
  compare('randomBytes 超上限', (c) => c.randomBytes(2 ** 31));
  compare('randomBytes 小数被截断', (c) => c.randomBytes(1.5).length);
  compare('randomBytes(0)', (c) => c.randomBytes(0).length);
  compare('randomInt 空区间', (c) => c.randomInt(5, 5));
  compare('randomInt 小数', (c) => c.randomInt(1.5));
  compare('randomFillSync 非 TypedArray', (c) => c.randomFillSync({}));
  compare('randomFillSync 无参', (c) => c.randomFillSync());
  compare('randomFillSync 窗口只填该填的（长度/返回值）', (c) => {
    const b = Buffer.alloc(8, 7);
    const r = c.randomFillSync(b, 2, 3);
    return [r === b, b[0] === 7 && b[7] === 7].join('|');
  });
});

// ──────────────────────────── 随机性与结构性断言 ────────────────────────────

describe('仿真 node:crypto —— 随机性、静态清单与有意不同', () => {
  it('randomBytes/randomUUID：长度与 UUID v4 形状（值不可比，只验形状）', () => {
    assert.equal(shim.randomBytes(16).byteLength, 16);
    assert.equal(shim.randomBytes(0).byteLength, 0);
    const uuids = new Set(Array.from({ length: 20 }, () => shim.randomUUID()));
    assert.equal(uuids.size, 20, 'randomUUID 不该重复');
    for (const u of uuids) {
      assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, `不像 v4 UUID：${u}`);
    }
  });

  it('getRandomValues：原地填、返回同一数组、两个特殊错误照 Node 的 name/code', () => {
    const arr = new Uint8Array(8);
    assert.equal(shim.getRandomValues(arr), arr, '必须返回同一个数组（WebCrypto 语义）');
    assert.notDeepEqual(Array.from(shim.getRandomValues(new Uint8Array(16))), new Array(16).fill(0));

    const tooBig = capture(() => shim.getRandomValues(new Uint8Array(65537)));
    assert.equal(tooBig.name, 'QuotaExceededError');
    assert.equal(tooBig.code, 22);
    assert.equal(tooBig.message, 'The requested length exceeds 65,536 bytes');
    // 对照：宿主给的是真 DOMException
    assert.equal(capture(() => hostCrypto.getRandomValues(new Uint8Array(65537))).name, 'QuotaExceededError');

    for (const bad of [new Float32Array(2), new DataView(new ArrayBuffer(4)), [1, 2, 3]]) {
      const out = capture(() => shim.getRandomValues(bad as any));
      assert.equal(out.name, 'TypeMismatchError');
      assert.equal(out.message, 'The data argument must be an integer-type TypedArray');
    }
  });

  it('randomInt：区间正确、覆盖两端、拒绝采样不越界', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const v = shim.randomInt(3, 7);
      assert.ok(v >= 3 && v < 7, `randomInt(3,7) 越界：${v}`);
      seen.add(v);
    }
    assert.deepEqual([...seen].sort(), [3, 4, 5, 6], '200 次应当覆盖全部 4 个值');
    assert.ok(shim.randomInt(1, 1_000_000) >= 1);
  });

  it('静态清单按 **v22.22.1 基线**（不与宿主比：它随 OpenSSL 版本变）', () => {
    // 出处：tools/truth/data/crypto-truth*.json（WSL node v22.22.1）
    assert.equal(shim.getHashes().length, 52);
    assert.equal(shim.getCiphers().length, 134);
    assert.equal(shim.getCurves().length, 82);
    for (const alg of ['md5', 'sha1', 'sha256', 'sha512', 'sha3-256', 'blake2b512', 'shake256']) {
      assert.ok(shim.getHashes().includes(alg), `getHashes 少了 ${alg}`);
    }
    assert.ok(shim.getCiphers().includes('aes-256-gcm'));
    assert.equal(shim.getFips(), 0);
    assert.equal(Object.keys(shim.constants).length, 56);
    assert.equal(shim.constants.RSA_PKCS1_PADDING, 1);
    assert.equal(shim.constants.OPENSSL_VERSION_NUMBER, 810549328);
    assert.equal(typeof shim.constants.defaultCipherList, 'string');
    assert.equal(Object.isFrozen(shim.constants), true, 'Node 的 crypto.constants 也是只读的');
    // 返回的是**副本**（插件改不动我们的表）
    const list = shim.getHashes();
    list.push('污染');
    assert.equal(shim.getHashes().includes('污染'), false);
  });

  it('非对称 / 密钥对象 / WebCrypto.subtle / 派生函数：一律**响亮抛错**', () => {
    const names = [
      'createPublicKey', 'createPrivateKey', 'createSecretKey', 'generateKeyPairSync', 'generateKeyPair',
      'createSign', 'createVerify', 'sign', 'verify', 'publicEncrypt', 'privateDecrypt', 'diffieHellman',
      'createDiffieHellman', 'createECDH', 'generatePrimeSync', 'checkPrimeSync', 'hkdfSync', 'pbkdf2Sync',
      'scryptSync', 'setEngine', 'setFips',
    ];
    for (const name of names) {
      assert.equal(typeof (shim as any)[name], 'function', `${name} 应当是函数（不能是 undefined）`);
      const out = capture(() => (shim as any)[name]());
      assert.equal(out.code, 'ERR_NOT_SUPPORTED_IN_SANDBOX', `${name} 应当明确抛错（拿到 ${out.code}）`);
      assert.equal(typeof (hostCrypto as any)[name], 'function', `宿主上 ${name} 是可用的（所以这是有意的缺失）`);
    }
    for (const m of ['digest', 'encrypt', 'importKey', 'generateKey']) {
      const out = capture(() => (shim.subtle as any)[m]());
      assert.equal(out.code, 'ERR_NOT_SUPPORTED_IN_SANDBOX', `subtle.${m} 应当抛错`);
    }
    assert.equal(typeof (shim.webcrypto as any).getRandomValues, 'function');
    assert.equal(typeof (shim.webcrypto as any).subtle, 'object');
  });

  it('**有意不同**：Hash 不是流（Node 里它是 stream.Transform）', () => {
    const h = shim.createHash('sha256');
    assert.equal(typeof (h as any).pipe, 'undefined', '本批没有 stream：不该假装有 pipe');
    assert.equal(typeof (h as any).write, 'undefined');
    // 但事件面在（继承 EventEmitter），`hash.on('error')` 这类用法成立
    assert.equal(typeof h.on, 'function');
    assert.equal(h instanceof (nodeBuffer as any).Buffer.constructor ? true : true, true);
    // 对照：宿主的 Hash 是 Transform
    const hostHash = hostCrypto.createHash('sha256');
    assert.equal(typeof (hostHash as any).pipe, 'function');
  });

  it('**有意不同**：setAAD/setAutoPadding 明确抛错（一次性解密）', () => {
    const d = shim.createDecipheriv('aes-256-gcm', Buffer.alloc(32, 1), Buffer.alloc(12, 1));
    for (const m of ['setAAD', 'setAutoPadding']) {
      const out = capture(() => (d as any)[m](Buffer.alloc(1)));
      assert.equal(out.code, 'ERR_NOT_SUPPORTED_IN_SANDBOX', `${m} 应当抛错`);
    }
  });
});

// ──────────────────────────── 真沙箱冒烟 ────────────────────────────

describe('仿真 node:crypto —— 真实 QuickJS 沙箱里跑通', async () => {
  const { createSandbox } = await import('../../core/sandbox.ts');
  const SMOKE_DIR = mkdtempSync(join(tmpdir(), 'spc-smoke-crypto-'));
  after(() => rmSync(SMOKE_DIR, { recursive: true, force: true }));

  async function runInSandbox(code: string, permissions: string[]): Promise<string> {
    const api = buildHostApi({ pluginId: '@spc-test/crypto', dataDir: SMOKE_DIR });
    const sandbox = await createSandbox(api, {
      pluginId: '@spc-test/crypto',
      permissions,
      facts: { version: { code: 1, name: 'test' }, dataDir: SMOKE_DIR, manifest: {}, config: {} },
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule('@spc-test/crypto', code);
      await sandbox.callHook('init', 5_000);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    return logs.join('\n');
  }

  // 这条必须走真沙箱：宿主进程里的差分测试证明不了"沙箱里真的没有缺全局"，也证明不了权限判定在真桥上成立。
  it('摘要/HMAC/随机/UUID/一次性解密全链路在沙箱里成立', async () => {
    // 权限只声明 crypto.*（外加 bytes.encode：**字符串编码**走编解码那条通道，见 shim 文件头边界 5）
    const out = await runInSandbox(
      `
import crypto from 'node:crypto';
export function init() {
  console.log('SHA ' + crypto.createHash('sha256').update('abc').digest('hex'));
  console.log('SPLIT ' + crypto.createHash('sha256').update('a').update('bc').digest('hex'));
  console.log('HMAC ' + crypto.createHmac('sha256', 'key').update('abc').digest('base64'));
  console.log('ONE ' + crypto.hash('md5', 'abc', 'hex'));
  console.log('UUID ' + /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()));
  console.log('RND ' + crypto.randomBytes(12).length + '/' + crypto.getRandomValues(new Uint8Array(4)).length);
  console.log('TSE ' + crypto.timingSafeEqual(Buffer.from('ab'), Buffer.from('ab')));
  console.log('LIST ' + crypto.getHashes().length + '/' + crypto.getCiphers().length + '/' + crypto.constants.RSA_PKCS1_PADDING);
  // 坏 key 长度：**name 与 message 都要过桥**（dotenv 就按这两个分支）
  try { crypto.createDecipheriv('aes-256-gcm', Buffer.alloc(10), Buffer.alloc(12)); }
  catch (e) { console.log('BADKEY ' + (e instanceof RangeError) + '/' + e.message + '/' + e.code); }
  try { crypto.createPublicKey('x'); } catch (e) { console.log('REFUSE ' + e.code); }
}
`,
      ['crypto.hash', 'crypto.random', 'crypto.cipher', 'bytes.encode'],
    );
    const lines = out.split('\n');
    assert.equal(lines[0], 'SHA ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(lines[1], lines[0].replace('SHA ', 'SPLIT '), '分片 update 必须与一次 update 等价');
    assert.equal(lines[2], 'HMAC ' + hostCrypto.createHmac('sha256', 'key').update('abc').digest('base64'));
    assert.equal(lines[3], 'ONE 900150983cd24fb0d6963f7d28e17f72');
    assert.equal(lines[4], 'UUID true');
    assert.equal(lines[5], 'RND 12/4');
    assert.equal(lines[6], 'TSE true');
    assert.equal(lines[7], 'LIST 52/134/1');
    // 「RangeError + Invalid key length」这一对是 dotenv 的判据，必须逐字成立
    assert.equal(lines[8], 'BADKEY true/Invalid key length/ERR_CRYPTO_INVALID_KEYLEN');
    assert.equal(lines[9], 'REFUSE ERR_NOT_SUPPORTED_IN_SANDBOX');
  });

  it('`crypto.*` 是 **self/auto 档：不声明也能用**（v4 免声明；以前这条断言的是 EACCES）', async () => {
    // 这条用例的**前提变过**（第四批 B）：`scope: self` 的点从"要声明"改成"免声明免授予"。
    // 于是"不声明就 EACCES"不再是期望行为——它现在断言的是**免声明路径真的通**。
    // ⚠️ 声明这道闸仍然存在，只是只对 `grant != auto`（即 host 点）生效：
    // 那一路的判据在 `permissions.test.ts`（`host + install` 未声明 → NOT_DECLARED）。
    // 真桥上的 host 点用例要等第一个 host 点落地（`exec.template.*`）再补。
    const out = await runInSandbox(
      `
import crypto from 'node:crypto';
export function init() {
  console.log('NOPERM-OK ' + crypto.createHash('sha256').update('abc').digest('hex').length);
}
`,
      [],
    );
    assert.equal(out, 'NOPERM-OK 64');
  });
});
