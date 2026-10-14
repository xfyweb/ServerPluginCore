import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import {
  isFail,
  isSuccess,
  newQuickJSAsyncWASMModule,
  Scope,
  type QuickJSAsyncContext,
  type QuickJSAsyncRuntime,
  type QuickJSHandle,
} from 'quickjs-emscripten';
import { audit as auditRaw, digest, digestParams, type AuditEntry } from './audit';
import { DEFAULT_LIMITS, type PluginLimits } from './config';
import { buildEnvFacts } from './emulated-env';
import { SpcError, toErrorShape } from './errors';
import { hostLogMethod } from './logs';
import { checkPermission } from './permissions/check';
import { pointSource } from './permissions/source';
import {
  applyLimits,
  classifyVmFailure,
  failureCodeFor,
  installDeadlineHandler,
  pumpJobsAsync,
  timeoutCodeFor,
  type HookName,
  type PumpOutcome,
  type VmFailure,
} from './plugin/limits';
import { isRegistered, isShimFileName, normalizeSpecifier, shimFileName } from './sandbox-modules/registry';

/**
 * 这个 handle 是不是 thenable？
 *
 * 用途只有一个：识别**带顶层 await（TLA）的模块**。QuickJS 的 `js_evaluate_module()`
 * （`vendor/quickjs/quickjs.c:30939`）**总是**建一个 promise 并把它交给 `JS_Eval`，而 QTS 的 `QTS_Eval_MaybeAsync`
 * 在"模块没有异步求值"时会把已落地的 promise 拆开、交出**模块命名空间**；一旦模块真的 TLA
 * （`m->async_evaluation`），交回来的就是那个未落地的 **promise**。
 * 于是：非 TLA → 命名空间对象（没有 `then`）；TLA → promise（有 `then`）。
 * 判定只看 `then` 是不是函数，拿不到就 dispose，别把 handle 漏在 Scope 里。
 */
function isThenableHandle(vm: QuickJSAsyncContext, handle: QuickJSHandle): boolean {
  if (vm.typeof(handle) !== 'object') return false;
  const then = vm.getProp(handle, 'then');
  try {
    return vm.typeof(then) === 'function';
  } finally {
    then.dispose();
  }
}

/** 沙箱对象（P1.5） */
export interface Sandbox {
  /** 加载 ESM bundle；成功后保留模块命名空间（后续钩子从这里取导出） */
  runModule(name: string, source: string): Promise<void>;
  /** 该导出是否存在且为函数（导出契约校验 / theme 豁免分支用；不抛错） */
  hasFunctionExport(name: string): boolean;
  /** 调用插件钩子 init/start/stop（CPU 中断 + job 泵 + 上下文注入） */
  callHook(name: 'init' | 'start' | 'stop', timeoutMs: number): Promise<void>;
  /**
   * 端点处理器是否存在（`exports.endpoints` 映射里有没有这个键，且是函数）。
   * 装载期用它核对"清单声明的 path ⟺ 模块里的实现"（对不上即装载失败，见 `core/plugin/loader.ts`）。
   */
  hasEndpointHandler(path: string): boolean;
  /**
   * **调用本插件的一个端点**（跨插件调用的落地端，`plugins.call` 的另一半）。
   *
   * - `paramsJson` / `bytes` 原样交给处理器（第三个参数是 `Uint8Array`，无字节时是 `undefined`）；
   * - 返回值是处理器给出的 **JSON 文本**（已确认是字符串；解析与"是不是合法 JSON"由调用方那侧判）；
   * - `callId` 只用于审计串联：本阶段**所有**条目都带上它（含处理器内部的 fs/kv 调用）。
   */
  callEndpoint(
    path: string,
    paramsJson: string,
    bytes: Uint8Array | undefined,
    timeoutMs: number,
    callId: string,
  ): Promise<string>;
  /**
   * 最近一个跑完的阶段里**等宿主 Promise 花掉的墙钟**（挂起时长）。
   *
   * 为什么要有这个取值口（而不是让 `callHook` 返回）：失败路径（超时/插件抛错）同样要记这笔账，
   * 而那条路上 `callHook` 是 reject 的 —— 返回值带不出来。审计字段见 `core/audit.ts` 的 `AuditEntry.suspendedMs`。
   */
  lastSuspendedMs(): number;
  /** 是否正在执行插件代码（定时器回调据此避让，避免重入同一 VM） */
  isBusy(): boolean;
  /**
   * 释放沙箱。**正在跑阶段时（含挂在异步宿主调用上）是"延后拆"**：先标记已释放
   * （后续调用一律 `PLUGIN_DISPOSED`），真正拆 VM 由那一阶段的收尾接手 —— 挂起期间拆 VM
   * 等于在 WASM 栈还摊开的时候释放运行时（收尾必命中 GC 断言，见 `beginPhase` 的注释）。
   */
  dispose(): void;
}

/** 宿主 API 的模块正文来自真实文件（可评审 / 可高亮 / 可单测），运行时只生成导出清单。 */
const HOST_API_SOURCE = readFileSync(new URL('./sandbox-modules/host-api.js', import.meta.url), 'utf8');
const EXPORTS_MARKER = '// __SPC_EXPORTS__';

/** Node 内建名单：只用于把"沙箱尚未支持"与"模块名写错"的报错文案区分开 */
const BUILTIN_MODULES = new Set(builtinModules);

/**
 * 由 host-api.js **自己实现**的方法组：需要 JSON 编解码（kv）、回调注册（timers）、
 * 或**二进制解包**（bytes）——导出清单生成器不再为它们产出 `__wrap` 版本，否则会重复声明标识符。
 */
const SELF_IMPLEMENTED_GROUPS = new Set(['kv', 'timers', 'bytes']);

/**
 * 返回值需要 JSON 解码的方法组：桥只有字符串，这些组的返回值是对象/数组/数字，
 * 统一在沙箱侧还原（否则插件代码里到处是 `JSON.parse(fs.read(...))`）。
 * exec 不在其列——它的返回值是带 stdout/stderr 的文本协议，由插件自己解析。
 */
const JSON_RESULT_GROUPS = new Set(['fs', 'lifecycle', 'events', 'url', 'crypto', 'zlib']);

/**
 * 沙箱内引导代码：装两个宿主可用、插件不可见的内部函数。
 * - `__spcMakeCtx`：把 ctx 事实 JSON + logger 组装成**深度冻结**的上下文对象
 *   （冻结在沙箱侧做，宿主只传 JSON——这样"只读快照"是 VM 语义保证的，不是靠约定）；
 * - `__spcInvoke`：统一同步/异步钩子的调用与错误落点。
 *   为什么要它：桥只传字符串，宿主不该去猜"返回值是不是 Promise"；
 *   让 VM 自己把结果归一化成 {status, error}，宿主只泵 job + 读状态。
 *   ⚠️ 钩子体是**排进一个 job** 再调起的（不是在这里同步调）—— 理由见函数内注释：宿主方法的
 *   async 通道要求挂起发生在"异步泵那一次 `executePendingJobsAsync()`"里面。
 */
// 正文在 `core/guest/bootstrap.js`（真文件：可评审/可高亮，且不会再有"模板字面量里写反引号"那类坑）
const BOOTSTRAP = readFileSync(new URL('./guest/bootstrap.js', import.meta.url), 'utf8');

/**
 * 沙箱里的 **Node 全局**（在 `BOOTSTRAP` 之后、任何插件代码之前求值一次）。
 *
 * 为什么用"求值一段模块"的方式装，而不是宿主侧 `vm.setProp(global, 'process', …)`：
 * 这些东西的实现在 `node-*.js` 里（仿真模块），而**宿主拿不到沙箱内的对象**——
 * 只有沙箱自己 `import` 它们才拿得到那份单例（同一份 `process`，钩子与依赖看到的是同一个）。
 *
 * `global` 是 Node 的 `globalThis` 别名（老代码常写 `global.X`）；
 * `TextEncoder`/`TextDecoder`/`URL`/`URLSearchParams` 是 Node 的**标准全局**，
 * QuickJS 一个都没有（见 `tools/probes/quickjs-globals-probe.mjs`），所以由仿真模块补上。
 */
// 正文在 `core/guest/node-globals.js`（同上；它是**模块**，所以文件里能 `import`）
const GLOBALS_PRELUDE = readFileSync(new URL('./guest/node-globals.js', import.meta.url), 'utf8');

/**
 * 宿主错误信封：宿主桥**不**用 `vm.throw`（asyncify 下宿主函数抛出的异常会随正常返回值被吞掉，
 * @experimental 路径不可靠），而是把错误当作返回值回传；模块包装层在沙箱内还原成
 * 带 `code` / `params` 的 `Error`。插件因此总能按英文码分支：
 *   catch (e) { if (e.code === 'SYMLINK_DANGLING') { … } }
 */
const HOST_ERROR_KEY = '__spcError';

function hostErrorPayload(code: string, params?: Record<string, string>): string {
  return JSON.stringify({
    [HOST_ERROR_KEY]: params && Object.keys(params).length > 0 ? { code, params } : { code },
  });
}

/** 宿主方法参数：字符串走常规通道，**字节**走二进制通道（每次跨界一次拷贝，实测非零拷贝） */
export type HostArg = string | Uint8Array;

/**
 * 把宿主实现返回的字节规整成"**恰好覆盖这些字节**"的 ArrayBuffer。
 *
 * ⚠️ **不能写 `view.slice()`**：`Buffer.prototype.slice` 是**共享内存**的（语义同 `subarray`），
 * 与 `Uint8Array.prototype.slice`（复制）不同名同义不同物。池化 Buffer（`Buffer.from` 小对象
 * 走 8KB 池）上 `slice().buffer` 仍是**整块池**——那会把同池里**属于别人的字节**一起送进沙箱。
 * 实测踩到过：沙箱收到的"5 字节"实际是 8192 字节池内容，里面混着构建工具的 source map。
 *
 * 所以这里用 `new Uint8Array(view)`：走 TypedArray 构造（复制），与 Buffer 的原型无关。
 */
function toExactBytes(result: unknown): ArrayBufferLike {
  // 声明了 `binaryResult` 就必须真的返回字节：宿主实现写错时**抛错**，
  // 不能静默退化成"零字节"——那会把一个实现缺陷变成沙箱里的垃圾数据
  // （破坏"ArrayBuffer=数据 / 字符串=错误"这条契约）。
  if (!(result instanceof Uint8Array) && !(result instanceof ArrayBuffer)) {
    throw new SpcError('INVALID_ARGS', { reason: 'binary-result-not-bytes', got: typeof result });
  }
  const view = result instanceof Uint8Array ? result : new Uint8Array(result as ArrayBufferLike);
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return new Uint8Array(view).buffer;
}

