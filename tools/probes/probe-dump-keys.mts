// 看 `vm.dump(错误对象)` 到底给了什么键（决定能不能拿到 QuickJS 的 stack）
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SPC_AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-dump-audit-'));
const { buildHostApi } = await import(fileUrl(REPO_ROOT + '/core/hostApi.ts'));
const { createSandbox } = await import(fileUrl(REPO_ROOT + '/core/sandbox.ts'));

const DIR = mkdtempSync(join(tmpdir(), 'spc-dump-'));
const api = buildHostApi({ pluginId: '@dump/x', dataDir: DIR });
const sandbox = await createSandbox(api, {
  pluginId: '@dump/x',
  permissions: [],
  facts: { version: { code: 1, name: 'dump' }, dataDir: DIR, manifest: {}, config: {} },
});

// 用一个**自己抛**的错误，看 classifyVmFailure 能看到什么（错误里带 stack 的形态）
const CASES: Record<string, string> = {
  'throw-error': `export function init() { throw new Error('boom'); }`,
  'assign-missing': `export function init() { const o = {}; o.x = 1; const p = Object.create(null); p.y = 2; }`,
  'ns-assign': `import * as fs from 'node:fs'; export function init() { fs.readFileSync = 1; }`,
  'proto-accessor': `export function init() { const base = {}; Object.defineProperty(base, 'k', { get: () => 1 }); const child = { __proto__: base }; child.k = 2; }`,
  'define-nonwritable': `export function init() { const o = {}; Object.defineProperty(o, 'k', { value: 1, writable: false }); o.k = 2; }`,
  // ★ 假设验证：**graceful-fs 的 clone() 形态**——命名空间做原型，再把命名空间的每个属性
  // 用同样的描述符定义成**自有**属性（getter-only！），然后 `fs.gracefulify = patch`。
  'clone-then-assign-new': `
import * as fs from 'node:fs';
export function init() {
  const copy = { __proto__: Object.getPrototypeOf(fs) };
  for (const k of Object.getOwnPropertyNames(fs)) {
    Object.defineProperty(copy, k, Object.getOwnPropertyDescriptor(fs, k));
  }
  copy.gracefulify = function () {};         // 全新名字（自有属性写）
  console.log('NEW OK ' + typeof copy.gracefulify);
}
`,
  'clone-then-overwrite-accessor': `
import * as fs from 'node:fs';
import { REPO_ROOT, fileUrl } from '../paths.mjs';
export function init() {
  const copy = { __proto__: Object.getPrototypeOf(fs) };
  for (const k of Object.getOwnPropertyNames(fs)) {
    Object.defineProperty(copy, k, Object.getOwnPropertyDescriptor(fs, k));
  }
  copy.readFileSync = function () {};        // 覆盖一个 getter-only 的**自有**属性
  console.log('OVERWRITE OK');
}
`,
  'clone-proto-is-namespace': `
import * as fs from 'node:fs';
export function init() {
  const copy = { __proto__: fs };            // 命名空间**直接**做原型
  copy.gracefulify = function () {};
  console.log('PROTO-NS OK ' + typeof copy.gracefulify + ' / ' + typeof copy.readFileSync);
}
`,
  'plain-object-overwrite': `
export function init() {
  const o = {};
  Object.defineProperty(o, 'k', { get: () => 1, enumerable: true, configurable: true });
  o.k = 2;
  console.log('PLAIN OVERWRITE OK');
}
`,
  'quickjs-locate-missing': `export function init() { const o = {}; o.missing = 1; }`,
};

for (const [name, code] of Object.entries(CASES)) {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  let err = '';
  try {
    await sandbox.runModule(`@dump/${name}`, code);
    await sandbox.callHook('init', 3000);
  } catch (e: any) {
    err = `${e?.code} | ${JSON.stringify(e?.params ?? e?.message)}`;
  } finally {
    console.log = orig;
  }
  orig(`--- ${name}: ${err ? 'FAIL ' + err : 'ok ' + logs.join(' | ')}`);
}
sandbox.dispose();
