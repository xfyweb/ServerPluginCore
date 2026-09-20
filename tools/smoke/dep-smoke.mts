// 真实依赖冒烟（逐包）：哪些包能直接在沙箱里跑，哪些卡在"缺全局"
// 用法（从仓库根）：node node_modules/tsx/dist/cli.mjs tools/smoke/dep-smoke.mts [mkdirp|properties|debug|eta|ejs|all]
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createCipheriv, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_MODULES, REPO_ROOT, SMOKE_BUNDLES, SURVEY_DIR, fileUrl } from '../paths.mjs';

const SHIM_DIR = SANDBOX_MODULES;
// bundle 是生成物（已 gitignore）⇒ 目录不会在仓库里，得自己建
mkdirSync(SMOKE_BUNDLES, { recursive: true });
const { build } = await import(`file:///${SURVEY_DIR}/node_modules/esbuild/lib/main.js`);

process.env.SPC_AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-depsmoke-audit-'));
const { createSandbox } = await import(fileUrl(REPO_ROOT + '/core/sandbox.ts'));
const { buildHostApi } = await import(fileUrl(REPO_ROOT + '/core/hostApi.ts'));

const SHIMS: Record<string, string> = {
  fs: 'node-fs.js',
  path: 'node-path.js',
  'fs/promises': 'node-fs-promises.js',
  url: 'node-url.js',
  util: 'node-util.js',
  'util/types': 'node-util-types.js',
  os: 'node-os.js',
  process: 'node-process.js',
  tty: 'node-tty.js',
  constants: 'node-constants.js',
  events: 'node-events.js',
  assert: 'node-assert.js',
  'assert/strict': 'node-assert-strict.js',
  buffer: 'node-buffer.js',
  string_decoder: 'node-string_decoder.js',
  crypto: 'node-crypto.js',
  zlib: 'node-zlib.js',
  worker_threads: 'node-worker_threads.js',
  querystring: 'node-querystring.js',
  stream: 'node-stream.js',
  'stream/promises': 'node-stream-promises.js',
};
const inlineShims = {
  name: 'inline-shims',
  setup(b: any) {
    b.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args: any) => {
      const canonical = args.path.replace(/^node:/, '');
      return SHIMS[canonical] ? { path: canonical, namespace: 'spc-shim' } : undefined;
    });
    b.onLoad({ filter: /.*/, namespace: 'spc-shim' }, (args: any) => ({
      contents: readFileSync(join(SHIM_DIR, SHIMS[args.path]), 'utf8'),
      loader: 'js',
      resolveDir: SHIM_DIR,
    }));
  },
};

// dotenv 的加密 .env 靶子：密文与密钥在**宿主侧**现算（dotenv 的格式：nonce(12) + ct + tag(16)，base64）
const dotenvKeyBytes = randomBytes(32);
const dotenvNonce = randomBytes(12);
const dotenvCipher = createCipheriv('aes-256-gcm', dotenvKeyBytes, dotenvNonce);
const dotenvCt = Buffer.concat([dotenvCipher.update(Buffer.from('SPC_SECRET=hello\n')), dotenvCipher.final()]);
const payload = Buffer.concat([dotenvNonce, dotenvCt, dotenvCipher.getAuthTag()]).toString('base64');
// dotenv 只取 keyStr 的**后 64 个 hex 字符**
const dotenvKeyArg = 'x'.repeat(20) + dotenvKeyBytes.toString('hex');

