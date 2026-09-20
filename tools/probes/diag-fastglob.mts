// fast-glob 的诊断：为什么 `fg.sync` 与 `fg.stream` 都没有条目（沙箱里）
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SURVEY = SURVEY_DIR;
const { build } = await import(`file:///${SURVEY}/node_modules/esbuild/lib/main.js`);
const SHIM_DIR = SANDBOX_MODULES;

process.env.SPC_AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-fg-audit-'));
const { buildHostApi } = await import(fileUrl(REPO_ROOT + '/core/hostApi.ts'));
const { createSandbox } = await import(fileUrl(REPO_ROOT + '/core/sandbox.ts'));

const SHIMS: Record<string, string> = {
  fs: 'node-fs.js', path: 'node-path.js', 'fs/promises': 'node-fs-promises.js', url: 'node-url.js',
  util: 'node-util.js', 'util/types': 'node-util-types.js', os: 'node-os.js', process: 'node-process.js',
  tty: 'node-tty.js', constants: 'node-constants.js', events: 'node-events.js', assert: 'node-assert.js',
  'assert/strict': 'node-assert-strict.js', buffer: 'node-buffer.js', string_decoder: 'node-string_decoder.js',
  crypto: 'node-crypto.js', zlib: 'node-zlib.js', worker_threads: 'node-worker_threads.js',
  querystring: 'node-querystring.js', stream: 'node-stream.js', 'stream/promises': 'node-stream-promises.js',
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
import { readFileSync } from 'node:fs';

const ENTRY = `
import fg from 'fast-glob';
import { mkdirSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { SURVEY_DIR, SANDBOX_MODULES, REPO_ROOT, fileUrl } from '../paths.mjs';
import { cwd } from 'node:process';
import { resolve } from 'node:path';
export function init() {
  mkdirSync('tree/sub', { recursive: true });
  writeFileSync('tree/a.txt', 'a');
  writeFileSync('tree/sub/b.txt', 'b');
  console.log('CWD ' + cwd());
  // 用「把同样两个参数手工拼一遍」的方式对照：cwd + '/' + 'tree'
  console.log('MANUAL ' + cwd().split('\\').join('/') + '/tree');
  console.log('RESOLVE ' + resolve('tree'));
  console.log('RESOLVE-ABS ' + resolve(cwd() + '/tree'));
  console.log('RESOLVE-IDEM ' + resolve(resolve('tree')));
  console.log('REALPATH ' + realpathSync('.'));
  console.log('READDIR ' + readdirSync('tree').sort().join(','));
  const out = fg.sync(['tree/**/*.txt']);
  console.log('SYNC ' + out.length + ' ' + out.join(','));
  console.log('SYNC-ABS ' + fg.sync([cwd() + '/tree/**/*.txt']).length);
  console.log('SYNC-DIRECT ' + fg.sync(['tree/a.txt']).length);
  console.log('SYNC-CWD-OPT ' + fg.sync(['**/*.txt'], { cwd: 'tree' }).length);
  console.log('SYNC-NOSTAT ' + fg.sync(['tree/**/*.txt'], { stats: false, onlyFiles: false }).length);
  console.log('SYNC-BASE ' + fg.sync(['tree/a.txt'], { stats: false }).length);
  const s = fg.stream(['tree/**/*.txt']);
  const seen = [];
  s.on('data', (e) => seen.push(String(e)));
  s.on('error', (e) => console.log('SERR ' + (e && e.code) + ' ' + (e && e.message)));
  s.on('end', () => console.log('STREAM ' + seen.length + ' ' + seen.join(',')));
}
`;

const out = await build({
  stdin: { contents: ENTRY, resolveDir: SURVEY, loader: 'js', sourcefile: 'entry.js' },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', write: false,
  plugins: [inlineShims], logLevel: 'silent',
});
const code = out.outputFiles[0].text;

const DIR = mkdtempSync(join(tmpdir(), 'spc-fg-'));
mkdirSync(join(DIR, 'cfg'), { recursive: true });
mkdirSync(join(DIR, 'tmp/cfg'), { recursive: true });
const api = buildHostApi({ pluginId: '@fg/x', dataDir: DIR });
const sandbox = await createSandbox(api, {
  pluginId: '@fg/x',
  permissions: ['fs.read.data', 'fs.write.data', 'bytes.encode', 'bytes.decode'],
  facts: { version: { code: 1, name: 'fg' }, dataDir: DIR, manifest: {}, config: {} },
});
const logs: string[] = [];
const orig = console.log;
console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
let err = '';
try {
  await sandbox.runModule('@fg/x', code);
  await sandbox.callHook('init', 8000);
} catch (e: any) {
  err = `${e?.code} ${JSON.stringify(e?.params ?? e?.message)}`;
} finally {
  console.log = orig;
  sandbox.dispose();
}
orig(`RESULT: ${err ? 'FAIL ' + err : 'ok'}`);
for (const l of logs) orig('   ' + l);
