// 沙箱宿主桥测试：错误信封还原、未捕获错误处理、销毁安全性、模块白名单
//
// 回归背景（两个真实缺陷）：
//   D1 插件未捕获的错误被静默吞掉（失败分支为空）→ 现在必须转成 PLUGIN_LOAD_FAILED 抛出并记账；
//   D2 失败时的 error handle 未释放 → runtime 释放命中 QuickJS 断言
//      （JS_FreeRuntime: assert(list_empty(&rt->gc_obj_list))）导致进程 Aborted；
//      因此这里显式断言 dispose() 不崩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 审计写隔离目录：AUDIT_DIR 在模块加载时读取环境变量，故必须先设再动态导入
const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;

const { createSandbox } = await import('../sandbox.ts');
const { SpcError } = await import('../errors.ts');
const { hostApi } = await import('../hostApi.ts');
const { DEFAULT_LIMITS } = await import('../config.ts');

test.after(() => {
  rmSync(AUDIT_DIR, { recursive: true, force: true });
});

// P1.5：fs 的作用域是**插件数据目录**（fs.write.home 那个 spike 权限点已删除），
// 声明 + 授予的都是 fs.write.data（scope=self）；越界由路径收敛报 PATH_OUT_OF_SCOPE。
const OPTIONS = { pluginId: '@xfy2412/sandbox-test', permissions: ['fs.write.data'], grants: ['fs.write.data'] };

test('宿主错误 → 插件按 code / params 捕获（信封还原）', async () => {
  const sandbox = await createSandbox(hostApi, OPTIONS);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
import { fs } from '@host/api';
try {
  fs.write('/etc/passwd', 'x');
} catch (e) {
  console.log('CAUGHT code=' + e.code + ' path=' + (e.params && e.params.path));
}
`,
    );
  } finally {
    console.log = origLog;
    sandbox.dispose();
  }
  assert.match(logs.join('\n'), /CAUGHT code=PATH_OUT_OF_SCOPE path=\/etc\/passwd/);
});

test('插件未捕获错误 → PLUGIN_LOAD_FAILED（带 cause），且 dispose 不崩（D1/D2 回归）', async () => {
  const sandbox = await createSandbox(hostApi, OPTIONS);
  await assert.rejects(
    () =>
      sandbox.runModule(
        '@xfy2412/sandbox-test',
        `
import { fs } from '@host/api';
fs.write('/etc/passwd', 'x');
`,
      ),
    (err: unknown) => {
      assert.ok(err instanceof SpcError);
      assert.equal(err.code, 'PLUGIN_LOAD_FAILED');
      assert.equal(err.params.cause, 'PATH_OUT_OF_SCOPE');
      assert.equal(err.params.pluginId, '@xfy2412/sandbox-test');
      return true;
    },
  );
  // D2 回归：过去这里会 Aborted(Assertion failed: list_empty(&rt->gc_obj_list))
  assert.doesNotThrow(() => sandbox.dispose());
});

test('**装载期也受 CPU 限额约束**：顶层死循环 → PLUGIN_LOAD_TIMEOUT（而不是挂死核心）', async () => {
  // 回归背景：runModule 曾经是唯一**没有 deadline** 的 VM 入口 —— 顶层 `while(true)`
  // 会把宿主事件循环占死：无超时、无审计、无恢复路径（核心与其它插件一起停摆）。
  // 装载同样是插件代码，必须与钩子共用同一套限额。
  const sandbox = await createSandbox(hostApi, {
    ...OPTIONS,
    limits: { ...DEFAULT_LIMITS, loadTimeoutMs: 300 },
  });
  const started = Date.now();
  await assert.rejects(
    () => sandbox.runModule('@xfy2412/sandbox-test', 'while (true) {}'),
    (err: unknown) => {
      assert.ok(err instanceof SpcError);
      assert.equal(err.code, 'PLUGIN_LOAD_TIMEOUT');
      assert.equal(err.params.pluginId, '@xfy2412/sandbox-test');
      return true;
    },
  );
  // 旁证：确实按 loadTimeoutMs 到点，而不是拖到别的预算
  assert.ok(Date.now() - started < 3_000, '装载超时没有按 loadTimeoutMs 生效');
  assert.doesNotThrow(() => sandbox.dispose());
});

test('装载结束后 deadline 被复位（不会把后续钩子一起掐掉）', async () => {
  const sandbox = await createSandbox(hostApi, {
    ...OPTIONS,
    limits: { ...DEFAULT_LIMITS, loadTimeoutMs: 300 },
  });
  // 装载：用满一小会儿但没超时
  await sandbox.runModule(
    '@xfy2412/sandbox-test',
    'export async function init() { const t = Date.now(); while (Date.now() - t < 400) {} }',
  );
  // init 自己忙等 400ms。若装载的 deadline 没复位（仍是刚才那个 300ms 的点），
  // 这一步会**立刻**被判超时 —— 那正是"设了 deadline 却忘了复位"的典型症状。
  await sandbox.callHook('init', 3_000);
  sandbox.dispose();
});

test('白名单外的模块被拒（零环境权力的执行点）', async () => {
  const sandbox = await createSandbox(hostApi, OPTIONS);
  await assert.rejects(
    () =>
      sandbox.runModule(
        '@xfy2412/sandbox-test',
        `
import fs from 'node:fs';
`,
      ),
    (err: unknown) => {
      assert.ok(err instanceof SpcError);
      assert.equal(err.code, 'PLUGIN_LOAD_FAILED');
      assert.match(err.params.message, /module not allowed: node:fs/);
      return true;
    },
  );
  assert.doesNotThrow(() => sandbox.dispose());
});
