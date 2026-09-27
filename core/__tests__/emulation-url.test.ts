// node:url 仿真的对齐测试
//
// 判卷人有三个，各管一段（照 emulation-os-process.test.ts / emulation-fs.test.ts 的分工）：
//   1. **宿主 Node**：平台无关的面逐条差分对跑——宿主通道用的是**真的宿主 API**
//      （`buildHostApi` + 一个只做"取参 / JSON 化 / 错误信封"三件事的假桥），宿主实现一行都不重写；
//   2. **v22.22.1 真值**（`tools/truth/data/fs-url-truth.json`，WSL node v22.22.1 实测 + `tools/truth/data/url-probe*.json`）：
//      仿真基线固定 v22.22.1，宿主 v24 在个别地方已经偏离（最典型的是 `URLPattern` 进了导出面、
//      非法端口从"当路径段"改成抛错）。凡是与平台无关的那些值，直接把录下来的真值写死在这里断言——
//      这台开发机是 Windows，拿宿主当判卷人在这些点上会得出错误结论；
//   3. **结构性断言**：凡是我们**有意与 Node 不同**的地方（POSIX 文件 URL 基线、不发 DeprecationWarning、
//      不做 createObjectURL），不跟宿主比，直接断言我们自己的判据。
//
// 最后还有一条**真沙箱冒烟**：宿主进程里的差分测试测不出"沙箱里没有某个全局"、
// 也测不出引导层注入与权限判定在真桥上是否成立（这个项目踩过 `queueMicrotask` 的坑：
// 宿主全绿、进沙箱就 ReferenceError）。
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as hostUrl from 'node:url';

