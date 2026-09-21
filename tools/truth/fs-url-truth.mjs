// fs / url 真值采集（在 WSL 的 node v22.22.1 上跑，环境即"仿真基线"）
//   用法：wsl -e node /mnt/d/git-repo/ServerPluginCore/tools/truth/fs-url-truth.mjs > tools/truth/data/fs-url-truth.json
// 采四类东西：
//   ① fs.constants 的键值（仿真层要照抄这一份，不是照抄 `constants` 模块）
//   ② errno → strerror 文案表（写 err.message 用；本地可核，不联网）
//   ③ 一串真实失败操作的错误形状（code / errno / syscall / path / message 的确切格式）
//   ④ url 的 legacy + WHATWG 行为（pathToFileURL/fileURLToPath 边界、URLSearchParams 序列化）
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, openSync, closeSync, constants as fsConstants, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as os from 'node:os';
import * as util from 'node:util';
import * as url from 'node:url';
import * as fs from 'node:fs';

const out = { meta: { node: process.version, platform: process.platform, arch: process.arch } };

// ── ① fs.constants ──
out.fsConstants = Object.fromEntries(Object.entries(fsConstants).sort(([a], [b]) => a.localeCompare(b)));

// ── ② errno → message ──
out.systemErrorMessages = {};
if (typeof util.getSystemErrorMessage === 'function') {
  for (const [name, num] of Object.entries(os.constants.errno)) {
    // 注意：Node 的 getSystemErrorMessage 收**负** errno（libuv 约定）；os.constants.errno 是正值
    out.systemErrorMessages[name] = { num, message: util.getSystemErrorMessage(-num) };
  }
} else {
  out.systemErrorMessages = null; // 该版本没有这个 API：改走真实失败操作拿文案
}

// ── ③ 真实失败操作的错误形状 ──
const dir = mkdtempSync(join(tmpdir(), 'spc-truth-'));
const file = join(dir, 'a.txt');
writeFileSync(file, 'hello');
mkdirSync(join(dir, 'sub'));
writeFileSync(join(dir, 'sub', 'inner.txt'), 'x');

const shape = (fn) => {
  try {
    const v = fn();
    return { ok: true, value: typeof v === 'object' && v !== null ? { ctor: v.constructor?.name, keys: Object.keys(v).slice(0, 12) } : v };
  } catch (e) {
    const o = { name: e.name, code: e.code, errno: e.errno, syscall: e.syscall, message: e.message };
    if (e.path !== undefined) o.path = e.path;
    if (e.dest !== undefined) o.dest = e.dest;
    if (e.input !== undefined) o.input = e.input;
    return { ok: false, error: o };
  }
};
const missing = join(dir, 'nope.txt');
const asDir = join(dir, 'sub'); // 目录当文件读
const asFile = file; // 文件当目录列

