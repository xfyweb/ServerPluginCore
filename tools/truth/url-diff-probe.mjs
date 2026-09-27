// 临时差分探针（不进仓库）：node-url.js vs 宿主 node:url
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as hostUrl from 'node:url';
import { REPO_ROOT } from '../paths.mjs';

const ROOT = process.env.SPC_ROOT || REPO_ROOT;
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'u-probe-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
for (const f of ['node-url.js', 'node-buffer.js']) copyFileSync(join(ROOT, 'core', 'sandbox-modules', f), join(SHIM_DIR, f));

const DATA_DIR = mkdtempSync(join(tmpdir(), 'u-data-'));
const { buildHostApi } = await import(pathToFileURL(join(ROOT, 'core', 'hostApi.ts')).href);
const { buildEnvFacts } = await import(pathToFileURL(join(ROOT, 'core', 'emulated-env.ts')).href);
const { toErrorShape } = await import(pathToFileURL(join(ROOT, 'core', 'errors.ts')).href);
const api = buildHostApi({ pluginId: '@test/url', dataDir: DATA_DIR });
globalThis.__spcEnv = JSON.stringify(buildEnvFacts(DATA_DIR));
globalThis.__host = new Proxy({}, {
  get: (_t, name) => (...raw) => {
    const method = api[name];
    if (!method) throw new Error('unknown host method ' + String(name));
    // 真桥的参数搬运：ArrayBuffer → Uint8Array（漏了这步宿主会以 ERR_INVALID_ARG_TYPE 失败）
    const args = raw.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Uint8Array) return Uint8Array.from(a);
      if (a instanceof ArrayBuffer) return Uint8Array.from(new Uint8Array(a));
      return a;
    });
    try {
      const result = method.fn(...args);
      if (method.binaryResult) {
        if (result instanceof Uint8Array) {
          return result.byteOffset === 0 && result.byteLength === result.buffer.byteLength ? result.buffer : new Uint8Array(result).buffer;
        }
        return result;
      }
      return JSON.stringify(result ?? null);
    } catch (err) { const s = toErrorShape(err) ?? { code: 'INTERNAL' }; return JSON.stringify({ __spcError: { code: s.code, params: s.params } }); }
  },
});

const U = await import(pathToFileURL(join(SHIM_DIR, 'node-url.js')).href);

let fail = 0, total = 0;
function eq(label, a, b) {
  total++;
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) { fail++; console.log('DIFF ' + label + '\n  shim=' + sa + '\n  host=' + sb); }
}
function shape(fn) {
  try { return { v: fn() }; } catch (e) { return { e: e.name + '/' + e.code + '/' + e.message }; }
}
function cmp(label, a, b) { eq(label, shape(a), shape(b)); }

// 导出面：与**真值表**比（基线迁 v24.20.0 后 `URLPattern` 进了基线 —— 我们**有意不仿真**，记账见 module-emulation-design §13.1 第 12 条）
const TRUTH_KEYS = ["URL","URLSearchParams","Url","default","domainToASCII","domainToUnicode","fileURLToPath","fileURLToPathBuffer","format","parse","pathToFileURL","resolve","resolveObject","urlToHttpOptions"];
eq('keys', Object.keys(U).sort(), TRUTH_KEYS);