/** 宿主方法：声明所需权限点 + 实现（权限检查在宿主侧强制，D3） */
export interface HostMethod {
  /** 静态权限点 */
  permission?: string;
  /** 动态解析本次调用所需的权限点（如 exec.run 按模板 ID 解析）；返回 null 表示目标非法 */
  permissionFor?: (args: string[]) => string | null;
  /**
   * 实现。参数是字符串或**字节**（二进制通道，见 `HostArg`）。
   *
   * 这里刻意用**方法语法**而不是 `fn: (...) => ...` 属性：方法参数在 TS 里是**双变**的，
   * 于是既有那批 `(path: string, ...) => ...` 处理器不必逐个加类型收窄。
   * 实践中二进制只会流到 `binaryResult` 那类方法——`@host/api` 的 `__marshal` 只产出字符串，
   * 只有 `bytes` 组自己走二进制通道；插件若绕过包装层直接调 `__host[...]` 传字节，
   * 处理器里的路径/字符串校验会照常抛错，不会静默算错。
   */
  fn(...args: HostArg[]): unknown;
  /**
   * 返回值是**字节**：桥走 `newArrayBuffer` 而不是 JSON 信封。
   * 失败时仍回传 JSON 字符串信封——沙箱侧按「ArrayBuffer = 数据 / 字符串 = 错误」区分。
   */
  binaryResult?: boolean;
  /**
   * **参数里可能有字节**：沙箱侧的包装层改用 `__marshalBin`（视图/ArrayBuffer 走二进制通道），
   * 而不是 `__marshal`（它会把 `ArrayBuffer` **JSON 化**成 `"{}"` —— 宿主收到的就成了个字符串参数）。
   *
   * 与 `binaryResult` 对称：一个说"结果里有字节"，一个说"参数里有字节"；同样**必须声明**，
   * 因为"这个参数是不是字节"在宿主侧只看得到 `Uint8Array`，而把字节静默 JSON 化正是最难查的一类失败。
   * 结果那半边仍按原有的两条路（`binaryResult` 或 `JSON_RESULT_GROUPS` 决定解包方式）。
   */
  binaryArgs?: boolean;
  /**
   * 声明**宿主实现是异步的**（`fn` 返回 Promise）：桥为此方法注册一条**可挂起**通道——
   * guest 侧函数返回 Promise，宿主 Promise 落地后 job 队列才收到续体（`await` 因此能拿到值）。
   *
   * 为什么必须**显式声明**而不是"看返回值像不像 thenable"：宿主实现写成 async 是**笔误**还是
   * **本意**，只有声明能表达。不声明的一律 fail-closed 拒绝（见下面桥里的守卫），否则
   * `JSON.stringify(promise)` 会把笔误静默变成 `{}`（插件收到一个空对象，最难查的一类失败）。
   *
   * ⚠️ **协议不变**：声明与否只影响"桥内部怎么等"，插件看到的仍是同一套
   * 「JSON 文本信封（二进制是 ArrayBuffer）/ 错误是 `{"__spcError":…}` 字符串」。
   *
   * ⚠️ **挂起能跑完还要求调用侧的 job 泵是异步的**：钩子/装载两条路径都用
   * `pumpJobsAsync()`（`executePendingJobsAsync()`）驱动 —— 同步泵驱动不了挂起（实测：钩子既不返回
   * 也拿不到值，且 dispose 时命中 QuickJS 的 GC 断言直接 Abort）。并且**必须先创建宿主 Promise 再驱动**
   * （实测：反序永久挂住）—— 本仓库的形态天然满足：宿主 Promise 是在 guest 那次调用里创建的，
   * 泵在调用返回之后才跑。
   *
   * ⚠️ 本通道下**一个宿主调用会让 guest 挂起一次**（handler 是 async，必然返回 Promise），
   * 所以"高频小方法"声明 `async: true` 是拿性能换语义，按需声明。
   */
  async?: boolean;
}
export type HostApi = Record<string, HostMethod>;

/** 定时器宿主能力：由 sandbox 回填，hostApi 的 timers.* 转发到这里 */
export interface SandboxTimerHost {
  every(intervalMs: number, callbackId: string): { timerId: string; intervalMs: number };
  clear(timerId: string): boolean;
}

/**
 * 装载器 ↔ sandbox 的**可变桥**：hostApi 需要回调进 VM（定时器），但 VM 又需要 hostApi 才能建。
 * 用一个提前创建、创建后回填的对象打破这个环——比把所有宿主 API 都塞进 sandbox.ts 清楚得多。
 */
export interface SandboxBridge {
  timers?: SandboxTimerHost;
  /**
   * 当前阶段还剩多少 CPU 预算（毫秒）；没有阶段在跑（deadline = ∞）时返回 `Infinity`。
   *
   * 宿主方法用它给**自己的**超时封顶。为什么必须要有：CPU 中断只能打断**解释器**，
   * 插件代码一进宿主方法（`exec.run` 的 `spawnSync`）解释器就停了 —— deadline 无从触发，
   * 于是"1 秒预算的钩子"照样能把核心阻塞到模板自己的超时（最长 120 秒）。实测踩到过
   * 40.7 秒，而且当时还被记成了**成功**。有了余额，宿主方法至少能把自己压回预算内。
   */
  remainingMs?: () => number;
  /**
   * 把宿主侧"待落盘状态"（当前是 kv 的合并写）强制落盘。
   *
   * 沙箱在**阶段边界**（`invoke` / `runModule` 结束）与 `dispose()` 时调用。
   * 为什么要有这个落盘点：kv 改成合并写之后，"钩子返回时数据已落盘"不再是 set 的副作用，
   * 而重启后的读取、测试里的断言、以及"卸载前不丢数据"都依赖它。
   */
  flush?: () => void;
  /**
   * 宿主 → guest 的**通用回调投递**（hostApi 用；定时器与 `fs.watch` 一族共用这条通道）。
   *
   * 为什么要有它：宿主侧拿到"该叫插件一声"的事件（定时器到点 / 文件变了）时，**不能**直接进 VM ——
   * 只有沙箱知道现在是不是有一个阶段在飞。这条通道就是那个唯一的门：
   *   · 空闲 ⇒ 起一个自己的阶段（`kind` 就是阶段名）把回调排进 job、由 `pumpJobsAsync` 驱动；
   *   · **忙或已拆 ⇒ 返回 `false`**（不并发进同一 VM、不排队）——调用方自己决定怎么办：
   *     定时器是"下一拍还会来"所以静默跳过；`fs.watch` 是"事件已经在宿主排好队"所以退避重试。
   * 审计分别记 `timers.tick` / `watch.event`（方法名带 kind，别把两件事混进同一条日志）。
   */
  deliver?: (kind: 'timer' | 'watch', callbackId: string, targetId: string) => Promise<boolean>;
  /**
   * **强制回收宿主侧句柄**（`core/plugin/handles.ts` 的表）。沙箱在 `teardown()` 里调一次。
   *
   * 为什么句柄的收口要由沙箱来触发：表是 hostApi 的（它得在调用期解析句柄），而"卸载"这件事
   * 只有沙箱知道。插件没自己释放的真资源（当前是流式摘要的 native 状态）**不许跨生命周期活着** ——
   * 与定时器的治理同一思路（`dispose()` 里 `clearInterval` 全部摘掉）。
   */
  releaseHandles?: () => void;
  /**
   * **当前正在跑的跨插件调用 id**（没有就是 `undefined`）。hostApi 用它给出自己写的那批审计
   * （fs/kv/handles…）打上 `callId` —— 一次 A→B 的调用要能在审计里"从 B 内部串回发起方"，
   * 而 B 内部的每一条宿主调用是 hostApi 写的，不是沙箱写的。
   */
  currentCallId?: () => string | undefined;
  /**
   * 给**本次宿主调用**那条审计附几个字段（`plugins.call` 用：`callId` / `attempts` / `waitedMs`）。
   *
   * 为什么要有这个口子：审计是沙箱的包装层写的（"每个宿主调用一条"这条不变量在那一层），
   * 而重试次数、等待时长这些**只有宿主方法的实现自己知道**。让它把标签留下、由包装层合并，
   * 比在包装层里为 `plugins.call` 开一个特例清楚（也避免出现第二条描述同一次调用的日志）。
   */
  tagAudit?: (extra: { callId?: string; attempts?: number; waitedMs?: number }) => void;
}

/** 注入 ctx 的"环境事实"（能力走 @host/api，环境走 ctx，见 plugin-lifecycle-design §1.3） */
export interface SandboxFacts {
  version: { code: number; name: string };
  dataDir: string;
  /** 只读副本（自查声明用） */
  manifest: unknown;
  /** 按 configSchema 校验并补默认值后的配置 */
  config: Record<string, unknown>;
}

/** 插件沙箱上下文（来自 manifest 声明 + 安装记录的授予） */
export interface SandboxOptions {
  pluginId: string;
  /** **完整引用** `<origin>/<id>`（v4）：只用于审计消歧（身份 = `(origin, id)`，见 audit.ts 的 `ref`） */
  ref?: string;
  /** manifest.permissions 提取的权限请求（可含通配） */
  permissions: string[];
  /** 管理员授予的权限点（精确；宿主侧唯一真相，见 plugin-signature-design.md §9） */
  grants?: string[];
  /** 四层限额（缺省用 DEFAULT_LIMITS） */
  limits?: PluginLimits;
  facts?: SandboxFacts;
  /** 插件日志出口（缺省打宿主 console，带插件前缀）—— ctx.logger.* 走它 */
  logger?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** console.* 的**聚合器**出口（宿主 stdout 那份由沙箱自己打，不带前缀） */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 定时器回填桥 */
  bridge?: SandboxBridge;
}

/** 生成 @host/api 的导出清单（模块正文来自 sandbox-modules/host-api.js，按方法组分组） */
function exportLines(api: HostApi): string {
  const groups = new Map<string, string[]>();
  for (const [key, method] of Object.entries(api)) {
    const idx = key.indexOf('.');
    const g = idx === -1 ? key : key.slice(0, idx);
    if (SELF_IMPLEMENTED_GROUPS.has(g)) continue; // 该组在模块文件里自己实现
    const prop = idx === -1 ? key : key.slice(idx + 1);
    // 包装层按两条独立的轴选（2×2，四个都必须存在，否则就有一类组合被迫走错路）：
    //   结果：`binaryResult` ⇒ `__bin`（ArrayBuffer = 数据）；`JSON_RESULT_GROUPS` ⇒ JSON 解码；否则原样文本。
    //   参数：`binaryArgs` ⇒ `__marshalBin`（字节走二进制通道）；否则 `__marshal`（非字符串 JSON 化）。
    // 为什么单独有 `__rawBin`：`plugins.call` 是"参数带字节 + 结果是 JSON **文本**（由插件自己 parse，
    // 照 exec.run 的约定）"这一格 —— 没有它就只能二选一，要么字节被 JSON 化，要么结果被提前解析。
    const wrap = method.binaryResult
      ? '__bin'
      : method.binaryArgs
        ? JSON_RESULT_GROUPS.has(g)
          ? '__jsonBin'
          : '__rawBin'
        : JSON_RESULT_GROUPS.has(g)
          ? '__json'
          : '__wrap';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(`  ${prop}: ${wrap}(globalThis.__host[${JSON.stringify(key)}])`);
  }
  return [...groups.entries()]
    .map(([g, props]) => `export const ${g} = {\n${props.join(',\n')}\n};`)
    .join('\n\n');
}

