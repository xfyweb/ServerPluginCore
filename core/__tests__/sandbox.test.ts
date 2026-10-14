// 沙箱宿主桥测试：错误信封还原、未捕获错误处理、销毁安全性、模块白名单
//
// 回归背景（两个真实缺陷）：
//   D1 插件未捕获的错误被静默吞掉（失败分支为空）→ 现在必须转成 PLUGIN_LOAD_FAILED 抛出并记账；
//   D2 失败时的 error handle 未释放 → runtime 释放命中 QuickJS 断言
//      （JS_FreeRuntime: assert(list_empty(&rt->gc_obj_list))）导致进程 Aborted；
//      因此这里显式断言 dispose() 不崩。
import type { AuditEntry } from '../audit';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostApi, SandboxBridge } from '../sandbox';

// 审计写隔离目录：AUDIT_DIR 在模块加载时读取环境变量，故必须先设再动态导入
const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-'));

/**
 * 当天的审计文件（**按天分文件**，见 `core/audit.ts` 头部）。
 *
 * ⚠️ **本地算**，不走 `core/audit`：本文件对 `stop` 之前的所有模块都是静态 import，而 `AUDIT_DIR` 的隔离
 * （`mkdtempSync` + `process.env.SPC_AUDIT_DIR`）在 import **之后**才执行 ⇒ 若从 `core/audit` 拿路径，
 * 那个模块早用默认目录加载完了，读的写的是仓库 `.spc/audit`（2026-10-14 踩过，涨了近 1 MB）。
 */
function auditFileToday(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return join(AUDIT_DIR, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`);
}
process.env.SPC_AUDIT_DIR = AUDIT_DIR;
/** 仓库根（子进程用例要按绝对路径 import TS 源码） */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

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

test('宿主方法返回 Promise ⇒ fail-closed（INTERNAL: async-host-method-not-supported）', async () => {
  // 为什么必须钉住这条：宿主方法被误写成 `async` 时，`JSON.stringify(promise)` **不报错**、给的是 `{}`，
  // 插件会**静默**收到一个空对象 —— 属"静默失败"那一类，最难查。
  // 修复前这条必红（RAW 会是 `{}`）；修复后拿到带 code/reason 的英文错误信封。
  const api: HostApi = {
    'test.async': {
      permission: 'fs.write.data', // 给一个已授予的点，确保走到"执行宿主实现"那一步
      async fn() {
        return { ok: true }; // 故意返回 Promise（模拟宿主实现失误）
      },
    },
  };
  const sandbox = await createSandbox(api, OPTIONS);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
const raw = globalThis.__host['test.async']();
console.log('RAW=' + raw);
`,
    );
  } finally {
    console.log = origLog;
    sandbox.dispose(); // 与 D2 同理：这条路径也不许在释放时命中断言
  }
  const out = logs.join('\n');
  assert.match(out, /__spcError/);
  assert.match(out, /INTERNAL/);
  assert.match(out, /async-host-method-not-supported/);
  assert.doesNotMatch(out, /RAW=\{\}/); // 旧行为：静默给空对象
});

