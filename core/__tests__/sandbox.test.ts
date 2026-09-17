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
import { Readable } from 'node:stream';
`,
      ),
    (err: unknown) => {
      assert.ok(err instanceof SpcError);
      assert.equal(err.code, 'PLUGIN_LOAD_FAILED');
      // `node:stream`（设计上排在第二批之后）：**未登记**才是这条用例要的样本。
      // 原来这里用 `node:fs`，第二批把它登记了，用例随排期推进自己失效了——样本要挑还没排到的模块。
      assert.match(err.params.message, /module not allowed: node:stream/);
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

// ---- P2-B：沙箱里的标准微任务（QuickJS 没有 queueMicrotask，由引导层补）----

/**
 * 为什么这条测试必须**在真沙箱里**跑：`process.nextTick` 与 `events` 的 rejection 路由都用了
 * `queueMicrotask`，而 QuickJS **没有**这个全局（实测见 `_audit/quickjs-globals-probe.mjs`）。
 * 在宿主 realm 里跑的差分测试（Node 有 queueMicrotask）**测不出**这个缺口——
 * 这正是"仿真模块的验收必须至少有一条真沙箱冒烟"的理由。
 */
test('P2-B：沙箱里有 queueMicrotask；nextTick 是异步的；captureRejections 的 rejection 真被泵到', async () => {
  const sandbox = await createSandbox(hostApi, OPTIONS);
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
import process from 'node:process';
import { EventEmitter } from 'node:events';
export function init() {
  console.log('HAS ' + typeof queueMicrotask);
  process.nextTick(() => console.log('TICK'));
  const e = new EventEmitter({ captureRejections: true });
  e.on('error', (err) => console.log('ERR ' + err.message));
  e.on('x', async () => { throw new Error('boom'); });
  e.emit('x');
  console.log('SYNC');
}
`,
    );
    await sandbox.callHook('init', 1_000);
  } finally {
    console.log = orig;
    sandbox.dispose();
  }
  assert.equal(logs[0], 'HAS function', '引导层没补上 queueMicrotask');
  // 同步输出必须排在微任务之前：微任务由钩子结束后的 job 泵驱动，不该插队到同步代码中间
  assert.ok(
    logs.includes('SYNC') && logs.includes('TICK') && logs.indexOf('SYNC') < logs.indexOf('TICK'),
    `执行顺序不对：${logs.join('|')}`,
  );
  // 这条覆盖了 events 的 addCatch：rejection 经 queueMicrotask 路由到 'error'
  assert.ok(logs.includes('ERR boom'), `captureRejections 没有把 rejection 送到 'error'：${logs.join('|')}`);
});

// ---- 装载期的微任务（TLA 续体）也必须被泵到 ----

/**
 * 回归：**装载期排在 job 队列里的续体以前会被静默丢掉**。
 *
 * `runModule` 只 `evalCodeAsync` 就返回，不泵 job 队列，于是模块顶层的 `.then()` 续体永远不执行，
 * 而 runModule 报的是**成功**（本轮写 `node:fs` 的真沙箱冒烟时踩到：`await fsp.stat(...)` 之后的行全丢）。
 * 修法：eval 成功后、deadline 复位**之前**泵一次 job 队列（泵的仍是限了额的插件代码）。
 *
 * **顶层 await（TLA）本身仍然不支持**，但现在会**明确报错**而不是静默半执行：
 * 源码层面（`quickjs.c` 的 `js_evaluate_module()`）模块求值**总是**建一个 promise，
 * QTS 的 `QTS_Eval_MaybeAsync` 只在"没有异步求值"时把它拆开交出命名空间；
 * 真 TLA 时交回来的是未落地的 promise，导出全都取不到（原来的症状是调用钩子报 `PLUGIN_NO_ENTRY`，
 * 读起来像"导出名写错了"）。要真支持得 pump 到 promise 落地再取结果值——等真实需求。
 */
