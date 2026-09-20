// Linux 侧差分探针（WSL，纯 .js 不依赖 tsx）：直接跑 shim vs 真 node:url
//   用法（在 WSL 里跑）：wsl -e node <仓库>/tools/truth/url-linux-probe.mjs
// 为什么不用 tsx：node_modules 是 Windows 装的，esbuild 二进制在 Linux 上不可用。
// 所以这里**手写一个 hostApi 的 url 组替身**（只做那 6 个方法，实现抄 core/hostApi.ts 的 url 段），
// 只用于取 Linux 真值——正式的对齐测试仍用真的 buildHostApi（在 Windows 上跑）。
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as hostUrl from 'node:url';
import { SANDBOX_MODULES } from '../paths.mjs';

const SRC = SANDBOX_MODULES;
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'u-linux-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
for (const f of ['node-url.js', 'node-buffer.js']) copyFileSync(join(SRC, f), join(SHIM_DIR, f));

const DATA_DIR = mkdtempSync(join(tmpdir(), 'u-linux-data-'));
const snap = (u) => ({
  href: u.href, origin: u.origin, protocol: u.protocol, username: u.username, password: u.password,
  host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash,
  params: [...u.searchParams].map(([k, v]) => [k, v]),
});
const SETTERS = new Set(['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']);
globalThis.__spcEnv = JSON.stringify({ dataDir: DATA_DIR, platform: 'linux', arch: 'x64' });
globalThis.__host = {
  'url.resolveHref': (input, base) => JSON.stringify(snap(base === undefined ? new URL(input) : new URL(input, String(base)))),
  'url.setPart': (href, part, value) => { const u = new URL(href); u[part] = value; return JSON.stringify(snap(u)); },
  'url.paramsParse': (text) => JSON.stringify([...new URLSearchParams(text)].map(([k, v]) => [k, v])),
  'url.paramsStringify': (pairsJson) => JSON.stringify(new URLSearchParams(JSON.parse(pairsJson)).toString()),
  'url.domainToASCII': (d) => JSON.stringify(new URL('http://x').constructor === undefined ? '' : hostUrl.domainToASCII(d)),
  'url.domainToUnicode': (d) => JSON.stringify(hostUrl.domainToUnicode(d)),
  // bytes 组：node-buffer.js 的编解码通道（畸形百分号回退与 fileURLToPathBuffer 会用到）
  'bytes.fromString': (text, enc) => {
    const b = Buffer.from(text, enc);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  'bytes.toString': (data, enc) => JSON.stringify(Buffer.from(data).toString(enc)),
  'bytes.byteLength': (text, enc) => JSON.stringify(Buffer.byteLength(text, enc)),
};

const U = await import(pathToFileURL(join(SHIM_DIR, 'node-url.js')).href);

let fail = 0, total = 0;
function cmp(label, a, b) {
  total++;
  let ra, rb;
  try { ra = { v: a() }; } catch (e) { ra = { e: [e.name, e.code, e.message] }; }
  try { rb = { v: b() }; } catch (e) { rb = { e: [e.name, e.code, e.message] }; }
  const sa = JSON.stringify(ra), sb = JSON.stringify(rb);
  if (sa !== sb) { fail++; console.log('DIFF ' + label + '\n  shim=' + sa + '\n  host=' + sb); }
}

// ── fs-url-truth.json 里的 url 条目（输入照 tools/truth/fs-url-truth.mjs）──
cmp('pathToFileURL_abs_posix', () => U.pathToFileURL('/tmp/a b#c.txt').href, () => hostUrl.pathToFileURL('/tmp/a b#c.txt').href);
cmp('pathToFileURL_rel', () => U.pathToFileURL(process.cwd() + '/rel/x.txt').href, () => hostUrl.pathToFileURL(process.cwd() + '/rel/x.txt').href);
cmp('pathToFileURL_dot', () => U.pathToFileURL(process.cwd()).href, () => hostUrl.pathToFileURL(process.cwd()).href);
cmp('pathToFileURL_root', () => U.pathToFileURL('/').href, () => hostUrl.pathToFileURL('/').href);
cmp('pathToFileURL_trailingSlash', () => U.pathToFileURL('/tmp/dir/').href, () => hostUrl.pathToFileURL('/tmp/dir/').href);
cmp('pathToFileURL_empty(有意差异：按数据目录解析)', () => U.pathToFileURL('').href, () => 'file://' + DATA_DIR);
cmp('pathToFileURL_rel(有意差异：按数据目录解析)', () => U.pathToFileURL('rel/x.txt').href, () => 'file://' + DATA_DIR + '/rel/x.txt');
cmp('pathToFileURL_dotdot', () => U.pathToFileURL('/tmp/../x').href, () => hostUrl.pathToFileURL('/tmp/../x').href);
cmp('pathToFileURL_utf8', () => U.pathToFileURL('/tmp/ä.txt').href, () => hostUrl.pathToFileURL('/tmp/ä.txt').href);
cmp('pathToFileURL_emoji', () => U.pathToFileURL('/tmp/😀.txt').href, () => hostUrl.pathToFileURL('/tmp/😀.txt').href);
cmp('pathToFileURL_percent', () => U.pathToFileURL('/tmp/a%20b.txt').href, () => hostUrl.pathToFileURL('/tmp/a%20b.txt').href);
cmp('pathToFileURL_backslash', () => U.pathToFileURL('/tmp/a\\b').href, () => hostUrl.pathToFileURL('/tmp/a\\b').href);
cmp('pathToFileURL_weird', () => U.pathToFileURL('/tmp/a~b|c^d`e{f}g[h]i<j>k"l\'m').href, () => hostUrl.pathToFileURL('/tmp/a~b|c^d`e{f}g[h]i<j>k"l\'m').href);
cmp('pathToFileURL_ctrl', () => U.pathToFileURL('/tmp/a\u0001b\u007fc').href, () => hostUrl.pathToFileURL('/tmp/a\u0001b\u007fc').href);

for (const f of ['file:///tmp/a%20b.txt', 'file://localhost/tmp/x', 'file://example.com/tmp/x', '/tmp/x', 'file:///tmp/a%2Fb',
  'file:///C:/x/y', 'file:///tmp/%E4%B8%AD.txt', 'file:///tmp/a%5Cb', 'file:///tmp/a%2e%2e/b', 'file://localhost/',
  'file:///tmp/a%zz', 'https://x/y', 'file:////x', 'file:///tmp/a%2fb', 'file:///tmp/a%41b', 'file:///tmp/%00']) {
  cmp('fileURLToPath ' + f, () => U.fileURLToPath(f), () => hostUrl.fileURLToPath(f));
}
cmp('fileURLToPath url instance', () => U.fileURLToPath(new U.URL('file:///tmp/a%20b.txt')), () => hostUrl.fileURLToPath(new hostUrl.URL('file:///tmp/a%20b.txt')));
cmp('fileURLToPath http url', () => U.fileURLToPath(new U.URL('http://x/y')), () => hostUrl.fileURLToPath(new hostUrl.URL('http://x/y')));
cmp('fileURLToPath obj', () => U.fileURLToPath({}), () => hostUrl.fileURLToPath({}));
for (const f of ['file:///tmp/a%20b%E4%B8%AD.txt', 'file:///tmp/a%2Fb', 'file:///C:/x/y', 'file:///tmp/a%zz', 'file:///tmp/a%00b', 'file:///tmp/%E4', 'file:///tmp/ä.txt']) {
  cmp('fileURLToPathBuffer ' + f, () => Buffer.from(U.fileURLToPathBuffer(f)).toString('hex'), () => Buffer.from(hostUrl.fileURLToPathBuffer(f)).toString('hex'));
}
cmp('fileURLToPathBuffer isBuffer', () => U.fileURLToPathBuffer('file:///tmp/x').constructor.name, () => 'Buffer');

// legacy + WHATWG 全量再跑一遍（Linux 上 domainToASCII 走真宿主，能验 IDNA 那条路）
const legacy = [
  ['http://u:p@example.com:8080/a/b?c=1&d=2#frag'], ['http://example.com/a'], ['mailto:a@b.com'], ['http:example.com/a'],
  ['http://a b/c'], ['/a/b?c#d'], ['a/b'], ['http://[::1]:8080/x'], ['http://x//a//b'], ['//a//b'], ['//a//b', false, true],
  ['http://x/a?b=1', false, true], ['http://x/a?b=1&b=2', true], ['?a=1'], ['#f'], ['/a/b', true], ['  http://x/a  '],
  ['http:\\\\x\\a'], ['http://x:abc/a'], ['http://ÄÖÜ.com/a'], ['HTTP://X.COM/A'], ['http://a%40b:p@x/a'],
  ['http://a@b@c/'], ['http://a@b?@c'], ['javascript:alert(1)'], ['javascript://x/%20'], ['gopher://x/a'], ['ws://x/a'],
  ['file:///tmp/x'], ['http://x/a+b'], ['http://x\t/a'], ['http://xn--a.com/'], ['http://%41.com/'], ['http://a..b/'],
  ['http://-a.com/'], ['http://' + 'a'.repeat(300) + '/x'], ['http://x/?a=%E4&b=%zz&c=+&d=%2B&e', true],
  ['http://x/?b=1&b=2&b=3', true], ['http://x/?a=1&&b=2&=c', true], ['http://[::1/a'], ['mailto:a@b.com?subject=x'],
  ['http://u:p@x:8080/a/b?c=1#f'], ['http://x/a?b=1', true], ['http://a b.com/x'], ['http://ex ample.com/'],
  ['http://％41.com/'], ['http://＃a.com/'], ['http://ａｂｃ.com/'], ['http://a／b.com/'], ['http://a＠b.com/'],
  ['http://a_b.com/'], ['http://A.COM/'], ['http://x/a?=b&=c&d=', true], ['http://a\u0000b.com/'], ['http://ünïcödé.example/'],
];
for (const args of legacy) {
  cmp('parse' + JSON.stringify(args), () => U.parse(...args), () => hostUrl.parse(...args));
}

console.log('\n' + (total - fail) + '/' + total + ' 一致，' + fail + ' 处不同   (dataDir=' + DATA_DIR + ')');
rmSync(SHIM_DIR, { recursive: true, force: true });
rmSync(DATA_DIR, { recursive: true, force: true });