// legacy
const legacy = [
  ['http://u:p@example.com:8080/a/b?c=1&d=2#frag'], ['http://example.com/a'], ['mailto:a@b.com'],
  ['http:example.com/a'], ['http://a b/c'], ['/a/b?c#d'], ['a/b'], ['http://[::1]:8080/x'],
  ['http://x//a//b'], ['//a//b'], ['//a//b', false, true], ['http://x/a?b=1', false, true],
  ['http://x/a?b=1&b=2', true], ['?a=1'], ['#f'], ['/a/b', true], ['  http://x/a  '],
  ['http:\\\\x\\a'], ['http://x:abc/a'], ['http://ÄÖÜ.com/a'], ['HTTP://X.COM/A'],
  ['http://a%40b:p@x/a'], ['http://a@b@c/'], ['http://a@b?@c'], ['javascript:alert(1)'],
  ['javascript://x/%20'], ['gopher://x/a'], ['ws://x/a'], ['file:///tmp/x'], ['http://x/a+b'],
  ['http://x\t/a'], ['http://xn--a.com/'], ['http://%41.com/'], ['http://a..b/'], ['http://-a.com/'],
  ['http://' + 'a'.repeat(300) + '/x'], ['http://x/?a=%E4&b=%zz&c=+&d=%2B&e', true],
  ['http://x/?b=1&b=2&b=3', true], ['http://x/?a=1&&b=2&=c', true],
  ['http://[::1/a'], ['mailto:a@b.com?subject=x'], ['http://u:p@x:8080/a/b?c=1#f'],
  ['http://x/a?b=1', true], ['http://a b.com/x'], ['http://ex ample.com/'], ['http://％41.com/'],
  ['http://＃a.com/'], ['http://ａｂｃ.com/'], ['http://a／b.com/'], ['http://a＠b.com/'],
  ['http://a_b.com/'], ['http://A.COM/'], ['http://x/a?=b&=c&d=', true],
];
for (const args of legacy) {
  const key = 'parse(' + JSON.stringify(args) + ')';
  cmp(key, () => U.parse(...args), () => hostUrl.parse(...args));
}
cmp('parse instance', () => U.parse('http://x/a') instanceof U.Url, () => hostUrl.parse('http://x/a') instanceof hostUrl.Url);
cmp('parse RoundTrip', () => { const u = U.parse('http://u:p@x:8080/a/b?c=1#f'); return [u.href, U.parse(u.href).href]; },
  () => { const u = hostUrl.parse('http://u:p@x:8080/a/b?c=1#f'); return [u.href, hostUrl.parse(u.href).href]; });
cmp('parse query proto', () => Object.getPrototypeOf(U.parse('http://x/a?b=1', true).query), () => Object.getPrototypeOf(hostUrl.parse('http://x/a?b=1', true).query));
cmp('parse maxkeys', () => Object.keys(U.parse('http://x/?' + Array.from({ length: 1200 }, (_, i) => 'k' + i + '=v').join('&'), true).query).length,
  () => Object.keys(hostUrl.parse('http://x/?' + Array.from({ length: 1200 }, (_, i) => 'k' + i + '=v').join('&'), true).query).length);

const formats = [
  [{ protocol: 'http', host: 'x.com', pathname: '/a', query: { b: '1' }, hash: '#f' }],
  ['http://x/a'],
  [{ protocol: 'http', slashes: true, auth: 'u:p', host: 'x.com' }],
  [{ protocol: 'http', host: 'x', pathname: '/a', query: { b: ['1', '2'] } }],
  [{ protocol: 'http', host: 'x', pathname: '/a', query: 'b=1' }],
  [{ protocol: 'http', host: 'x', query: {} }],
  [{ protocol: 'http', host: 'x', pathname: '/a', query: { b: 'x y' } }],
  [{ protocol: 'http', host: 'x', auth: 'a b@c' }],
  [{ protocol: 'http', host: 'x', pathname: '/a', search: '?b=1' }],
  [{ protocol: 'file', pathname: '/tmp/x' }],
  [{ protocol: 'http:', host: 'x' }],
  [null],
];
for (const args of formats) cmp('format(' + JSON.stringify(args) + ')', () => U.format(...args), () => hostUrl.format(...args));
const urlsForFmt = ['http://u:p@x:8080/a?b=1#f', 'http://x/a', 'https://xn--fiq228c.com/p?q=1#h', 'file:///tmp/x', 'http://[::1]:8080/a?b=1#f'];
for (const h of urlsForFmt) {
  for (let mask = 0; mask < 16; mask++) {
    const opt = { fragment: !!(mask & 1), unicode: !!(mask & 2), search: !!(mask & 4), auth: !!(mask & 8) };
    cmp('format(' + h + ',' + JSON.stringify(opt) + ')', () => U.format(new U.URL(h), opt), () => hostUrl.format(new hostUrl.URL(h), opt));
  }
}
for (const args of [['http://x/a/b', '../c'], ['http://x/a/b', 'https://y/z'], ['http://x/a?q=1', '?r=2'], ['http://x/a', '//y/b'], ['http://x/a#f', '#g'], ['/a/b', 'c'], ['file:///a/b', '../c'], ['http://x/a', '']]) {
  cmp('resolve' + JSON.stringify(args), () => U.resolve(...args), () => hostUrl.resolve(...args));
}
cmp('resolveObject', () => U.resolveObject('http://x/a/b', '../c').href, () => hostUrl.resolveObject('http://x/a/b', '../c').href);
cmp('resolveObject no src', () => U.resolveObject('', 'http://x/a'), () => hostUrl.resolveObject('', 'http://x/a'));
cmp('resolveObject type', () => U.resolveObject('http://x/a/b', '../c') instanceof U.Url, () => true);
cmp('resolveObject proto change', () => U.resolveObject('http://x/a/b?c=1#f', 'https://y/p?q=2').href, () => hostUrl.resolveObject('http://x/a/b?c=1#f', 'https://y/p?q=2').href);
cmp('resolveObject mailto', () => { try { return U.resolveObject('mailto:local1@domain1', 'local2@domain2').href; } catch (e) { return 'E:' + e.code; } },
  () => { try { return hostUrl.resolveObject('mailto:local1@domain1', 'local2@domain2').href; } catch (e) { return 'E:' + e.code; } });
