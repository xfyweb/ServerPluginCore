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
import type { HostApi, SandboxBridge } from '../sandbox';

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

// ---- S-2：宿主阻塞期间的限额 ----

/**
 * 合成宿主方法：同步忙等（模拟 `spawnSync`）。
 * 这是 CPU deadline 的**盲区**：插件一进宿主方法，解释器就停了，中断处理器一次都不会被调用
 * —— 预算到期了也没人查。修复前实测：1 秒预算 + 阻塞式 exec = 40777ms，且被记成**成功**。
 *
 * 合成方法也必须挂一个已授予的权限点：桥对"没有权限点"的方法一律 PERMISSION_DENIED
 * （`fs.write.data` 就是 OPTIONS 里已授予的那个，这里借它过闸，不涉及真实文件操作）。
 */
function blockingApi(): HostApi {
  return {
    'test.block': {
      permission: 'fs.write.data',
      fn: () => {
        const t = Date.now();
        while (Date.now() - t < 400) {
          /* 忙等：占用宿主事件循环 */
        }
        return 'ok';
      },
    },
  };
}

test('**宿主阻塞期间的限额**：超预算的成功被报成 PLUGIN_INIT_TIMEOUT（S-2 回归）', async () => {
  const sandbox = await createSandbox(blockingApi(), {
    ...OPTIONS,
    limits: { ...DEFAULT_LIMITS, initTimeoutMs: 100 },
  });
  await sandbox.runModule(
    '@xfy2412/sandbox-test',
    `
import { test } from '@host/api';
export function init() { test.block(); }
`,
  );
  await assert.rejects(
    () => sandbox.callHook('init', 100),
    (err: unknown) => {
      assert.ok(err instanceof SpcError);
      assert.equal(err.code, 'PLUGIN_INIT_TIMEOUT');
      // `overrunMs` 只有**墙钟事后校验**那条路径才带：阻塞期间解释器没跑，
      // 中断那条路径不可能触发 —— 它出现就证明兜底判定生效了（而不是碰巧被中断）。
      assert.ok(Number(err.params.overrunMs) >= 290, `overrunMs=${err.params.overrunMs}`);
      return true;
    },
  );
  assert.doesNotThrow(() => sandbox.dispose());
});

test('**装载期也一样**：顶层代码里的宿主阻塞 → PLUGIN_LOAD_TIMEOUT（S-2 回归）', async () => {
  const sandbox = await createSandbox(blockingApi(), {
    ...OPTIONS,
    limits: { ...DEFAULT_LIMITS, loadTimeoutMs: 100 },
  });
  await assert.rejects(
    () =>
      sandbox.runModule(
        '@xfy2412/sandbox-test',
        `
import { test } from '@host/api';
test.block();
`,
      ),
    (err: unknown) => {
      assert.ok(err instanceof SpcError);
      assert.equal(err.code, 'PLUGIN_LOAD_TIMEOUT');
      assert.equal(err.params.hook, 'load');
      assert.ok(Number(err.params.overrunMs) >= 290, `overrunMs=${err.params.overrunMs}`);
      return true;
    },
  );
  assert.doesNotThrow(() => sandbox.dispose());
});

// ---- S-4：宿主资源的计量（定时器数量） ----

test('timers 有同时存活上限，且 clear 立即释放名额（S-4 回归）', async () => {
  const { buildHostApi } = await import('../hostApi.ts');
  const bridge: SandboxBridge = {};
  const dataDir = mkdtempSync(join(tmpdir(), 'spc-timers-'));
  const api = buildHostApi({ pluginId: '@xfy2412/sandbox-test', dataDir, bridge });
  const sandbox = await createSandbox(api, {
    pluginId: '@xfy2412/sandbox-test',
    permissions: ['timers.schedule'],
    grants: ['timers.schedule'],
    bridge,
    limits: { ...DEFAULT_LIMITS, maxTimers: 3 },
  });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
import { timers } from '@host/api';
let made = 0;
let code = 'none';
const ids = [];
for (let i = 0; i < 5; i++) {
  try { ids.push(timers.every(1000, () => {}).timerId); made++; }
  catch (e) { code = e.code; break; }
}
console.log('MADE ' + made + ' CODE ' + code);
// clear 掉一个 → 名额必须立刻回收（计"活着的"，不是累计创建数）
timers.clear(ids[0]);
const again = timers.every(1000, () => {});
console.log('AFTER-CLEAR ' + (again.timerId ? 'ok' : 'no'));
`,
    );
  } finally {
    console.log = origLog;
    sandbox.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
  const out = logs.join('\n');
  assert.match(out, /MADE 3 CODE TIMER_LIMIT_EXCEEDED/);
  assert.match(out, /AFTER-CLEAR ok/);
});

test('**预算穿透**：钩子里的宿主方法能看到剩余预算（exec 靠它给 spawnSync 封顶）', async () => {
  const bridge: SandboxBridge = {};
  const seen: number[] = [];
  const api: HostApi = {
    'test.remaining': {
      permission: 'fs.write.data',
      fn: () => {
        seen.push(bridge.remainingMs!());
        return 'ok';
      },
    },
  };
  const sandbox = await createSandbox(api, {
    ...OPTIONS,
    bridge,
    limits: { ...DEFAULT_LIMITS, initTimeoutMs: 1_000 },
  });
  await sandbox.runModule(
    '@xfy2412/sandbox-test',
    `
import { test } from '@host/api';
export function init() { test.remaining(); }
`,
  );
  await sandbox.callHook('init', 1_000);
  assert.equal(seen.length, 1);
  const left = seen[0];
  // 必须为正（0/负数会让调用方按"还有很久"处理或直接抛 ERR_OUT_OF_RANGE）
  assert.ok(left > 0 && left <= 1_000, `remainingMs=${left}`);
  sandbox.dispose();
});