/**
 * 沙箱模块白名单：specifier → 源码。未登记一律拒绝（零环境权力的执行点）。
 *
 * 两类来源：
 *   · `@host/api`——**能力面**，导出清单按本次装配的方法组动态生成（正文来自 host-api.js）；
 *   · **仿真模块**（`node:path` / `node:events` …）——正文来自 `sandbox-modules/node-*.js`，
 *     **整文件直出、不做任何替换**。这不是省事，是硬约束：它们必须能被构建层内联进插件产物
 *     （CJS 依赖里的 require 无法标记为外部，见 build-layer-evidence §3.2），
 *     所以**不能有随插件而变的占位符**。能力一律运行时从 `globalThis.__host` 取。
 */
function moduleSource(moduleName: string, api: HostApi): string | null {
  if (moduleName === '@host/api') {
    return HOST_API_SOURCE.replace(EXPORTS_MARKER, exportLines(api));
  }
  if (isRegistered(moduleName)) {
    return shimSource(normalizeSpecifier(moduleName));
  }
  // shim 之间可以互相 import（`./node-assert.js`）：构建层由 esbuild 内联（同目录相对引用）。
  // 沙箱里要注意 **QuickJS 交给我们的是解析后的名字**，不是源码里写的那个：
  // 相对 specifier 按"父模块名的目录部分"解析，而我们的模块名是**规范名**
  // （`node:assert/strict`），于是 `./node-assert.js` 会变成 `node:assert/node-assert.js`。
  // 判据因此落在**基名**上：`…/node-<名字>.js` 且该文件确实在 sandbox-modules/ ⇒ 服务它。
  // 形状判定用 registry 的 `isShimFileName`（命名约定的另一半，别在这里再写一条正则——
  // 曾经两处不一致：这里只认 `[a-z0-9-]`，而 `node-string_decoder.js` 带着下划线）。
  // 安全性：只有基名参与拼接，`..` / 绝对路径 / 带盘符的名字都拼不出 `node-*.js` 这个形状。
  const base = SHIM_BASENAME.exec(moduleName)?.[1];
  if (base !== undefined && isShimFileName(base) && shimFileExists(base)) {
    return shimSourceForFile(base);
  }
  return null;
}

/** 只从解析后的名字里取出基名（形状判定交给 `isShimFileName`，见 moduleSource 的注释） */
const SHIM_BASENAME = /(?:^|\/)([^/]+)$/;

/**
 * 模块名**归一化**：把同一个 shim 的所有叫法收敛到**同一个模块名**，否则它会被求值两次。
 *
 * 为什么必须收敛（实测，不是推理）：shim 之间是**相对引用**（`node-crypto.js` 里 `import { Buffer }
 * from './node-buffer.js'` —— 构建层要用 esbuild 内联它们，所以只能这么写），而插件写的是
 * `import 'node:buffer'`。QuickJS 的模块缓存键就是**解析后的名字**，于是同一个文件以两个名字各求值一次
 * ⇒ **两份 `Buffer` 类**。后果是静默错值：`Buffer.isBuffer(crypto.createHash(...).digest())` 在沙箱里
 * 给 **false**，而 Node 给 true（探针实测；`crypto.randomBytes` 这类跨桥回来的字节全都中招）。
 * 这类"值不对但不报错"的差异最难查，所以从加载器这一层修掉。
 *
 * 规则（只做"收敛"，不做白名单——白名单仍在 `moduleSource` 里）：
 *   ① 能认成规范名（`node:buffer` / `buffer` / `fs/promises`）⇒ 归到它的**文件名**（`node-buffer.js`）；
 *   ② 解析后名字的**基名**是个 shim 文件（`node-assert/node-assert.js` 这种相对引用解析出来的怪名字）
 *      ⇒ 同样归到那个文件名；
 *   ③ 其余原样返回（`@host/api`、插件自己的相对引用…），交给 `moduleSource` 判放行/拒绝。
 *
 * 相对引用的解析按 QuickJS 的默认规则自己算一遍（父模块名的目录部分 + 请求名）——因为一旦提供归一化器，
 * 默认解析就不再发生，得由我们补上。
 */
function normalizeModuleName(baseModuleName: string, requestedName: string): string {
  const resolved = resolveRelativeModuleName(baseModuleName, requestedName);
  const canonical = normalizeSpecifier(resolved);
  if (isRegistered(canonical)) return shimFileName(canonical);
  const base = SHIM_BASENAME.exec(resolved)?.[1];
  if (base !== undefined && isShimFileName(base) && shimFileExists(base)) return base;
  return resolved;
}

