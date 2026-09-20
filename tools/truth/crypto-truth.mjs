// node:crypto 的真值采集（在 WSL 的 node v22.22.1 上跑 = 仿真基线）
//   用法：wsl -e node /mnt/d/git-repo/_audit/tools/truth/crypto-truth.mjs > _audit/data/crypto-truth.json
// 采四类：① 导出面 ② constants/getHashes/getCiphers 基线 ③ 摘要/HMAC 的输出真值 ④ 错误形状
import * as crypto from 'node:crypto';

const out = { meta: { node: process.version, platform: process.platform } };
const shape = (fn) => {
  try {
    const v = fn();
    if (v instanceof Uint8Array) return { ok: true, bytes: Buffer.from(v).toString('hex') };
    if (typeof v === 'object' && v !== null) return { ok: true, keys: Object.keys(v).slice(0, 8), type: v.constructor?.name };
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, name: e.name, code: e.code, message: e.message, ...(e.reason ? { reason: e.reason } : {}) };
  }
};

// ① 导出面
out.exportKeys = Object.keys(crypto).sort();

// ② 基线与静态清单
out.constants = Object.fromEntries(Object.entries(crypto.constants).filter(([, v]) => typeof v !== 'object'));
out.getHashes = crypto.getHashes();
out.getCiphers = crypto.getCiphers();
out.hasFips = (crypto ).fips;

// ③ 输出真值（差分测试的期望值）
const algs = ['md5', 'sha1', 'sha256', 'sha384', 'sha512', 'sha3-256', 'blake2b512'];
out.digests = {};
for (const alg of algs) {
  out.digests[alg] = {
    empty: shape(() => crypto.createHash(alg).digest('hex')),
    abc_hex: shape(() => crypto.createHash(alg).update('abc').digest('hex')),
    abc_base64: shape(() => crypto.createHash(alg).update('abc').digest('base64')),
    abc_buffer: shape(() => crypto.createHash(alg).update('abc').digest()),
    // 分片 update 必须与一次 update 等价
    split: shape(() => crypto.createHash(alg).update('a').update('b').update('c').digest('hex')),
    utf8: shape(() => crypto.createHash(alg).update('中文🎉').digest('hex')),
  };
}
out.hmac = {};
for (const alg of ['sha256', 'sha512']) {
  out.hmac[alg] = {
    hex: shape(() => crypto.createHmac(alg, 'key').update('abc').digest('hex')),
    keyBuffer: shape(() => crypto.createHmac(alg, Buffer.from([1, 2, 3])).update('abc').digest('hex')),
    empty: shape(() => crypto.createHmac(alg, '').update('').digest('hex')),
  };
}
out.copyBehavior = shape(() => {
  const h = crypto.createHash('sha256').update('a');
  const c = h.copy();
  return [h.update('b').digest('hex'), c.update('c').digest('hex')];
});
out.timingSafeEqual = {
  equal: shape(() => crypto.timingSafeEqual(Buffer.from('abc'), Buffer.from('abc'))),
  diff: shape(() => crypto.timingSafeEqual(Buffer.from('abc'), Buffer.from('abd'))),
  lengthMismatch: shape(() => crypto.timingSafeEqual(Buffer.from('abc'), Buffer.from('ab'))),
  strings: shape(() => crypto.timingSafeEqual('abc' , 'abc' )),
};
out.random = {
  bytes16: shape(() => crypto.randomBytes(16)),
  bytes0: shape(() => crypto.randomBytes(0)),
  negative: shape(() => crypto.randomBytes(-1)),
  huge: shape(() => crypto.randomBytes(2 ** 31)),
  float: shape(() => crypto.randomBytes(1.5)),
  uuid: shape(() => crypto.randomUUID()),
  uuidShape: shape(() => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID())),
  randomFillBytes: shape(() => { const b = Buffer.alloc(4); crypto.randomFillSync(b); return b.length; }),
  getRandomValues8: shape(() => { const a = new Uint8Array(8); crypto.getRandomValues(a); return a.length; }),
  getRandomValuesBig: shape(() => crypto.getRandomValues(new Uint8Array(65537))),
  getRandomValuesFloat: shape(() => crypto.getRandomValues(new Float32Array(1) )),
  getRandomValuesDataView: shape(() => crypto.getRandomValues(new DataView(new ArrayBuffer(4)) )),
  webcryptoRandomValues: shape(() => { const a = new Uint8Array(4); crypto.webcrypto.getRandomValues(a); return a.length; }),
};

// ④ 错误形状（差分与 §7 翻译要用）
out.errors = {
  badAlg: shape(() => crypto.createHash('nope').update('x').digest('hex')),
  badAlgHmac: shape(() => crypto.createHmac('nope', 'k')),
  digestTwice: shape(() => { const h = crypto.createHash('sha256'); h.digest('hex'); return h.digest('hex'); }),
  updateAfterDigest: shape(() => { const h = crypto.createHash('sha256'); h.digest('hex'); return h.update('x').digest('hex'); }),
  digestBadEncoding: shape(() => crypto.createHash('sha256').update('x').digest('zzz')),
  updateBadEncoding: shape(() => crypto.createHash('sha256').update('x', 'zzz')),
  updateWrongType: shape(() => crypto.createHash('sha256').update(42 )),
  createHashNoArg: shape(() => crypto.createHash(undefined )),
  hmacNoKey: shape(() => crypto.createHmac('sha256', undefined )),
  randomBytesNoArg: shape(() => (crypto.randomBytes )()),
  timingSafeEqualWrongType: shape(() => crypto.timingSafeEqual(1 , 2 )),
};
out.hmacStreaming = shape(() => crypto.createHmac('sha256', 'k').update('a').update('b').digest('base64'));

process.stdout.write(JSON.stringify(out, null, 1));


