// 四层限额装配 + job 泵（docs/plugin-lifecycle-design.md §4）
//
// 为什么单列一个文件：这四条防线是"插件不能拖垮核心"的全部依据，且都是纯逻辑
// （装配 + deadline + 泵循环），可独立单测，不必起沙箱。
//
// QuickJS 语义（**核实的是我们发行的那份引擎** `vendor/quickjs/quickjs.c`，非推测；
// ⚠️ **不是**上游那个独立的 `quickjs/` 克隆——两者行号相差数百行；基准见仓库根 `AGENTS.md` §3.1）：
//   · 中断轮询：`js_poll_interrupts()` 计数器初值 `JS_INTERRUPT_COUNTER_INIT = 10000`（`vendor/quickjs/quickjs.c:445`），
//     解释器主循环每个 opcode/跳转都轮询（`vendor/quickjs/quickjs.c:18430-18523`），函数调用入口也轮询（`vendor/quickjs/quickjs.c:17393`）；
//   · **中断异常不可捕获**：`JS_ThrowInterrupted()` = InternalError("interrupted") +
//     `JS_SetUncatchableException(ctx, TRUE)`（`vendor/quickjs/quickjs.c:7442-7446`）；catch 展开时看到
//     `current_exception_is_uncatchable` 就跳过 CATCH 分支（`vendor/quickjs/quickjs.c:20086`）→ 插件 try/catch 吞不掉超时；
//     该标志在下一次 `JS_Throw` 时复位（`vendor/quickjs/quickjs.c:6944`），不会污染后续异常；
//   · **job 泵也被中断覆盖**：`JS_ExecutePendingJob`（`vendor/quickjs/quickjs.c:1875`）直接调 `job_func`（异步续体），
//     走的还是解释器 → 无限微任务链同样会被 deadline 打断，不会把核心挂死；
//   · 内存超限：分配返回 NULL → `JS_ThrowOutOfMemory` → InternalError("out of memory")（`vendor/quickjs/quickjs.c:1741`/`:1221-1230`），
//     **可捕获**（未设 uncatchable）——所以只能按 message 归类，插件吞掉它也不会突破上限（分配照样失败）；
//   · 栈超限：`JS_ThrowStackOverflow` → InternalError("stack overflow")（`vendor/quickjs/quickjs.c:7373-7376`）。
//
// 三者都表现为 InternalError + 不同的 message，因此宿主侧归类就是"看 name + message"。
import { isFail, type ExecutePendingJobsResult, type QuickJSRuntime } from 'quickjs-emscripten';
import type { PluginLimits } from '../config';

/**
 * 会被计时的阶段。
 * `load` = **模块求值**（`runModule`），`timer` = 定时器回调，`watch` = 文件监视回调
 * （见 hostApi 的 `timers.every` 与 `fs.watchOpen`）。
 * load 与 init 单列：顶层代码同样是插件代码，不能借 init 的预算。
 *
 * `watch` 与 `timer` **共用同一个限额**（`timerTimeoutMs`）但**各有各的错误码**：
 * 两者是同一类东西（无人值守的回调阶段），没必要多一个配置旋钮；
 * 而排障时必须分得开——"定时器超时"与"文件监视回调超时"是两条完全不同的线索。
 *
 * `call` = **跨插件调用的被调方阶段**（`plugins.call` 落在对端 VM 里的那次执行）：
 * 它有独立的限额，因为它既不是"插件自己的钩子"（不能占用 init/start 的额度），
 * 也不该白拿调用方剩下的全部预算——调用方的阶段预算是**硬顶**（见 manager 的投递链）。
 */
export type HookName = 'load' | 'init' | 'start' | 'stop' | 'timer' | 'watch' | 'call';

/** VM 侧失败的归类：限额命中 vs 插件自己的错误 */
export interface VmFailure {
  kind: 'interrupt' | 'memory' | 'stack' | 'error';
  /** kind=error 时的英文码（宿主错误码原样透出，未分类记 PLUGIN_ERROR） */
  code?: string;
  params?: Record<string, string>;
  message: string;
}

/** 装配 CPU 之外的硬限额（CPU 用 interrupt handler，见 installDeadlineHandler） */
export function applyLimits(
  runtime: QuickJSRuntime,
  limits: { memoryBytes: number; maxStackBytes: number },
): void {
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.maxStackBytes);
}

/**
 * 装一个"读当前 deadline"的中断处理器，只装一次。
 * deadline = Infinity 时永不触发。
 *
 * `remainingMs()` 是给**宿主方法**用的（见 sandbox 的 `SandboxBridge.remainingMs`）：
 * 中断处理器只能在解释器跑 opcode 时打断它，**拦不住宿主方法里的同步阻塞**
 * （`spawnSync` 实测：1 秒预算的钩子里阻塞了 40.7 秒，解释器全程没在跑）。
 * 所以宿主方法必须能问"这个阶段还剩多少预算"，再给**自己的**超时封顶。
 */