/** `./x` / `../x` 按父模块名的目录部分解析；裸名与绝对名原样（同 QuickJS 默认规则） */
function resolveRelativeModuleName(baseModuleName: string, requestedName: string): string {
  if (!requestedName.startsWith('.')) return requestedName;
  const slash = baseModuleName.lastIndexOf('/');
  const dir = slash === -1 ? '' : baseModuleName.slice(0, slash);
  const parts = (dir === '' ? [] : dir.split('/')).concat(requestedName.split('/'));
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/** sandbox-modules/ 下真实存在的文件（readdir 一次 + 缓存）：基名不能凭想象放行 */
let shimDirFiles: Set<string> | undefined;
function shimFileExists(fileName: string): boolean {
  shimDirFiles ??= new Set(readdirSync(new URL('./sandbox-modules/', import.meta.url)));
  return shimDirFiles.has(fileName);
}

/** shim 源码按需读取 + 缓存（一个模块一个真实文件，见 registry.ts 的文件名约定） */
const shimCache = new Map<string, string>();
function shimSourceForFile(fileName: string): string {
  let source = shimCache.get(fileName);
  if (source === undefined) {
    source = readFileSync(new URL(`./sandbox-modules/${fileName}`, import.meta.url), 'utf8');
    shimCache.set(fileName, source);
  }
  return source;
}

function shimSource(canonical: string): string {
  return shimSourceForFile(shimFileName(canonical));
}

/**
 * 每个沙箱**各起一份** WASM 模块实例（实测 12–41ms，5 个 runtime+eval 共 41ms，不值得复用）。
 *
 * 为什么**不能**用 memoizePromiseFactory 复用同一个模块换速度：
 * `setMaxStackSize` 在 asyncify 变体上是**整个模块的全局副作用**——上游 d.ts 原文
 * "Setting this limit also adjusts the global ASYNCIFY_STACK_SIZE for the entire
 * QuickJSAsyncWASMModule"（quickjs-emscripten-core 0.32）。
 * 复用模块 = 让"栈限额"退化成进程级且互相污染：先建的插件会被后建插件的配置改掉栈上限。
 * 一份模块一份 runtime 的代价是可接受的，而"每个插件的限额真的只作用于它自己"是设计前提（§4）。
 */
async function newRuntimeForSandbox(): Promise<QuickJSAsyncRuntime> {
  const QuickJS = await newQuickJSAsyncWASMModule();
  return QuickJS.newRuntime();
}

/** 限额命中 / 插件错误 → 带正确码的 SpcError（设计 §5 的错误码表） */
function hookError(
  pluginId: string,
  hook: HookName,
  failure: VmFailure,
  extra?: Record<string, string>,
): SpcError {
  // `message` 一定要带上：插件 `init()` 抛 ENOENT 时，只给一个 `cause: 'ENOENT'` 等于什么都没说
  // （作者既不知道哪个文件，也不知道哪一行）。它本来就是**插件自己的**错误文本，
  // 不泄露宿主额外的信息；长度封顶避免把日志/面板刷爆（装载失败那条路径一直是带 message 的，
  // 钩子这条以前漏了——排查真实依赖时踩到）。
  const detail: Record<string, string> = {};
  if (failure.message !== undefined && failure.message !== '') {
    detail.message = failure.message.length > 500 ? failure.message.slice(0, 500) + '…' : failure.message;
  }
  const base = { pluginId, hook, ...detail, ...(extra ?? {}) };
  switch (failure.kind) {
    case 'interrupt':
      return new SpcError(timeoutCodeFor(hook), base);
    case 'memory':
      return new SpcError('PLUGIN_MEMORY_LIMIT', base);
    case 'stack':
      return new SpcError('PLUGIN_STACK_LIMIT', base);
    case 'error':
      return new SpcError(failureCodeFor(hook), {
        ...base,
        cause: failure.code ?? 'PLUGIN_ERROR',
      });
  }
}

/**
 * 被调方失败 → 抛给**调用方**的那个错误（`plugins.call` 的失败面）。
 *
 * 与 `hookError` 的关键差别：**被调方自己的码要原样透出**（设计 §3.7：「失败 = 结构化错误码，
 * 被调方自己的 `code`/`params` 原样回传」）—— 调用方据此分支，而不是拿到一个笼统的
 * `PLUGIN_CALL_FAILED` 去猜。只有"没有码"的裸错误才归到 `PLUGIN_CALL_FAILED`。
 *
 * 限额那几类（中断/内存/栈）**不套 PLUGIN_CALL_* 壳**：它们是被调方 VM 的资源事实，
 * 调用方与排障者需要看到的就是"对端撞了内存/栈/超时"，包一层反而把信息糊掉。
 */
function endpointError(
  pluginId: string,
  ref: string | undefined,
  path: string,
  callId: string,
  failure: VmFailure,
): SpcError {
  const detail: Record<string, string> = {
    pluginId,
    // `callee` 一律给（locale 的文案要它）：没有 ref 时退回裸 id，绝不把 `{callee}` 原样打给用户
    callee: ref ?? pluginId,
    hook: 'call',
    path,
    callId,
  };
  if (failure.message !== undefined && failure.message !== '') {
    detail.message = failure.message.length > 500 ? failure.message.slice(0, 500) + '…' : failure.message;
  }
  switch (failure.kind) {
    case 'interrupt':
      return new SpcError('PLUGIN_CALL_TIMEOUT', detail);
    case 'memory':
      return new SpcError('PLUGIN_MEMORY_LIMIT', detail);
    case 'stack':
      return new SpcError('PLUGIN_STACK_LIMIT', detail);
    case 'error':
      // 插件自己抛的码（含它内部的宿主错误）原样回传；params 也照带（那是被调方**自己**选择抛出的东西，
      // 而栈只在审计里，见 host-api.js 的 __unwrap 与 classifyVmFailure 的分工）
      return failure.code !== undefined && failure.code !== 'PLUGIN_ERROR'
        ? new SpcError(failure.code, { ...detail, ...(failure.params ?? {}) })
        : new SpcError('PLUGIN_CALL_FAILED', { ...detail, cause: failure.code ?? 'PLUGIN_ERROR' });
  }
}

export async function createSandbox(api: HostApi, options: SandboxOptions): Promise<Sandbox> {  const limits: PluginLimits = options.limits ?? DEFAULT_LIMITS;
  const log =
    options.logger ??
    ((level: 'info' | 'warn' | 'error', message: string) => {
      // `info` 打到 `console.log`（不是 `console.info`）—— 历史行为，也是运维直觉，见 `logs.ts` 的注释
      console[hostLogMethod(level)](`[${options.pluginId}] ${message}`);
    });
  // 插件数据目录只解析一次：`node:os`/`node:process` 的环境事实、以及 ctx 里的 dataDir 都用它
  // （两处各写一份 `?? process.cwd()` 迟早会漂移）
  const dataDir = options.facts?.dataDir ?? process.cwd();

  /**
   * 本文件的审计都带"这个插件是谁"：`pluginId` 是裸 id（历史字段），`ref` 是**完整引用**（身份 = `(origin, id)`）。
   * 就地包装一次（`auditOwn`），免得十几处调用点各写两遍 —— 漏一个就出现"分不清是谁"的条目。
   * ⚠️ 调用点里原有的 `pluginId: options.pluginId` 会被这里**覆盖**：保留它只是为了让这次改动是"换个函数名"，
   * 不必同时动十几处；**新写审计时两件都不用写**。
   *
   * `callId` 是**环境值**：本插件正被别的插件调用时（`callEndpoint` 那一阶段），它这一段里产生的
   * **每一条**审计都带上同一个 id —— 否则"B 在 handler 里读了三个文件"这三条日志无法归到那次跨插件调用上。
   */
  const auditOwn = (entry: Omit<AuditEntry, 'pluginId' | 'ref'> & { pluginId?: string }): void =>
    auditRaw({
      ...entry,
      pluginId: options.pluginId,
      ref: options.ref,
      ...(entry.callId === undefined && currentCallId !== undefined ? { callId: currentCallId } : {}),
    });
  /** 当前是否正被别的插件调用（`callEndpoint` 期间有值）；对 hostApi 也有意义（见 SandboxBridge.currentCallId） */
  let currentCallId: string | undefined;
  /** 本次宿主调用要附带的审计字段（宿主方法的实现自己填，包装层合并；每次调用前清空） */
  let hostAuditTag: { callId?: string; attempts?: number; waitedMs?: number } | undefined;
  if (options.bridge) {
    options.bridge.currentCallId = () => currentCallId;
    options.bridge.tagAudit = (extra) => {
      hostAuditTag = extra;
    };
  }

  // asyncify 变体：宿主 API 可返回 Promise（exec/网络必须异步，见设计结论）
  // 注：quickjs-emscripten@0.32.0 的 asyncify newRuntime 释放顺序有 bug（deleteRuntime 先于
  // QTS_FreeRuntime），上游 Issue #261（justjake/quickjs-emscripten，OPEN）已确认：
  // https://github.com/justjake/quickjs-emscripten/issues/261
  // 本地通过 pnpm patch（patches/quickjs-emscripten-core.patch）修复，回归测试见
  // scripts/verify-quickjs-patch.mjs（pnpm verify:sandbox）
  const runtime = await newRuntimeForSandbox();

  // 四层限额：内存 + 栈在这里落地；CPU 用 deadline 中断（下面装 handler）；
  // "挂起"那层由宿主方法自带超时负责（exec 的 timeoutMs），且**必须用桥上的预算余额封顶** ——
  // 见 SandboxBridge.remainingMs 与 invoke() 的墙钟事后校验。
  applyLimits(runtime, limits);
  const deadline = installDeadlineHandler(runtime);

  // ESM 加载器（v0.32 API）：loader 返回模块"源码字符串"
  // 白名单外模块一律拒绝——零环境权力的执行点
  runtime.setModuleLoader(
    (moduleName: string): string => {
      const src = moduleSource(moduleName, api);
      if (src === null) {
        // 报错文案要能区分"沙箱尚未支持"与"写错了模块名"——前者是仿真排期问题，
        // 后者是作者笔误，把他引向"去装个包"是误导（build-layer-evidence §4.4-2）。
        const isBuiltin = BUILTIN_MODULES.has(normalizeSpecifier(moduleName));
        throw new Error(
          isBuiltin
            ? `[sandbox] module not allowed: ${moduleName}（沙箱尚未支持该 Node 内建，见 docs/module-emulation-design.md）`
            : `[sandbox] module not allowed: ${moduleName}`,
        );
      }
      return src;
    },
    normalizeModuleName,
  );

  const vm = runtime.newContext();
  const scope = new Scope(); // 统一管理宿主侧创建的 handle，dispose 时按序释放

  // 注入 __host 全局（宿主调用桥：沙箱内唯一的能力来源）
  const hostObj = scope.manage(vm.newObject());
  for (const [name, method] of Object.entries(api)) {
    // 两条通道（未声明 async 的走 `newFunction`，声明了的走 `newAsyncifiedFunction`）**共用**同一份
    // 参数读取、权限解析、权限判定、序列化与审计代码 —— 分流只差在"怎么把结果等出来"这一步，
    // 复制两份迟早会漂（尤其是审计：每个宿主调用一条，少一条就是审计缺口）。
    //
    // 结构：`prepareCall`（前段：读参 + 权限 + 各自的拒绝审计）→ 取值的两条通道 → `finishCall` / `failCall`
    // （后段：序列化 + 成败审计）。**这里不用生成器**：把两条通道塞进同一个生成器体、按 `yield` 分叉，
    // 只会让同步那条路径永远走不到分叉（值也传不出来），留下一个不可达的分支与一个死错误码。
    //
    // ⚠️ 注册时两条通道**不能对调**：把未声明 async 的方法挂到 `newAsyncifiedFunction` 上，等于让它的
    //    每次调用都白白挂起一次（handler 是 async ⇒ 必然返回 Promise）；反过来把 async handler 挂到
    //    `newFunction` 上更糟 —— handle 会变成 Promise 本身（`setProp` 拿到个非 handle）。

    /** 前段结果：要么**已经能返回给插件**（越权 / 参数错的错误信封，审计已落），要么把后段要用的账带出来 */
    type CallPrep =
      | { early: QuickJSHandle }
      | {
          raw: HostArg[];
          requested: string;
          callDigest: string;
          /** 权限判定的账目（后段落审计要用；判定本身只在前段做一次） */
          grantCode: string;
          grantDigest: ReturnType<typeof digestParams>;
          start: number;
        };
    /** 前段"继续往下走"那一支：后段两个函数的入参 */
    type PreparedCall = Extract<CallPrep, { raw: HostArg[] }>;

    /** 前段：参数读取 + 权限解析/判定。**每条失败路径都要落审计**——少一条就是审计缺口。 */
    function prepareCall(...args: QuickJSHandle[]): CallPrep {
      const start = Date.now();
      // 每次调用前清掉上一次留下的审计标签：它是"本次调用"的补充字段，
      // 忘了清就会把上一次的 attempts/waitedMs 挂到这一次的条目上（一条假账）。
      hostAuditTag = undefined;
      // 参数读取：按 **VM 侧类型**判别。二进制走 getArrayBuffer 并拷出来
      // （返回的 Lifetime 释放后视图即失效，不能直接交出去）；其余按字符串。
      // ⚠️ 不能一律 getString：对 ArrayBuffer 它**不报错**，而是返回字面量
      //    "[object ArrayBuffer]"——那会把二进制静默变成一串垃圾（见 module-emulation-design §3.2）。
      // ⚠️ 也不能对任何 object 都调 getArrayBuffer：**它只认 ArrayBuffer，不认 TypedArray 视图**，
      //    而且失败时报的是 "Couldn't allocate memory to get ArrayBuffer"（读起来像 OOM，极具误导）。
      //    契约是"二进制参数必须是 ArrayBuffer"（`@host/api` 侧由 __toAB 保证），这里给明确的错。
      const raw: HostArg[] = [];
      for (const h of args) {
        if (vm.typeof(h) !== 'object') {
          raw.push(vm.getString(h));
          continue;
        }
        let view;
        try {
          view = vm.getArrayBuffer(h);
        } catch {
          // **失败路径也要落审计**：不落的话插件可以制造任意多次不可见交互，
          // 破坏"每个宿主调用一条审计"这条不变量。
          auditOwn({
            ts: Date.now(),
            pluginId: options.pluginId,
            method: name,
            target: undefined,
            paramsDigest: digest(name),
            result: 'error',
            error: { code: 'INVALID_ARGS', paramsDigest: digestParams({ reason: 'binary-arg-not-arraybuffer' }) },
            durationMs: Date.now() - start,
          });
          const reason = 'binary-arg-not-arraybuffer';
          return { early: vm.newString(hostErrorPayload('INVALID_ARGS', { reason })) };
        }
        try {
          raw.push(Uint8Array.from(view.value));
        } finally {
          view.dispose();
        }
      }
      // 权限解析与审计只用字符串形态：字节只记长度，不记内容
      const strings = raw.map((a) => (typeof a === 'string' ? a : `[bytes:${a.byteLength}]`));
      const callDigest = digest(JSON.stringify(strings));

      // ① 解析本次调用的权限点（动态点如 exec.run 由模板 ID / 原生写法匹配决定）
      //    解析失败（如 exec 匹配不到模板）由方法自己抛 SpcError：只做**结构匹配**，
      //    参数校验留到权限通过之后（避免未授权插件拿参数校验结果做探测）。
      let requested: string;
      try {
        const resolved = method.permissionFor ? method.permissionFor(strings) : method.permission;
        if (!resolved) throw new SpcError('PERMISSION_DENIED', { permission: '(unresolved)' });
        requested = resolved;
      } catch (err) {
        const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
        auditOwn({
          ts: Date.now(),
          pluginId: options.pluginId,
          method: name,
          // **不落明文**：这一支是"权限点解析失败"，`strings[0]` 完全由插件控制
          // （exec.run 的命令行里可能有路径/凭据），与 audit.ts「不落明文参数」的策略相矛盾。
          // 需要复盘时用 paramsDigest 关联；能给出权限点的地方（下面那支）才写 target。
          target: undefined,
          paramsDigest: callDigest,
          result: 'denied',
          permission: { decision: 'deny', code: shape.code, paramsDigest: digestParams(shape.params) },
          durationMs: Date.now() - start,
        });
        return { early: vm.newString(hostErrorPayload(shape.code, shape.params)) };
      }

      // ② 权限判定（宿主侧强制 + 审计）；判定只记码与参数摘要，不记本地化文本
      // `pointSource` = **冻结表 ∪ 临时表**：静态点来自注册表，跨插件调用/订阅的点从
      // 当前活着的插件派生（对端卸载 ⇒ 它当场消失 ⇒ 第 1 步就 UNKNOWN_POINT，fail-closed）
      const check = checkPermission(pointSource, requested, options.permissions, options.grants ?? []);
      if (check.decision === 'deny') {
        auditOwn({
          ts: Date.now(),
          pluginId: options.pluginId,
          method: name,
          target: requested,
          paramsDigest: callDigest,
          result: 'denied',
          permission: {
            decision: 'deny',
            code: check.code,
            paramsDigest: digestParams(check.params),
          },
          durationMs: Date.now() - start,
        });
        return {
          early: vm.newString(
            hostErrorPayload('PERMISSION_DENIED', {
              permission: requested,
              reason: check.code,
            }),
          ),
        };
      }

      return {
        raw,
        requested,
        callDigest,
        grantCode: check.code,
        grantDigest: digestParams(check.params),
        start,
      };
    }

    /** 后段·成功：二进制走 `newArrayBuffer`（一次拷贝），其余仍是 JSON 文本信封；落一条 ok 审计 */
    function finishCall(prep: PreparedCall, result: unknown): QuickJSHandle {
      // 二进制结果走 newArrayBuffer（一次拷贝）；其余仍是 JSON 文本信封。
      // 失败路径**一律**回字符串信封，于是沙箱侧可以按「ArrayBuffer = 数据 / 字符串 = 错误」区分。
      const bytes = method.binaryResult ? toExactBytes(result) : null;
      const serialized = bytes ? null : JSON.stringify(result ?? null);
      auditOwn({
        ts: Date.now(),
        pluginId: options.pluginId,
        method: name,
        target: prep.requested,
        paramsDigest: prep.callDigest,
        result: 'ok',
        permission: {
          decision: 'allow',
          code: prep.grantCode,
          paramsDigest: prep.grantDigest,
        },
        resultBytes: bytes ? bytes.byteLength : Buffer.byteLength(serialized as string),
        // 宿主方法自己留下的补充字段（目前只有 plugins.call：callId / attempts / waitedMs）
        ...(hostAuditTag ?? {}),
        durationMs: Date.now() - prep.start,
      });
      return bytes ? vm.newArrayBuffer(bytes) : vm.newString(serialized as string);
    }

    /** 后段·失败：宿主错误 → 英文码 + 参数摘要入审计；插件面拿到 code/params（未分类错误记 INTERNAL） */
    function failCall(prep: PreparedCall, err: unknown): QuickJSHandle {
      const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
      auditOwn({
        ts: Date.now(),
        pluginId: options.pluginId,
        method: name,
        target: prep.requested,
        paramsDigest: prep.callDigest,
        result: 'error',
        permission: {
          decision: 'allow',
          code: prep.grantCode,
          paramsDigest: prep.grantDigest,
        },
        error: { code: shape.code, paramsDigest: digestParams(shape.params) },
        // 失败路径同样要带上标签：**忙到用尽重试**的那次调用恰恰最需要 attempts/waitedMs
        ...(hostAuditTag ?? {}),
        durationMs: Date.now() - prep.start,
      });
      return vm.newString(hostErrorPayload(shape.code, shape.params));
    }

    /** 未声明 `async` 的宿主方法走这条：**同步**拿值（`newFunction` 的 handler 必须同步返回 handle） */
    function hostCall(...args: QuickJSHandle[]): QuickJSHandle {
      const prep = prepareCall(...args);
      if ('early' in prep) return prep.early;
      try {
        const result: unknown = method.fn(...prep.raw);
        // ⚠️ fail-closed：**未声明 `async` 的**宿主方法不得返回 Promise（thenable）。
        // 为什么必须显式拦：`JSON.stringify(promise)` **不报错**，它给的是 `{}` ——
        // 于是"宿主方法被写成 async"会**静默**退化成"插件收到一个空对象"，属于最难查的一类失败。
        // （异步是**声明出来的**，不是看返回值猜的；声明了 `async: true` 的走下面那条通道。）
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          throw new SpcError('INTERNAL', {
            method: name,
            reason: 'async-host-method-not-supported',
          });
        }
        return finishCall(prep, result);
      } catch (err) {
        return failCall(prep, err);
      }
    }

    /**
     * 声明了 `async: true` 的方法走这条：handler 是 `async` 且**返回 `Promise<QuickJSHandle>`**。
     *
     * ⚠️ 这正是 `newAsyncifiedFunction` 的契约，别把它写反（前一轮的注释写反过）：**可以**（也应当）
     * 把 async handler 直接交给它 —— 上游实现就是 `return this.newFunction(name, fn)`，
     * 挂起语义来自宿主回调**返回 Promise** 时 asyncify 的 unwind（`Asyncify.handleSleep`），
     * 而 rewind 要由调用侧的 `pumpJobsAsync`（`executePendingJobsAsync`）驱动。
     * 反倒是"自己造一个同步 handle 交出去"才是错的（那就没有挂起可言了）。
     *
     * ⚠️ **先 await 出真值、再序列化**。反例（本轮改掉的缺陷）：把 `method.fn(...)` 的 Promise 直接
     * 交给 `JSON.stringify` ⇒ 插件收到字符串 `"{}"`，而审计记 `result: 'ok'`：静默失败，最难查。
     *
     * ⚠️ **异常绝不许逃出去变成 rejected promise**：上游 `handleAsyncify`（`QuickJSModuleCallbacks`）
     * 的拒绝分支只把 `suspended` 清掉、**不调 `done()`** ⇒ asyncify 的挂起永不恢复 = 沙箱挂死
     * （解释器根本没在跑，宿主 CPU 中断也进不去）。所以连"错误信封都造不出来"这一步也要兜住。
     */
    async function asyncHostCall(...args: QuickJSHandle[]): Promise<QuickJSHandle> {
      const prep = prepareCall(...args);
      if ('early' in prep) return prep.early;
      const waitedFrom = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        // **宿主 Promise 受当前阶段预算封顶**（契约：宿主 Promise 永不落地也不许挂住核心，见 docs §4.3）。
        // 少了这道 race，"宿主方法返回一个永不 settle 的 Promise"就是核心级挂死：泵里的
        // `await pump.executePendingJobsAsync(...)` 永不返回，连 `while (hasPendingJob())` 里的
        // deadline 判断都没机会再跑；卸载时也只会撞上"挂起中拆 VM"那条路。
        // 到点就**把这次挂起落地**成一个内部错误信封（不是新造一个超时码）：解释器随即醒过来，
        // 下一条 opcode 的中断轮询看到 deadline 已过 ⇒ `JS_ThrowInterrupted()`（不可捕获）
        // ⇒ 归类成既有的 `PLUGIN_<阶段>_TIMEOUT` —— 报出来的正是"阶段预算用完了"这个事实。
        const budget = deadline.remainingMs();
        let result: unknown;
        if (Number.isFinite(budget)) {
          if (budget <= 0) {
            // 预算已经用完：**连宿主方法都不进**（它有副作用，别给它一次白跑的机会）
            throw new SpcError('INTERNAL', { method: name, reason: 'host-call-deadline' });
          }
          // 收成 Promise 再 race：同步 throw / 声明了 async 却返回非 Promise 的实现在这里都不炸
          const wait = Promise.resolve().then(() => method.fn(...prep.raw));
          const raced = await Promise.race([
            wait.then(
              (value) => ({ kind: 'value' as const, value }),
              (error: unknown) => ({ kind: 'error' as const, error }),
            ),
            new Promise<{ kind: 'deadline' }>((resolve) => {
              timer = setTimeout(() => resolve({ kind: 'deadline' }), Math.max(1, budget));
            }),
          ]);
          if (raced.kind === 'deadline') {
            // 迟到的落地由上面那个 `.then(_, _)` 接住（不是无主 rejection）；结果丢弃即可
            throw new SpcError('INTERNAL', { method: name, reason: 'host-call-deadline' });
          }
          if (raced.kind === 'error') throw raced.error;
          result = raced.value;
        } else {
          result = await method.fn(...prep.raw);
        }
        return finishCall(prep, result);
      } catch (err) {
        try {
          return failCall(prep, err);
        } catch {
          return vm.newString(hostErrorPayload('INTERNAL', { method: name, reason: 'host-call-failed' }));
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // 挂起墙钟记账（含被预算打断的那一次）：这段时间 `durationMs` 里有、CPU 预算里没有，
        // 审计必须能把它单列出来（见 `AuditEntry.suspendedMs`）。
        suspendedMs += Date.now() - waitedFrom;
      }
    }

    // 尊重返回的 Lifetime 所有权：`scope.manage` 收下它，dispose 时统一释放
    // （别把这个 manage 挪进分支里 —— 两条通道的释放路径必须一致）。
    const wrapped = scope.manage(
      method.async === true
        ? vm.newAsyncifiedFunction(`host.${name}`, asyncHostCall)
        : vm.newFunction(`host.${name}`, hostCall),
    );
    vm.setProp(hostObj, name, wrapped);
  }
  vm.setProp(vm.global, '__host', hostObj);

  /**
   * 注入**仿真环境事实**（`node:os` / `node:process` 的数据源）。
   *
   * 为什么用 JSON 字符串而不是宿主构造对象：仿真模块必须能被构建层**整文件内联**（静态、无占位符），
   * 所以它们只能在运行时从全局取数据；给字符串最省事，也不会在类型上骗人（shim 侧 `JSON.parse` 一次）。
   * 取值规则（哪些固定、哪些用宿主真值、哪些不暴露）见 core/emulated-env.ts 的文件头。
   *
   * 注入时机必须是**建沙箱时**：`runModule` 求值的顶层代码就可能 `import 'node:os'`，
   * 而 ctx 是首次钩子才组装的（惰性）——晚一步就会让装载期读到 undefined。
   */
  const envHandle = scope.manage(vm.newString(JSON.stringify(buildEnvFacts(dataDir))));
  vm.setProp(vm.global, '__spcEnv', envHandle);

  // 注入最小 console（QuickJS 沙箱默认无 console）
  // ⚠️ 与 `ctx.logger` **同一个出口**（`options.logger`）：以前这里直接 `console[level](...)` 打到宿主 stdout，
  // 于是 `console.log` 出来的东西**进不了聚合器**（`spc log` 读不到）、也没有等级 —— 同一个插件的两种写法
  // 行为不一致是最难查的那种。等级映射：`log`/`info` ⇒ info（console 没有 debug）。
  const consoleObj = scope.manage(vm.newObject());
  for (const [name, level] of [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
  ] as const) {
    const fn = scope.manage(
      vm.newFunction(`console.${name}`, (...args) => {
        const text = args.map((h) => vm.getString(h)).join(' ');
        // ⚠️ 两条出口是**分开**的（历史行为，别合并）：
        //   · 宿主 stdout：**不加前缀**（`ctx.logger.*` 才带 `[ref]` 前缀）—— 合并过一次，
        //     54 条捕获宿主 `console.log` 的真沙箱用例立刻全红（它们按"无前缀"断言，2026-10-14 踩过）；
        //   · 聚合器：走 `options.onLog`（守护进程注入），`spc log` 读它。
        console[hostLogMethod(level)](text);
        options.onLog?.(level, text);
        return vm.undefined;
      }),
    );
    vm.setProp(consoleObj, name, fn);
  }
  vm.setProp(vm.global, 'console', consoleObj);

  // 引导代码 + 取回内部函数句柄（纳入 Scope：漏 dispose 会在 runtime 释放时命中 GC 断言）
  {
    const boot = await vm.evalCodeAsync(BOOTSTRAP);
    if (isFail(boot)) {
      let dumped: unknown;
      try {
        dumped = vm.dump(boot.error);
      } finally {
        boot.error.dispose();
      }
      scope.dispose();
      vm.dispose();
      runtime.dispose();
      throw new SpcError('PLUGIN_LOAD_FAILED', {
        pluginId: options.pluginId,
        cause: 'BOOTSTRAP_FAILED',
        message: String(dumped),
      });
    }
    boot.value.dispose();
  }

  /**
   * 沙箱里的 **Node 全局**（`process` / `Buffer` / `global` / `URL` / `TextEncoder` …）。
   *
   * 为什么必须有：**真实依赖用的是裸全局，不是 import**。实测（`tools/smoke/dep-smoke.mts`，
   * 真实 npm 包内联后进真沙箱）：
   *   · `mkdirp/dist/mjs/path-arg.js` → `process.env.… || process.platform`
   *   · `mkdirp/dist/mjs/use-native.js` → `process.env.… || process.version`
   *   · `properties/lib/stringify.js` → `process.platform === "win32" ? "\r\n" : "\n"`
   * 沙箱里没有 `process` 时，这些包**在装载期就 ReferenceError**（PLUGIN_LOAD_FAILED），
   * 而它们并不是要什么能力——只是要"Node 保证存在的那个全局"。
   *
   * 装的是**仿真模块本身**（不是宿主 process）：`env` 冻结为空、`exit`/`kill` 抛错、
   * `platform` 固定 linux，所以"零环境权力"这条不变量没被破坏——插件拿到的仍然只是仿真值。
   * 换句话说：`queueMicrotask` 那类标准全局怎么补，这里就怎么补，只是这几个的实现在 `node-*.js` 里。
   */
  {
    const globals = await vm.evalCodeAsync(GLOBALS_PRELUDE, 'spc-globals.js', { type: 'module' });
    if (isFail(globals)) {
      let dumped: unknown;
      try {
        dumped = vm.dump(globals.error);
      } finally {
        globals.error.dispose();
      }
      scope.dispose();
      vm.dispose();
      runtime.dispose();
      throw new SpcError('PLUGIN_LOAD_FAILED', {
        pluginId: options.pluginId,
        cause: 'GLOBALS_PRELUDE_FAILED',
        message: String(dumped),
      });
    }
    globals.value.dispose();
  }
  const ctxFactory = scope.manage(vm.getProp(vm.global, '__spcMakeCtx'));
  const invokeFn = scope.manage(vm.getProp(vm.global, '__spcInvoke'));
  const timerInvokeFn = scope.manage(vm.getProp(vm.global, '__spcTimerInvoke'));
  const endpointInvokeFn = scope.manage(vm.getProp(vm.global, '__spcInvokeEndpoint'));

  // ctx.logger：三个宿主函数，只建一次（插件日志不落审计，落宿主 console / P2-4 聚合器）
  const loggerObj = scope.manage(vm.newObject());
  for (const level of ['info', 'warn', 'error'] as const) {
    const fn = scope.manage(
      vm.newFunction(`logger.${level}`, (...args) => {
        log(level, args.map((h) => vm.getString(h)).join(' '));
        return vm.undefined;
      }),
    );
    vm.setProp(loggerObj, level, fn);
  }

  let namespace: QuickJSHandle | undefined;
  let ctxHandle: QuickJSHandle | undefined;
  let busy = false;
  let disposed = false;
  const timers = new Map<string, NodeJS.Timeout>();
  let timerSeq = 0;
  /** 在飞阶段的名字（`load` / 钩子名 / `timer`）：`PLUGIN_BUSY` 的 `busyWith` 读它 */
  let busyWith = '';
  /** 本阶段累计的挂起墙钟（阶段开始时清零，见 `beginPhase`） */
  let suspendedMs = 0;
  /** 最近一个跑完阶段的挂起墙钟（`endPhase` 落账；失败路径靠它记审计） */
  let lastSuspendedMs = 0;
  /** 有人要求在"阶段还在飞"的时候卸载：真正拆 VM 延后到阶段收尾（见 `beginPhase`） */
  let teardownPending = false;
  let tornDown = false;

  function readProp(obj: QuickJSHandle, key: string): unknown {
    const h = vm.getProp(obj, key);
    try {
      return vm.dump(h);
    } finally {
      h.dispose();
    }
  }

  /** 环境事实只组装一次（沙箱生命周期内不变；配置变更走 reload → 新沙箱） */
  function ensureCtx(): QuickJSHandle {
    if (ctxHandle) return ctxHandle;
    const facts = options.facts ?? {
      version: { code: 0, name: '0.0.0' },
      dataDir,
      manifest: {},
      config: {},
    };
    const factsJson = JSON.stringify({
      pluginId: options.pluginId,
      version: facts.version,
      dataDir: facts.dataDir,
      manifest: facts.manifest,
      grants: options.grants ?? [],
      config: facts.config,
    });
    const jsonHandle = vm.newString(factsJson);
    try {
      const res = vm.callFunction(ctxFactory, vm.undefined, jsonHandle, loggerObj);
      if (isFail(res)) {
        let dumped: unknown;
        try {
          dumped = vm.dump(res.error);
        } finally {
          res.error.dispose();
        }
        throw new SpcError('PLUGIN_LOAD_FAILED', {
          pluginId: options.pluginId,
          cause: 'CTX_FAILED',
          message: String(dumped),
        });
      }
      ctxHandle = scope.manage(res.value);
    } finally {
      jsonHandle.dispose();
    }
    return ctxHandle;
  }

  /**
   * 阶段边界的宿主状态落盘点（kv 合并写）。
   * 落盘失败**只记日志**：它不该盖掉钩子本身的错误（在 finally 里抛会顶掉原异常），
   * 而失败原因（磁盘满/权限）本身也不是插件的行为。
   */
  function flushHostState(): void {
    try {
      options.bridge?.flush?.();
    } catch (err) {
      log('error', `宿主状态落盘失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 阶段（装载 / 钩子 / 定时器）开始：置 `busy`、记阶段名、清零挂起墙钟。
   *
   * 为什么 `busy` 不只是"别并发"的标志：它同时是**能不能拆 VM** 的判据。声明了 `async: true` 的宿主方法
   * 会让 guest 那次调用在 asyncify 里挂起（WASM 栈 unwind，等宿主 Promise 落地）；在那中间拆 VM
   * 等于在栈还摊开的时候释放运行时 —— 收尾必命中 `JS_FreeRuntime` 的
   * `assert(list_empty(&rt->gc_obj_list))`（`vendor/quickjs/quickjs.c:2036`）⇒ 整个进程 Abort。
   */
  function beginPhase(what: string): void {
    busy = true;
    busyWith = what;
    suspendedMs = 0;
  }

  /**
   * 阶段收尾：复位 deadline / busy、落盘宿主状态，并在有人要求延后卸载时**接手拆 VM**。
   *
   * 顺序是要紧的：`teardown()` 必须发生在**阶段真的跑完**之后（挂起已落地、泵已返回），
   * 所以它是本函数的最后一步，而不是 `dispose()` 里直接做。
   * 返回本阶段的挂起墙钟（审计用；`runTimer` 与 `callHook` 两条路都要它）。
   */
  function endPhase(): number {
    const spent = suspendedMs;
    lastSuspendedMs = spent;
    suspendedMs = 0;
    busy = false;
    busyWith = '';
    deadline.setDeadline(Number.POSITIVE_INFINITY);
    flushHostState();
    if (teardownPending) teardown();
    return spent;
  }

  /**
   * 真正释放 VM（幂等）。**只许在"没有阶段在飞"时调**：`dispose()` 在有阶段在飞时会延后到这里。
   */
  function teardown(): void {
    if (tornDown) return;
    tornDown = true;
    // ① 先跑沙箱内的卸载钩子（`process.on('exit')` 的落点）——**必须在 flush 之前**：
    //    监听器里可能还要写 kv，那笔写在 flush 之后就丢了。
    try {
      const runHooks = vm.getProp(vm.global, '__spcRunDisposeHooks');
      try {
        if (vm.typeof(runHooks) === 'function') vm.callFunction(runHooks, vm.undefined);
      } finally {
        runHooks.dispose();
      }
    } catch {
      // 卸载路径吞掉异常：钩子只服务于"清理"，不该阻塞句柄释放（放进日志会需要 logger，得不偿失）
    }
    // ② 卸载前把待落盘状态（kv）写下去：合并写之后，这是"不丢数据"的最后一道保证
    flushHostState();
    for (const handle of timers.values()) clearInterval(handle);
    timers.clear();
    // ③ 宿主侧句柄（流式摘要等真资源）：插件没释放的在这里强制回收（并留一条审计）。
    //    吞掉异常：一条资源释放失败不该让整个卸载崩（与上面卸载钩子同一策略）。
    try {
      options.bridge?.releaseHandles?.();
    } catch (err) {
      log('error', `宿主句柄回收失败：${err instanceof Error ? err.message : String(err)}`);
    }
    deadline.setDeadline(Number.POSITIVE_INFINITY);
    scope.dispose(); // 先释放宿主侧 handle
    vm.dispose();
    runtime.dispose();
  }

  /**
   * 统一的钩子/定时器回调调用：
   * 设 deadline → 调 __spcInvoke / __spcTimerInvoke（拿到状态对象，钩子体**排在一个 job 里**）
   * → **异步**泵 job（插件代码实际在这里跑，含 asyncify 的挂起/rewind）→ 读归一化状态 → 归类失败。
   */
  async function invoke(
    kind: 'hook' | 'timer' | 'watch',
    name: string,
    hook: HookName,
    timeoutMs: number,
  ): Promise<void> {
    // 阶段名给 `PLUGIN_BUSY` 用：回调类（定时器/监视）用统一名（callbackId 是摘要，对排障没意义）
    beginPhase(kind === 'hook' ? name : kind);
    const started = Date.now();
    const dl = started + timeoutMs;
    deadline.setDeadline(dl);
    try {
      const ctx = ensureCtx();
      let stateResult;
      if (kind === 'hook') {
        const fnHandle = vm.getProp(namespace!, name);
        try {
          if (vm.typeof(fnHandle) !== 'function') {
            throw new SpcError('PLUGIN_NO_ENTRY', { pluginId: options.pluginId, hook: name });
          }
          stateResult = vm.callFunction(invokeFn, vm.undefined, fnHandle, ctx);
        } finally {
          fnHandle.dispose();
        }
      } else {
        const idHandle = vm.newString(name);
        try {
          stateResult = vm.callFunction(timerInvokeFn, vm.undefined, idHandle, ctx);
        } finally {
          idHandle.dispose();
        }
      }

      if (isFail(stateResult)) {
        let dumped: unknown;
        try {
          dumped = vm.dump(stateResult.error);
        } finally {
          stateResult.error.dispose();
        }
        throw hookError(options.pluginId, hook, classifyVmFailure(dumped));
      }

      const state = stateResult.value;
      try {
        const pump = await pumpJobsAsync(runtime, dl);
        if (pump.status === 'failed') {
          throw hookError(options.pluginId, hook, pump.failure);
        }
        const status = readProp(state, 'status');
        // 泵完之后状态只可能是 done / async / error：钩子体是在泵里那个 job 中调起的
        // （见 BOOTSTRAP 的 __spcInvoke），泵没跑到它（deadline 先到）时仍停在 scheduled —— 一并按
        // "还有没回收的异步任务"报 PLUGIN_JOB_PENDING（泵返回 pending 那支），语义不变。
        if (status === 'async' || pump.status === 'pending') {
          // 钩子返回了 Promise 但没泵完：插件留下了未回收的异步任务（§4.4）
          throw new SpcError('PLUGIN_JOB_PENDING', { pluginId: options.pluginId, hook });
        }
        if (status === 'error') {
          throw hookError(options.pluginId, hook, classifyVmFailure(readProp(state, 'error')));
        }
      } finally {
        state.dispose();
      }

      // **墙钟事后校验**：走到这里说明 VM 侧"没报错"，但没报错 ≠ 没超时。
      // deadline 只能中断解释器，拦截不了宿主方法里的同步阻塞（`spawnSync`）：那段时间
      // 解释器没在跑，中断处理器一次都不会被调用 —— 预算到期了也没人查。时间是真花掉了，
      // 所以这里按超时上报（fail-closed）。实测：1 秒预算 + 阻塞式 exec = 40.7 秒，
      // 而且当时被记成**成功**（调用方据此认为插件健康）。
      // 只判"成功路径"：失败路径本来就 fail-closed，不该用超时盖掉插件自己的错误。
      const overrunMs = Date.now() - dl;
      if (overrunMs > 0) {
        throw new SpcError(timeoutCodeFor(hook), {
          pluginId: options.pluginId,
          hook,
          overrunMs: String(overrunMs),
        });
      }
    } finally {
      // 阶段收尾统一走 `endPhase()`：它复位 deadline/busy、落盘宿主状态，并在有人要求
      // 延后卸载时接手拆 VM。返回值（本阶段挂起墙钟）由 `lastSuspendedMs()` 暴露给审计。
      endPhase();
    }
  }

  /**
   * **跨插件调用的落地端**：在**本**插件（被调方）的 VM 里跑一个端点处理器。
   *
   * 与 `invoke()` 同一套骨架（阶段/deadline/异步泵/墙钟事后校验/endPhase），差别有三处：
   *   ① 取出的是 `namespace.endpoints[path]`（装载期已核对存在），不是钩子；
   *   ② 要**把处理器的返回值带出来**（JSON 文本）；
   *   ③ 全程带 `callId`（写进本阶段的每条审计，含处理器内部那些宿主调用）。
   *
   * ⚠️ **忙碌即拒、不排队**（同钩子）：调用方 A 正挂在自己的宿主调用上等着，宿主此刻进 B 的 VM；
   * 若 B 也在跑阶段（钩子/定时器/另一次调用），两条阶段叠在同一个 runtime 上会把状态机搅乱
   * （deadline 互相覆盖、异步泵嵌套在同一个 VM 里）。`PLUGIN_BUSY` 由**投递方**做有界重试。
   */
  async function callEndpoint(
    path: string,
    paramsJson: string,
    bytes: Uint8Array | undefined,
    timeoutMs: number,
    callId: string,
  ): Promise<string> {
    if (disposed) throw new SpcError('PLUGIN_DISPOSED', { pluginId: options.pluginId, hook: 'call' });
    if (busy) {
      throw new SpcError('PLUGIN_BUSY', { pluginId: options.pluginId, hook: 'call', busyWith });
    }
    if (!namespace) throw new SpcError('PLUGIN_NO_ENTRY', { pluginId: options.pluginId, hook: 'call' });

    const started = Date.now();
    currentCallId = callId;
    beginPhase('plugins.call');
    const dl = started + timeoutMs;
    deadline.setDeadline(dl);
    const paramsBytes = Buffer.byteLength(paramsJson);
    try {
      const ctx = ensureCtx();
      // 处理器的句柄：`endpoints` 是普通对象，按 path 取属性（装载期已核对过是函数）
      const endpointsObj = vm.getProp(namespace, 'endpoints');
      let fnHandle: QuickJSHandle | undefined;
      let stateResult;
      try {
        fnHandle = vm.getProp(endpointsObj, path);
        if (vm.typeof(fnHandle) !== 'function') {
          // 装载期核对过，走到这里只有一种可能：插件在自己运行期把映射改了（或删了某个键）。
          // 端点集合是**装载期快照**语义，所以这里 fail-closed，而不是"再看一眼现在的映射"。
          throw new SpcError('PLUGIN_NO_ENTRY', { pluginId: options.pluginId, hook: 'call', path });
        }
        const paramsHandle = vm.newString(paramsJson);
        // 字节要交**完整的 ArrayBuffer**（`newArrayBuffer` 只认它；视图自己带的 offset/length 会被忽略，
        // 那就会把一段无关的内存交出去）。`toExactBytes` 就是干这个的（同 finishCall 的二进制结果那条路）。
        const bytesHandle = bytes ? vm.newArrayBuffer(toExactBytes(bytes)!) : vm.undefined;
        try {
          stateResult = vm.callFunction(endpointInvokeFn, vm.undefined, fnHandle, ctx, paramsHandle, bytesHandle);
        } finally {
          paramsHandle.dispose();
          if (bytes) bytesHandle.dispose();
        }
      } finally {
        fnHandle?.dispose();
        endpointsObj.dispose();
      }

      if (isFail(stateResult)) {
        let dumped: unknown;
        try {
          dumped = vm.dump(stateResult.error);
        } finally {
          stateResult.error.dispose();
        }
        throw endpointError(options.pluginId, options.ref, path, callId, classifyVmFailure(dumped));
      }

      const state = stateResult.value;
      let value: unknown;
      try {
        const pump = await pumpJobsAsync(runtime, dl);
        if (pump.status === 'failed') {
          throw endpointError(options.pluginId, options.ref, path, callId, pump.failure);
        }
        const status = readProp(state, 'status');
        if (status === 'async' || pump.status === 'pending') {
          // 处理器返回了 Promise 但没泵完：插件留下了未回收的异步任务（与钩子同一条规矩）
          throw new SpcError('PLUGIN_JOB_PENDING', {
            pluginId: options.pluginId,
            callee: options.ref ?? options.pluginId,
            hook: 'call',
            path,
            callId,
          });
        }
        if (status === 'error') {
          throw endpointError(
            options.pluginId,
            options.ref,
            path,
            callId,
            classifyVmFailure(readProp(state, 'error')),
          );
        }
        value = readProp(state, 'value');
      } finally {
        state.dispose();
      }

      // 墙钟事后校验（与 invoke() 同一理由：deadline 拦不住宿主方法里的同步阻塞）
      const overrunMs = Date.now() - dl;
      if (overrunMs > 0) {
        throw new SpcError('PLUGIN_CALL_TIMEOUT', {
          pluginId: options.pluginId,
          callee: options.ref ?? options.pluginId,
          hook: 'call',
          path,
          callId,
          overrunMs: String(overrunMs),
        });
      }
      if (typeof value !== 'string') {
        // 引导层已经保证"成功 ⇒ 字符串"，这里再兜一层：拿不到文本就绝不能当成功返回
        throw new SpcError('PLUGIN_CALL_BAD_RESULT', {
          pluginId: options.pluginId,
          callee: options.ref ?? options.pluginId,
          hook: 'call',
          path,
          callId,
          reason: 'result-not-text',
        });
      }
      auditOwn({
        ts: Date.now(),
        method: 'plugins.call',
        target: path,
        paramsDigest: digest(JSON.stringify([callId, paramsBytes, bytes?.byteLength ?? 0])),
        result: 'ok',
        callId,
        resultBytes: Buffer.byteLength(value),
        suspendedMs: lastSuspendedMs,
        durationMs: Date.now() - started,
      });
      return value;
    } catch (err) {
      // 失败也要有被调方这一侧的账（调用方那条只说明"我调了、失败了"）
      const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
      auditOwn({
        ts: Date.now(),
        method: 'plugins.call',
        target: path,
        paramsDigest: digest(JSON.stringify([callId, paramsBytes, bytes?.byteLength ?? 0])),
        result: 'error',
        error: { code: shape.code, paramsDigest: digestParams(shape.params) },
        callId,
        suspendedMs: lastSuspendedMs,
        durationMs: Date.now() - started,
      });
      throw err;
    } finally {
      endPhase();
      currentCallId = undefined;
    }
  }

  /**
   * 宿主触发的**非钩子回调**（定时器 / 文件监视）：与钩子同样的限额；失败只落审计，不改变插件状态
   * （由 manager 决定策略）。
   *
   * `kind` 决定阶段名与审计方法名（`timers.tick` / `watch.event`）：两条通道共用一份实现，
   * 但日志里必须分得开——"定时器跳了一拍"与"文件变了没送到"是两种完全不同的排障线索。
   */
  async function runGuestCallback(kind: 'timer' | 'watch', callbackId: string, targetId: string): Promise<void> {
    // 重入保护：正在执行插件代码就**跳过一次**，绝不并发进同一 VM。
    // 这里与钩子那条（`PLUGIN_BUSY`）有意不同：定时器是**周期性**的，把"这一拍错过"报成错误
    // 只会让插件因为一次正常的避让被判失败；下一拍还会来，静默跳过才是它该有的语义。
    // （`fs.watch` 那边把跳过变成"稍后重试"：事件已经排在宿主队列里，跳过的是**投递**不是事件。）
    if (busy || disposed) return;
    const started = Date.now();
    const auditMethod = kind === 'timer' ? 'timers.tick' : 'watch.event';
    try {
      await invoke(kind, callbackId, kind, limits.timerTimeoutMs);
      auditOwn({
        ts: Date.now(),
        pluginId: options.pluginId,
        method: auditMethod,
        target: targetId,
        paramsDigest: digest(callbackId),
        result: 'ok',
        // 阶段已由 `invoke` 的 endPhase 收尾 ⇒ 累计值已挪到 lastSuspendedMs（现场那个恒为 0）
        suspendedMs: lastSuspendedMs,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
      auditOwn({
        ts: Date.now(),
        pluginId: options.pluginId,
        method: auditMethod,
        target: targetId,
        paramsDigest: digest(callbackId),
        result: 'error',
        error: { code: shape.code, paramsDigest: digestParams(shape.params) },
        suspendedMs: lastSuspendedMs,
        durationMs: Date.now() - started,
      });
    }
  }

  /** 定时器回调（保留原名字：`timers` 那条路的第一调用方，语义与审计方法名都不变） */
  async function runTimer(callbackId: string, timerId: string): Promise<void> {
    await runGuestCallback('timer', callbackId, timerId);
  }

  // 回填桥：hostApi 的 timers.* 转发到这里（此时 VM 已就绪）
  if (options.bridge) {
    // 预算余额给宿主方法（exec 用它给自己的 spawnSync 超时封顶）；无阶段在跑时是 Infinity
    options.bridge.remainingMs = () => deadline.remainingMs();
    // 通用回调投递（定时器 / fs.watch）：`false` = 现在进不去 VM（忙或已拆），调用方稍后重试
    options.bridge.deliver = async (kind, callbackId, targetId) => {
      if (busy || disposed) return false;
      await runGuestCallback(kind, callbackId, targetId);
      return true;
    };
    options.bridge.timers = {
      every(intervalMs: number, callbackId: string) {
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 86_400_000) {
          throw new SpcError('TIMER_INTERVAL_INVALID', { intervalMs: String(intervalMs) });
        }
        // 数量上限（宿主资源要计量）：计**活着的**定时器，clear 后名额立刻回收。
        // 没有它，插件可以几秒内塞进成千上万个宿主 setInterval（实测 5s/6659 个、RSS +18.9MB、无报错）。
        if (timers.size >= limits.maxTimers) {
          throw new SpcError('TIMER_LIMIT_EXCEEDED', {
            pluginId: options.pluginId,
            limit: String(limits.maxTimers),
          });
        }
        const timerId = `t${++timerSeq}`;
        const handle = setInterval(() => {
          void runTimer(callbackId, timerId);
        }, intervalMs);
        // unref：定时器不该让宿主进程"为了一个插件"活着（核心退出时不会被它拖住）
        handle.unref?.();
        timers.set(timerId, handle);
        return { timerId, intervalMs };
      },
      clear(timerId: string) {
        const handle = timers.get(timerId);
        if (!handle) return false;
        clearInterval(handle);
        timers.delete(timerId);
        return true;
      },
    };
  }

  return {
    async runModule(name: string, source: string) {
      if (disposed) throw new SpcError('PLUGIN_DISPOSED', { pluginId: options.pluginId });
      // 同一 VM 不许并发进（契约二）：装载期跑的就是插件顶层代码，这时再进一个阶段就是并发。
      // 报出来而不是排队：调用方（manager/CLI）本就串行，走到这里说明上层时序出了问题。
      if (busy) throw new SpcError('PLUGIN_BUSY', { pluginId: options.pluginId, busyWith });
      // 阶段罩：用内层 async IIFE 罩住**整段**装载体（5 个 throw 出口 + 1 个 return 出口都在里面），
      // 这样"阶段收尾"只需要写一次 —— 逐个出口补 endPhase 迟早会漏一个，而漏掉的那个出口
      // 会让 `busy` 永远停在 true（此后一切调用都被判 PLUGIN_BUSY、dispose 也永远延后）。
      // 收尾必须晚于**最后一次 VM 访问**：body 里的 TLA 判定/审计都还在读句柄。
      beginPhase('load');
      try {
        await (async () => {
      // import 语句自动走 setModuleLoader；evalCodeAsync 返回 SuccessOrFail<QuickJSHandle>
      //
      // **必须显式传 `{ type: 'module' }`**：不传时 quickjs-emscripten 会打开模块自动探测
      // （QTS_Eval_MaybeAsync 的 detectModule=1 → `JS_DetectModule`），而它**只看第一个 token**
      // （`vendor/quickjs/quickjs.c:23205`）。esbuild 会把导出提升到文件末尾（`function init(){}` + `export { init };`），
      // 于是首 token 是 `function` → 判成脚本模式 → `unsupported keyword: export`。
      // 插件契约本来就是 ESM-only（ADR-005），显式声明模块模式既正确又不再依赖首 token 的运气。
      const started = Date.now();
      // **装载也必须计时**：顶层代码同样是插件代码，`while(true)` 可以就写在这里。
      // 少了这段 deadline，一个死循环会把整个核心占死——无超时、无审计、无恢复路径。
      // 与钩子同一套做法：设 deadline → 无论成败都在 finally 复位（复位成 Infinity 即"永不触发"）。
      deadline.setDeadline(started + limits.loadTimeoutMs);
      let result;
      let loadPump: PumpOutcome | undefined;
      try {
        result = await vm.evalCodeAsync(source, 'plugin.js', { type: 'module' });
        if (isSuccess(result)) {
          // 命名空间句柄**保留**（钩子从这里取导出），由 Scope 在 dispose 时释放
          namespace = scope.manage(result.value);
          // **装载期也要泵 job 队列**：模块顶层的 `await`（TLA 续体）与 `.then()` 都排在 job 队列里，
          // 不泵就等于**静默丢掉**——实测（本轮 fs 冒烟踩到）：`await Promise.resolve(); console.log('B')`
          // 里的 B 永远不打印，而 runModule 报的是**成功**。插件把初始化写在顶层 await 后面时，
          // 表现就是"导出存在但没初始化好"，最难查的那种静默差异。
          // 泵要放在 finally **之前**：deadline 还armed 着，泵里跑的仍是限了额的插件代码。
          // 用**异步**泵（与钩子同一条）：顶层 `.then()` 续体是 job，job 里同样可能 await 一个
          // `async: true` 的宿主方法 —— 同步泵驱动不了那种挂起（见 `pumpJobsAsync` 的注释）。
          loadPump = await pumpJobsAsync(runtime, started + limits.loadTimeoutMs);
        }
      } finally {
        deadline.setDeadline(Number.POSITIVE_INFINITY);
        // 顶层代码也能写 kv（装载是独立阶段），同样是落盘边界
        flushHostState();
      }
      if (isSuccess(result)) {
        // **顶层 await（TLA）模块要明确拒绝**，不能装作没事：QuickJS 的 `QTS_Eval_MaybeAsync`
        // 对带 TLA 的模块返回的是模块的 TLA **promise**，不是命名空间（quickjs-emscripten 的
        // `evalCodeAsync` 只把 handle 交出来，不解这个 promise）。于是 `namespace` 是个 promise，
        // 导出全都取不到，调用钩子时报的是 **PLUGIN_NO_ENTRY**——读起来像"你把导出名写错了"，
        // 而真因是"模块顶层用了 await"。要真正支持它得 pump 到 promise 落地再取结果值（见 HANDOFF）。
        // （`loaded` 是为了让 TS 收窄：赋值发生在 try 里，跨不过去。）
        const loaded = namespace;
        if (loaded !== undefined && isThenableHandle(vm, loaded)) {
          throw new SpcError('PLUGIN_LOAD_FAILED', {
            pluginId: options.pluginId,
            hook: 'load',
            message:
              'module uses top-level await, which the sandbox does not support: ' +
              'put the async initialisation inside the init() hook instead',
          });
        }
        // 与钩子同一套判定：泵失败→按 VM 失败归类；到点没泵完→PLUGIN_JOB_PENDING（§4.4）
        if (loadPump?.status === 'failed') {
          throw hookError(options.pluginId, 'load', loadPump.failure);
        }
        if (loadPump?.status === 'pending') {
          throw new SpcError('PLUGIN_JOB_PENDING', { pluginId: options.pluginId, hook: 'load' });
        }
        // 与钩子同一道**墙钟事后校验**：顶层代码里的宿主同步阻塞（spawnSync）同样让 deadline 失效
        // —— 时间花掉了就必须报 PLUGIN_LOAD_TIMEOUT，不能记成"装载成功"（见 invoke 的同一段注释）。
        const overrunMs = Date.now() - (started + limits.loadTimeoutMs);
        if (overrunMs > 0) {
          throw new SpcError(timeoutCodeFor('load'), {
            pluginId: options.pluginId,
            hook: 'load',
            overrunMs: String(overrunMs),
          });
        }
        return;
      }

      // 失败：先把错误内容取出来，**再释放 handle**。
      // 漏释放会让该 JS 对象常驻，runtime 释放时命中 QuickJS 断言
      // （JS_FreeRuntime: assert(list_empty(&rt->gc_obj_list))）→ 整个进程 Aborted。
      let dumped: unknown;
      try {
        dumped = vm.dump(result.error);
      } catch {
        dumped = undefined;
      } finally {
        result.error.dispose();
      }

      // 与钩子**共用同一套归类**：中断（超时）/ 内存 / 栈 / 插件自身错误。
      // 于是装载期限额命中会得到 PLUGIN_LOAD_TIMEOUT / PLUGIN_MEMORY_LIMIT / PLUGIN_STACK_LIMIT，
      // 而不是一律混进 PLUGIN_LOAD_FAILED —— 靠 code 分支的调用方（manager/CLI）才分得清"限额"与"缺陷"。
      // `message` 必须带上：装载失败的原文是排障的第一手信息（既有用法与测试都依赖它）。
      const failure = classifyVmFailure(dumped);
      const err = hookError(
        options.pluginId,
        'load',
        failure,
        failure.message ? { message: failure.message } : undefined,
      );

      // 判定为加载失败：终止本次加载 + 记账（是否禁用该插件由上层策略决定，核心不崩）
      auditOwn({
        ts: Date.now(),
        pluginId: options.pluginId,
        method: 'lifecycle.load',
        paramsDigest: digest(name),
        result: 'error',
        error: {
          code: err.code,
          paramsDigest: digestParams({ cause: err.params.cause ?? err.code }),
        },
        // 这里读的是**现场累计值**（本阶段的 endPhase 还没跑，`lastSuspendedMs` 还是上一阶段的）
        suspendedMs,
        durationMs: Date.now() - started,
      });
      throw err;
        })();
      } finally {
        endPhase();
      }
    },

    hasFunctionExport(name: string) {
      if (!namespace) return false;
      const h = vm.getProp(namespace, name);
      try {
        return vm.typeof(h) === 'function';
      } finally {
        h.dispose();
      }
    },

    async callHook(name: 'init' | 'start' | 'stop', timeoutMs: number) {
      // 卸载后再调：必须报**明确的码**。少了这道检查，句柄已释放，抛出来的是
      // `QuickJSUseAfterFree: Lifetime not alive` —— 上层没法按 code 分支，看着像内核崩了。
      if (disposed) throw new SpcError('PLUGIN_DISPOSED', { pluginId: options.pluginId, hook: name });
      // 同一 VM 不许并发进（契约二）：钩子可能正挂在异步宿主调用上（asyncify 挂着、job 泵在跑），
      // 这时再进一个阶段就是两条挂起 + 两条泵叠在同一个运行时上 —— 状态机直接错乱，
      // 而且 `deadline.setDeadline` 会被后者覆盖（前一个钩子的预算凭空变形）。
      // fail-closed 报 PLUGIN_BUSY（`busyWith` 说明是谁在跑），不排队：调用方本就串行。
      if (busy) {
        throw new SpcError('PLUGIN_BUSY', { pluginId: options.pluginId, hook: name, busyWith });
      }
      if (!namespace) throw new SpcError('PLUGIN_NO_ENTRY', { pluginId: options.pluginId, hook: name });
      await invoke('hook', name, name, timeoutMs);
    },

    hasEndpointHandler(path: string) {
      if (!namespace) return false;
      const endpointsObj = vm.getProp(namespace, 'endpoints');
      try {
        if (vm.typeof(endpointsObj) !== 'object') return false;
        const h = vm.getProp(endpointsObj, path);
        try {
          return vm.typeof(h) === 'function';
        } finally {
          h.dispose();
        }
      } finally {
        endpointsObj.dispose();
      }
    },

    async callEndpoint(path, paramsJson, bytes, timeoutMs, callId) {
      return callEndpoint(path, paramsJson, bytes, timeoutMs, callId);
    },

    lastSuspendedMs() {
      return lastSuspendedMs;
    },

    isBusy() {
      return busy;
    },

    dispose() {
      if (disposed) return; // 幂等：stop 失败路径与正常卸载路径都可能调到这里
      disposed = true;
      // ⚠️ **正在跑阶段时（含挂在异步宿主调用上）不许现在拆**：WASM 栈还摊开着（asyncify unwind），
      // 这时 `vm.dispose()`/`runtime.dispose()` 会在收尾命中 GC 断言
      // （`JS_FreeRuntime` 的 `assert(list_empty(&rt->gc_obj_list))`，`vendor/quickjs/quickjs.c:2036`）
      // 直接把整个进程 Abort —— 一个插件的卸载不该带走核心。
      // 于是先标记 `disposed`（后续调用立刻 `PLUGIN_DISPOSED`，行为上"已经卸载了"），
      // 真正拆 VM 交给在飞阶段收尾的 `endPhase()` 接手；这一步**有硬上限**：
      // 每个 async 宿主调用都受阶段剩余预算封顶（见 `asyncHostCall`），阶段一定会收尾。
      if (busy) {
        teardownPending = true;
        return;
      }
      teardown();
    },
  };
}