test('装载期的 then 续体会被泵完；顶层 await 明确报错（不静默半执行）', async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  const sandbox = await createSandbox(hostApi, OPTIONS);
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
console.log('A');
Promise.resolve().then(() => console.log('B'));
queueMicrotask(() => console.log('C'));
export function init() { console.log('HOOK'); }
`,
    );
    assert.deepEqual(logs, ['A', 'B', 'C'], `装载期续体丢了：${logs.join('|')}`);
    await sandbox.callHook('init', 1_000);
    assert.equal(logs[3], 'HOOK');

    // 顶层 await：明确拒绝（fail-closed），并说清该怎么改
    await assert.rejects(
      () =>
        sandbox.runModule(
          '@xfy2412/sandbox-test',
          `
await Promise.resolve();
export function init() {}
`,
        ),
      (err: any) => {
        assert.equal(err.code, 'PLUGIN_LOAD_FAILED');
        assert.match(String(err.params?.message), /top-level await/);
        return true;
      },
    );
  } finally {
    console.log = orig;
    sandbox.dispose();
  }
});

// ---- C9：dispose 的幂等与"dispose 之后"的行为 ----

test('C9：dispose 幂等；dispose 之后再装载/调钩子 → 明确报错（不是崩）', async () => {
  const sandbox = await createSandbox(hostApi, OPTIONS);
  await sandbox.runModule('@xfy2412/sandbox-test', 'export function init() {}');
  assert.doesNotThrow(() => sandbox.dispose());
  // 幂等：stop 失败路径与正常卸载路径都会调到它
  assert.doesNotThrow(() => sandbox.dispose(), 'dispose 应当幂等');
  assert.equal(sandbox.isBusy(), false);
  // 卸载后再用：必须是**明确的错误码**，不能是"用了已释放的句柄"那种崩（D2 那类断言）
  await assert.rejects(
    () => sandbox.runModule('@xfy2412/sandbox-test', 'export function init() {}'),
    (err: unknown) => (err as { code?: string }).code === 'PLUGIN_DISPOSED',
  );
  await assert.rejects(
    () => sandbox.callHook('init', 100),
    (err: unknown) => (err as { code?: string }).code === 'PLUGIN_DISPOSED',
  );
});

// ---- S-4：宿主资源的计量（定时器数量） ----

test('C9：dispose 之后定时器不再触发（卸载即摘干净，不留回调）', async () => {
  const { buildHostApi } = await import('../hostApi.ts');
  const bridge: SandboxBridge = {};
  const dataDir = mkdtempSync(join(tmpdir(), 'spc-timer-dispose-'));
  const api = buildHostApi({ pluginId: '@xfy2412/sandbox-test', dataDir, bridge });
  const sandbox = await createSandbox(api, {
    pluginId: '@xfy2412/sandbox-test',
    permissions: ['timers.schedule'],
    grants: ['timers.schedule'],
    bridge,
  });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
import { timers } from '@host/api';
export function init() { console.log('ID ' + timers.every(100, () => { console.log('TICK'); }).timerId); }
`,
    );
    await sandbox.callHook('init', 1_000);
    const timerId = /ID (\S+)/.exec(logs.join('\n'))?.[1];
    assert.ok(timerId, `没拿到 timerId：${logs.join('|')}`);
    sandbox.dispose();
    // ① 宿主侧真的把定时器**摘掉了**（不是只靠 `disposed` 标志挡住回调）
    //    这条对 `dispose()` 里的 `clearInterval` 有判别力：去掉那行这里会返回 true
    assert.equal(bridge.timers!.clear(timerId), false, 'dispose 应当已经清掉宿主定时器');
    await new Promise((r) => setTimeout(r, 350)); // 至少 3 个间隔
  } finally {
    console.log = origLog;
    rmSync(dataDir, { recursive: true, force: true });
  }
  // ② 也确认没有回调漏出来（这道由 `disposed` 标志保证）
  assert.deepEqual(logs.filter((l) => l === 'TICK'), [], `卸载后仍收到定时器回调：${logs.join(',')}`);
});

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
