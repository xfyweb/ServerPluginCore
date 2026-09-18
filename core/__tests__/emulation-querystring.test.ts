// node:querystring 仿真的对齐测试
//
// 判卷人：
//   1. **宿主 Node**：纯计算模块，剧本逐条与 `node:querystring` 差分（本模块就是它的逐行移植）；
//   2. **形状真值**（`_audit/qs-shape-truth.json`，WSL node v22.22.1）：别名身份（`encode === stringify`）、
//      常量、坏转义回退这类"差分脚本里容易漏掉"的点按真值断言；
//   3. **真沙箱冒烟**：QuickJS 里跑一遍（真实的 UTF-8 回退要走宿主 bytes 通道）。
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as hostQs from 'node:querystring';
import { pathToFileURL } from 'node:url';

const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-qs-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;
after(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

const { buildHostApi } = await import('../../core/hostApi.ts');
const { buildEnvFacts } = await import('../../core/emulated-env.ts');
const { toErrorShape } = await import('../../core/errors.ts');

const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-shims-qs-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
const SHIM_SRC = join(process.cwd(), 'core', 'sandbox-modules');
for (const f of ['node-querystring.js', 'node-buffer.js']) copyFileSync(join(SHIM_SRC, f), join(SHIM_DIR, f));
after(() => rmSync(SHIM_DIR, { recursive: true, force: true }));

const DATA_DIR = mkdtempSync(join(tmpdir(), 'spc-qs-data-'));
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

/** 最小假桥：够 `node-buffer.js` 的编解码用（与 `emulation-zlib.test.ts` 同一套写法） */
function installBridge(dataDir: string): void {
  const api = buildHostApi({ pluginId: '@test/qs', dataDir });
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
            return result instanceof Uint8Array
              ? (result.byteOffset === 0 && result.byteLength === result.buffer.byteLength
                  ? result.buffer
                  : new Uint8Array(result).buffer)
              : result;
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

installBridge(DATA_DIR);
const qs = await import(pathToFileURL(join(SHIM_DIR, 'node-querystring.js')).href);

interface Outcome {
  ok: boolean;
  value?: unknown;
  code?: string;
  name?: string;
  message?: string;
}

function capture(fn: () => unknown): Outcome {
  try {
    const v = fn();
    // null 原型对象 deepEqual 会因原型不同而失败 ⇒ 转成普通对象，另用 protoOf 单独断言原型
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const plain: Record<string, unknown> = {};
      for (const k of Object.keys(v as object)) plain[k] = (v as any)[k];
      return { ok: true, value: { plain, nullProto: Object.getPrototypeOf(v) === null } };
    }
    return { ok: true, value: v };
  } catch (err: any) {
    return { ok: false, code: err?.code, name: err?.name, message: err?.message };
  }
}

function compare(name: string, run: (q: any) => unknown): void {
  it(name, () => {
    const ours = capture(() => run(qs));
    const theirs = capture(() => run(hostQs));
    assert.equal(
      ours.ok,
      theirs.ok,
      `${name}：成败不一致（我们 ${ours.ok ? 'ok' : ours.code}，宿主 ${theirs.ok ? 'ok' : theirs.code}）`,
    );
    if (theirs.ok) {
      assert.deepEqual(ours.value, theirs.value, `${name}：结果不一致`);
    } else {
      assert.equal(ours.code, theirs.code, `${name}：错误码不一致`);
      assert.equal(ours.message, theirs.message, `${name}：错误 message 不一致`);
    }
  });
}

describe('仿真 node:querystring —— 与宿主 Node 差分对跑', () => {
  // ── parse ──
  compare('parse：常规、空串、非字符串、重复键、无等号、空键', (q) => [
    q.parse('a=1&b=2'),
    q.parse(''),
    q.parse(42),
    q.parse('a=1&a=2&a=3'),
    q.parse('a&b=2'),
    q.parse('=b'),
    q.parse('a=1&'),
    q.parse('&&a=1&&'),
  ]);
  compare('parse：`+` 与 `%20`、百分号解码、坏转义回退', (q) => [
    q.parse('a+b=c+d'),
    q.parse('a%20b=c%20d'),
    q.parse('a=%E4'), // 孤立的非法 UTF-8 ⇒ U+FFFD（走宿主 UTF-8 回退）
    q.parse('a=%zz'),
    q.parse('a=%4'),
    q.parse('%E4=%E4'),
  ]);
  compare('parse：maxKeys 的三种取值（正数/0/-1）', (q) => [
    q.parse('a=1&b=2&c=3', '&', '=', { maxKeys: 2 }),
    q.parse('a=1&b=2&c=3', '&', '=', { maxKeys: 0 }),
    q.parse('a=1&b=2&c=3', '&', '=', { maxKeys: -1 }),
    q.parse('a=1&b=2&c=3', '&', '=', { maxKeys: 1 }),
  ]);
  compare('parse：自定义 sep/eq 与自定义 decodeURIComponent', (q) => [
    q.parse('a=1;b=2', ';', '='),
    q.parse('a:1|b:2', '|', ':'),
    q.parse('a=%41&b=%42', '&', '=', { decodeURIComponent: (s: string) => s.toLowerCase() }),
  ]);
  compare('parse：分段的多字节分隔符（Node 的逐字符匹配算法）', (q) => [
    q.parse('a=1&&b=2', '&&', '='),
    q.parse('k1::v1::k2::v2', '::', '::'),
  ]);

  // ── stringify ──
  compare('stringify：标量/数组/空数组/空串/null/undefined/布尔/大数', (q) => [
    q.stringify({ a: 1, b: 'x y', c: [1, 2], d: null, e: undefined, f: true, g: 1e21 }),
    q.stringify({ a: [] }),
    q.stringify({ a: '' }),
    q.stringify({ a: [''], b: 'z' }),
    q.stringify({}),
    q.stringify(null),
    q.stringify('nope'),
    q.stringify(42),
  ]);
  compare('stringify：非 ASCII / 代理对 / 需要转义的标点', (q) => [
    q.stringify({ '中文': '值', emoji: '😀' }),
    q.stringify({ p: "!'()*~ -._" }),
    q.stringify({ a: 1, b: 2 }, ';', ':'),
    q.stringify({ a: 'x y' }, '&', '=', { encodeURIComponent: encodeURIComponent }),
    q.stringify({ a: '' }, '&', '=', { encodeURIComponent: (s: string) => 'X' + s }),
    q.stringify({ a: [1, 2, 3] }, '&', '=', { encodeURIComponent: (s: string) => '[' + s + ']' }),
  ]);
  compare('stringify：孤立代理项 → ERR_INVALID_URI', (q) => q.stringify({ a: '\uD800' }));

  // ── escape / unescape ──
  compare('escape：字符串、数字、对象、空串', (q) => [
    q.escape("!'()*~ -._"),
    q.escape(42),
    q.escape({ toString: () => 'a b' }),
    q.escape(''),
    q.escape('中文😀'),
  ]);
  compare('unescape：合法转义、坏转义、`+` 不当空格', (q) => [
    q.unescape('%E4%B8%AD'),
    q.unescape('%E4'),
    q.unescape('%zz%4'),
    q.unescape('a+b'),
    q.unescape('a+b', true),
  ]);
  compare('unescapeBuffer：返回值形状（截断策略见"有意不同"）', (q) => [
    Array.from(q.unescapeBuffer('a+b', true)),
    Array.from(q.unescapeBuffer('a+b', false)),
    Array.from(q.unescapeBuffer('%E4', true)),
    // 无 hex ⇒ Node 返回整段（含未初始化尾部），我们返回写出的字节：长度**有意不同**，
    // 内容前缀必须一致
    Array.from(q.unescapeBuffer('abc', true).subarray(0, 3)),
  ]);
});

describe('仿真 node:querystring —— 形状与有意不同', () => {
  it('别名是**同一个函数对象**（`encode === stringify`、`decode === parse`）', () => {
    assert.equal(qs.encode, qs.stringify);
    assert.equal(qs.decode, qs.parse);
    assert.equal(qs.default.encode, qs.default.stringify);
    assert.equal(qs.default.decode, qs.default.parse);
    // 宿主上同样成立（所以这确实是契约的一部分，不是我们多写的）
    assert.equal((hostQs as any).encode, (hostQs as any).stringify);
    assert.equal((hostQs as any).decode, (hostQs as any).parse);
  });

  it('导出面：默认导出 7 个方法 + 命名空间多一个 `default`', () => {
    const SEVEN = ['decode', 'encode', 'escape', 'parse', 'stringify', 'unescape', 'unescapeBuffer'];
    const ours = Object.keys(qs.default).sort();
    assert.deepEqual(ours, SEVEN);
    for (const k of ours) assert.equal(typeof (qs as any)[k], 'function', `${k} 应当是具名导出`);
    // 不拿宿主命名空间去比键集：CJS 内建的具名导出是 Node 逐版本调整的启发式产物
    // （实测同一个文件在 tsx 与原生 ESM 下看到的键集都不同），拿它当判卷人只会得到"工具相关"的红灯。
    // 契约本身来自基线真值（`_audit/qs-shape-truth.json`）：
    //   宿主 CJS 对象（`require`）= 这 7 个；宿主 ESM 命名空间 = 这 7 个 + `default`。
    const hostCjs = createRequire(import.meta.url)('node:querystring');
    assert.deepEqual(Object.keys(hostCjs).sort(), SEVEN, '宿主 CJS 对象就是这 7 个');
    const ns = Object.keys(qs).sort();
    assert.deepEqual(ns, ['decode', 'default', ...SEVEN.filter((k) => k !== 'decode')]);
    for (const k of SEVEN) assert.equal(typeof (hostQs as any)[k], 'function', `宿主也有 ${k}`);
  });

  it('`escape` 的保留字符集按基线：`!-._~\'()*` 与字母数字**不转义**（空格 → `%20`）', () => {
    // 真值 `_audit/qs-shape-truth.json`（v22.22.1）：`"!'()*~%20-._"`
    // 容易记反：`encodeURIComponent` 保留 `!'()*`，而 querystring 的 noEscape 表里 `!` 根本不置位
    // ⇒ 我们与宿主**都不**转义它们，四种输入给同一个串
    const expected = "!'()*~%20-._";
    assert.equal(hostQs.escape("!'()*~ -._"), expected);
    assert.equal(qs.escape("!'()*~ -._"), expected);
  });

  it('parse 返回 **null 原型**对象（`__proto__` 注入不成立）', () => {
    const parsed = qs.parse('__proto__=x&a=1');
    assert.equal(Object.getPrototypeOf(parsed), null);
    assert.equal((parsed as any).a, '1');
    assert.equal(({} as any).x, undefined);
    assert.equal(Object.getPrototypeOf(hostQs.parse('a=1')), null);
  });

  it('unescapeBuffer 的长度为**实际写出的字节**（整段/截断两条路都与 Node 一致）', () => {
    // 基线 v22.22.1（`_audit/qs-unescbuf-truth.mjs`）：有 hex ⇒ 截断到写出长度；无 hex ⇒ 整段。
    // `@types/node` 没给 `unescapeBuffer` 的类型（它漏了这个公开 API）⇒ 这里显式收窄
    const hostUnesc = (hostQs as unknown as { unescapeBuffer: (s: string, sp: boolean) => Buffer })
      .unescapeBuffer;
    assert.equal(typeof hostUnesc, 'function', '宿主确实有 unescapeBuffer（类型定义漏了）');
    assert.equal(hostUnesc('abc', true).length, 3); // 无 hex ⇒ 整段
    assert.equal(hostUnesc('%41%42', false).length, 2); // 有 hex ⇒ 截断
    assert.equal(hostUnesc('%E4', true).length, 1);
    // 我们给的是**写出的字节**：三条都对得上（差异只在"无 hex"那档的尾部未初始化字节，
    // Node 那边那是 `allocUnsafe` 的残留，值本身没有语义）
    assert.equal(qs.unescapeBuffer('abc', true).length, 3);
    assert.equal(qs.unescapeBuffer('%41%42', false).length, 2);
    assert.equal(qs.unescapeBuffer('%E4', true).length, 1);
    assert.equal(qs.unescapeBuffer('%41%42', false).toString(), hostUnesc('%41%42', false).toString());
    assert.equal(qs.unescapeBuffer('%E4', true).toString(), '\uFFFD');
  });

  it('坏转义的 UTF-8 回退**真的走了宿主**（沙箱里没有 UTF-8 解码器）', () => {
    // 假桥记一笔：说明这条路径不是"沙箱里自己凑出来的"
    const calls: string[] = [];
    const proxy = (globalThis as any).__host;
    (globalThis as any).__host = new Proxy(
      {},
      {
        get: (_t, name: string) => {
          const fn = proxy[name];
          return (...args: unknown[]) => {
            calls.push(name);
            return fn(...args);
          };
        },
      },
    );
    try {
      assert.equal(qs.parse('a=%E4').a, '\uFFFD');
      assert.ok(calls.length > 0, '坏转义回退应当调用宿主编解码');
    } finally {
      (globalThis as any).__host = proxy;
    }
  });
});

// ──────────────────────────── 真沙箱冒烟 ────────────────────────────

describe('仿真 node:querystring —— 真实 QuickJS 沙箱里跑通', async () => {
  const { createSandbox } = await import('../../core/sandbox.ts');
  const SMOKE_DIR = mkdtempSync(join(tmpdir(), 'spc-smoke-qs-'));
  after(() => rmSync(SMOKE_DIR, { recursive: true, force: true }));

  async function runInSandbox(code: string, permissions: string[]): Promise<string> {
    const api = buildHostApi({ pluginId: '@spc-test/qs', dataDir: SMOKE_DIR });
    const sandbox = await createSandbox(api, {
      pluginId: '@spc-test/qs',
      permissions,
      facts: { version: { code: 1, name: 'test' }, dataDir: SMOKE_DIR, manifest: {}, config: {} },
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule('@spc-test/qs', code);
      await sandbox.callHook('init', 5_000);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    return logs.join('\n');
  }

  it('parse/stringify/escape/坏转义回退 全链路在沙箱里成立', async () => {
    const out = await runInSandbox(
      `
import qs, { parse, stringify, escape, unescape } from 'node:querystring';
export function init() {
  console.log('PARSE ' + JSON.stringify(parse('a=1&b=x+y&c=%E4%B8%AD')));
  console.log('ALIAS ' + (qs.encode === qs.stringify) + '/' + (qs.decode === qs.parse));
  console.log('STR ' + stringify({ a: 1, b: ['x', 'y'], c: null }));
  console.log('ESC ' + escape("!'()*~ -._"));
  console.log('BAD ' + unescape('%E4'));
  console.log('PROTO ' + (Object.getPrototypeOf(parse('a=1')) === null));
}
`,
      ['bytes.encode', 'bytes.decode'],
    );
    assert.equal(out.split('\n')[0], 'PARSE {"a":"1","b":"x y","c":"中"}');
    assert.equal(out.split('\n')[1], 'ALIAS true/true');
    assert.equal(out.split('\n')[2], 'STR a=1&b=x&b=y&c=');
    assert.equal(out.split('\n')[3], "ESC !'()*~%20-._");
    assert.equal(out.split('\n')[4], 'BAD \uFFFD');
    assert.equal(out.split('\n')[5], 'PROTO true');
  });

  it('不声明 bytes 权限也能走坏转义回退（v4：`bytes.*` 是 self/auto，免声明）', async () => {
    // 前提变更（第四批 B）：以前这条断言"未声明 → EACCES"。
    // `bytes.encode`/`decode` 是 `scope: self`——输入是调用方给的字节/字符串、输出还给调用方。
    // 宿主代工不等于要权限：判据是"够不够得着别人"。
    const out = await runInSandbox(
      `
import { parse } from 'node:querystring';
export function init() {
  try { console.log('NOPERM ' + parse('a=%E4').a.charCodeAt(0)); } catch (e) { console.log('NOPERM ' + e.code); }
}
`,
      [],
    );
    assert.equal(out, 'NOPERM 65533'); // U+FFFD：UTF-8 回退真的走了宿主，且不再需要声明
  });
});
