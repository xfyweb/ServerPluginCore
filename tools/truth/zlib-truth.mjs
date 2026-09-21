// zlib 真值采集（WSL node v22.22.1 = 仿真基线）
//   用法：wsl -e node /mnt/d/git-repo/ServerPluginCore/tools/truth/zlib-truth.mjs > tools/truth/data/zlib-truth.json
// 只采**同步面**（本批范围）：adm-zip 用的是 deflateRawSync / inflateRawSync（带 maxOutputLength）。
import * as zlib from 'node:zlib';

const out = { meta: { node: process.version, platform: process.platform } };
const shape = (fn) => {
  try {
    const v = fn();
    if (v instanceof Uint8Array) return { ok: true, bytes: Buffer.from(v).toString('hex') };
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, name: e.name, code: e.code, message: e.message, errno: e.errno };
  }
};

out.exportKeys = Object.keys(zlib).sort();
out.constants = Object.fromEntries(Object.entries(zlib.constants));

const data = Buffer.from('hello zlib hello zlib hello zlib hello zlib');
out.roundTrip = {
  deflateRawSync_hex: shape(() => zlib.deflateRawSync(data)),
  deflateSync_hex: shape(() => zlib.deflateSync(data)),
  gzipSync_hex: shape(() => zlib.gzipSync(data)),
  deflateRawSync_level9: shape(() => zlib.deflateRawSync(data, { level: 9 })),
  deflateRawSync_level0: shape(() => zlib.deflateRawSync(data, { level: 0 })),
  inflateRaw_back: shape(() => zlib.inflateRawSync(zlib.deflateRawSync(data)).toString('utf8')),
  inflate_back: shape(() => zlib.inflateSync(zlib.deflateSync(data)).toString('utf8')),
  gunzip_back: shape(() => zlib.gunzipSync(zlib.gzipSync(data)).toString('utf8')),
  empty: shape(() => zlib.deflateRawSync(Buffer.alloc(0))),
  crc32: shape(() => (zlib.crc32 ? zlib.crc32(data) : 'NO-CRC32')),
  // adm-zip 的 inflater 会传 maxOutputLength（防 zip bomb，见其 GHSA 修复）
  maxOutputLength_enough: shape(() => zlib.inflateRawSync(zlib.deflateRawSync(data), { maxOutputLength: 1024 }).length),
  maxOutputLength_tooSmall: shape(() => zlib.inflateRawSync(zlib.deflateRawSync(data), { maxOutputLength: 5 })),
  maxOutputLength_zero: shape(() => zlib.inflateRawSync(zlib.deflateRawSync(data), { maxOutputLength: 0 })),
  dictionary: shape(() => zlib.deflateRawSync(data, { dictionary: Buffer.from('hello') })),
};

out.errors = {
  inflateRaw_garbage: shape(() => zlib.inflateRawSync(Buffer.from('not compressed at all'))),
  inflateRaw_empty: shape(() => zlib.inflateRawSync(Buffer.alloc(0))),
  deflateRaw_wrongType: shape(() => zlib.deflateRawSync('abc')),
  deflateRaw_badLevel: shape(() => zlib.deflateRawSync(data, { level: 99 })),
  inflateSync_on_raw: shape(() => zlib.inflateSync(zlib.deflateRawSync(data))),
  gunzip_on_raw: shape(() => zlib.gunzipSync(zlib.deflateRawSync(data))),
  deflateRaw_noArg: shape(() => zlib.deflateRawSync()),
  badAsyncStyle: shape(() => zlib.deflateRaw(data, 'zzz', () => {})),
};
out.syncFnNames = ['deflate', 'deflateRaw', 'gzip', 'inflate', 'inflateRaw', 'gunzip', 'unzip', 'deflateSync', 'deflateRawSync', 'gzipSync', 'inflateSync', 'inflateRawSync', 'gunzipSync', 'unzipSync', 'crc32', 'constants'];
out.protoOfSyncResult = shape(() => Object.getOwnPropertyNames(Object.getPrototypeOf(zlib.deflateRawSync(data))).sort());

process.stdout.write(JSON.stringify(out, null, 1));
