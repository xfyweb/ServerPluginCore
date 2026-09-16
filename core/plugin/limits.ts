// 四层限额装配 + job 泵（docs/plugin-lifecycle-design.md §4）
//
// 为什么单列一个文件：这四条防线是"插件不能拖垮核心"的全部依据，且都是纯逻辑
// （装配 + deadline + 泵循环），可独立单测，不必起沙箱。
//
// QuickJS 语义（本地 C 源码 `D:\git-repo\quickjs` 核实，非推测）：
//   · 中断轮询：`js_poll_interrupts()` 计数器初值 `JS_INTERRUPT_COUNTER_INIT = 10000`（quickjs.c:512），
//     解释器主循环每个 opcode/跳转都轮询（quickjs.c:18824-18917），函数调用入口也轮询（quickjs.c:17787）；
//   · **中断异常不可捕获**：`JS_ThrowInterrupted()` = InternalError("interrupted") +
//     `JS_SetUncatchableException(ctx, TRUE)`（quickjs.c:7858-7862）；catch 展开时看到
//     `current_exception_is_uncatchable` 就跳过 CATCH 分支（quickjs.c:20670）→ 插件 try/catch 吞不掉超时；
//     该标志在下一次 `JS_Throw` 时复位（quickjs.c:7360），不会污染后续异常；
//   · **job 泵也被中断覆盖**：`JS_ExecutePendingJob`（quickjs.c:2303）直接调 `job_func`（异步续体），
//     走的还是解释器 → 无限微任务链同样会被 deadline 打断，不会把核心挂死；
//   · 内存超限：分配返回 NULL → `JS_ThrowOutOfMemory` → InternalError("out of memory")（quickjs.c:2160/7778-7787），
//     **可捕获**（未设 uncatchable）——所以只能按 message 归类，插件吞掉它也不会突破上限（分配照样失败）；
//   · 栈超限：`JS_ThrowStackOverflow` → InternalError("stack overflow")（quickjs.c:7789-7792）。
//
// 三者都表现为 InternalError + 不同的 message，因此宿主侧归类就是"看 name + message"。
import { isFail, type QuickJSRuntime } from 'quickjs-emscripten';
import type { PluginLimits } from '../config';

/**
 * 会被计时的阶段。
 * `load` = **模块求值**（`runModule`），`timer` = 定时器回调（见 hostApi 的 timers.every）。
 * load 与 init 单列：顶层代码同样是插件代码，不能借 init 的预算。
 */
export type HookName = 'load' | 'init' | 'start' | 'stop' | 'timer';

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
 * 比每次调用 `setInterruptHandler` 更省事，也不会出现"忘了摘掉"的悬挂 handler：
 * deadline = Infinity 时永不触发。
 */
export function installDeadlineHandler(runtime: QuickJSRuntime): { setDeadline(ms: number): void } {
  const state = { deadline: Number.POSITIVE_INFINITY };
  runtime.setInterruptHandler(() => Date.now() > state.deadline);
  return {
    setDeadline(ms: number) {
      state.deadline = ms;
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
      return limits.timerTimeoutMs;
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
  return { kind: 'error', code: 'PLUGIN_ERROR', message };
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