const ENTRIES: Record<string, string> = {  // fs + path 的最小真实用法，且用返回值的语义
  mkdirp: `
import { mkdirp } from 'mkdirp';
export function init() {
  try {
    // 用**没预建过的**新路径：这样才走"真建 + 用返回值"的分支（返回第一个被创建的目录，Node 语义）
    console.log('MKDIRP1 ' + mkdirp.sync('made/x/y/z'));
    console.log('MKDIRP2 ' + mkdirp.sync('made/x/y/z'));
  } catch (e) {
    console.log('ERR ' + e.code + '/' + e.spcCode + '/path=' + e.path + '/params=' + JSON.stringify(e.params || null));
    console.log('MSG ' + e.message);
    console.log('STACK ' + String(e.stack).split('\\n').slice(0, 6).join(' | '));
  }
}
`,
  // CJS + 我们自己写的 fs 读文件 + properties 解析（CJS 互操作 + 回调风格 + 字符串解析）
  properties: `
import fs from 'node:fs';
import properties from 'properties';
export function init() {
  try {
    const text = fs.readFileSync('cfg/app.properties', 'utf8');
    console.log('PROPS ' + JSON.stringify(properties.parse(text)));
    fs.readFile('cfg/app.properties', 'utf8', (err, asyncText) => {
      console.log('PROPS-ASYNC ' + (err ? 'ERR:' + err.code : JSON.stringify(properties.parse(asyncText))));
    });
  } catch (e) {
    console.log('ERR ' + e.code + '/' + e.message + ' | ' + String(e.stack).split('\\n').slice(0, 5).join(' | '));
  }
}
`,
  // util + os + process + tty 的组合（debug 是"只用官方模块"的真实代表）
  debug: `
import debugFactory from 'debug';
export function init() {
  const dbg = debugFactory('spc:probe');
  dbg.enabled = true;
  dbg('hello %s %d', 'world', 42);
  console.log('DEBUG ok ' + typeof debugFactory.enable);
}
`,
  // 第三批靶子：crypto（uuid v14 用 getRandomValues / randomUUID）
  uuid: `
import { v4 as uuidv4, v7 as uuidv7, validate, version } from 'uuid';
export function init() {
  const a = uuidv4();
  const b = uuidv4();
  console.log('UUID4 ' + a + '/' + (a !== b) + '/' + validate(a) + '/' + version(a));
  const c = uuidv7();
  console.log('UUID7 ' + version(c) + '/' + validate(c));
}
`,
  // 第三批靶子：crypto（tmp 用 randomBytes 生成名字）+ fs + os
  tmp: `
import tmp from 'tmp';
export function init() {
  // ① 目录形态：不需要 fd，走 fs.mkdirSync + **crypto.randomBytes** 生成名字
  const d = tmp.dirSync({ template: 'cfg/d-XXXXXX' });
  console.log('TMPDIR ' + /d-[A-Za-z0-9]{6}$/.test(d.name) + '/' + d.name.startsWith('cfg/d-'));
  d.removeCallback();
  // ② 文件形态要 fd（openSync）——**本批明确不做**，这条断言把边界钉住
  try {
    tmp.fileSync({ template: 'cfg/f-XXXXXX.txt' });
    console.log('TMPFILE unexpected');
  } catch (e) {
    console.log('TMPFILE-FD ' + e.code);
  }
}
`,
  // 第三批靶子：dotenv 的**加密 .env 解密路径**（就是 createDecipheriv 那个用例）
  dotenv: `
import { decrypt } from 'dotenv';
export function init() {
  const plain = decrypt(${JSON.stringify(payload)}, ${JSON.stringify(dotenvKeyArg)});
  console.log('DOTENV ' + JSON.stringify(plain));
}
`,
  // 第三批靶子：adm-zip（zlib 的同步路径 + 我们自己写的 fs 读写字节）
  'adm-zip': `
import AdmZip from 'adm-zip';
const seedBytes = Buffer.from("UEsDBBQAAAgIAJluMl0lK8DFFAAAABIAAAAFAAAAYS50eHTLSM3JyVdIK8rPVUhMydWtyiwAAFBLAwQUAAAICACZbjJdaREftggAAAAGAAAACQAAAGRpci9iLnR4dCtOTc7PSwEAUEsBAhQKFAAACAgAmW4yXSUrwMUUAAAAEgAAAAUAAAAAAAAAAAAAAKSBAAAAAGEudHh0UEsBAhQKFAAACAgAmW4yXWkRH7YIAAAABgAAAAkAAAAAAAAAAAAAAKSBNwAAAGRpci9iLnR4dFBLBQYAAAAAAgACAGoAAABmAAAAAAA=", 'base64');
export function init() {
  // ① 内存读路径：从字节建 zip → 列条目 → 读内容（走 zlib.inflateRawSync）
  const zip = new AdmZip(seedBytes);
  console.log('ZIP ' + zip.getEntries().map((e) => e.entryName).sort().join(',') + '/' + zip.readAsText('a.txt'));
  // ② 内存写路径：toBuffer() 走 zlib.deflateRawSync（不落盘、不需要 fd）
  const made = new AdmZip();
  made.addFile('x.txt', Buffer.from('made in the sandbox'));
  console.log('MADE ' + (made.toBuffer().length > 0) + '/' + new AdmZip(made.toBuffer()).readAsText('x.txt'));
  // ③ 写盘路径是 **fd 式**（openSync/writeSync/closeSync）——本批明确不做，等 HostRef 审定后的决定
  try {
    made.writeZip('out.zip');
    console.log('WRITE unexpected');
  } catch (e) {
    console.log('WRITE-FD ' + e.code);
  }
}
`,
  // 模板引擎：读模板文件（fs.readFileSync + path）
  ejs: `
import ejs from 'ejs';
export function init() {
  console.log('EJS ' + ejs.render('hi <%= who %>', { who: 'spc' }));
  console.log('EJSFILE ' + ejs.render('<%= who %>!', { who: 'file' }, { filename: 'out/a/b/c/tpl.ejs' }));
}
`,
  // 第三批收口靶子：write-file-atomic —— 装 `worker_threads.threadId` + 用 `process.getuid()` 探 root
  // （这两个就是本轮加它的唯一理由：Linux 基线上 getuid 是**函数**，老实现会去调用它然后抛错）
  'write-file-atomic': `import { readFileSync, existsSync } from 'node:fs';
import writeFileAtomic from 'write-file-atomic';
export function init() {
  console.log('WFA-NONROOT ' + process.getuid() + '/' + (process.getuid() !== 0));
  // ⚠️ 它（经由 signal-exit）会用到 __filename：那是 esbuild 把 CJS 包搬进 ESM 产物时**自己**
  // 留下的引用，不是包源码里的（见设计 §9 的 __filename/__dirname 条目）。所以下面那两条
  // 断言量的是**边界**，不是"这个包能不能用"。
  // ① 同步写盘路径是 **fd 式**（openSync/writeSync/fsyncSync/closeSync）——本批明确不做
  try {
    writeFileAtomic.sync('cfg/atomic.txt', 'atomic-ok', { fsync: false });
    console.log('WFA-SYNC unexpected');
  } catch (e) {
    console.log('WFA-SYNC-FD ' + (e && e.code) + '/' + (e && e.name));
  }
  // ② 异步路径：它是 Promise 形态（内部用 promisify 的 fs 调用，不走 fd）
  const p = writeFileAtomic('cfg/async.txt', 'async-ok');
  p.then(() => {
    console.log('WFA-ASYNC ' + readFileSync('cfg/async.txt', 'utf8') + '/' + existsSync('cfg/async.txt.tmp'));
  }, (e) => {
    console.log('WFA-ASYNC-ERR ' + (e && e.code) + '/' + (e && e.message));
  });
}
`,
  // 第三批 B1 靶子①：graceful-fs —— 只用 `require('stream').Stream` 做 **legacy 函数基类**
  // （`legacy-streams.js:14` 的 `Stream.call(this)`）。它主要验证"Stream 可 call"这条形状。
  'graceful-fs': `
import gfs from 'graceful-fs';
export function init() {
  console.log('GF-API ' + [typeof gfs.readFileSync, typeof gfs.writeFileSync, typeof gfs.ReadStream].join(','));
  gfs.writeFileSync('cfg/gf.txt', 'graceful');
  console.log('GF-READ ' + gfs.readFileSync('cfg/gf.txt', 'utf8'));
  // 流形态是 fd 式（fs.open）⇒ 本批明确不做；这条断言把边界钉住
  try {
    const s = gfs.createReadStream('cfg/gf.txt');
    console.log('GF-STREAM unexpected ' + s);
  } catch (e) {
    console.log('GF-STREAM ' + (e && e.code));
  }
}
`,
  // 第三批 B1 靶子②：fast-glob —— `new Readable({objectMode, read})` + `new PassThrough({objectMode})`
  // + 实例上覆写 `_write` + 事件搬运（`providers/stream.js` / `readers/stream.js`）
  'fast-glob': `
import fg from 'fast-glob';
import { mkdirSync, writeFileSync } from 'node:fs';
export function init() {
  mkdirSync('tree/sub', { recursive: true });
  writeFileSync('tree/a.txt', 'a');
  writeFileSync('tree/sub/b.txt', 'b');
  // ① 同步 API（基准）
  console.log('FG-SYNC ' + fg.sync(['tree/**/*.txt']).sort().join(','));
  // ② 流式 API：走 Readable(objectMode) + PassThrough(objectMode) + 我们的事件面
  const stream = fg.stream(['tree/**/*.txt']);
  const seen = [];
  stream.on('data', (entry) => seen.push(String(entry)));
  stream.on('error', (e) => console.log('FG-STREAM-ERR ' + (e && e.code)));
  stream.on('end', () => console.log('FG-STREAM ' + seen.sort().join(',')));
}
`,
};