out.errorShapes = {
  readFile_missing: shape(() => readFileSync(missing, 'utf8')),
  readFile_isDir: shape(() => readFileSync(asDir, 'utf8')),
  readdir_missing: shape(() => readdirSync(missing)),
  readdir_isFile: shape(() => readdirSync(asFile)),
  stat_missing: shape(() => statSync(missing)),
  lstat_missing: shape(() => lstatSync(missing)),
  unlink_missing: shape(() => fs.unlinkSync(missing)),
  unlink_isDir: shape(() => fs.unlinkSync(asDir)),
  rmdir_nonEmpty: shape(() => fs.rmdirSync(dir)),
  rmdir_missing: shape(() => fs.rmdirSync(missing)),
  rmdir_missing_recursiveFalse: shape(() => fs.rmdirSync(missing, { recursive: false })),
  rmdir_recursiveOpt: shape(() => fs.rmdirSync(missing, { recursive: true })),
  rm_missing: shape(() => fs.rmSync(missing)),
  rm_missing_force: shape(() => fs.rmSync(missing, { force: true })),
  rm_isDir_nonRecursive: shape(() => fs.rmSync(asDir)),
  rm_dir_nonEmpty_nonRecursive: shape(() => fs.rmSync(dir)),
  mkdir_existing: shape(() => fs.mkdirSync(dir)),
  mkdir_existing_recursive: shape(() => fs.mkdirSync(dir, { recursive: true })),
  mkdir_missingParent: shape(() => fs.mkdirSync(join(dir, 'x', 'y'))),
  mkdir_missingParent_recursive: shape(() => fs.mkdirSync(join(dir, 'x', 'y'), { recursive: true })),
  rename_missing: shape(() => fs.renameSync(missing, join(dir, 'z'))),
  copyFile_missing: shape(() => fs.copyFileSync(missing, join(dir, 'z'))),
  copyFile_excl_exists: shape(() => fs.copyFileSync(file, file, fsConstants.COPYFILE_EXCL)),
  access_missing: shape(() => fs.accessSync(missing)),
  access_missing_rw: shape(() => fs.accessSync(missing, fsConstants.R_OK | fsConstants.W_OK)),
  readFile_badEncoding: shape(() => readFileSync(file, 'zzz')),
  readFile_badFlag: shape(() => readFileSync(file, { flag: 'zzz' })),
  writeFile_badData: shape(() => fs.writeFileSync(join(dir, 'w.txt'), 42)),
  readdir_badEncoding: shape(() => readdirSync(dir, { encoding: 'zzz' })),
  open_badFlag: shape(() => openSync(file, 'zzz')),
  realpath_missing: shape(() => fs.realpathSync(missing)),
  mkdtemp_missingParent: shape(() => fs.mkdtempSync(join(dir, 'nodir', 'p-'))),
  mkdtemp_badPrefix: shape(() => fs.mkdtempSync(123)),
};
// mkdir 返回值（recursive 下返回"第一个被创建的目录"）
const mk1 = join(dir, 'r1', 'r2', 'r3');
out.mkdirReturn = { recursive: fs.mkdirSync(mk1, { recursive: true }), nonRecursive: fs.mkdirSync(join(dir, 'plain')) };
out.rmdirReturn = undefined;

// 打开 + 读取（fd 面不在本批，但记录一下 openSync 返回啥）
const fd = openSync(file, 'a');
out.openReturn = { type: typeof fd, isInt: Number.isInteger(fd) };
closeSync(fd);