// 审计隔离（本文件会建真沙箱）：AUDIT_DIR 在 audit.ts 模块加载时读环境变量，所以先设再动态 import
const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-url-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;
after(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

const { buildHostApi } = await import('../../core/hostApi.ts');
const { buildEnvFacts } = await import('../../core/emulated-env.ts');
const { toErrorShape } = await import('../../core/errors.ts');

// shim 的加载方式与既有对齐测试一致：逐字节拷到临时目录（ESM），再按 file: 导入。
// node-url.js 依赖 node-buffer.js（fileURLToPathBuffer 的返回类型与畸形百分号编码的字节回退），两个都得拷。
const SHIM_SRC = join(process.cwd(), 'core', 'sandbox-modules');
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-shims-url-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
for (const f of ['node-url.js', 'node-buffer.js']) copyFileSync(join(SHIM_SRC, f), join(SHIM_DIR, f));
after(() => rmSync(SHIM_DIR, { recursive: true, force: true }));

const DATA_DIR = mkdtempSync(join(tmpdir(), 'spc-data-url-'));
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

/**
 * 装假桥：只做真桥做的三件事（见 core/sandbox.ts 的 `__host` 闭包）。
 *
 * 两个**不能省**的细节：
 *   · 参数按 VM 侧类型搬运——ArrayBuffer 要变成 `Uint8Array`（真桥是 `Uint8Array.from(view.value)`）。
 *     漏了这步宿主实现会以 `ERR_INVALID_ARG_TYPE` 失败，而差分测试会把它误读成 shim 的 bug；
 *   · `binaryResult` 方法要回 ArrayBuffer（`bytes.fromString`），其余仍是 JSON 文本信封——
 *     `fileURLToPathBuffer` 与畸形百分号回退都走这条通道。
 */
function installBridge(dataDir: string): void {
  const api = buildHostApi({ pluginId: '@test/url', dataDir });
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
            const bytes = result as Uint8Array;
            return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
              ? bytes.buffer
              : new Uint8Array(bytes).buffer;
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

/** shim 与它的 Buffer（判 `instanceof` 必须用**同一个** Buffer，不能用宿主的） */
const U: any = await import(pathToFileURL(join(SHIM_DIR, 'node-url.js')).href);
const { Buffer: ShimBuffer } = await import(pathToFileURL(join(SHIM_DIR, 'node-buffer.js')).href);

/** 只比"抛没抛 + 错误形状"：成功时给值，失败时给 `name/code/message` 三元组 */
function outcome(fn: () => unknown): unknown {
  try {
    return { ok: fn() };
  } catch (e: any) {
    return { err: [e?.name, e?.code, e?.message] };
  }
}

/** 同一操作在 shim 与宿主上各跑一遍，逐字比结果（含错误三元组） */
function diff(label: string, mine: () => unknown, theirs: () => unknown): void {
  assert.deepStrictEqual(outcome(mine), outcome(theirs), label);
}

// ─────────────────────────────────────────────────────────────
// 导出面 + 文件 URL（POSIX 基线）
// ─────────────────────────────────────────────────────────────
describe('仿真 node:url —— 导出面', () => {
  it('导出键与 v22.22.1 一致（真值：tools/truth/data/fs-url-truth.json 的 urlExportKeys）', () => {
    // 与 v22.22.1 对齐而不是与宿主对齐：宿主 v24 多了一个 `URLPattern`
    // （它是独立的内置绑定，Node 在 v24 才挂到 url 模块上），仿真基线里没有它。
    assert.deepStrictEqual(Object.keys(U).sort(), [
      'URL',
      'URLSearchParams',
      'Url',
      'default',
      'domainToASCII',
      'domainToUnicode',
      'fileURLToPath',
      'fileURLToPathBuffer',
      'format',
      'parse',
      'pathToFileURL',
      'resolve',
      'resolveObject',
      'urlToHttpOptions',
    ]);
    assert.equal(typeof (hostUrl as any).URLPattern, 'function', '宿主已加 URLPattern——差异是有意的');
  });

  it('默认导出与具名导出是同一批值（`import url from "node:url"` 的老写法要能用）', () => {
    for (const k of Object.keys(U.default)) {
      assert.equal(U.default[k], U[k], `${k} 的默认导出与具名导出不是同一个值`);
    }
    // 命名空间比 default 多一个 `default` 自己（14 vs 13）
    assert.equal(Object.keys(U.default).length, 13);
  });
});

describe('仿真 node:url —— pathToFileURL / fileURLToPath（POSIX 基线，真值表逐条）', () => {
  // 绝对路径的结果**与平台无关**（我们的 resolve 固定 posix），所以这些真值在任何宿主上都成立：
  // 出处 tools/truth/data/fs-url-truth.json + tools/truth/data/url-probe2.json（WSL node v22.22.1）。
  const PTF_TRUTH: Array<[string, string]> = [
    ['/tmp/a b#c.txt', 'file:///tmp/a%20b%23c.txt'],
    ['/', 'file:///'],
    ['/tmp/dir/', 'file:///tmp/dir/'],
    ['/tmp/../x', 'file:///x'],
    ['/tmp/ä.txt', 'file:///tmp/%C3%A4.txt'],
    ['/tmp/😀.txt', 'file:///tmp/%F0%9F%98%80.txt'],
    ['/tmp/a%20b.txt', 'file:///tmp/a%2520b.txt'],
    ['/tmp/a\\b', 'file:///tmp/a%5Cb'],
    // 逐字符验过 0x01–0x7F（开发工作区的探针实测）：这 15 个 + C0 控制符 + 0x7F 会被**预转义**，
    // 剩下的交给宿主解析器。少了预转义表，`~`/`|`/`^` 这些就会原样留在 href 里。
    ['/tmp/a~b|c^d`e{f}g[h]i<j>k"l', 'file:///tmp/a%7Eb%7Cc%5Ed%60e%7Bf%7Dg%5Bh%5Di%3Cj%3Ek%22l'],
    ['/tmp/a\u0001b\u007fc', 'file:///tmp/a%01b%7Fc'],
  ];

  it('绝对路径的转义与 v22.22.1 逐条一致（宿主是 Windows 也成立）', () => {
    for (const [input, expected] of PTF_TRUTH) {
      assert.equal(U.pathToFileURL(input).href, expected, `pathToFileURL(${JSON.stringify(input)})`);
    }
  });

  it('Linux 宿主上与 node:url 一致：**绝对路径**逐条比宿主，**相对路径**比自洽', () => {
    if (process.platform !== 'linux') return; // 相对路径的差异见下面那条"有意不同"
    // ⚠️ 相对路径**不能**和宿主比：宿主的 cwd 是仓库根，而沙箱里 `process.cwd()` 就是**数据目录**
    // （`module-emulation-design` §8：沙箱可见的路径全是一个形态）。原来那句"两边 cwd 相同"是错的
    // —— 它只在这条用例被跳过时（非 Linux）才没露。
    for (const p of ['/tmp/a b#c.txt', '/', '/tmp/dir/']) {
      assert.equal(U.pathToFileURL(p).href, hostUrl.pathToFileURL(p).href, `pathToFileURL(${JSON.stringify(p)})`);
    }
    // 相对路径：两边 cwd 不同（宿主=仓库根，我们=数据目录），所以比**去掉 cwd 之后的那一段** ——
    // 这样既验了"相对路径按自己的 cwd 解析、`..` 归一"这个形状，又不依赖谁的 cwd 长什么样。
    const ourBase = U.pathToFileURL('.').href;
    const hostBase = hostUrl.pathToFileURL('.').href;
    for (const p of ['rel/x.txt', '.', '', 'a/../b']) {
      const ours = U.pathToFileURL(p).href;
      const theirs = hostUrl.pathToFileURL(p).href;
      assert.ok(ours.startsWith(ourBase), `我们这边应当以自身 cwd 起头：${p} ⇒ ${ours}`);
      assert.ok(theirs.startsWith(hostBase), `宿主那边应当以自身 cwd 起头：${p} ⇒ ${theirs}`);
      assert.equal(ours.slice(ourBase.length), theirs.slice(hostBase.length), `相对部分应当同形：${p}`);
    }
  });

  it('fileURLToPath：真值表的四种错误与三条成功路径', () => {
    // 出处 tools/truth/data/fs-url-truth.json（Linux）——我们固定 posix，所以在任何宿主上都是这些值
    assert.equal(U.fileURLToPath('file:///tmp/a%20b.txt'), '/tmp/a b.txt');
    assert.equal(U.fileURLToPath('file://localhost/tmp/x'), '/tmp/x');
    assert.equal(U.fileURLToPath('file:///C:/x/y'), '/C:/x/y');
    assert.equal(U.fileURLToPath('file:///tmp/%E4%B8%AD.txt'), '/tmp/中.txt');
    assert.equal(U.fileURLToPath('file://localhost/'), '/');

    const cases: Array<[string, string, string]> = [
      ['file://example.com/tmp/x', 'ERR_INVALID_FILE_URL_HOST', 'File URL host must be "localhost" or empty on linux'],
      ['/tmp/x', 'ERR_INVALID_URL', 'Invalid URL'],
      ['file:///tmp/a%2Fb', 'ERR_INVALID_FILE_URL_PATH', 'File URL path must not include encoded / characters'],
    ];
    for (const [input, code, message] of cases) {
      assert.throws(
        () => U.fileURLToPath(input),
        (err: any) => err.name === 'TypeError' && err.code === code && err.message === message,
        `fileURLToPath(${input})`,
      );
    }
  });

  it('fileURLToPath 同时接受 URL 实例（node-fs.js 会把插件传的 URL 路径参数交给它）', () => {
    assert.equal(U.fileURLToPath(new U.URL('file:///tmp/a%20b.txt')), '/tmp/a b.txt');
    diff(
      'fileURLToPath(非 file: 的 URL 实例)',
      () => U.fileURLToPath(new U.URL('http://x/y')),
      () => hostUrl.fileURLToPath(new hostUrl.URL('http://x/y')),
    );
    // 下面两条传的是**非法输入**（宿主 Node 会抛 ERR_INVALID_ARG_TYPE），类型定义拦着不给传，故 as any
    diff('fileURLToPath(普通对象)', () => U.fileURLToPath({}), () => hostUrl.fileURLToPath({} as any));
    diff('fileURLToPath(数字)', () => U.fileURLToPath(123), () => hostUrl.fileURLToPath(123 as any));
  });

  it('fileURLToPathBuffer 返回**沙箱自己的 Buffer**，且保留原始字节（不做 UTF-8 解码）', () => {
    const b = U.fileURLToPathBuffer('file:///tmp/a%20b%E4%B8%AD.txt');
    assert.equal(b instanceof ShimBuffer, true, '必须是 shimBuffer 的实例（与 node:buffer 同一份实现）');
    assert.equal(b instanceof Uint8Array, true);
    // `/tmp/a b` + E4B8AD + `.txt`：中文字符保持三个原始字节，**不**合并成字符
    assert.equal(Buffer.from(b).toString('hex'), '2f746d702f612062e4b8ad2e747874');

    if (process.platform === 'linux') {
      for (const f of ['file:///tmp/a%20b%E4%B8%AD.txt', 'file:///tmp/a%2Fb', 'file:///tmp/a%zz', 'file:///tmp/a%00b']) {
        assert.equal(
          Buffer.from(U.fileURLToPathBuffer(f)).toString('hex'),
          Buffer.from(hostUrl.fileURLToPathBuffer(f)).toString('hex'),
          `fileURLToPathBuffer(${f})`,
        );
      }
    }
    // `%2F` 在 buffer 变体里**不报错**（Node 刻意不扫斜杠转义），与字符串变体正相反
    assert.equal(Buffer.from(U.fileURLToPathBuffer('file:///tmp/a%2Fb')).toString(), '/tmp/a/b');
    assert.throws(() => U.fileURLToPath('file:///tmp/a%2Fb'), (e: any) => e.code === 'ERR_INVALID_FILE_URL_PATH');
  });
});

// ─────────────────────────────────────────────────────────────
// legacy 面
// ─────────────────────────────────────────────────────────────
describe('仿真 node:url —— legacy Url/parse/format/resolve', () => {
  const LEGACY_INPUTS: unknown[][] = [
    ['http://u:p@example.com:8080/a/b?c=1&d=2#frag'],
    ['http://example.com/a'],
    ['mailto:a@b.com'],
    ['http:example.com/a'],
    ['http://a b/c'],
    ['/a/b?c#d'],
    ['a/b'],
    ['http://[::1]:8080/x'],
    ['http://x//a//b'], // 真值：pathname = '//a//b'（不做斜杠合并）
    ['//a//b'],
    ['//a//b', false, true],
    ['http://x/a?b=1', false, true],
    ['http://x/a?b=1&b=2', true],
    ['?a=1'],
    ['#f'],
    ['/a/b', true],
    ['  http://x/a  '],
    ['http:\\\\x\\a'],
    ['http://x:abc/a'], // 见 describe 末尾那条：v22 基线行为
    ['http://ÄÖÜ.com/a'],
    ['HTTP://X.COM/A'],
    ['http://a%40b:p@x/a'],
    ['http://a@b@c/'],
    ['http://a@b?@c'],
    ['javascript:alert(1)'],
    ['javascript://x/%20'],
    ['gopher://x/a'],
    ['ws://x/a'],
    ['file:///tmp/x'],
    ['http://x/a+b'],
    ['http://x\t/a'],
    ['http://xn--a.com/'],
    ['http://%41.com/'],
    ['http://a..b/'],
    ['http://-a.com/'],
    ['http://a_b.com/'],
    ['http://A.COM/'],
    ['http://' + 'a'.repeat(300) + '/x'], // 主机名超 255 → 清空
    ['http://x/?a=%E4&b=%zz&c=+&d=%2B&e', true],
    ['http://x/?b=1&b=2&b=3', true],
    ['http://x/?a=1&&b=2&=c', true],
    ['http://x/a?=b&=c&d=', true],
    ['http://[::1/a'],
    ['mailto:a@b.com?subject=x'],
    ['http://u:p@x:8080/a/b?c=1#f'],
    ['http://x/a?b=1', true],
    ['http://a b.com/x'],
    ['http://ex ample.com/'],
    ['http://％41.com/'],
    ['http://＃a.com/'],
    ['http://ａｂｃ.com/'],
    ['http://a／b.com/'],
    ['http://a＠b.com/'],
    ['http://a\u0000b.com/'],
    ['http://ünïcödé.example/'],
  ];

  /**
   * Url 实例 → 普通对象再比：`deepStrictEqual` 会先比原型，而两边的 `Url` 是各自模块里的类
   * （原型天然不同）。字段值一个不少地比，只是不比"是谁的实例"——那一条单独断言。
   */
  const plainUrl = (u: any): unknown =>
    u && typeof u === 'object' ? { ...u, query: u.query && typeof u.query === 'object' ? { ...u.query } : u.query } : u;

  it(`url.parse 与宿主逐条一致（${LEGACY_INPUTS.length} 组，含真值表的全部输入）`, () => {
    for (const args of LEGACY_INPUTS) {
      diff(`parse(${JSON.stringify(args)})`, () => plainUrl(U.parse(...args)), () => plainUrl((hostUrl.parse as any)(...args)));
    }
  });

  it('parse 的结果是 Url 实例，且 href 能再 parse 回来（幂等）', () => {
    assert.equal(U.parse('http://x/a') instanceof U.Url, true);
    const u = U.parse('http://u:p@x:8080/a/b?c=1#f');
    assert.equal(U.parse(u.href).href, u.href);
    assert.equal(U.parse(u), u, 'parse 收到 Url 实例要原样返回（Node: `if (url instanceof Url) return url`）');
  });

  it('parseQueryString=true 用 querystring 语义：重复键变数组、null 原型、上限 1000', () => {
    // 真值：tools/truth/data/url-probe3.json（重复键 / 空段 / 非 UTF-8 百分号 / 上限）
    const q = U.parse('http://x/?b=1&b=2&b=3&a=%E4&c=+&d=%2B&e', true).query;
    assert.deepStrictEqual({ ...q }, { b: ['1', '2', '3'], a: '\uFFFD', c: ' ', d: '+', e: '' });
    assert.equal(Object.getPrototypeOf(q), null, 'query 是 { __proto__: null }');
    assert.deepStrictEqual({ ...U.parse('http://x/?a=1&&b=2&=c', true).query }, { a: '1', b: '2', '': 'c' });
    const many = 'http://x/?' + Array.from({ length: 1200 }, (_, i) => `k${i}=v`).join('&');
    assert.equal(Object.keys(U.parse(many, true).query).length, 1000);
    // parseQueryString=false 时 query 是**字符串**（不去掉 `?`），照 Node
    assert.equal(U.parse('http://x/a?b=1', false, true).query, 'b=1');
    assert.equal(U.parse('http://x/a?b=1', false, true).search, '?b=1');
  });

  const FORMAT_INPUTS: unknown[][] = [
    [{ protocol: 'http', host: 'x.com', pathname: '/a', query: { b: '1' }, hash: '#f' }],
    ['http://x/a'],
    [{ protocol: 'http', slashes: true, auth: 'u:p', host: 'x.com' }],
    [{ protocol: 'http', host: 'x', pathname: '/a', query: { b: ['1', '2'] } }],
    [{ protocol: 'http', host: 'x', pathname: '/a', query: 'b=1' }], // 字符串 query 不走 format（要靠 search）
    [{ protocol: 'http', host: 'x', query: {} }],
    [{ protocol: 'http', host: 'x', pathname: '/a', query: { b: 'x y' } }], // querystring 用 %20 不是 +
    [{ protocol: 'http', host: 'x', auth: 'a b@c' }],
    [{ protocol: 'http', host: 'x', pathname: '/a', search: '?b=1' }],
    [{ protocol: 'file', pathname: '/tmp/x' }],
    [{ protocol: 'http:', host: 'x' }],
    [null],
  ];

  it(`url.format 与宿主逐条一致（${FORMAT_INPUTS.length} 组）`, () => {
    for (const args of FORMAT_INPUTS) {
      diff(`format(${JSON.stringify(args)})`, () => U.format(...args), () => (hostUrl.format as any)(...args));
    }
  });

  it('url.format(URL 实例, options)：四个开关的 16 种组合都与宿主一致', () => {
    // 这条守的是"宿主代工替代不了的 C++ 行为"：node/src/node_url.cc:370 的 Format 直接改四个字段再序列化，
    // 其中 `out->host = to_unicode(...)` 是**绕过解析器**的直接赋值，只有做定位替换才能复刻。
    const urls = ['http://u:p@x:8080/a?b=1#f', 'http://x/a', 'https://xn--fiq228c.com/p?q=1#h', 'file:///tmp/x', 'http://[::1]:8080/a?b=1#f', 'http://x/a?'];
    for (const href of urls) {
      for (let mask = 0; mask < 16; mask++) {
        const opts = { fragment: !!(mask & 1), unicode: !!(mask & 2), search: !!(mask & 4), auth: !!(mask & 8) };
        diff(
          `format(${href}, ${JSON.stringify(opts)})`,
          () => U.format(new U.URL(href), opts),
          () => hostUrl.format(new hostUrl.URL(href), opts),
        );
      }
    }
    // 真值：`unicode:true` 把 punycode 主机名解回 Unicode（不经 IDNA 转回去）
    assert.equal(U.format(new U.URL('https://xn--fiq228c.com/p'), { unicode: true }), 'https://中文.com/p');
  });

  const RESOLVE_INPUTS: Array<[string, string]> = [
    ['http://x/a/b', '../c'],
    ['http://x/a/b', 'https://y/z'],
    ['http://x/a?q=1', '?r=2'],
    ['http://x/a', '//y/b'],
    ['http://x/a#f', '#g'],
    ['/a/b', 'c'],
    ['file:///a/b', '../c'],
    ['http://x/a', ''],
  ];

  it('url.resolve / resolveObject 与宿主一致（含协议相对、query-only、空相对）', () => {
    for (const [source, rel] of RESOLVE_INPUTS) {
      diff(`resolve(${source}, ${rel})`, () => U.resolve(source, rel), () => hostUrl.resolve(source, rel));
    }
    for (const [source, rel] of [['http://x/a/b', '../c'], ['http://x/a/b?c=1#f', 'https://y/p?q=2'], ['mailto:local1@domain1', 'local2@domain2']]) {
      // `resolveObject` 在 @types/node 里没有声明（Node 的类型定义确实缺这个方法），故 as any
      diff(`resolveObject(${source}, ${rel})`, () => U.resolveObject(source, rel).href, () => (hostUrl as any).resolveObject(source, rel).href);
    }
    assert.equal(U.resolveObject('http://x/a/b', '../c') instanceof U.Url, true);
    assert.equal(U.resolveObject('', 'http://x/a'), 'http://x/a', '没有 source 时原样返回 relative');
  });

  it('Url 类本体：构造器字段顺序、方法、parseHost 的端口切分', () => {
    assert.deepStrictEqual(Object.keys(new U.Url()), [
      'protocol', 'slashes', 'auth', 'host', 'port', 'hostname', 'hash', 'search', 'query', 'pathname', 'path', 'href',
    ]);
    const u = new U.Url();
    u.parse('http://x/a?b=1', true, true);
    assert.deepStrictEqual([u.protocol, u.href, u.format(), { ...u.query }], ['http:', 'http://x/a?b=1', 'http://x/a?b=1', { b: '1' }]);
    const ipv6 = U.parse('http://[::1]:8080/x');
    assert.deepStrictEqual([ipv6.host, ipv6.hostname, ipv6.port], ['[::1]:8080', '::1', '8080']);
  });

  it('非法端口按 **v22.22.1 基线**处理（v27 检出已改成抛错，那不在仿真基线里）', () => {
    // url.js:519-521（本地 v27）里这里是 `throw ERR_INVALID_ARG_VALUE('url','Invalid port in url')`，
    // 而 v22.22.1（真值表 + 宿主 v24）把 `:abc` 当路径段。仿真基线固定 v22.22.1（设计 §13.1 第 4 条），
    // 所以按基线移植——这条用例就是那条决策的守门人。
    assert.equal(U.parse('http://x:abc/a').href, 'http://x/:abc/a');
    assert.equal(hostUrl.parse('http://x:abc/a').href, 'http://x/:abc/a', '宿主 v24 与基线一致');
    assert.throws(() => U.parse(123 as any), (e: any) => e.code === 'ERR_INVALID_ARG_TYPE');
  });
});

// ─────────────────────────────────────────────────────────────
// WHATWG 面
// ─────────────────────────────────────────────────────────────
describe('仿真 node:url —— WHATWG URL（宿主快照 + 部件 setter）', () => {
  const HREFS = [
    'http://u:p@x:8080/a?b=1#f',
    'http://u:p@x:8080/a/b?b=1&c=%20#f',
    'http://x/a',
    'not a url',
    'http://x',
    'nope',
    'file:///C:/x',
    'data:text/plain,x',
    'http://x:80/a',
    'http://[::1]:8080/a',
    'http://ÄÖÜ.com/a',
    'http://x/a?',
    'ws://x/a',
    'http://x/%20a b',
  ];

  it(`new URL 与宿主一致（${HREFS.length} 组，含非法输入的错误三元组）`, () => {
    for (const href of HREFS) {
      diff(`new URL(${href})`, () => new U.URL(href).href, () => new hostUrl.URL(href).href);
    }
    diff('new URL(相对, base)', () => new U.URL('../c', 'http://x/a/b?q').href, () => new hostUrl.URL('../c', 'http://x/a/b?q').href);
    diff('new URL(base 是 URL 实例)', () => new U.URL('/c', new U.URL('http://x/a/b')).href, () => new hostUrl.URL('/c', new hostUrl.URL('http://x/a/b')).href);
    diff('new URL(base 非法)', () => new U.URL('/a', 'nope').href, () => new hostUrl.URL('/a', 'nope').href);
    diff('new URL(对象)', () => new U.URL({ toString: () => 'http://x/a' }).href, () => new hostUrl.URL({ toString: () => 'http://x/a' } as any).href);
  });

  it('全部 getter 与宿主逐项一致（快照字段一个不漏）', () => {
    const read = (u: any) => ({
      href: u.href, origin: u.origin, protocol: u.protocol, username: u.username, password: u.password,
      host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash,
      params: u.searchParams.toString(),
    });
    // 真值 WHATWG_components：search 保留 `%20`，searchParams 序列化成 `+`——两条路不能混
    assert.deepStrictEqual(read(new U.URL('http://u:p@x:8080/a/b?b=1&c=%20#f')), {
      href: 'http://u:p@x:8080/a/b?b=1&c=%20#f',
      origin: 'http://x:8080',
      protocol: 'http:',
      username: 'u',
      password: 'p',
      host: 'x:8080',
      hostname: 'x',
      port: '8080',
      pathname: '/a/b',
      search: '?b=1&c=%20',
      hash: '#f',
      params: 'b=1&c=+',
    });
    assert.equal(new U.URL('file:///tmp/x').origin, 'null');
    assert.equal(new U.URL('data:text/plain,x').origin, 'null');
    assert.equal(new U.URL('ws://x/a').origin, 'ws://x');
    assert.equal(new U.URL('http://x:80/a').href, 'http://x/a');
  });

  it('toString / toJSON / Symbol.toStringTag 与宿主一致（JSON.stringify 出字符串）', () => {
    const u = new U.URL('http://x/a?b=1#f');
    assert.equal(String(u), 'http://x/a?b=1#f');
    assert.equal(u.toString(), u.href);
    assert.equal(u.toJSON(), u.href);
    assert.equal(Object.prototype.toString.call(u), '[object URL]');
    assert.equal(JSON.stringify({ u }), '{"u":"http://x/a?b=1#f"}');
  });

  it('9 个部件 setter × 9 个取值与宿主逐条一致（**非法值静默忽略**是 WHATWG 语义）', () => {
    const parts = ['protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
    const values = ['https', 'y', '', '8080', '99999', 'bad host', '?q=1', 'f', '/p'];
    // 真值 WHATWG_invalidSetters：`protocol='bogus'` / `port='99999'` / `host='bad host'` 之后 href 不变
    for (const part of parts) {
      for (const value of values) {
        diff(`u.${part} = ${JSON.stringify(value)}`, () => {
          const u = new U.URL('http://u:p@x:8080/a?b=1#f');
          u[part] = value;
          return [u.href, u.search, u.hash, u.port, u.hostname];
        }, () => {
          const u = new hostUrl.URL('http://u:p@x:8080/a?b=1#f');
          (u as any)[part] = value;
          return [u.href, u.search, u.hash, u.port, u.hostname];
        });
      }
    }
    const u = new U.URL('http://x/a');
    u.protocol = 'bogus';
    u.port = '99999';
    u.host = 'bad host';
    assert.equal(u.href, 'http://x/a', '三个非法赋值必须都被静默忽略');
  });

  it('href setter **不回用当前 URL 当 base**：相对值是抛 ERR_INVALID_URL 而不是解析', () => {
    const shape = (U2: any) => {
      const u = new U2('http://x/a/b');
      try {
        u.href = '/c';
      } catch (e: any) {
        return [e.name, e.code, e.message, e.input, Object.keys(e).join(',')];
      }
      return u.href;
    };
    assert.deepStrictEqual(shape(U.URL), ['TypeError', 'ERR_INVALID_URL', 'Invalid URL', '/c', 'code,input']);
    assert.deepStrictEqual(shape(hostUrl.URL), shape(U.URL));
    const u = new U.URL('http://x/a');
    u.href = 'http://y/b?c=1';
    assert.equal(u.href, 'http://y/b?c=1');
  });

  it('构造器缺参：`new URL()` / canParse() / parse() 都是 ERR_MISSING_ARGS', () => {
    const missing = (fn: () => unknown) => {
      try {
        fn();
        return 'no-throw';
      } catch (e: any) {
        return [e.name, e.code, e.message];
      }
    };
    assert.deepStrictEqual(missing(() => new U.URL()), ['TypeError', 'ERR_MISSING_ARGS', 'The "url" argument must be specified']);
    assert.deepStrictEqual(missing(() => U.URL.canParse()), missing(() => (hostUrl.URL as any).canParse()));
    assert.deepStrictEqual(missing(() => U.URL.parse()), missing(() => (hostUrl.URL as any).parse()));
  });

  it('构造器/静态入口的 USVString 转换与宿主一致（Symbol 抛 TypeError，非法值仍给 false/null）', () => {
    // Node 在 internal/url.js:889 / 1207 先做 `input = \`${input}\`` 再进解析，所以转换错误**跑在
    // try 之外**：`new URL(Symbol())` / `URL.canParse(Symbol())` / `URL.parse(Symbol())` 都抛 TypeError，
    // 而不是变成 ERR_INVALID_URL / false / null。
    const cases: Array<[string, () => unknown, () => unknown]> = [
      ['new URL(Symbol)', () => new U.URL(Symbol('s')), () => new hostUrl.URL(Symbol('s') as any)],
      ['new URL(123)', () => new U.URL(123 as any).href, () => new hostUrl.URL(123 as any).href],
      ['new URL(null)', () => new U.URL(null as any), () => new hostUrl.URL(null as any)],
      ['new URL(base=Symbol)', () => new U.URL('/a', Symbol('s') as any), () => new hostUrl.URL('/a', Symbol('s') as any)],
      ['new URL(base=null)', () => new U.URL('/a', null as any), () => new hostUrl.URL('/a', null as any)],
      ['URL.canParse(Symbol)', () => U.URL.canParse(Symbol('s')), () => (hostUrl.URL as any).canParse(Symbol('s'))],
      ['URL.parse(Symbol)', () => U.URL.parse(Symbol('s')), () => (hostUrl.URL as any).parse(Symbol('s'))],
      ['URL.parse(123)', () => U.URL.parse(123), () => (hostUrl.URL as any).parse(123)],
      ['URL.parse(null)', () => U.URL.parse(null), () => (hostUrl.URL as any).parse(null)],
    ];
    for (const [label, mine, theirs] of cases) diff(label, mine, theirs);
    // 抛的确实是"转换错误"（没有 code），不是 ERR_INVALID_URL —— 两者会被 URL.parse 区别对待
    assert.throws(() => new U.URL(Symbol('s')), (e: any) => e.name === 'TypeError' && e.code === undefined);
    assert.throws(() => U.URL.parse(Symbol('s')), (e: any) => e.name === 'TypeError' && e.code === undefined);
    assert.equal(U.URL.canParse('nope'), false, '解析失败仍然是 false，不是抛');
  });

  it('URL 的 setter 对 undefined/null 做 USVString 强转（不是"必填校验"），Symbol 才抛', () => {
    // 真值（WSL 逐条取）：`u.hostname = undefined` → `http://undefined/a`、`u.search = null` → `?null`、
    // `u.port = undefined` → 端口保持不变（'undefined' 不是合法端口，按 WHATWG 静默忽略）、
    // `u.hostname = Symbol()` → TypeError。所以 setter 上**没有**缺失参数校验，只有类型转换。
    const apply = (U2: any, part: string, value: unknown) => {
      const u = new U2('http://x:81/a');
      u[part] = value;
      return u.href;
    };
    for (const [part, value] of [
      ['hostname', undefined],
      ['hostname', null],
      ['hostname', 123],
      ['port', undefined],
      ['search', null],
      ['hash', undefined],
      ['pathname', undefined],
    ] as Array<[string, unknown]>) {
      diff(`u.${part} = ${String(value)}`, () => apply(U.URL, part, value), () => apply(hostUrl.URL, part, value));
    }
    for (const part of ['hostname', 'href']) {
      assert.throws(
        () => apply(U.URL, part, Symbol('s')),
        (e: any) => e.name === 'TypeError' && e.code === undefined,
        `u.${part} = Symbol() 应当抛转换错误`,
      );
      assert.throws(() => apply(hostUrl.URL, part, Symbol('s')), (e: any) => e.name === 'TypeError' && e.code === undefined);
    }
    assert.equal(apply(U.URL, 'hostname', undefined), 'http://undefined:81/a', 'undefined → 字符串 "undefined"');
    assert.equal(apply(U.URL, 'search', null), 'http://x:81/a?null');
    // 但 href setter 是整串重解析，`undefined` 直接非法 → ERR_INVALID_URL（不是强转后成功）
    const u = new U.URL('http://x/a');
    assert.throws(() => {
      u.href = undefined as any;
    }, (e: any) => e.code === 'ERR_INVALID_URL');
  });

  it('静态 canParse / parse：不抛的两个入口（失败给 false / null）', () => {
    // 真值 WHATWG_canParse / url_canparse_base / url_parse_static_*
    assert.deepStrictEqual(
      [U.URL.canParse('http://x'), U.URL.canParse('nope'), U.URL.canParse('/a', 'http://x'), U.URL.canParse('/a'), U.URL.canParse('nope', 'http://x'), U.URL.canParse('/a', 'nope')],
      [true, false, true, false, true, false],
    );
    assert.equal(U.URL.parse('nope'), null);
    assert.equal(U.URL.parse('http://x/a').href, 'http://x/a');
    assert.equal(U.URL.parse('../c', 'http://x/a/b').href, 'http://x/c');
    assert.equal(U.URL.parse('nope') instanceof U.URL, false);
    assert.equal(U.URL.canParse('http://x'), (hostUrl.URL as any).canParse('http://x'));
  });
});

// ─────────────────────────────────────────────────────────────
// searchParams：身份稳定 + 双向联动
// ─────────────────────────────────────────────────────────────
describe('仿真 node:url —— searchParams 是同一个对象且是活的', () => {
  it('身份稳定：`u.searchParams === u.searchParams`，URL 变了还是同一个对象', () => {
    const u = new U.URL('http://x/a?b=1');
    const p = u.searchParams;
    assert.equal(u.searchParams === p, true);
    u.search = '?c=2';
    assert.equal(u.searchParams === p, true, 'URL 变化不能换掉 searchParams 对象');
    assert.equal(p.toString(), 'c=2', '内容要跟着刷新');
    assert.equal(p.get('c'), '2');
    u.href = 'http://y/z?d=3';
    assert.equal(u.searchParams === p, true);
    assert.equal(p.toString(), 'd=3');
    // hash 变化不影响 params，但仍然必须是同一个对象（真值 url_probe: sp_after_hash_only_change）
    const u2 = new U.URL('http://x/a?b=1');
    const p2 = u2.searchParams;
    u2.hash = '#z';
    assert.deepStrictEqual([u2.searchParams === p2, p2.toString(), u2.href], [true, 'b=1', 'http://x/a?b=1#z']);
  });

  it('反向联动：改 searchParams 会重写 u 的 href（真值 WHATWG_setters / sp_mutate_rewrites_href）', () => {
    const u = new U.URL('http://x/a?b=1#f');
    u.searchParams.append('z', '2');
    assert.equal(u.href, 'http://x/a?b=1&z=2#f');
    u.searchParams.set('b', 'x y');
    assert.equal(u.href, 'http://x/a?b=x+y&z=2#f');
    u.searchParams.delete('z');
    assert.equal(u.href, 'http://x/a?b=x+y#f');
    u.searchParams.delete('b');
    assert.equal(u.href, 'http://x/a#f', '清空后 `?` 也要消失');
    // 真值：`u.searchParams.sort()` 也重写 href
    const u2 = new U.URL('http://x/c?b=1&a=2');
    u2.searchParams.sort();
    assert.equal(u2.href, 'http://x/c?a=2&b=1');
  });

  it('**无变更的变更调用也会重写 href**（Node 的 #markUpdated 是无条件的）', () => {
    // `new URL('http://x/a?b')` 上删一个不存在的键，Node 的 href 会变成 `http://x/a?b=`
    // ——因为 URL 一旦被标记"searchParams 已修改"就整体重新序列化。少了这条就是可观测分歧。
    const shape = (U2: any) => {
      const u = new U2('http://x/a?b');
      u.searchParams.delete('zz');
      return [u.href, u.search, u.searchParams.toString()];
    };
    assert.deepStrictEqual(shape(U.URL), ['http://x/a?b=', '?b=', 'b=']);
    assert.deepStrictEqual(shape(U.URL), shape(hostUrl.URL));
  });

  it('URL 一侧的变更会刷新同一个 params 对象（含 size 与清空）', () => {
    const u = new U.URL('http://x/a?b=1');
    const p = u.searchParams;
    assert.equal(p.size, 1);
    u.search = '';
    assert.deepStrictEqual([p.size, p.toString(), u.href], [0, '', 'http://x/a']);
    u.search = '??c=2'; // 真值：search 原样保留 `??c=2`
    assert.deepStrictEqual([u.search, u.href], ['??c=2', 'http://x/a??c=2']);
  });

  it('`u.searchParams = …` 抛 TypeError（只有 getter，没有 setter）', () => {
    const u = new U.URL('http://x/a');
    assert.throws(() => {
      (u as any).searchParams = new U.URLSearchParams('b=1');
    }, TypeError);
    assert.equal(u.href, 'http://x/a', '抛错后 URL 不能被改坏');
  });

  it('独立构造的 URLSearchParams 不绑定任何 URL（改了不影响别人）', () => {
    const p = new U.URLSearchParams('a=1');
    p.append('b', '2');
    assert.equal(p.toString(), 'a=1&b=2');
    assert.equal(new U.URL('http://x/a').href, 'http://x/a');
  });
});

// ─────────────────────────────────────────────────────────────
// URLSearchParams
// ─────────────────────────────────────────────────────────────
describe('仿真 node:url —— URLSearchParams', () => {
  it('构造器五种入参形态与宿主一致（字符串 / 序列 / 记录 / 另一个 SP / URL）', () => {
    const inits: unknown[] = [
      undefined, null, '', 'a=1&b=2', '?a=1', 'a=1;b=2', 'a', '=b', 'a=', 'a=%zz', 'a=%E4', 'a=%C3%A4', 'a=b+c',
      'b=1&a=2&b=3&a=4', 123, true, [['a', '1'], ['b', '2']], [['a', 1], ['b', null]], { a: 1, b: undefined, c: null },
      "a=!*'()~-._",
    ];
    for (const init of inits) {
      diff(`new URLSearchParams(${JSON.stringify(init)})`, () => new U.URLSearchParams(init).toString(), () => new hostUrl.URLSearchParams(init as any).toString());
    }
    diff('new URLSearchParams(另一个 SP)', () => new U.URLSearchParams(new U.URLSearchParams('a=1&b=2')).toString(), () => new hostUrl.URLSearchParams(new hostUrl.URLSearchParams('a=1&b=2')).toString());
    // URL 实例走**记录**分支：URL 的属性全在原型上，所以结果是空（真值 params_from_object_and_url = ''）
    // 类型定义不收 URL（Node 的构造签名写的是 minLength 那种联合），运行时宿主是接受的，故 as any
    assert.equal(new U.URLSearchParams(new U.URL('http://x/?a=1&a=2')).toString(), '');
    assert.equal(new hostUrl.URLSearchParams(new hostUrl.URL('http://x/?a=1&a=2') as any).toString(), '');
  });

  it('非法入参的错误形状与宿主一致（ERR_INVALID_TUPLE / ERR_MISSING_ARGS / ERR_INVALID_ARG_TYPE）', () => {
    // 这一组**故意**少传参数（缺失参数判定看的是 `arguments.length`，所以不能补 `undefined`）；
    // 类型定义会拦住少参调用，故两边都用 any 化的工厂取实例，运行时才是判卷人。
    const S = (): any => new U.URLSearchParams('');
    const H = (): any => new hostUrl.URLSearchParams('');
    const cases: Array<[string, () => unknown, () => unknown]> = [
      ['元组只有 1 个元素', () => new U.URLSearchParams([['a']]), () => new hostUrl.URLSearchParams([['a']] as any)],
      ['元组有 3 个元素', () => new U.URLSearchParams([['a', 'b', 'c']]), () => new hostUrl.URLSearchParams([['a', 'b', 'c']] as any)],
      ['元组是 null', () => new U.URLSearchParams([null]), () => new hostUrl.URLSearchParams([null] as any)],
      ['append 缺 value', () => S().append('a'), () => H().append('a')],
      ['get 缺 name', () => S().get(), () => H().get()],
      ['getAll 缺 name', () => S().getAll(), () => H().getAll()],
      ['has 缺 name', () => S().has(), () => H().has()],
      ['set 缺 value', () => S().set('a'), () => H().set('a')],
      ['delete 缺 name', () => S().delete(), () => H().delete()],
      ['forEach 传数字', () => new U.URLSearchParams('a=1').forEach(1 as any), () => new hostUrl.URLSearchParams('a=1').forEach(1 as any)],
    ];
    for (const [label, mine, theirs] of cases) diff(label, mine, theirs);
  });

  it('编码表：序列化把空格编成 `+`、`~` 也编；解析把 `+` 与 `%20` 都解成空格', () => {
    // 真值 params_serialize_specials / params_parse_plus / params_serialize_space
    assert.equal(new U.URLSearchParams({ a: 'b c' }).toString(), 'a=b+c');
    assert.equal(new U.URLSearchParams([['a', "!*'()~-._"], ['b', 'ä'], ['c', '+&='], ['', '']]).toString(), 'a=%21*%27%28%29%7E-._&b=%C3%A4&c=%2B%26%3D&=');
    assert.deepStrictEqual([...new U.URLSearchParams('a=b+c&d=%20').entries()], [['a', 'b c'], ['d', ' ']]);
    assert.equal(new U.URLSearchParams('a=%C3%A4').get('a'), 'ä');
    assert.equal(new U.URLSearchParams('a=%zz').toString(), 'a=%25zz');
    // 编码表由宿主决定，这里逐条与宿主对一遍（少一条都可能漂）
    diff('序列化全字符表', () => new U.URLSearchParams([['a', '/?:@&=+$,;[]{}|\\^`<>#" ']]).toString(), () => new hostUrl.URLSearchParams([['a', '/?:@&=+$,;[]{}|\\^`<>#" ']]).toString());
  });

  it('迭代与查询方法：size/keys/values/entries/forEach/get/getAll/has/set/delete/sort', () => {
    const script = (SP: any) => {
      const p = new SP('a=1&b=2&a=3');
      p.sort();
      const seen: unknown[] = [];
      p.forEach((v: string, k: string) => seen.push([v, k]));
      return {
        size: p.size,
        entries: [...p],
        keys: [...p.keys()],
        values: [...p.values()],
        all: p.getAll('a'),
        has: p.has('b'),
        hasValue: [p.has('a', '1'), p.has('a', '9')],
        get: p.get('zz'),
        sorted: p.toString(),
        seen,
        string: String(p),
        tag: Object.prototype.toString.call(p),
      };
    };
    assert.deepStrictEqual(script(U.URLSearchParams), script(hostUrl.URLSearchParams));
    // 真值 params_iteration 原文（防止两边同时错）
    assert.deepStrictEqual([...new U.URLSearchParams('a=1&b=2&a=3').entries()], [['a', '1'], ['b', '2'], ['a', '3']]);
    assert.deepStrictEqual([...new U.URLSearchParams('a=1&b=2&a=3').keys()], ['a', 'b', 'a']);
    assert.deepStrictEqual([...new U.URLSearchParams('a=1&b=2&a=3').values()], ['1', '2', '3']);
  });

  it('迭代器形状与宿主一致（活的迭代器：`Symbol.iterator` 返回自身、toStringTag 是 URLSearchParams Iterator）', () => {
    const script = (SP: any) => {
      const it = new SP('a=1').entries();
      return [Object.prototype.toString.call(it), it[Symbol.iterator]() === it, JSON.stringify(it.next()), JSON.stringify(it.next())];
    };
    assert.deepStrictEqual(script(U.URLSearchParams), script(hostUrl.URLSearchParams));
  });

  it('参数**类型**校验照抄 WebIDL：非 string 走 USVString 转换（Symbol 抛 TypeError，其它强转）', () => {
    // 真值（WSL 逐条取过）：`get(null)`→null、`get(123)`→null、`get({toString})` 用转换结果查、
    // `get(Symbol())` → TypeError「Cannot convert a Symbol value to a string」（**没有 code**）。
    // 这一条是"模板串 ≠ String()"的守门人：`String(Symbol())` 会给 'Symbol()' 而不抛。
    const S = (): any => new U.URLSearchParams('a=1');
    const H = (): any => new hostUrl.URLSearchParams('a=1');
    const objArg = { toString: () => 'a' };
    const cases: Array<[string, () => unknown, () => unknown]> = [
      ['get(null)', () => S().get(null), () => H().get(null)],
      ['get(123)', () => S().get(123), () => H().get(123)],
      ['get(对象)', () => S().get(objArg), () => H().get(objArg)],
      ['get(Symbol)', () => S().get(Symbol('s')), () => H().get(Symbol('s'))],
      ['has(1)', () => S().has(1), () => H().has(1)],
      ['delete(1)', () => S().delete(1), () => H().delete(1)],
      ['getAll(1)', () => S().getAll(1), () => H().getAll(1)],
      ['append(1, 2)', () => S().append(1, 2), () => H().append(1, 2)],
      ['append(null, undefined)', () => S().append(null, undefined), () => H().append(null, undefined)],
      ['append(Symbol, 1)', () => S().append(Symbol('s'), 1), () => H().append(Symbol('s'), 1)],
      ['构造器传 Symbol', () => new U.URLSearchParams(Symbol('s')), () => new hostUrl.URLSearchParams(Symbol('s') as any)],
      ['forEach(null)', () => S().forEach(null), () => H().forEach(null)],
      ['forEach()', () => S().forEach(), () => H().forEach()],
    ];
    for (const [label, mine, theirs] of cases) diff(label, mine, theirs);
    // 强转后再取值的实际结果也要对：`append(1,2)` 之后 `get('1')` 是 '2'
    const p = new U.URLSearchParams('a=1');
    (p as any).append(1, 2);
    assert.equal(p.get('1'), '2');
  });

  it('变更方法：append/set/delete（含两参形式）/sort 与宿主一致', () => {
    const script = (SP: any) => {
      const p = new SP('a=1');
      p.append('b', '2');
      p.set('a', '9');
      p.delete('b');
      p.append('c', 'x y');
      p.delete('a', '9');
      p.delete('zz');
      p.set('d', '4');
      return [p.toString(), p.size, String(p), p.has('d', '4')];
    };
    assert.deepStrictEqual(script(U.URLSearchParams), script(hostUrl.URLSearchParams));
    // 真值 params_mutations：a=9&c=x+y
    const p = new U.URLSearchParams('a=1');
    p.append('b', '2');
    p.set('a', '9');
    p.delete('b');
    p.append('c', 'x y');
    assert.deepStrictEqual([p.toString(), p.size, String(p)], ['a=9&c=x+y', 2, 'a=9&c=x+y']);
  });

  it('sort 是**稳定**的，且长表（≥100 条）走归并排序分支', () => {
    assert.equal(new U.URLSearchParams('a=1').sort(), undefined, 'sort() 不返回新对象（Node 返回 undefined）');
    const p = new U.URLSearchParams('b=1&a=2&b=3&a=4');
    p.sort();
    assert.equal(p.toString(), 'a=2&a=4&b=1&b=3', '同键必须保持原相对次序');
    // 100 条以上走另一条分支（Node 的阈值），必须仍然稳定
    const pairs = Array.from({ length: 120 }, (_, i) => [`k${(i * 37) % 11}`, `v${i}`] as [string, string]);
    const mine = new U.URLSearchParams(pairs);
    const theirs = new hostUrl.URLSearchParams(pairs);
    mine.sort();
    theirs.sort();
    assert.equal(mine.toString(), theirs.toString());
  });

  it('孤立代理项按 USVString 处理（QuickJS 没有 toWellFormed，这里手写）', () => {
    assert.equal(new U.URLSearchParams('\uD800=1').toString(), '%EF%BF%BD=1');
    assert.equal(new U.URLSearchParams('\uD800=1').get('\uFFFD'), '1');
    assert.equal(new hostUrl.URLSearchParams('\uD800=1').toString(), '%EF%BF%BD=1');
  });
});

// ─────────────────────────────────────────────────────────────
// 错误语义 / 其余导出
// ─────────────────────────────────────────────────────────────
describe('仿真 node:url —— 错误语义与其余导出面', () => {
  it('ERR_INVALID_URL 的形状照抄 Node：TypeError + code + input（自有属性就这两个）', () => {
    const shape = (fn: () => unknown) => {
      try {
        fn();
        return 'no-throw';
      } catch (e: any) {
        return { name: e.name, code: e.code, message: e.message, input: e.input, keys: Object.keys(e), isTypeError: e instanceof TypeError };
      }
    };
    assert.deepStrictEqual(shape(() => new U.URL('not a url')), shape(() => new hostUrl.URL('not a url')));
    const baseBad = shape(() => new U.URL('/a', 'nope')) as { input: unknown };
    assert.equal(baseBad.input, '/a', 'base 非法时 input 仍是第一个参数');
  });

  it('宿主码不泄漏给插件：解析失败一律是 Node 的 ERR_INVALID_URL（不是 INTERNAL）', () => {
    // hostApi 的 parseUrl 把失败收敛成 SpcError('ERR_INVALID_URL')，而**href setter** 那条路
    // 宿主抛的是裸 TypeError —— 所以 shim 侧对 href 走 resolveHref，否则过桥会退化成 INTERNAL。
    for (const bad of ['nope', '', 'http://', '://x']) {
      assert.throws(
        () => new U.URL(bad),
        (e: any) => e.code === 'ERR_INVALID_URL' && e.name === 'TypeError',
        `new URL(${JSON.stringify(bad)}) 应当抛 Node 形状的 ERR_INVALID_URL`,
      );
    }
    const u = new U.URL('http://x/a');
    assert.throws(() => {
      u.href = 'nope';
    }, (e: any) => e.code === 'ERR_INVALID_URL');
  });

  it('urlToHttpOptions 与宿主逐条一致（含 IPv6 去括号、port 数字化、auth 解码）', () => {
    for (const href of ['http://u:p@x:8080/a?b=1#f', 'http://x/a', 'http://[::1]:8080/a', 'http://a%40b:p%20q@x/a', 'file:///tmp/x']) {
      diff(`urlToHttpOptions(${href})`, () => U.urlToHttpOptions(new U.URL(href)), () => hostUrl.urlToHttpOptions(new hostUrl.URL(href)));
    }
    // 真值 legacy_urlToHttpOptions / urlToHttpOptions_ipv6（结果原型是 null，故先摊平再比）
    assert.deepStrictEqual({ ...U.urlToHttpOptions(new U.URL('http://u:p@x:8080/a?b=1#f')) }, {
      protocol: 'http:', hostname: 'x', hash: '#f', search: '?b=1', pathname: '/a', path: '/a?b=1',
      href: 'http://u:p@x:8080/a?b=1#f', port: 8080, auth: 'u:p',
    });
    assert.equal(U.urlToHttpOptions(new U.URL('http://[::1]:8080/a')).hostname, '::1');
    // 原型是 null（Node 的 `{ __proto__: null }`），免得 `options.constructor` 被原型链带出来
    assert.equal(Object.getPrototypeOf(U.urlToHttpOptions(new U.URL('http://x/a'))), null);
  });

  it('domainToASCII / domainToUnicode 走宿主，含缺参错误', () => {
    for (const d of ['中文.com', 'example.com', 'xn--fiq228c.com', 'ÄÖÜ.com', 'a_b.com', 'xn--a.com', '', 'ａｂｃ.com']) {
      assert.equal(U.domainToASCII(d), hostUrl.domainToASCII(d), `domainToASCII(${d})`);
      assert.equal(U.domainToUnicode(d), hostUrl.domainToUnicode(d), `domainToUnicode(${d})`);
    }
    assert.equal(U.domainToASCII('中文.com'), 'xn--fiq228c.com');
    assert.equal(U.domainToUnicode('xn--fiq228c.com'), '中文.com');
    for (const name of ['domainToASCII', 'domainToUnicode']) {
      assert.throws(
        () => U[name](),
        (e: any) => e.code === 'ERR_MISSING_ARGS' && e.message === 'The "domain" argument must be specified',
        `${name}() 缺参`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 有意与 Node 不同
// ─────────────────────────────────────────────────────────────
describe('仿真 node:url —— 有意与 Node 不同的地方（结构性断言，不跟宿主比）', () => {
  it('`pathToFileURL` 的相对路径按**沙箱数据目录**解析（不是宿主 cwd）', () => {
    // 与 node-path.js 的 `resolve()` 兜底虚拟根 `/` 不同：文件 URL 必须能指回插件作用域里的真文件，
    // 按数据目录解析才有意义。宿主是 Windows 时结果与宿主**必然不同**（宿主会先做 win32 resolve），
    // 所以这条只在 Linux 上与宿主比，其它平台直接断言我们的基线。
    const href = U.pathToFileURL('rel/x.txt').href;
    if (process.platform === 'linux') {
      assert.equal(href, hostUrl.pathToFileURL(join(DATA_DIR, 'rel/x.txt')).href);
      assert.equal(U.pathToFileURL('.').href, hostUrl.pathToFileURL(DATA_DIR).href);
    } else {
      assert.ok(href.startsWith('file:///'), `非 posix cwd 下也必须仍是合法的 file: URL，实际 ${href}`);
      assert.ok(decodeURIComponent(href).endsWith('/rel/x.txt'));
      assert.notEqual(href, hostUrl.pathToFileURL('rel/x.txt').href, '与宿主的差异是**有意**的（宿主走 win32 resolve）');
    }
    assert.equal(U.pathToFileURL('/abs').href, 'file:///abs', '绝对路径不受 cwd 影响');
  });

  it('`fileURLToPath` 固定 POSIX：Windows 宿主上 `file:///C:/x` 与宿主**有意不同**', () => {
    if (process.platform === 'linux') {
      assert.equal(U.fileURLToPath('file:///C:/x/y'), hostUrl.fileURLToPath('file:///C:/x/y'));
    } else {
      // 宿主在 win32 上走的是另一条分支：同一条 URL 给 `C:\x\y`，而我们的 POSIX 基线给 `/C:/x/y`
      assert.equal(U.fileURLToPath('file:///C:/x/y'), '/C:/x/y');
      assert.equal(hostUrl.fileURLToPath('file:///C:/x/y'), 'C:\\x\\y');
      assert.notEqual(U.fileURLToPath('file:///C:/x/y'), hostUrl.fileURLToPath('file:///C:/x/y'));
      // Windows 宿主对 POSIX 形态的 file URL 直接报错——我们照样给 posix 路径
      assert.throws(() => hostUrl.fileURLToPath('file:///tmp/a%20b.txt'), (e: any) => e.code === 'ERR_INVALID_FILE_URL_PATH');
      assert.equal(U.fileURLToPath('file:///tmp/a%20b.txt'), '/tmp/a b.txt');
    }
  });

  it('`options.windows` 明确抛错（不做静默降级到 posix）', () => {
    for (const fn of ['fileURLToPath', 'fileURLToPathBuffer']) {
      assert.throws(
        () => U[fn]('file:///tmp/x', { windows: true }),
        (e: any) => e.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
        `${fn}({windows:true}) 应当响亮抛错`,
      );
      assert.equal(typeof U[fn]('file:///tmp/x', { windows: false }), fn === 'fileURLToPath' ? 'string' : 'object');
    }
  });

  it('`createObjectURL` / `revokeObjectURL` 明确抛 ERR_NOT_SUPPORTED_IN_SANDBOX（沙箱里没有 Blob）', () => {
    for (const name of ['createObjectURL', 'revokeObjectURL']) {
      assert.equal(typeof U.URL[name], 'function');
      assert.throws(() => U.URL[name]({}), (e: any) => e.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX', `${name} 应当明确抛错`);
      // 宿主上它是可用的 —— 所以这是我们**有意**的缺失（不是抄漏了）
      assert.equal(typeof (hostUrl.URL as any)[name], 'function');
    }
  });

  it('不发 DeprecationWarning：shim 根本不碰 process（静态可查 + 行为面）', () => {
    // Node 首次调用 `url.parse()` 发 DEP0169、非法端口发 DEP0170；沙箱里没有 process 可发，
    // 也不该把宿主告警面暴露给插件。用"监听 warning"来测是不可靠的（node:test 下告警的投递时机
    // 会被推迟，实测会串到后面某个用例里），所以改成**静态断言**：文件里不许出现 `process` /
    // `node:` import / `require(`——这三条同时也是"能被构建层整文件内联"的硬约束。
    const source = readFileSync(join(SHIM_SRC, 'node-url.js'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/\bprocess\b/.test(code), false, 'node-url.js 不该引用 process');
    assert.equal(/\brequire\s*\(/.test(code), false, 'node-url.js 不该出现 require(');
    assert.equal(/from\s+['"]node:/.test(code), false, 'node-url.js 不该 import 任何 node:*');
    assert.equal(/from\s+['"][^'"]+['"]/.test(code.replace(/from\s+['"]\.\/node-buffer\.js['"]/g, '')), false, '只能相对 import ./node-buffer.js');
    // 行为面：非法端口按基线处理，不抛错、不打扰
    assert.equal(U.parse('http://x:abc/a').href, 'http://x/:abc/a');
    assert.equal(U.parse('http://x/a').href, 'http://x/a');
  });

  it('畸形百分号编码的字节回退要经 `bytes.decode`（宿主 Node 的 UTF-8 替换字符语义）', () => {
    // 这是本模块**唯一**间接依赖 node:buffer 权限点的路径（真值 legacy_query_decode：`%E4` → U+FFFD）。
    // 主流程（URL / URLSearchParams / pathToFileURL / fileURLToPath / fileURLToPathBuffer 的 ASCII 路径）
    // 都不碰它——下面那条真沙箱用例就是那个不变量的回归。
    assert.equal(U.parse('http://x/?a=%C3', true).query.a, '\uFFFD');
    assert.equal(U.parse('http://x/?a=%E4%41', true).query.a, '\uFFFD' + 'A');
    assert.equal(U.parse('http://x/?a=%00', true).query.a, '\u0000');
  });
});

// ─────────────────────────────────────────────────────────────
// 真沙箱冒烟
// ─────────────────────────────────────────────────────────────
describe('仿真 node:url —— 真实 QuickJS 沙箱里跑通（真桥 + 权限判定）', async () => {
  const { createSandbox } = await import('../../core/sandbox.ts');
  const SMOKE_DIR = mkdtempSync(join(tmpdir(), 'spc-smoke-url-'));
  after(() => rmSync(SMOKE_DIR, { recursive: true, force: true }));

  /** 在真沙箱里跑一段插件代码，回捞 console.log */
  async function runInSandbox(code: string, permissions: string[]): Promise<string> {
    const api = buildHostApi({ pluginId: '@spc-test/url', dataDir: SMOKE_DIR });
    const sandbox = await createSandbox(api, {
      pluginId: '@spc-test/url',
      permissions,
      grants: permissions,
      facts: { version: { code: 1, name: 'test' }, dataDir: SMOKE_DIR, manifest: {}, config: {} },
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule('@spc-test/url', code);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    return logs.join('\n');
  }

  /**
   * 这条必须走真沙箱：宿主进程里的差分测试证明不了"沙箱里真的没有 URL/URLSearchParams"、
   * 也证明不了引导层的 `__spcEnv` 注入与真桥的权限判定成立。
   *
   * 权限只声明 `url.parse` / `url.encode`——**用 node:url 不该额外依赖 `bytes.*`**
   * （设计 §6 的映射表就是 url.parse/url.encode 两个点；主流程里没有一次编解码跨界）。
   */
  it('node:url 在沙箱里可装载，且只吃 url.parse / url.encode 两个权限点', async () => {
    const out = await runInSandbox(
      `
import url, { URL, URLSearchParams, parse, format, resolve, pathToFileURL, fileURLToPath, fileURLToPathBuffer } from 'node:url';
console.log('NATIVE ' + [typeof globalThis.URL, typeof globalThis.URLSearchParams].join(','));
console.log('HREF ' + new URL('http://u:p@x:8080/a?b=1#f').href);
console.log('SP ' + new URLSearchParams('a=1&b=2').get('a') + '/' + new URLSearchParams({ a: 'x y' }).toString());
console.log('PTF ' + pathToFileURL('/tmp/x').href);
console.log('FUP ' + fileURLToPath('file:///tmp/a%20b.txt'));
console.log('FUPB ' + (fileURLToPathBuffer('file:///tmp/a%20b.txt') instanceof Uint8Array));
console.log('LEGACY ' + parse('http://x/a?b=1').host + '/' + format({ protocol: 'http', host: 'x', pathname: '/a' }) + '/' + resolve('http://x/a/b', '../c'));
console.log('LIVE ' + (() => { const u = new URL('http://x/a?b=1'); const p = u.searchParams; u.search = '?c=2'; return (u.searchParams === p) + ':' + p.get('c'); })());
console.log('KEYS ' + Object.keys(url).length);
let thrown = 'none';
try { URL.createObjectURL({}); } catch (e) { thrown = e.code; }
console.log('OBJURL ' + thrown);
`,
      ['url.parse', 'url.encode'],
    );
    const lines = out.split('\n');
    // 前提核对：沙箱里**没有 QuickJS 原生的** URL/URLSearchParams（探测见 `tools/probes/quickjs-globals-probe.mjs`）。
    // 现在 `globalThis.URL`/`URLSearchParams` 是**仿真件**（`core/sandbox.ts` 的 GLOBALS_PRELUDE 装的，
    // 与 Node 一样把 URL 暴露成标准全局）——这正是宿主编解码的必要性来源：解析跑在宿主里。
    assert.equal(lines[0], 'NATIVE function,function');
    assert.equal(lines[1], 'HREF http://u:p@x:8080/a?b=1#f');
    assert.equal(lines[2], 'SP 1/a=x+y');
    assert.equal(lines[3], 'PTF file:///tmp/x');
    assert.equal(lines[4], 'FUP /tmp/a b.txt');
    assert.equal(lines[5], 'FUPB true');
    assert.equal(lines[6], 'LEGACY x/http://x/a/http://x/c');
    assert.equal(lines[7], 'LIVE true:2');
    assert.equal(lines[8], 'KEYS 13');
    assert.equal(lines[9], 'OBJURL ERR_NOT_SUPPORTED_IN_SANDBOX');
  });

  it('没声明权限时宿主代工面**照常可用**（v4：`url.*` 是 self/auto，免声明）', async () => {
    // 前提变更（第四批 B）：以前这条断言"没声明 → PERMISSION_DENIED"。
    // `url.parse`/`url.encode` 是 `scope: self`（输入是调用方给的串、输出还给调用方，够不着别人）
    // ⇒ 现在免声明。宿主代工**不等于**要权限：判据是"够不够得着别人"，不是"在哪台机器上算的"。
    const out = await runInSandbox(
      `
import { URL } from 'node:url';
console.log('HREF ' + new URL('http://x/a').href);
`,
      [],
    );
    assert.equal(out, 'HREF http://x/a');
  });

  it('沙箱里 `pathToFileURL` 的相对路径落在数据目录下（与 process.cwd() 同一事实）', async () => {
    const out = await runInSandbox(
      `
import { pathToFileURL } from 'node:url';
import process from 'node:process';
console.log('REL ' + pathToFileURL('rel/x.txt').href);
console.log('CWD ' + process.cwd());
`,
      ['url.parse', 'url.encode'],
    );
    const [relLine, cwdLine] = out.split('\n');
    const cwd = cwdLine.slice('CWD '.length);
    const rel = relLine.slice('REL '.length);
    // 沙箱里看到的路径**按仿真平台**取形态（P2-E / 模型 B）：linux `/`、win32 `\`
    // （见 core/emulated-env.ts 的说明——不能再写死 POSIX 形态）
    const sep = process.platform === 'win32' ? '\\' : '/';
    assert.equal(cwd, process.platform === 'win32' ? SMOKE_DIR : SMOKE_DIR.split('\\').join('/'));
    // cwd 是数据目录 → 相对路径解析成它下面的路径。
    // ⚠️ 只比**后缀**：`file:` URL 里分隔符恒为 `/`，而路径形态随平台
    // （win32 上 href 是 `file:///D:/…/rel/x.txt`），写死 `/rel/x.txt` 在 Windows 上会红。
    assert.ok(rel.startsWith('file:///'), `相对路径也必须得到合法的 file: URL，实际 ${rel}`);
    assert.ok(
      decodeURIComponent(rel).endsWith('/rel/x.txt') || decodeURIComponent(rel).endsWith('\\rel\\x.txt'),
      `相对路径应当落在数据目录下的 rel/x.txt，实际 ${rel}`,
    );
    // 必须是**绝对** file URL：路径部分要含数据目录（形态随平台，所以按 sep 归一后比）
    const relPath = decodeURIComponent(rel.slice('file://'.length)).split('/').join(sep === '\\' ? '\\' : '/');
    assert.ok(relPath.includes(cwd), `file URL 的路径应当包含 cwd：${relPath} vs ${cwd}`);
  });
});