test('钩子里连续 await 两次 async 宿主方法都拿到值（可挂起的异步 job 泵）', async () => {
  // 判别性（这条用例的**全部意义**）：宿主方法声明 `async: true` 后，guest 侧那次调用会在 asyncify 里
  // **挂起**（宿主 Promise 未落地 => WASM 栈 unwind），要接着往下跑得靠 MaybeAsync 那条入口
  // （`executePendingJobsAsync()`）做 rewind。同步 `executePendingJobs()` 驱动不了它 ⇒ 这条用例在
  // "泵还是同步" 时必红。**实测的红**：钩子拿不到值、状态停在 async，且 `dispose()` 时命中 QuickJS 的
  // GC 断言 `JS_FreeRuntime: assert(list_empty(&rt->gc_obj_list))`（`vendor/quickjs/quickjs.c:2036`）
  // 直接 Abort —— 换个说法：挂起把沙箱的宿主/guest 同步关系打断了，VM 也留在了不一致状态。
  // 为什么要**连续 await 两次**：一次只证明"挂起能落地一次"，两次才证明泵是**循环**泵到静止，
  // 而不是"等一次就收工"。
  const api: HostApi = {
    'test.slow': {
      permission: 'fs.write.data', // self/auto 档，免声明免授予，且不碰真实文件
      async: true,
      async fn() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { ok: true };
      },
    },
  };
  const sandbox = await createSandbox(api, OPTIONS);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
const H = globalThis.__host;
export async function init() {
  // 桥的协议不变：拿到的仍是 JSON 文本信封（异步只影响"桥内部怎么等"）
  const ra = await H['test.slow']();
  const rb = await H['test.slow']();
  console.log('RAW=' + ra);
  console.log('A=' + JSON.parse(ra).ok + ' B=' + JSON.parse(rb).ok);
}
`,
    );
    // 防挂死：泵等不到挂起落地时会**永久 await**（那正是判别点），所以自带超时兜底，
    // 让"红"表现为一条明确的失败，而不是把整个测试进程挂住（挂住也算证据，但要能跑出结论）。
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sandbox.callHook('init', 3_000),
        new Promise((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error('HOOK_HUNG: callHook 5s 内没返回（挂起没被驱动）')), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(guard);
    }
  } finally {
    console.log = origLog;
    sandbox.dispose();
  }
  const out = logs.join('\n');
  // ① 拿到的是**真值**、不是 `{}`：`async: true` 的通道**必须**先 await 宿主 Promise 再序列化。
  //    反例（本轮修掉的缺陷）：把 Promise 直接交给 `JSON.stringify` ⇒ 插件收到字符串 `"{}"`
  //    （而且审计还记 `result: 'ok'`）—— 静默失败，所以这里把它钉住。
  assert.match(out, /RAW=\{"ok":true\}/, `实际日志：${JSON.stringify(out)}`);
  // ② 连续两次都拿到值：一次只证明"挂起能落地一次"，两次才证明泵是**循环**泵到静止。
  assert.match(out, /A=true B=true/, `实际日志：${JSON.stringify(out)}`);
});

test('真沙箱：fs.promises.readFile 走真异步通道（挂起 + 真 I/O），同步面不受影响', async () => {
  // 为什么这条必须落在**真沙箱**里：`fs.promises.readFile` 是第一个接上"真异步"的**插件可见** API ——
  // 宿主侧 `fs.readTextAsync` / `fs.readBytesAsync` 声明了 `async: true`，guest 那次调用会在 asyncify 里
  // 挂起、靠 MaybeAsync 的 job 泵 rewind；**这条链只在真 VM 里存在**（`emulation-fs.test.ts` 的纯 Node
  // 假桥复现不出挂起，那边只验 fs/promises 的语义）。
  // 判别点（本轮实测过）：把 `fs.readTextAsync` 的 `async: true` 去掉 ⇒ 宿主调用不再挂起、guest 拿到的是
  // Promise 句柄，桥的同步守卫抛 `async-host-method-not-supported` ⇒ `readFile` 拒绝 ⇒ 这条必红；
  // 把 job 泵换回同步 `executePendingJobs` ⇒ 这里表现为 HOOK_HUNG（挂起没被驱动）。
  const { buildHostApi } = await import('../hostApi.ts');
  const bridge: SandboxBridge = {};
  const dataDir = mkdtempSync(join(tmpdir(), 'spc-async-fs-'));
  const api = buildHostApi({ pluginId: '@xfy2412/sandbox-test', dataDir, bridge });
  writeFileSync(join(dataDir, 'a.txt'), 'xy');
  const sandbox = await createSandbox(api, {
    pluginId: '@xfy2412/sandbox-test',
    permissions: ['fs.read.data'],
    grants: ['fs.read.data'],
    bridge,
  });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
import fsp from 'node:fs/promises';
import fs from 'node:fs';
export async function init() {
  const a = await fsp.readFile('a.txt', 'utf8');
  const b = await fsp.readFile('a.txt', 'utf8');
  // 不带编码 → 走二进制通道：证明 async 与 binaryResult **两条属性一起**生效
  const buf = await fsp.readFile('a.txt');
  // 失败面照旧是**拒绝**（不是抛出），syscall 照宿主真值（读不存在 = open）
  let code = 'NO-THROW';
  let syscall = '-';
  try { await fsp.readFile('nope.txt', 'utf8'); } catch (e) { code = e.code; syscall = e.syscall; }
  // 同一次调用里同步面照跑：两条通道互不干扰（同步方法**不许**被挂起机制带偏）
  const c = fs.readFileSync('a.txt', 'utf8');
  console.log('A=' + a + ' B=' + b + ' N=' + buf.length + ' S=' + (buf.toString('utf8') === 'xy') + ' C=' + c);
  console.log('ERR=' + code + '/' + syscall);
}
`,
    );
    // 防挂死：泵驱动不了挂起时会**永久 await**，那是判别点，但"红"必须是一条失败而不是挂住进程。
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sandbox.callHook('init', 3_000),
        new Promise((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error('HOOK_HUNG: callHook 5s 内没返回（真异步通道没被驱动）')), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(guard);
    }
  } finally {
    console.log = origLog;
    sandbox.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
  const out = logs.join('\n');
  // 连续两次都拿到内容（一次只证明"挂起落地一次"，两次才证明泵循环到静止），字节面与同步面同值。
  assert.match(out, /A=xy B=xy N=2 S=true C=xy/, `实际日志：${JSON.stringify(out)}`);
  assert.match(out, /ERR=ENOENT\/open/, `实际日志：${JSON.stringify(out)}`);
});

