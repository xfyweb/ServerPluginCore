// node:zlib 仿真的对齐测试
//
// 判卷人：
//   1. **宿主 Node**：本机宿主与我们的实现**用的是同一个 zlib**（我们把计算整体交宿主），
//      所以压缩输出、错误码/文案、options 校验都能逐条差分——这是本模块最省事的一点；
//   2. **固定基线真值**（`_audit/zlib-truth.json`，WSL node v22.22.1）：`constants`/`codes` 表按基线断言
//      （宿主 zlib/OpenSSL 版本会变），另外用真值里的**压缩产物**做解压方向的输入向量
//      （解压是跨版本稳定的，压缩不是——所以压缩只比往返与宿主交叉解压）；
//   3. **结构性断言**：流式入口/brotli/zstd 明确抛错（本批不做，见 shim 文件头边界 1/2）。
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as hostZlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-zlib-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;
after(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

const { buildHostApi } = await import('../../core/hostApi.ts');
const { buildEnvFacts } = await import('../../core/emulated-env.ts');
const { toErrorShape } = await import('../../core/errors.ts');

const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-shims-zlib-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
const SHIM_SRC = join(process.cwd(), 'core', 'sandbox-modules');
for (const f of ['node-zlib.js', 'node-buffer.js']) copyFileSync(join(SHIM_SRC, f), join(SHIM_DIR, f));
after(() => rmSync(SHIM_DIR, { recursive: true, force: true }));

const DATA_DIR = mkdtempSync(join(tmpdir(), 'spc-zlib-data-'));
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function installBridge(dataDir: string): void {
  const api = buildHostApi({ pluginId: '@test/zlib', dataDir });
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
const shim = await import(pathToFileURL(join(SHIM_DIR, 'node-zlib.js')).href);

interface Outcome {
  ok: boolean;
  bytes?: string;
  value?: unknown;
  code?: string;
  name?: string;
  message?: string;
}

function capture(fn: () => unknown): Outcome {
  try {
    const v = fn();
    if (ArrayBuffer.isView(v)) return { ok: true, bytes: Buffer.from(v as Uint8Array).toString('hex') };
    return { ok: true, value: v };
  } catch (err: any) {
    return { ok: false, code: err?.code, name: err?.name, message: err?.message };
  }
}

function compare(name: string, run: (z: any) => unknown): void {
  it(name, () => {
    const ours = capture(() => run(shim));
    const theirs = capture(() => run(hostZlib));
    assert.equal(ours.ok, theirs.ok, `${name}：成败不一致（我们 ${ours.ok ? 'ok' : ours.code}，宿主 ${theirs.ok ? 'ok' : theirs.code}）`);
    if (theirs.ok) {
      assert.deepEqual(ours.bytes ?? ours.value, theirs.bytes ?? theirs.value, `${name}：结果不一致`);
    } else {
      assert.equal(ours.code, theirs.code, `${name}：错误码不一致`);
      assert.equal(ours.name, theirs.name, `${name}：错误 name 不一致`);
      assert.equal(ours.message, theirs.message, `${name}：错误 message 不一致`);
    }
  });
}

const SAMPLE = Buffer.from('hello zlib hello zlib hello zlib hello zlib'.repeat(4));
// 真值表里的压缩产物（Linux v22.22.1 采的）——**解压方向**的输入向量，跨版本稳定
const TRUTH_RAW_HEX = 'cb48cdc9c957a8cac94c52c820c00400';

describe('仿真 node:zlib —— 与宿主 Node 差分对跑', () => {
  for (const form of ['deflateRaw', 'deflate', 'gzip'] as const) {
    compare(`${form}Sync 往返 + 空输入 + level 0/9`, (z) => {
      const c = z[`${form}Sync`];
      const back = z[`inflateRawSync`] && form === 'gzip' ? z.gunzipSync(c(SAMPLE)) : z[`${form === 'deflateRaw' ? 'inflateRawSync' : 'inflateSync'}`](c(SAMPLE));
      return [c(SAMPLE).length > 0, back.toString('utf8') === SAMPLE.toString('utf8'), c(Buffer.alloc(0)).length, c(SAMPLE, { level: 0 }).length, c(SAMPLE, { level: 9 }).length];
    });
  }
  compare('解压真值向量（Linux v22.22.1 的 deflateRaw 产物）', (z) => z.inflateRawSync(Buffer.from(TRUTH_RAW_HEX, 'hex')).toString('utf8'));
  compare('unzipSync 自动识别 gzip/deflate', (z) =>
    [z.unzipSync(z.gzipSync(SAMPLE)).toString('utf8') === SAMPLE.toString('utf8'), z.unzipSync(z.deflateSync(SAMPLE)).toString('utf8') === SAMPLE.toString('utf8')],
  );
  compare('maxOutputLength：够用/太小/为 0', (z) => {
    const c = z.deflateRawSync(SAMPLE);
    return [
      z.inflateRawSync(c, { maxOutputLength: 4096 }).length,
      capture(() => z.inflateRawSync(c, { maxOutputLength: 5 })),
      capture(() => z.inflateRawSync(c, { maxOutputLength: 0 })),
    ];
  });
  compare('dictionary 压缩/缺字典解压', (z) => {
    const c = z.deflateRawSync(SAMPLE, { dictionary: Buffer.from('hello') });
    return [c.length, capture(() => z.inflateRawSync(c)), z.inflateRawSync(c, { dictionary: Buffer.from('hello') }).length];
  });
  compare('crc32（含种子）', (z) => [z.crc32(SAMPLE), z.crc32(Buffer.from('a')), z.crc32(SAMPLE, 12345)]);

  // ── 错误面（codes/message 都是契约）──
  compare('解压垃圾数据', (z) => z.inflateRawSync(Buffer.from('not compressed at all')));
  compare('解压空输入', (z) => z.inflateRawSync(Buffer.alloc(0)));
  compare('inflateSync 喂 raw 数据', (z) => z.inflateSync(z.deflateRawSync(SAMPLE)));
  compare('gunzipSync 喂 raw 数据', (z) => z.gunzipSync(z.deflateRawSync(SAMPLE)));
  compare('参数类型错', (z) => z.deflateRawSync(undefined));
  compare('level 越界', (z) => z.deflateRawSync(SAMPLE, { level: 99 }));
  compare('非对象 options 被忽略（Node 的宽容）', (z) => z.deflateRawSync(SAMPLE, 'zzz').length);
  compare('字符串输入按 utf8', (z) => z.deflateSync('abc').length);
});

describe('仿真 node:zlib —— 静态表、回调面与有意不同', () => {
  it('constants / codes 按 **v22.22.1 基线**（含双向 codes 映射）', () => {
    assert.equal(Object.keys(shim.constants).length, 170);
    assert.equal(shim.constants.Z_DATA_ERROR, -3);
    assert.equal(shim.constants.Z_BEST_COMPRESSION, 9);
    assert.equal(shim.codes.Z_DATA_ERROR, -3);
    assert.equal(shim.codes[-3], 'Z_DATA_ERROR');
    assert.equal(shim.codes[0], 'Z_OK');
    assert.equal(Object.isFrozen(shim.constants), true);
  });

  it('回调面：**异步触发**、成功与失败两条路都走回调', async () => {
    let after = false;
    const seen: string[] = [];
    await new Promise<void>((resolve) => {
      shim.deflateRaw(SAMPLE, (err: any, out: any) => {
        seen.push(after ? 'after-sync' : 'before-sync');
        seen.push(String(err) + '/' + (out instanceof Uint8Array));
        resolve();
      });
      after = true;
    });
    assert.deepEqual(seen, ['after-sync', 'null/true']);

    const err: any = await new Promise((resolve) => {
      shim.inflateRaw(Buffer.from('garbage'), (e: any) => resolve(e));
    });
    assert.equal(err.code, 'Z_DATA_ERROR');
    assert.equal(err.name, 'Error');
    // 回调不是函数 → 同步抛（与 Node 一致）
    assert.equal(capture(() => shim.gzip(SAMPLE, 'not-a-fn')).code, 'ERR_INVALID_ARG_TYPE');
  });

  it('流式入口 / brotli / zstd 一律**响亮抛错**（不静默降级成假流）', () => {
    const names = [
      'createDeflate', 'createDeflateRaw', 'createGzip', 'createInflate', 'createInflateRaw', 'createGunzip',
      'createUnzip', 'createBrotliCompress', 'createBrotliDecompress', 'brotliCompressSync',
      'brotliDecompressSync', 'createZstdCompress', 'createZstdDecompress', 'zstdCompressSync',
    ];
    for (const name of names) {
      assert.equal(typeof (shim as any)[name], 'function', `${name} 应当是函数`);
      const out = capture(() => (shim as any)[name]());
      assert.equal(out.code, 'ERR_NOT_SUPPORTED_IN_SANDBOX', `${name} 应当明确抛错（拿到 ${out.code}）`);
      assert.equal(typeof (hostZlib as any)[name], 'function', `宿主上 ${name} 可用（所以这是有意的缺失）`);
    }
  });
});

// ──────────────────────────── 真沙箱冒烟 ────────────────────────────

describe('仿真 node:zlib —— 真实 QuickJS 沙箱里跑通', async () => {
  const { createSandbox } = await import('../../core/sandbox.ts');
  const SMOKE_DIR = mkdtempSync(join(tmpdir(), 'spc-smoke-zlib-'));
  after(() => rmSync(SMOKE_DIR, { recursive: true, force: true }));

  async function runInSandbox(code: string, permissions: string[]): Promise<string> {
    const api = buildHostApi({ pluginId: '@spc-test/zlib', dataDir: SMOKE_DIR });
    const sandbox = await createSandbox(api, {
      pluginId: '@spc-test/zlib',
      permissions,
      facts: { version: { code: 1, name: 'test' }, dataDir: SMOKE_DIR, manifest: {}, config: {} },
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule('@spc-test/zlib', code);
      await sandbox.callHook('init', 5_000);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    return logs.join('\n');
  }

  it('压缩/解压/crc32/错误码/流式拒绝 全链路在沙箱里成立', async () => {
    const out = await runInSandbox(
      `
import zlib from 'node:zlib';
export function init() {
  const data = Buffer.from('hello zlib');
  const c = zlib.deflateRawSync(data);
  console.log('ROUND ' + zlib.inflateRawSync(c).toString());
  console.log('GZIP ' + zlib.gunzipSync(zlib.gzipSync(data)).toString());
  console.log('CRC ' + zlib.crc32(data));
  console.log('CONST ' + zlib.constants.Z_DATA_ERROR + '/' + zlib.codes[-3]);
  try { zlib.inflateRawSync(Buffer.from('nope')); } catch (e) { console.log('ERR ' + e.code + '/' + e.name + '/' + e.message); }
  try { zlib.createGzip(); } catch (e) { console.log('STREAM ' + e.code); }
  zlib.deflateRaw(data, (err, zipped) => {
    console.log('ASYNC ' + (err === null) + '/' + zlib.inflateRawSync(zipped).toString());
  });
}
`,
      // bytes.decode 也要：`Buffer.prototype.toString()` 是宿主代工的编解码（字符串输入才要 encode）
      ['zlib.compress', 'zlib.decompress', 'bytes.encode', 'bytes.decode'],
    );
    const lines = out.split('\n');
    assert.equal(lines[0], 'ROUND hello zlib');
    assert.equal(lines[1], 'GZIP hello zlib');
    assert.equal(lines[2], 'CRC ' + hostZlib.crc32(Buffer.from('hello zlib')));
    assert.equal(lines[3], 'CONST -3/Z_DATA_ERROR');
    assert.equal(lines[4], 'ERR Z_DATA_ERROR/Error/invalid block type');
    assert.equal(lines[5], 'STREAM ERR_NOT_SUPPORTED_IN_SANDBOX');
    assert.equal(lines[6], 'ASYNC true/hello zlib');
  });

  it('`zlib.*` 是 **self/auto：不声明也能用**（v4 免声明；以前这条断言的是 EACCES）', async () => {
    // 前提变更（第四批 B）：判定链第 2/3 步改成只看 `grant`，`scope: self` 的点免声明免授予。
    // 声明这道闸没消失——它只对 `grant != auto`（host 点）生效，那一路的判据在 permissions.test.ts。
    const out = await runInSandbox(
      `
import zlib from 'node:zlib';
export function init() {
  const c = zlib.deflateRawSync(Buffer.from('x'));
  console.log('NOPERM-OK ' + (zlib.inflateRawSync(c).toString() === 'x'));
}
`,
      [],
    );
    assert.equal(out, 'NOPERM-OK true');
  });
});