cmp('Url direct', () => { const u = new U.Url(); u.parse('http://x/a?b=1', true, true); return [u.href, u.format(), u.query]; },
  () => { const u = new hostUrl.Url(); u.parse('http://x/a?b=1', true, true); return [u.href, u.format(), u.query]; });
cmp('Url keys', () => Object.keys(new U.Url()), () => Object.keys(new hostUrl.Url()));

// WHATWG
const w = [
  ['http://u:p@x:8080/a?b=1#f'], ['http://u:p@x:8080/a/b?b=1&c=%20#f'], ['http://x/a'], ['not a url'],
  ['../c', 'http://x/a/b?q'], ['http://x'], ['nope'], ['/a', 'http://x'], ['file:///C:/x'],
  ['data:text/plain,x'], ['http://x:8080/a'], ['http://x:80/a'], ['http://[::1]:8080/a'],
  ['http://ÄÖÜ.com/a'], ['http://x/a?'], ['ws://x/a'], ['http://x/%20a b'], []
];
for (const args of w) {
  cmp('new URL' + JSON.stringify(args), () => new U.URL(...args).href, () => new hostUrl.URL(...args).href);
}
const setters = ['protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
for (const s of setters) {
  for (const v of ['https', 'y', '', '8080', '99999', 'bad host', '?q=1', 'f', '/p']) {
    cmp('set ' + s + '=' + JSON.stringify(v), () => { const u = new U.URL('http://u:p@x:8080/a?b=1#f'); u[s] = v; return [u.href, u.search, u.hash, u.port]; },
      () => { const u = new hostUrl.URL('http://u:p@x:8080/a?b=1#f'); u[s] = v; return [u.href, u.search, u.hash, u.port]; });
  }
}
cmp('href setter', () => { const u = new U.URL('http://x/a'); try { u.href = 'nope'; } catch (e) { return 'E:' + e.code + '/' + e.name + '/' + e.input + '/' + JSON.stringify(Object.keys(e)); } return u.href; },
  () => { const u = new hostUrl.URL('http://x/a'); try { u.href = 'nope'; } catch (e) { return 'E:' + e.code + '/' + e.name + '/' + e.input + '/' + JSON.stringify(Object.keys(e)); } return u.href; });
cmp('href setter rel', () => { const u = new U.URL('http://x/a/b'); try { u.href = '/c'; } catch (e) { return 'E:' + e.code; } return u.href; },
  () => { const u = new hostUrl.URL('http://x/a/b'); try { u.href = '/c'; } catch (e) { return 'E:' + e.code; } return u.href; });
cmp('bad input attrs', () => { try { new U.URL('nope'); } catch (e) { return [e.name, e.code, e.message, e.input, JSON.stringify(Object.keys(e))]; } },
  () => { try { new hostUrl.URL('nope'); } catch (e) { return [e.name, e.code, e.message, e.input, JSON.stringify(Object.keys(e))]; } });
cmp('bad base input', () => { try { new U.URL('/a', 'nope'); } catch (e) { return [e.code, e.input]; } },
  () => { try { new hostUrl.URL('/a', 'nope'); } catch (e) { return [e.code, e.input]; } });
cmp('missing args', () => { try { new U.URL(); } catch (e) { return [e.code, e.message]; } }, () => { try { new hostUrl.URL(); } catch (e) { return [e.code, e.message]; } });
cmp('canParse', () => [U.URL.canParse('http://x'), U.URL.canParse('nope'), U.URL.canParse('/a', 'http://x'), U.URL.canParse('/a'), U.URL.canParse('nope', 'http://x'), U.URL.canParse('/a', 'nope')],
  () => [hostUrl.URL.canParse('http://x'), hostUrl.URL.canParse('nope'), hostUrl.URL.canParse('/a', 'http://x'), hostUrl.URL.canParse('/a'), hostUrl.URL.canParse('nope', 'http://x'), hostUrl.URL.canParse('/a', 'nope')]);
cmp('canParse noargs', () => { try { U.URL.canParse(); } catch (e) { return [e.code, e.message]; } }, () => { try { hostUrl.URL.canParse(); } catch (e) { return [e.code, e.message]; } });
cmp('URL.parse', () => { const u = U.URL.parse('http://x/a'); return [u && u.href, U.URL.parse('nope'), U.URL.parse('../c', 'http://x/a/b').href, U.URL.parse('/a', 'nope')]; },
  () => { const u = hostUrl.URL.parse('http://x/a'); return [u && u.href, hostUrl.URL.parse('nope'), hostUrl.URL.parse('../c', 'http://x/a/b').href, hostUrl.URL.parse('/a', 'nope')]; });
cmp('URL.parse noargs', () => { try { U.URL.parse(); } catch (e) { return [e.code, e.message]; } }, () => { try { hostUrl.URL.parse(); } catch (e) { return [e.code, e.message]; } });
cmp('toString/toJSON', () => { const u = new U.URL('http://x/a?b=1#f'); return [String(u), u.toString(), u.toJSON(), Object.prototype.toString.call(u), JSON.stringify({ u })]; },
  () => { const u = new hostUrl.URL('http://x/a?b=1#f'); return [String(u), u.toString(), u.toJSON(), Object.prototype.toString.call(u), JSON.stringify({ u })]; });
cmp('sp identity', () => { const u = new U.URL('http://x/a?b=1'); const p = u.searchParams; const s1 = u.searchParams === p; u.search = '?c=2'; return [s1, u.searchParams === p, p.toString(), u.href]; },
  () => { const u = new hostUrl.URL('http://x/a?b=1'); const p = u.searchParams; const s1 = u.searchParams === p; u.search = '?c=2'; return [s1, u.searchParams === p, p.toString(), u.href]; });
cmp('sp mutate href', () => { const u = new U.URL('http://x/a?b=1#f'); const r = []; u.searchParams.append('z', '2'); r.push(u.href); u.searchParams.set('b', 'x y'); r.push(u.href); u.searchParams.delete('z'); r.push(u.href); u.searchParams.sort(); r.push(u.href); u.searchParams.delete('b'); r.push(u.href); return r; },
  () => { const u = new hostUrl.URL('http://x/a?b=1#f'); const r = []; u.searchParams.append('z', '2'); r.push(u.href); u.searchParams.set('b', 'x y'); r.push(u.href); u.searchParams.delete('z'); r.push(u.href); u.searchParams.sort(); r.push(u.href); u.searchParams.delete('b'); r.push(u.href); return r; });
cmp('sp weirdsuffix', () => { const u = new U.URL('http://x/a?b'); u.searchParams.delete('zz'); return [u.href, u.search]; },
  () => { const u = new hostUrl.URL('http://x/a?b'); u.searchParams.delete('zz'); return [u.href, u.search]; });
cmp('sp of url empty search', () => { const u = new U.URL('http://x/a?'); return [u.search, u.searchParams.toString(), u.href]; },
  () => { const u = new hostUrl.URL('http://x/a?'); return [u.search, u.searchParams.toString(), u.href]; });
cmp('sp setter throws', () => { const u = new U.URL('http://x/a'); try { u.searchParams = 1; return 'assigned'; } catch (e) { return 'throws'; } },
  () => { const u = new hostUrl.URL('http://x/a'); try { u.searchParams = 1; return 'assigned'; } catch (e) { return 'throws'; } });

// URLSearchParams
const spInits = [undefined, null, '', 'a=1&b=2', 'a=b+c&d=%20', '?a=1', 'a=1;b=2', 'a', '=b', 'a=', 'a=%zz', 'a=%E4',
  'a=%C3%A4', 'a=b+c', 'b=1&a=2&b=3&a=4', 123, true, [['a', '1'], ['b', '2']], [['a', 1], ['b', null]],
  { a: 1, b: undefined, c: null }, 'a=' + "!*'()~-._"];
for (const init of spInits) {
  cmp('new SP(' + JSON.stringify(init) + ')', () => new U.URLSearchParams(init).toString(), () => new hostUrl.URLSearchParams(init).toString());
}
cmp('SP from SP', () => new U.URLSearchParams(new U.URLSearchParams('a=1&b=2')).toString(), () => new hostUrl.URLSearchParams(new hostUrl.URLSearchParams('a=1&b=2')).toString());
cmp('SP from URL', () => new U.URLSearchParams(new U.URL('http://x/?a=1&a=2')).toString(), () => new hostUrl.URLSearchParams(new hostUrl.URL('http://x/?a=1&a=2')).toString());
cmp('SP bad tuple', () => { try { new U.URLSearchParams([['a']]); } catch (e) { return [e.code, e.message]; } }, () => { try { new hostUrl.URLSearchParams([['a']]); } catch (e) { return [e.code, e.message]; } });
cmp('SP bad tuple2', () => { try { new U.URLSearchParams([['a', 'b', 'c']]); } catch (e) { return [e.code, e.message]; } }, () => { try { new hostUrl.URLSearchParams([['a', 'b', 'c']]); } catch (e) { return [e.code, e.message]; } });
cmp('SP null pair', () => { try { new U.URLSearchParams([null]); } catch (e) { return [e.code, e.message]; } }, () => { try { new hostUrl.URLSearchParams([null]); } catch (e) { return [e.code, e.message]; } });
cmp('SP iteration', () => { const p = new U.URLSearchParams('a=1&b=2&a=3'); p.sort(); return [p.size, [...p], [...p.keys()], [...p.values()], p.getAll('a'), p.has('b'), p.has('a', '1'), p.has('a', '9'), p.get('zz'), p.toString()]; },
  () => { const p = new hostUrl.URLSearchParams('a=1&b=2&a=3'); p.sort(); return [p.size, [...p], [...p.keys()], [...p.values()], p.getAll('a'), p.has('b'), p.has('a', '1'), p.has('a', '9'), p.get('zz'), p.toString()]; });
cmp('SP sort stable', () => { const p = new U.URLSearchParams('b=1&a=2&b=3&a=4'); p.sort(); return p.toString(); }, () => { const p = new hostUrl.URLSearchParams('b=1&a=2&b=3&a=4'); p.sort(); return p.toString(); });
cmp('SP sort big', () => { const p = new U.URLSearchParams(Array.from({ length: 120 }, (_, i) => ['k' + ((i * 37) % 11), 'v' + i])); p.sort(); return p.toString(); }, () => { const p = new hostUrl.URLSearchParams(Array.from({ length: 120 }, (_, i) => ['k' + ((i * 37) % 11), 'v' + i])); p.sort(); return p.toString(); });
cmp('SP mutations', () => { const p = new U.URLSearchParams('a=1'); p.append('b', '2'); p.set('a', '9'); p.delete('b'); p.append('c', 'x y'); p.delete('a', '9'); p.delete('zz'); return [p.toString(), p.size, String(p)]; },
  () => { const p = new hostUrl.URLSearchParams('a=1'); p.append('b', '2'); p.set('a', '9'); p.delete('b'); p.append('c', 'x y'); p.delete('a', '9'); p.delete('zz'); return [p.toString(), p.size, String(p)]; });
cmp('SP forEach', () => { const seen = []; new U.URLSearchParams('a=1&b=2').forEach(function (v, k, t) { seen.push([v, k, t === this]); }, null); return seen; },
  () => { const seen = []; new hostUrl.URLSearchParams('a=1&b=2').forEach(function (v, k, t) { seen.push([v, k, t === this]); }, null); return seen; });
cmp('SP missing args', () => { const p = new U.URLSearchParams(''); const r = []; for (const m of ['append', 'get', 'getAll', 'has', 'delete']) { try { p[m](); r.push(m); } catch (e) { r.push(e.code + '|' + e.message); } } try { p.set('a'); } catch (e) { r.push(e.code + '|' + e.message); } return r; },
  () => { const p = new hostUrl.URLSearchParams(''); const r = []; for (const m of ['append', 'get', 'getAll', 'has', 'delete']) { try { p[m](); r.push(m); } catch (e) { r.push(e.code + '|' + e.message); } } try { p.set('a'); } catch (e) { r.push(e.code + '|' + e.message); } return r; });
cmp('SP bad callback', () => { try { new U.URLSearchParams('a=1').forEach(1); } catch (e) { return [e.code, e.message]; } }, () => { try { new hostUrl.URLSearchParams('a=1').forEach(1); } catch (e) { return [e.code, e.message]; } });
cmp('SP iterator tag', () => { const it = new U.URLSearchParams('a=1').entries(); return [Object.prototype.toString.call(it), it[Symbol.iterator]() === it, JSON.stringify(it.next()), JSON.stringify(it.next())]; },
  () => { const it = new hostUrl.URLSearchParams('a=1').entries(); return [Object.prototype.toString.call(it), it[Symbol.iterator]() === it, JSON.stringify(it.next()), JSON.stringify(it.next())]; });
cmp('SP tag', () => [Object.prototype.toString.call(new U.URLSearchParams()), Object.keys(new U.URLSearchParams()), new U.URLSearchParams().size],
  () => [Object.prototype.toString.call(new hostUrl.URLSearchParams()), Object.keys(new hostUrl.URLSearchParams()), new hostUrl.URLSearchParams().size]);
cmp('SP lone surrogate', () => { const p = new U.URLSearchParams('\uD800=1'); return [p.toString(), p.get('\uFFFD')]; }, () => { const p = new hostUrl.URLSearchParams('\uD800=1'); return [p.toString(), p.get('\uFFFD')]; });
cmp('SP number', () => new U.URLSearchParams(123).toString(), () => new hostUrl.URLSearchParams(123).toString());

// urlToHttpOptions
for (const h of ['http://u:p@x:8080/a?b=1#f', 'http://x/a', 'http://[::1]:8080/a', 'http://a%40b:p%20q@x/a', 'file:///tmp/x']) {
  cmp('u2ho ' + h, () => U.urlToHttpOptions(new U.URL(h)), () => hostUrl.urlToHttpOptions(new hostUrl.URL(h)));
}
cmp('u2ho plain', () => U.urlToHttpOptions({ href: 'http://x/a', protocol: 'http:', hostname: 'x', port: '', pathname: '/a', search: '', hash: '', username: '', password: '' }),
  () => hostUrl.urlToHttpOptions({ href: 'http://x/a', protocol: 'http:', hostname: 'x', port: '', pathname: '/a', search: '', hash: '', username: '', password: '' }));
cmp('u2ho proto', () => Object.getPrototypeOf(U.urlToHttpOptions(new U.URL('http://x/a'))), () => Object.getPrototypeOf(hostUrl.urlToHttpOptions(new hostUrl.URL('http://x/a'))));

// domainTo*
for (const d of ['中文.com', 'example.com', 'xn--fiq228c.com', 'ÄÖÜ.com', 'a_b.com', 'xn--a.com', '', 'ａｂｃ.com']) {
  cmp('d2a ' + d, () => U.domainToASCII(d), () => hostUrl.domainToASCII(d));
  cmp('d2u ' + d, () => U.domainToUnicode(d), () => hostUrl.domainToUnicode(d));
}
cmp('d2a missing', () => { try { U.domainToASCII(); } catch (e) { return [e.code, e.message]; } }, () => { try { hostUrl.domainToASCII(); } catch (e) { return [e.code, e.message]; } });

// pathToFileURL / fileURLToPath
if (process.platform === 'linux') {
  for (const p of ['/tmp/a b#c.txt', 'rel/x.txt', '.', '/', '/tmp/dir/', '', '/tmp/ä.txt', '/tmp/😀.txt', '/tmp/a%20b.txt', '/tmp/../x', 'a/../b', '/tmp/a\\b', '/tmp/a~b|c.txt']) {
    cmp('ptf ' + JSON.stringify(p), () => U.pathToFileURL(p).href, () => hostUrl.pathToFileURL(p).href);
  }
}
if (process.platform === 'linux') {
  for (const f of ['file:///tmp/a%20b.txt', 'file://localhost/tmp/x', 'file://example.com/tmp/x', '/tmp/x', 'file:///tmp/a%2Fb', 'file:///C:/x/y',
    'file:///tmp/%E4%B8%AD.txt', 'file:///tmp/a%5Cb', 'file:///tmp/a%2e%2e/b', 'file://localhost/', 'file:///tmp/a%zz', 'https://x/y', 'file:////x']) {
    cmp('fup ' + f, () => U.fileURLToPath(f), () => hostUrl.fileURLToPath(f));
  }
  cmp('fup url instance', () => U.fileURLToPath(new U.URL('file:///tmp/a%20b.txt')), () => hostUrl.fileURLToPath(new hostUrl.URL('file:///tmp/a%20b.txt')));
  for (const f of ['file:///tmp/a%20b%E4%B8%AD.txt', 'file:///tmp/a%2Fb', 'file:///C:/x/y', 'file:///tmp/a%zz', 'file:///tmp/a%00b']) {
    cmp('fupb ' + f, () => Buffer.from(U.fileURLToPathBuffer(f)).toString('hex'), () => Buffer.from(hostUrl.fileURLToPathBuffer(f)).toString('hex'));
  }
} else {
  console.log('SKIP fileURLToPath 差分（宿主是 ' + process.platform + '，posix 基线有意不同）');
}
cmp('fup url instance http', () => { try { U.fileURLToPath(new U.URL('http://x/y')); } catch (e) { return [e.name, e.code, e.message]; } },
  () => { try { hostUrl.fileURLToPath(new hostUrl.URL('http://x/y')); } catch (e) { return [e.name, e.code, e.message]; } });
cmp('fup obj', () => { try { U.fileURLToPath({}); } catch (e) { return [e.name, e.code, e.message]; } }, () => { try { hostUrl.fileURLToPath({}); } catch (e) { return [e.name, e.code, e.message]; } });
cmp('fup number', () => { try { U.fileURLToPath(123); } catch (e) { return [e.name, e.code, e.message]; } }, () => { try { hostUrl.fileURLToPath(123); } catch (e) { return [e.name, e.code, e.message]; } });
const shimBuffer = await import(pathToFileURL(join(SHIM_DIR, 'node-buffer.js')).href);
cmp('fupb isBuffer', () => U.fileURLToPathBuffer('file:///tmp/x') instanceof shimBuffer.Buffer, () => true);

console.log('\n' + (total - fail) + '/' + total + ' 一致，' + fail + ' 处不同');
rmSync(SHIM_DIR, { recursive: true, force: true });
rmSync(DATA_DIR, { recursive: true, force: true });