// ── ④ url 行为 ──
const urlShapes = [];
const t = (label, fn) => {
  try {
    const v = fn();
    urlShapes.push({ label, value: typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v });
  } catch (e) {
    urlShapes.push({ label, error: { name: e.name, code: e.code, message: e.message } });
  }
};
t('pathToFileURL_abs_posix', () => url.pathToFileURL('/tmp/a b#c.txt').href);
t('pathToFileURL_rel', () => url.pathToFileURL('rel/x.txt').href);
t('pathToFileURL_dot', () => url.pathToFileURL('.').href);
t('pathToFileURL_root', () => url.pathToFileURL('/').href);
t('pathToFileURL_trailingSlash', () => url.pathToFileURL('/tmp/dir/').href);
t('fileURLToPath_basic', () => url.fileURLToPath('file:///tmp/a%20b.txt'));
t('fileURLToPath_host', () => url.fileURLToPath('file://localhost/tmp/x'));
t('fileURLToPath_bad_host', () => url.fileURLToPath('file://example.com/tmp/x'));
t('fileURLToPath_noScheme', () => url.fileURLToPath('/tmp/x'));
t('fileURLToPath_encodedSlash', () => url.fileURLToPath('file:///tmp/a%2Fb'));
t('fileURLToPath_windowsish', () => url.fileURLToPath('file:///C:/x/y'));
t('legacy_parse_full', () => url.parse('http://u:p@example.com:8080/a/b?c=1&d=2#frag'));
t('legacy_parse_slashes', () => url.parse('http://example.com/a'));
t('legacy_parse_noSlashes', () => url.parse('mailto:a@b.com'));
t('legacy_parse_noslash_host', () => url.parse('http:example.com/a'));
t('legacy_parse_weird', () => url.parse('http://a b/c'));
t('legacy_parse_relative', () => url.parse('/a/b?c#d'));
t('legacy_parse_hostless_path', () => url.parse('a/b'));
t('legacy_parse_noQueryString', () => url.parse('http://x/a?b=1', false, true));
t('legacy_parse_queryString', () => url.parse('http://x/a?b=1&b=2', true));
t('legacy_parse_IPv6', () => url.parse('http://[::1]:8080/x'));
t('legacy_format_obj', () => url.format({ protocol: 'http', host: 'x.com', pathname: '/a', query: { b: '1' }, hash: '#f' }));
t('legacy_format_str', () => url.format('http://x/a'));
t('legacy_format_auth_only', () => url.format({ protocol: 'http', slashes: true, auth: 'u:p', host: 'x.com' }));
t('legacy_resolve_basic', () => url.resolve('http://x/a/b', '../c'));
t('legacy_resolve_abs', () => url.resolve('http://x/a/b', 'https://y/z'));
t('legacy_resolve_query', () => url.resolve('http://x/a?q=1', '?r=2'));
t('legacy_resolve_protorel', () => url.resolve('http://x/a', '//y/b'));
t('legacy_resolve_hash', () => url.resolve('http://x/a#f', '#g'));
t('legacy_urlToHttpOptions', () => url.urlToHttpOptions(new URL('http://u:p@x:8080/a?b=1#f')));
t('WHATWG_basic', () => new URL('http://u:p@x:8080/a?b=1#f').href);
t('WHATWG_components', () => {
  const u = new URL('http://u:p@x:8080/a/b?b=1&c=%20#f');
  return {
    href: u.href, origin: u.origin, protocol: u.protocol, username: u.username, password: u.password,
    host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search,
    searchParams: u.searchParams.toString(), hash: u.hash, json: u.toJSON(),
  };
});
t('WHATWG_setters', () => {
  const u = new URL('http://x/a');
  u.protocol = 'https'; u.hostname = 'y'; u.port = '8080'; u.pathname = '/p'; u.search = '?q=1'; u.hash = '#h';
  const r1 = { href: u.href, searchParams: u.searchParams.toString() };
  u.searchParams.append('z', '2');
  return { ...r1, afterParams: u.href, params: u.searchParams.toString() };
});
t('WHATWG_badInput', () => new URL('not a url'));
t('WHATWG_relative', () => new URL('../c', 'http://x/a/b?q').href);
t('WHATWG_canParse', () => [URL.canParse('http://x'), URL.canParse('nope')]);
t('WHATWG_invalidSetters', () => {
  const u = new URL('http://x/a');
  u.protocol = 'bogus'; const a = u.href;
  u.port = '99999'; const b = u.href;
  u.host = 'bad host'; const c = u.href;
  return [a, b, c];
});
t('params_serialize_space', () => new URLSearchParams({ a: 'b c' }).toString());
t('params_serialize_specials', () => new URLSearchParams([['a', "!*'()~-._"], ['b', 'ä'], ['c', '+&='], ['', '']]).toString());
t('params_parse_plus', () => [...new URLSearchParams('a=b+c&d=%20').entries()]);
t('params_iteration', () => {
  const p = new URLSearchParams('a=1&b=2&a=3');
  return { size: p.size, entries: [...p], keys: [...p.keys()], values: [...p.values()], all: p.getAll('a'), has: p.has('b'), sorted: (p.sort(), p.toString()) };
});
t('params_mutations', () => {
  const p = new URLSearchParams('a=1');
  p.append('b', '2'); p.set('a', '9'); p.delete('b'); p.append('c', 'x y');
  return { str: p.toString(), size: p.size, string: String(p) };
});
t('params_from_object_and_url', () => new URLSearchParams(new URL('http://x/?a=1')).toString());
t('url_export_keys', () => Object.keys(url).sort());
t('legacy_Url_instanceof', () => url.parse('http://x/a') instanceof url.Url);
t('legacy_parse_slashes_denormalized', () => url.parse('http://x//a//b').pathname);

out.url = urlShapes;
out.urlExportKeys = Object.keys(url).sort();
out.fsExportKeys = Object.keys(fs).sort();
out.fspExportKeys = Object.keys(fsp).sort();

rmSync(dir, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out, null, 2));
