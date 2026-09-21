// crypto 真值补充采集：getCurves / getFips / hash 一次性 / randomInt / webcrypto / **decipher 错误文案**
// 用法：wsl -e node /mnt/d/git-repo/ServerPluginCore/tools/truth/crypto-truth2.mjs > tools/truth/data/crypto-truth2.json
import * as crypto from 'node:crypto';

const out = {};
const shape = (fn) => {
  try {
    const v = fn();
    if (Array.isArray(v)) return { ok: true, array: v.map(String) };
    if (v instanceof Uint8Array) return { ok: true, bytes: Buffer.from(v).toString('hex') };
    if (typeof v === 'object' && v !== null) return { ok: true, keys: Object.keys(v).slice(0, 10), type: v.constructor?.name };
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, name: e.name, code: e.code, message: e.message };
  }
};

out.getCurves = crypto.getCurves();
out.getFips = shape(() => crypto.getFips());
out.constantsRaw = Object.fromEntries(Object.entries(crypto.constants));
out.webcryptoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(crypto.webcrypto)).sort();
out.subtleKeys = Object.keys(crypto.webcrypto.subtle).sort();
out.hashOneShot = {
  hex: shape(() => crypto.hash('sha256', 'abc', 'hex')),
  base64: shape(() => crypto.hash('sha256', 'abc', 'base64')),
  buffer: shape(() => crypto.hash('sha256', 'abc')),
  md5: shape(() => crypto.hash('md5', 'abc', 'hex')),
  badAlg: shape(() => crypto.hash('nope', 'abc', 'hex')),
};
out.randomInt = {
  sync: shape(() => crypto.randomInt(10)),
  syncRange: shape(() => crypto.randomInt(5, 6)),
  badRange: shape(() => crypto.randomInt(5, 5)),
  float: shape(() => crypto.randomInt(1.5)),
  callback: typeof crypto.randomInt(1, 10, () => {}),
};
out.randomFill = {
  sync: shape(() => { const b = Buffer.alloc(4); return crypto.randomFillSync(b) === b; }),
  offset: shape(() => { const b = Buffer.alloc(8); crypto.randomFillSync(b, 2, 3); return b.length; }),
  asyncKind: typeof crypto.randomFill,
};

// ★ decipher：dotenv 依赖的是**错误文案**（它按 message 分支），必须逐条取真值
const key = Buffer.alloc(32, 1);
const nonce = Buffer.alloc(12, 2);
const okCt = (() => {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([c.update(Buffer.from('hello dotenv')), c.final()]);
  return { ct: enc, tag: c.getAuthTag() };
})();
out.decipher = {
  happy: shape(() => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(okCt.tag);
    return `${d.update(okCt.ct)}${d.final()}`;
  }),
  badKeyLength: shape(() => crypto.createDecipheriv('aes-256-gcm', Buffer.alloc(10), nonce)),
  badIvLength: shape(() => crypto.createDecipheriv('aes-256-gcm', key, Buffer.alloc(5))),
  badAlg: shape(() => crypto.createDecipheriv('nope', key, nonce)),
  badTag: shape(() => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(Buffer.alloc(16, 9));
    d.update(okCt.ct);
    return d.final();
  }),
  updateReturnType: shape(() => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(okCt.tag);
    return d.update(okCt.ct);
  }),
  noTag: shape(() => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.update(okCt.ct);
    return d.final();
  }),
  finalTwice: shape(() => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(okCt.tag);
    d.update(okCt.ct);
    d.final();
    return d.final();
  }),
  setTagAfterFinal: shape(() => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.update(okCt.ct);
    d.final();
    return d.setAuthTag(okCt.tag);
  }),
  outputEncoding: shape(() => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(okCt.tag);
    return d.update(okCt.ct, undefined, 'hex') + d.final('hex');
  }),
  protoKeys: shape(() => Object.getOwnPropertyNames(Object.getPrototypeOf(crypto.createDecipheriv('aes-256-gcm', key, nonce))).sort()),
};
out.hashProtoKeys = shape(() => Object.getOwnPropertyNames(Object.getPrototypeOf(crypto.createHash('sha256'))).sort());
out.hashOwnKeys = shape(() => Object.keys(crypto.createHash('sha256')));
out.hmacProtoKeys = shape(() => Object.getOwnPropertyNames(Object.getPrototypeOf(crypto.createHmac('sha256', 'k'))).sort());

process.stdout.write(JSON.stringify(out, null, 1));