const which = process.argv[2] ?? 'all';
const names = which === 'all' ? Object.keys(ENTRIES) : [which];

for (const name of names) {
  const DATA_DIR = mkdtempSync(join(tmpdir(), `spc-deps-${name}-`));
  mkdirSync(join(DATA_DIR, 'cfg'), { recursive: true });
  // 与 core/plugin/loader.ts 一致：宿主建好 <dataDir>/tmp（os.tmpdir() 指的就是它）
  mkdirSync(join(DATA_DIR, 'tmp/cfg'), { recursive: true });
  writeFileSync(join(DATA_DIR, 'cfg/app.properties'), 'name = spc\nport = 8080\n');
  mkdirSync(join(DATA_DIR, 'out/a/b/c'), { recursive: true });
  writeFileSync(join(DATA_DIR, 'out/a/b/c/tpl.ejs'), '<%= who %>!');

  let code: string;
  try {
    const out = await build({
      stdin: { contents: ENTRIES[name], resolveDir: SURVEY_DIR, loader: 'js', sourcefile: 'entry.js' },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      write: false,
      plugins: [inlineShims],
      logLevel: 'silent',
    });
    code = out.outputFiles[0].text;
    // 诊断用：产物落盘，出怪事时直接 grep（`__filename` 那类问题用眼睛看日志是看不出来的）
    writeFileSync(join(SMOKE_BUNDLES, `bundle-${name}.mjs`), code);
  } catch (err: any) {
    console.log(`✗ ${name}: 构建失败 ${err?.message ?? err}`);
    rmSync(DATA_DIR, { recursive: true, force: true });
    continue;
  }

  const api = buildHostApi({ pluginId: `@deps/${name}`, dataDir: DATA_DIR });
  const sandbox = await createSandbox(api, {
    pluginId: `@deps/${name}`,
    permissions: ['fs.read.data', 'fs.write.data', 'crypto.hash', 'crypto.random', 'crypto.cipher', 'zlib.compress', 'zlib.decompress', 'bytes.encode', 'bytes.decode', 'url.parse', 'url.encode'],
    facts: { version: { code: 1, name: 'deps' }, dataDir: DATA_DIR, manifest: {}, config: {} },
  });
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void logs.push('[stderr] ' + a.map(String).join(' '));
  let thrown = '';
  // ⚠️ `callHook` 里的墙钟是**总量**预算，而"等一条永不到来的流事件"会一直占着它 ——
  // 所以这里再加一道**外层超时**：靶子挂住时打印诊断而不是把整个冒烟挂死（本轮被挂过一次）。
  const HANG = Symbol('hang');
  try {
    await sandbox.runModule(`@deps/${name}`, code);
    const result = await Promise.race([
      sandbox.callHook('init', 6_000).then(() => null),
      new Promise((r) => setTimeout(() => r(HANG), 9_000)),
    ]);
    if (result === HANG) thrown = 'HANG 剧本在 9 秒内没结束（最可能是"等一条永不到来的流事件"）';
  } catch (err: any) {
    thrown = `${err?.code ?? ''} ${String(err?.params?.message ?? err?.message ?? '')} ${JSON.stringify(err?.params ?? {})}`;
  } finally {
    console.log = origLog;
    console.error = origErr;
    sandbox.dispose();
  }
  origLog(`${thrown ? '✗' : '✔'} ${name}（产物 ${code.length} 字节，动态欠条 ${code.includes('Dynamic require of ') ? '有' : '无'}）`);
  for (const line of logs) origLog('    ' + line);
  if (thrown) origLog('    THROW ' + thrown);
  // 沙箱外的真实结果（证明它真的落到了盘上，而不只是没抛错）
  if (name === 'mkdirp') {
    origLog(`    磁盘上 made/x/y/z 存在: ${existsSync(join(DATA_DIR, 'made/x/y/z'))}`);
    origLog(`    数据目录外没被创建: ${!existsSync(join(DATA_DIR, '..', 'made'))}`);
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
}