// ---- ⑤ 真异步通道的四条契约（2026-09-21，用户拍板：PLUGIN_BUSY / 延后拆 / 审计记 suspendedMs）----

test('模块名归一化：同一个 shim 只求值一次（否则跨桥回来的字节 `instanceof Buffer` 是 false）', async () => {
  // 判别点：把 `runtime.setModuleLoader(loader, normalizeModuleName)` 的第二个参数去掉 ⇒ 后两行变成
  // `DIGEST false false` / `RANDOM false` ⇒ 必红。
  // 机制（实测）：shim 之间是**相对引用**（`node-crypto.js` 里 `import { Buffer } from './node-buffer.js'`，
  // 构建层要用 esbuild 内联所以只能这么写），而插件写 `import 'node:buffer'`；QuickJS 的模块缓存键是
  // **解析后的名字** ⇒ 同一个文件以两个名字各求值一次 ⇒ **两份 Buffer 类**。后果是**静默错值**：
  // `Buffer.isBuffer(摘要结果)` 在沙箱里是 false 而 Node 是 true —— 这种差异不报错，只能靠断言钉住。
  const sandbox = await createSandbox(hostApi, OPTIONS);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
import crypto from 'node:crypto';
import { Buffer as B } from 'node:buffer';
export function init() {
  console.log('SAME=' + (B === Buffer));
  const d = crypto.createHash('sha256').update('a').digest();
  console.log('DIGEST=' + Buffer.isBuffer(d) + '/' + (d instanceof Buffer));
  console.log('RANDOM=' + Buffer.isBuffer(crypto.randomBytes(4)));
}
`,
    );
    await sandbox.callHook('init', 3_000);
  } finally {
    console.log = origLog;
    sandbox.dispose();
  }
  const out = logs.join('\n');
  assert.match(out, /SAME=true/, `实际日志：${JSON.stringify(out)}`);
  assert.match(out, /DIGEST=true\/true/, `实际日志：${JSON.stringify(out)}`);
  assert.match(out, /RANDOM=true/, `实际日志：${JSON.stringify(out)}`);
});

/** 慢宿主方法：`ms` 之后才落地（用来制造一个**真的挂起**） */
function slowApi(ms: number): HostApi {
  return {
    'test.slow': {
      permission: 'fs.write.data', // self/auto 档，免声明免授予，且不碰真实文件
      async: true,
      async fn() {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { ok: true };
      },
    },
  };
}

test('契约二：同一 VM 不许并发进 —— 阶段在飞时再调钩子 ⇒ PLUGIN_BUSY（报错，不排队）', async () => {
  // 判别点：这道守卫是本轮新加的（`callHook` 此前**根本没查 busy**）。少了它，第二个钩子会与
  // 第一个钩子叠在同一个 VM 上：两条 asyncify 挂起 + 两条 job 泵 + `deadline.setDeadline` 互相覆盖
  // （前一个钩子的预算凭空变形）。所以这里断言的是**新码 PLUGIN_BUSY**，在没有守卫的代码上必红。
  const sandbox = await createSandbox(slowApi(60), OPTIONS);
  await sandbox.runModule(
    '@xfy2412/sandbox-test',
    `export async function init() { await globalThis.__host['test.slow'](); }
     export function start() {}`,
  );
  const first = sandbox.callHook('init', 3_000);
  try {
    // 等它真的进到挂起（不靠 sleep 猜：轮询 isBusy）。⚠️ 等 5s 不是 1s：机器一忙（并发跑命令 /
    // 后台有负载）"进到挂起"这一步本身会被拖慢，1s 会变成偶发红灯（2026-09-21 追偶发失败时收紧这条）。
    for (let i = 0; i < 500 && !sandbox.isBusy(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(sandbox.isBusy(), true, '钩子应当已在执行/挂起（已等 5s）');
    await assert.rejects(
      () => sandbox.callHook('start', 3_000),
      (err: unknown) => {
        const e = err as { code?: string; params?: Record<string, string> };
        assert.equal(e.code, 'PLUGIN_BUSY');
        assert.equal(e.params?.busyWith, 'init', 'busyWith 要说明是谁在跑（排障靠它）');
        return true;
      },
    );
    await first; // 在飞的钩子照常跑完（守卫只拦后来者）
    // 挂起结束后就放行了：这不是"插件坏了"，只是时序冲突
    await sandbox.callHook('start', 3_000);
  } finally {
    sandbox.dispose();
  }
});

test('契约三：挂起期间 dispose 是"延后拆" —— 不 Abort、卸载立刻生效、拆由阶段收尾接手', async () => {
  // 判别点：`dispose()` 此前是无条件 `vm.dispose()`。挂起（asyncify unwind）期间拆 VM 等于在栈还摊开时
  // 释放运行时 ⇒ 旧行为下这条用例**实测挂死**（进程停住；不是干净的错误，也不是每次都能看到
  // `JS_FreeRuntime` 的 `assert(list_empty(&rt->gc_obj_list))` 那条 Abort）—— 所以本用例自带防挂死兜底，
  // 让"红"表现为一条可读的失败。`vendor/quickjs/quickjs.c:2036` 是那条断言的出处（行号有冻结帧）。
  const { buildHostApi } = await import('../hostApi.ts');
  const bridge: SandboxBridge = {};
  const dataDir = mkdtempSync(join(tmpdir(), 'spc-async-dispose-'));
  const api = { ...buildHostApi({ pluginId: '@xfy2412/sandbox-test', dataDir, bridge }), ...slowApi(120) };
  const sandbox = await createSandbox(api, {
    pluginId: '@xfy2412/sandbox-test',
    permissions: ['fs.write.data', 'timers.schedule'],
    grants: ['fs.write.data', 'timers.schedule'],
    bridge,
  });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  let first: Promise<void> | undefined;
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
import { timers } from '@host/api';
export async function init() {
  const t = timers.every(1000, () => {});
  console.log('TID=' + t.timerId);
  await globalThis.__host['test.slow']();
}
`,
    );
    first = sandbox.callHook('init', 3_000);
    // 同上：等 5s（不是 1s），免得机器一忙就把"还没轮到它"误判成缺陷
    for (let i = 0; i < 500 && !sandbox.isBusy(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(sandbox.isBusy(), true, '钩子应当已挂在异步宿主调用上（已等 5s）');
    const timerId = /TID=(\S+)/.exec(logs.join('\n'))?.[1];
    assert.ok(timerId, `没拿到 timerId：${logs.join('|')}`);
    // ① 卸载本身不许崩、也不许卡：立刻返回（真正拆延后）
    assert.doesNotThrow(() => sandbox.dispose());
    // ② 行为上"已经卸载了"：后续调用一律明确报错
    await assert.rejects(
      () => sandbox.callHook('start', 100),
      (err: unknown) => (err as { code?: string }).code === 'PLUGIN_DISPOSED',
    );
    // ③ 在飞的那个钩子照常收尾（挂起落地），随后拆才真正发生：宿主定时器此时才被摘掉
    //    **带防挂死兜底**：这道守卫失效时实测的表现是"进程挂死"（不是 Abort）—— 挂死会让整个
    //    `pnpm test` 一起停住、连失败都看不到，所以要把它变成一条可读的失败。
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        first,
        new Promise((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error('PHASE_HUNG: 延后拆没接上（在飞阶段没收尾）')), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(guard);
    }
    assert.equal(sandbox.isBusy(), false, '阶段应当已经收尾');
    assert.equal(bridge.timers!.clear(timerId), false, '延后拆应当在阶段收尾后摘掉宿主定时器');
    assert.doesNotThrow(() => sandbox.dispose(), 'dispose 仍然幂等');
  } finally {
    console.log = origLog;
    if (first) await first.catch(() => {});
    sandbox.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('契约四：挂起墙钟单独记账（lastSuspendedMs + 审计字段），与 durationMs 分列', async () => {
  // 为什么这条重要：挂起期间解释器没在跑（既不吃 CPU 预算、也不落中断），但 `durationMs` 里含着它。
  // 少了这个字段，事后审计看到"init 花了 40ms"时分不清"插件自己算的"与"等宿主 I/O 的"。
  const { buildHostApi } = await import('../hostApi.ts');
  const bridge: SandboxBridge = {};
  const dataDir = mkdtempSync(join(tmpdir(), 'spc-async-audit-'));
  const api = { ...buildHostApi({ pluginId: '@xfy2412/sandbox-test', dataDir, bridge }), ...slowApi(40) };
  const sandbox = await createSandbox(api, {
    pluginId: '@xfy2412/sandbox-test',
    permissions: ['fs.write.data', 'timers.schedule'],
    grants: ['fs.write.data', 'timers.schedule'],
    bridge,
  });
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
import { timers } from '@host/api';
export async function init() {
  timers.every(100, async () => { await globalThis.__host['test.slow'](); });
  await globalThis.__host['test.slow']();
}
`,
    );
    const started = Date.now();
    await sandbox.callHook('init', 3_000);
    const spent = sandbox.lastSuspendedMs();
    assert.ok(spent >= 30, `钩子里的挂起墙钟没记上（${spent}ms，宿主睡了 40ms）`);
    assert.ok(Date.now() - started >= spent - 5, '挂起墙钟不该超过阶段总时长');
    // 定时器回调那条也走同一套记账，并且要**真落进审计**（sandbox 自己写 timers.tick 条目）
    await new Promise((r) => setTimeout(r, 350));
    const ticks = readFileSync(auditFileToday(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEntry)
      .filter((e) =>
      e.method === 'timers.tick' &&
      (e.actor?.ref === '@xfy2412/sandbox-test' || e.actor?.ref?.endsWith('/@xfy2412/sandbox-test') === true),
    );
    assert.ok(ticks.length >= 1, '定时器回调没落审计');
    assert.ok(
      ticks.some((e) => typeof e.timing?.suspendedMs === 'number' && e.timing.suspendedMs >= 30),
      `timers.tick 条目没记 suspendedMs：${JSON.stringify(ticks)}`,
    );
  } finally {
    sandbox.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/**
 * 子进程脚本源码（"宿主 Promise 永不落地"的负例）。
 *
 * ⚠️ 用**数组 join** 而不是模板字面量：这段代码本身要装进字符串，而里面还有一层插件源码字符串 ——
 * 模板字面量方案一遇到反引号就提前终止，报错还指向别处（本仓库为此炸过 4 次，见 AGENTS.md §2.3）。
 */
const HANG_CHILD_SOURCE = [
  "import { pathToFileURL } from 'node:url';",
  "import { join } from 'node:path';",
  '',
  'const root = process.argv[2];',
  "const { createSandbox } = await import(pathToFileURL(join(root, 'core', 'sandbox.ts')).href);",
  '',
  'const sandbox = await createSandbox(',
  "  { 'test.never': { permission: 'fs.write.data', async: true, fn: () => new Promise(() => {}) } },",
  "  { pluginId: '@xfy2412/sandbox-test', permissions: ['fs.write.data'], grants: ['fs.write.data'] },",
  ');',
  'await sandbox.runModule(',
  "  '@xfy2412/sandbox-test',",
  '  "export async function init() { await globalThis.__host[\'test.never\'](); }",',
  ');',
  'const t0 = Date.now();',
  "let outcome = 'NO-THROW';",
  'try {',
  "  await sandbox.callHook('init', 400);",
  '} catch (err) {',
  "  outcome = err && err.code ? err.code : String(err);",
  '}',
  "console.log('OUTCOME=' + outcome + ' ELAPSED_MS=' + (Date.now() - t0));",
  'sandbox.dispose();',
  "console.log('DISPOSED-CLEAN');",
].join('\n');

test('契约一：宿主 Promise 永不落地也不挂住核心（子进程验：到点按 PLUGIN_INIT_TIMEOUT 收口）', () => {
  // 为什么必须放**子进程**：这条用例验的正是"核心会不会挂死"。真出现挂死时，进程内跑会把整个
  // `pnpm test` 一起挂住（连失败都看不到）—— 子进程 + 超时才能把"挂死"变成一条**可读的失败**。
  // 判别点：去掉 `asyncHostCall` 里那道"宿主调用受阶段预算封顶"，子进程会永久卡在
  // `await pump.executePendingJobsAsync(...)`（泵的 while 里那句 deadline 判断根本没机会再跑）。
  // **实测的红**（把预算强行设成 Infinity 跑这条）：子进程 exit **13**，
  // 原文 `Warning: Detected unsettled top-level await at ...` 后面跟着 `hang-probe.mjs` 与行号 18
  // （那是 Node 打印的**运行时消息**，句尾还带着 `await sandbox.callHook('init', 400);`）——
  // 核心挂死、Node 判定"顶层 await 永不落地"后自尽；不封顶就没有任何东西会来收这个口。
  // ⚠️ 这里刻意**不写成"文件名:行号"那种形式**：那是运行时消息的**引文**，不是指向仓库文件的引用，
  // 而 `tools/check-line-refs.mjs` 会把它当成引用去查（查不到 ⇒ 每轮体检都报一条假阳性）。
  const dir = mkdtempSync(join(tmpdir(), 'spc-async-hang-'));
  const script = join(dir, 'hang-probe.mjs');
  writeFileSync(script, HANG_CHILD_SOURCE, 'utf8');
  try {
    const res = spawnSync(process.execPath, [join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), script, REPO_ROOT], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, SPC_AUDIT_DIR: dir },
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.equal(res.error, undefined, `子进程没跑完（很可能就是挂死被 timeout 杀掉）：${out}`);
    assert.equal(res.status, 0, `子进程退出码非 0：${out}`);
    assert.match(out, /OUTCOME=PLUGIN_INIT_TIMEOUT/, `没按阶段超时收口：${out}`);
    assert.match(out, /DISPOSED-CLEAN/, `卸载路径没走干净：${out}`);
    const elapsed = Number(/ELAPSED_MS=(\d+)/.exec(out)?.[1] ?? 'NaN');
    assert.ok(elapsed >= 300, `收口太快，不像"到点收口"（${elapsed}ms）`);
    assert.ok(elapsed < 10_000, `收口太慢（${elapsed}ms）：预算只有 400ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('CJS 全局 `__filename`/`__dirname` 存在且指向沙箱内（esbuild 搬 CJS 包时要用）', async () => {
  // 为什么需要：esbuild 把 CJS 包搬进 ESM 产物时**自己**会留下对这两个标识符的引用，
  // 而包源码里没有（实测 `write-file-atomic/lib/index.js` 的临时文件名 = hash(__filename, pid, threadId, n)）。
  // 不给的话是运行期 ReferenceError，且症状只是"某个包写不了文件"。
  const sandbox = await createSandbox(hostApi, OPTIONS);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  try {
    await sandbox.runModule(
      '@xfy2412/sandbox-test',
      `
export function init() {
  console.log('FILE ' + __filename);
  console.log('DIR ' + __dirname);
  console.log('ARGV ' + process.argv.join('|'));
  console.log('TYPES ' + typeof __filename + '/' + typeof __dirname);
}
`,
    );
    await sandbox.callHook('init', 3_000);
  } finally {
    console.log = origLog;
    sandbox.dispose();
  }
  const [file, dir, argv, types] = logs;
  // 值 = 沙箱形态的路径（POSIX 形态、以数据目录为根）——**不是**宿主路径形态，也不是空串。
  // 这里用的是默认 `hostApi`（数据目录 = 进程 cwd），所以只断言形状与自洽性，不断言具体前缀。
  // ⚠️ 不断言"以 `/` 开头"：路径形态**按仿真平台**取（P2-E：win32 宿主上 `__dirname` 是 `D:\…`）；
  // 也**不能补前导 `/`**（宿主侧 `path.resolve('/C:/…')` → `<cwd>/C:/…` ⇒ validatePath 判越界）。
  const sep = process.platform === 'win32' ? '\\' : '/';
  assert.equal(types, 'TYPES string/string');
  assert.match(file, /^FILE .+plugin\.js$/);
  assert.match(dir, /^DIR .+/);
  assert.equal(argv, 'ARGV node|plugin.js');
  // `__filename` 必须是"目录 + argv[1]"这种自洽关系，否则拿它拼路径会对不上
  assert.equal(file.slice(5), dir.slice(4) + sep + 'plugin.js');
  // 路径形态与**仿真平台**一致（P2-E）：win32 上就是 `D:\…`。
  // 这条以前断言"不含反斜杠"（模型 A 时代：沙箱永远 POSIX，出现 `\` 就是宿主泄露）——
  // 模型 B 之后反斜杠是**合法**的，所以改成"分隔符必须与平台一致"（混合形态才是 bug）。
  assert.equal(file.includes(sep), true, `应当出现平台分隔符：${file}`);
  assert.equal(file.includes(sep === '\\' ? '/' : '\\'), false, `不该出现另一种分隔符（混合形态）：${file}`);
  assert.equal(file.includes('file://'), false);
});

/**
 * 合成宿主方法：`host` + `explicit` / `install` 两档的权限点（模拟未来的 `exec.template.*`）。
 *
 * 为什么要合成的：**声明这道闸只对 host 点生效**，而内置的 host 点
 * （`exec.template.git.*`）与"机器上装没装 git"有关 ⇒ 拿它写用例会随机器变红。
 * `install` 档这一档在生产注册表里**今天一个点都没有**（探针实测：17 self/auto + 7 host/explicit），
 * 而"撤回"这条路径正是修 2026-09-23 那个假成功时补上的 —— 没有合成点就测不到它。
 */
function hostPointApi(): HostApi {
  return {
    'test.hostop': {
      permission: 'test.host.gate',
      fn: () => 'ran',
      // 权限点由测试自己登记（注册表是全局的；`register` 对重复名会抛，所以这里用固定名 + 幂等）
    },
    'test.installop': {
      permission: 'test.install.gate',
      fn: () => 'ran',
    },
  };
}

/** 幂等登记一个测试用的合成点（注册表是全局的，重复注册会抛） */
async function ensurePoint(point: {
  name: string;
  scope: 'self' | 'host';
  grant: 'auto' | 'install' | 'explicit';
}): Promise<void> {
  const { registry: live } = await import('../permissions/registry');
  if (live.get(point.name)) return;
  live.register({
    name: point.name,
    group: 'test',
    description: '合成点（测试用）',
    scope: point.scope,
    grant: point.grant,
    confidentiality: 'sensitive',
    executionLevel: 'medium',
  });
}

test('host 点：**未声明 → NOT_DECLARED**；声明了但未授予 → **NOT_GRANTED**；授予后才放行', async () => {
  const { PermissionRegistry } = await import('../permissions/registry');
  const { registry: live } = await import('../permissions/registry');
  assert.ok(live instanceof PermissionRegistry);
  if (!live.get('test.host.gate')) {
    live.register({
      name: 'test.host.gate',
      group: 'test',
      description: '合成 host 点（测试用）：模拟 exec.template.* 的档位',
      scope: 'host',
      grant: 'explicit',
      confidentiality: 'sensitive',
      executionLevel: 'medium',
    });
  }

  /** 跑一次调用并回收结果/错误码 */
  async function call(permissions: string[], grants: string[]): Promise<string> {
    const sandbox = await createSandbox(hostPointApi(), {
      pluginId: '@xfy2412/sandbox-test',
      permissions,
      grants,
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule(
        '@xfy2412/sandbox-test',
        `
const H = globalThis.__host;
export function init() {
  const raw = H['test.hostop']();
  const parsed = JSON.parse(raw);
  // 信封优先：越权是 {__spcError:{code,params}}；否则就是**返回值的 JSON**
  // （桥的返回值一律是 JSON 文本，字符串返回值会是 "ran" 这种带引号的形态）
  if (parsed && typeof parsed === 'object' && parsed.__spcError) {
    const info = parsed.__spcError;
    console.log('DENY ' + info.code + '/' + (info.params ? info.params.reason : ''));
    return;
  }
  console.log('OK ' + String(parsed));
}
`,
      );
      await sandbox.callHook('init', 3_000);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    return logs.join('\n').trim();
  }

  // ① 未声明 → 声明这道闸先拦（host 资源要在安装时被看见）
  const first = await call([], []);
  assert.equal(first, 'DENY PERMISSION_DENIED/NOT_DECLARED', `实际拿到：${JSON.stringify(first)}`);
  // ② 声明了但没授予 → 授予这道闸拦（explicit 档默认拒绝）
  assert.equal(await call(['test.host.gate'], []), 'DENY PERMISSION_DENIED/NOT_GRANTED');
  // ③ 逐点授予 → 放行
  assert.equal(await call(['test.host.gate'], ['test.host.gate']), 'OK ran');
});

test('install 档：声明 + **在白名单里**才放行（与 explicit 同一条道；撤回后真的拒）', async () => {
  await ensurePoint({ name: 'test.install.gate', scope: 'host', grant: 'install' });

  /** 跑一次 `test.installop` 调用并回收结果/错误码 */
  async function call(permissions: string[], grants: string[]): Promise<string> {
    const sandbox = await createSandbox(hostPointApi(), {
      pluginId: '@xfy2412/sandbox-test',
      permissions,
      grants,
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule(
        '@xfy2412/sandbox-test',
        `
const H = globalThis.__host;
export function init() {
  const parsed = JSON.parse(H['test.installop']());
  if (parsed && typeof parsed === 'object' && parsed.__spcError) {
    console.log('DENY ' + parsed.__spcError.code + '/' + (parsed.__spcError.params ? parsed.__spcError.params.reason : ''));
    return;
  }
  console.log('OK ' + String(parsed));
}
`,
      );
      await sandbox.callHook('init', 3_000);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    return logs.join('\n').trim();
  }

  // 未声明 → 拒（install 档**要声明**）
  assert.equal(await call([], []), 'DENY PERMISSION_DENIED/NOT_DECLARED');
  // 声明了、白名单里没有 → 拒。**install 与 explicit 在这一步没有区别**：
  // install 档的那条授权是"首次安装时播种"写进 `grants` 的（`manager.seedGrants`），不是"免授予"
  assert.equal(await call(['test.install.gate'], []), 'DENY PERMISSION_DENIED/NOT_GRANTED');
  // 在白名单里 → 放行
  assert.equal(await call(['test.install.gate'], ['test.install.gate']), 'OK ran');
  // 撤回 = 移出白名单 ⇒ 真的拒（修之前 install 档撤销是空操作、而 CLI 报成功）
  assert.equal(await call(['test.install.gate'], []), 'DENY PERMISSION_DENIED/NOT_GRANTED');
});

test('白名单外的模块被拒（零环境权力的执行点）', async () => {
  const sandbox = await createSandbox(hostApi, OPTIONS);
  await assert.rejects(
    () =>
      sandbox.runModule(
        '@xfy2412/sandbox-test',
        `
import { spawn } from 'node:child_process';
`,
      ),
    (err: unknown) => {
      assert.ok(err instanceof SpcError);
      assert.equal(err.code, 'PLUGIN_LOAD_FAILED');
      // 样本要挑**设计上永不登记**的模块：这条用例已经随排期推进失效过一次
      // （`node:fs` → 第二批登记）与一次险情（`node:stream` → 第三批 P2-D 登记）。
      // `node:child_process` 属于"一律拒绝的能力面"（设计 §9/§3.1），不会再被登记。
      assert.match(err.params.message, /module not allowed: node:child_process/);
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
 * 合成方法也必须挂一个已登记的权限点（**桥对"没有权限点"的方法一律 PERMISSION_DENIED**，
 * 那条与声明/授予无关）。这里借 `fs.write.data` 过闸——它是 self/auto（v4 起免声明免授予），
 * 不涉及真实文件操作。声明这道闸只对 host 点生效，用例见下面"host 点必须申报"那条。
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
 * `queueMicrotask`，而 QuickJS **没有**这个全局（实测见 `tools/probes/quickjs-globals-probe.mjs`）。
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
