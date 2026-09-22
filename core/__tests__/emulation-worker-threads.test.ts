// node:worker_threads 仿真的测试（**事实面**，不是线程能力）
//
// 这个模块的验收标准不是"覆盖 Node 的 API"，而是两句话：
//   1. 三个事实（threadId/isMainThread/workerData）在**主线程**这个语境下与基线一致
//      —— 依据是 `write-file-atomic` 那类包在装载时就读它来决定临时文件名后缀；
//   2. 其余全部**响亮抛错**——静默给个空壳会让依赖卡死在"等一条永不到来的消息"上。
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-wt-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;
after(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

const { buildHostApi } = await import('../../core/hostApi.ts');
const { buildEnvFacts } = await import('../../core/emulated-env.ts');

const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-shims-wt-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
copyFileSync(
  join(process.cwd(), 'core', 'sandbox-modules', 'node-worker_threads.js'),
  join(SHIM_DIR, 'node-worker_threads.js'),
);
after(() => rmSync(SHIM_DIR, { recursive: true, force: true }));

const DATA_DIR = mkdtempSync(join(tmpdir(), 'spc-wt-data-'));
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

(globalThis as any).__spcEnv = JSON.stringify(buildEnvFacts(DATA_DIR));
const wt = await import(pathToFileURL(join(SHIM_DIR, 'node-worker_threads.js')).href);

/** 事实面：与"主线程"这个语境一致（真值取自官方 node **v22.22.1** 的实跑——那个发行版就是判卷人） */
describe('仿真 node:worker_threads —— 事实面', () => {
  it('threadId/isMainThread/workerData/parentPort 与基线主线程一致', () => {
    assert.equal(wt.threadId, 0);
    assert.equal(wt.isMainThread, true);
    assert.equal(wt.workerData, null);
    assert.equal(wt.parentPort, null);
    assert.equal(wt.default.threadId, 0);
    assert.equal(wt.default.isMainThread, true);
  });

  it('SHARE_ENV 是 `nodejs.worker_threads.SHARE_ENV` 这个著名 Symbol', () => {
    assert.equal(typeof wt.SHARE_ENV, 'symbol');
    assert.equal(Symbol.keyFor(wt.SHARE_ENV), 'nodejs.worker_threads.SHARE_ENV');
  });

  it('`write-file-atomic` 的装载探测写法在这里成立（不抛错、给得出 0）', () => {
    // 它就是 `require('worker_threads').threadId`（整段包在 try/catch 里，取不到回退 0）——
    // 这条断言把这个模块的**存在理由**钉在测试里：写错了用例会红。
    const id = wt.threadId || 0;
    assert.equal(Number.isInteger(id) && id >= 0, true);
  });
});

describe('仿真 node:worker_threads —— 线程能力一律响亮抛错', () => {
  const NAMES = [
    'Worker', 'MessageChannel', 'MessagePort', 'BroadcastChannel', 'receiveMessageOnPort',
    'setEnvironmentData', 'getEnvironmentData', 'markAsUntransferable', 'markAsUncloneable',
  ];

  it('名字都存在（特性探测不会因为沙箱走另一条路），但一用就抛错', () => {
    for (const name of NAMES) {
      assert.equal(typeof (wt as any)[name], 'function', `${name} 应当是函数（不是 undefined）`);
      assert.throws(
        () => (wt as any)[name](),
        (err: any) => err.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
        `${name} 应当明确抛错`,
      );
      assert.equal((wt as any)[name].name, name, `${name} 的函数名要能在栈里认出来`);
    }
  });
});

// ──────────────────────────── 真沙箱冒烟 ────────────────────────────

describe('仿真 node:worker_threads —— 真实 QuickJS 沙箱里跑通', async () => {
  const { createSandbox } = await import('../../core/sandbox.ts');
  const SMOKE_DIR = mkdtempSync(join(tmpdir(), 'spc-smoke-wt-'));
  after(() => rmSync(SMOKE_DIR, { recursive: true, force: true }));

  async function runInSandbox(code: string): Promise<string> {
    const api = buildHostApi({ pluginId: '@spc-test/wt', dataDir: SMOKE_DIR });
    const sandbox = await createSandbox(api, {
      pluginId: '@spc-test/wt',
      permissions: [],
      facts: { version: { code: 1, name: 'test' }, dataDir: SMOKE_DIR, manifest: {}, config: {} },
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule('@spc-test/wt', code);
      await sandbox.callHook('init', 5_000);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    return logs.join('\n');
  }

  it('事实三个字段读得到，`new Worker` 给的是明确错误（不需要任何权限）', async () => {
    const out = await runInSandbox(
      `
import wt, { threadId, isMainThread, workerData } from 'node:worker_threads';
export function init() {
  console.log('FACTS ' + threadId + '/' + isMainThread + '/' + workerData);
  console.log('NS ' + wt.threadId + '/' + (wt.parentPort === null));
  try { new wt.Worker('x.js'); } catch (e) { console.log('WORKER ' + e.code); }
}
`,
    );
    assert.deepEqual(out.split('\n'), ['FACTS 0/true/null', 'NS 0/true', 'WORKER ERR_NOT_SUPPORTED_IN_SANDBOX']);
  });
});