export function installDeadlineHandler(runtime: QuickJSRuntime): {
  setDeadline(ms: number): void;
  remainingMs(): number;
} {
  const state = { deadline: Number.POSITIVE_INFINITY };
  runtime.setInterruptHandler(() => Date.now() > state.deadline);
  return {
    setDeadline(ms: number) {
      state.deadline = ms;
    },
    remainingMs() {
      if (state.deadline === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
      // 夹到 0：已经超时时不能返回负数（调用方会把它当"还有很久"，符号反了就是 fail-open）
      return Math.max(0, state.deadline - Date.now());
    },
  };
}

export function timeoutMsFor(hook: HookName, limits: PluginLimits): number {
  switch (hook) {
    case 'load':
      return limits.loadTimeoutMs;
    case 'init':
      return limits.initTimeoutMs;
    case 'start':
      return limits.startTimeoutMs;
    case 'stop':
      return limits.stopTimeoutMs;
    case 'timer':
    case 'watch':
      return limits.timerTimeoutMs;
    case 'call':
      return limits.callTimeoutMs;
  }
}

/** 阶段超时码（契约：只增不改；见 plugin-lifecycle-design §5 错误码表） */
export function timeoutCodeFor(hook: HookName): string {
  switch (hook) {
    case 'load':
      return 'PLUGIN_LOAD_TIMEOUT';
    case 'init':
      return 'PLUGIN_INIT_TIMEOUT';
    case 'start':
      return 'PLUGIN_START_TIMEOUT';
    case 'stop':
      return 'PLUGIN_STOP_TIMEOUT';
    case 'timer':
      return 'PLUGIN_TIMER_TIMEOUT';
    case 'watch':
      return 'PLUGIN_WATCH_TIMEOUT';
    case 'call':
      return 'PLUGIN_CALL_TIMEOUT';
  }
}

/** 阶段失败码（非限额原因） */
export function failureCodeFor(hook: HookName): string {
  switch (hook) {
    case 'load':
      return 'PLUGIN_LOAD_FAILED';
    case 'init':
      return 'PLUGIN_INIT_FAILED';
    case 'start':
      return 'PLUGIN_START_FAILED';
    case 'stop':
      return 'PLUGIN_STOP_FAILED';
    case 'timer':
      return 'PLUGIN_TIMER_FAILED';
    case 'watch':
      return 'PLUGIN_WATCH_FAILED';
    case 'call':
      return 'PLUGIN_CALL_FAILED';
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

/**
 * 把 VM 里 dump 出来的错误值归类。
 * - 宿主错误信封在沙箱内被还原成带 `code` 的 Error → 原样透出该码；
 * - InternalError 的三个 message 分别对应 中断 / 内存 / 栈；
 * - 其余一律 PLUGIN_ERROR（细节只在 message 里，审计只记码）。
 */
export function classifyVmFailure(dumped: unknown): VmFailure {
  if (typeof dumped === 'string') {
    return { kind: 'error', code: 'PLUGIN_ERROR', message: dumped };
  }
  const obj = (dumped && typeof dumped === 'object' ? dumped : {}) as Record<string, unknown>;
  const name = str(obj.name);
  const message = str(obj.message) || JSON.stringify(dumped ?? null);

  // 宿主错误信封（host-api.js 的 __wrap 还原）：带 code，原样透出
  if (typeof obj.code === 'string' && obj.code.length > 0) {
    return {
      kind: 'error',
      code: obj.code,
      params: (obj.params && typeof obj.params === 'object'
        ? (obj.params as Record<string, string>)
        : undefined),
      message,
    };
  }

  if (name === 'InternalError' || name === 'Error') {
    if (message === 'interrupted') return { kind: 'interrupt', message };
    if (message === 'out of memory') return { kind: 'memory', message };
    if (message === 'stack overflow') return { kind: 'stack', message };
  }
  // **QuickJS 侧的栈**：没有它，"插件装载失败：no setter for property"这类消息等于没有信息
  // —— 定位不到是哪一行（本轮为了查 graceful-fs 的装载失败，绕了四五次探针才发现是这里丢了栈）。
  // 截断到 1200 字：栈只是诊断线索，不该把它整个塞进错误信封与审计记录。
  const stack = str(obj.stack);
  return {
    kind: 'error',
    code: 'PLUGIN_ERROR',
    message,
    ...(stack ? { params: { stack: stack.slice(0, 1200) } } : {}),
  };
}

/** 泵 job 的结果 */
export type PumpOutcome =
  | { status: 'drained' }
  | { status: 'pending' } // deadline 到点仍有未回收任务 → PLUGIN_JOB_PENDING
  | { status: 'failed'; failure: VmFailure };

/** 每次 executePendingJobs 最多跑多少个 job（保持 deadline 响应性；队列没空就再来一轮） */
const JOB_BATCH = 1000;

/**
 * 泵 QuickJS 的 job 队列（async 钩子的续体在这里执行）。
 * 未泵完就超时**不是**错误分类的依据——调用方据此报 PLUGIN_JOB_PENDING（§4.4）。
 */
export function pumpJobs(runtime: QuickJSRuntime, deadline: number): PumpOutcome {
  while (runtime.hasPendingJob()) {
    if (Date.now() > deadline) return { status: 'pending' };
    const res = runtime.executePendingJobs(JOB_BATCH);
    if (isFail(res)) {
      let dumped: unknown;
      try {
        dumped = res.error.context.dump(res.error);
      } catch {
        dumped = undefined;
      } finally {
        res.error.dispose();
      }
      return { status: 'failed', failure: classifyVmFailure(dumped) };
    }
  }
  return { status: 'drained' };
}

/**
 * 运行时**确实有**、但上游类型声明（`quickjs-emscripten-core/dist/index.d.mts`）里还没有的那条入口：
 * `patches/quickjs-emscripten-core.patch` 只补了 dist 的 JS 正文，d.ts 没跟着生成。
 * 按"最小必要面"自己声明一次——类型落后于运行时，不等于运行时没有（这条路径由
 * `core/__tests__/sandbox.test.ts` 的"连续 await 两次 async 宿主方法"用例钉住）。
 */
interface AsyncJobPump {
  executePendingJobsAsync(maxJobsToExecute?: number): Promise<ExecutePendingJobsResult>;
}

/**
 * 泵 QuickJS 的 job 队列，**可挂起版**：用 `executePendingJobsAsync()` 驱动。钩子/装载两条路径都用它。
 *
 * 为什么非它不可（**实测**，不是推理）：宿主方法声明 `async: true` 时，guest 那次调用会在 asyncify 里
 * **挂起**（WASM 栈 unwind，等宿主 Promise 落地）。同步的 `executePendingJobs()` 走的是 Emscripten 的
 * 非 async 入口，**驱动不了挂起**——实测现象：钩子既不返回、也拿不到值，并且沙箱在 dispose 时命中
 * `JS_FreeRuntime` 的 `assert(list_empty(&rt->gc_obj_list))`（`vendor/quickjs/quickjs.c:2036`）直接 Abort。
 *
 * ⚠️ 循环条件必须与同步版一致：**队列空时一次都不许调**。实测（不是推理）：本仓库 patch 过的
 * `executePendingJobsAsync()` 少同步版开头那道 `ctxPtr === 0` 短路 —— 队列为空时 `ctxPtr` 是 0，
 * 它会走 `contextMap.get(0) ?? newContext({ contextPointer: 0 })`，而 0 是 falsy ⇒ **真造一个
 * 永不释放的新 context**（实测：同文件里那些跟异步毫无关系的用例，dispose 时统统命中
 * `JS_FreeRuntime` 的 `assert(list_empty(&rt->gc_obj_list))` 而 Abort）。所以"驱动挂起"这件事
 * 必须发生在**某个 job 内部**（钩子就是在 job 里被调起的，见 `core/sandbox.ts` 的 `__spcInvoke`），
 * 而不是靠"空队列也去戳一下"。
 *
 * 限额语义与同步版一致（deadline 到点报 pending，由调用方转 PLUGIN_JOB_PENDING）。但要说清一条**盲区**：
 * 挂起等宿主 Promise 时 `await` 让 deadline 管不着——那段时间解释器根本没在跑（与宿主里 `spawnSync`
 * 阻塞同源）。这条由调用方的**墙钟事后校验**兜住（见 `core/sandbox.ts` 的 `invoke`）。
 */
export async function pumpJobsAsync(runtime: QuickJSRuntime, deadline: number): Promise<PumpOutcome> {
  const pump = runtime as unknown as AsyncJobPump;
  // 同步版 `pumpJobs` 留着不删：它的语义（不 await、不碰挂起）在"确定不会挂起"的场合仍是正确的那条，
  // 也是这条异步版的对照实现。**当前两个调用方（钩子/定时器、装载）都用的是本函数**。
  while (runtime.hasPendingJob()) {
    if (Date.now() > deadline) return { status: 'pending' };
    const res = await pump.executePendingJobsAsync(JOB_BATCH);
    if (isFail(res)) {
      let dumped: unknown;
      try {
        dumped = res.error.context.dump(res.error);
      } catch {
        dumped = undefined;
      } finally {
        res.error.dispose();
      }
      return { status: 'failed', failure: classifyVmFailure(dumped) };
    }
  }
  return { status: 'drained' };
}
