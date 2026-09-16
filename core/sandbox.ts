import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import {
  isFail,
  isSuccess,
  newQuickJSAsyncWASMModule,
  Scope,
  type QuickJSAsyncRuntime,
  type QuickJSHandle,
} from 'quickjs-emscripten';
import { audit, digest, digestParams } from './audit';
import { DEFAULT_LIMITS, type PluginLimits } from './config';
import { SpcError, toErrorShape } from './errors';
import { checkPermission } from './permissions/check';
import { registry } from './permissions/registry';
import {
  applyLimits,
  classifyVmFailure,
  failureCodeFor,
  installDeadlineHandler,
  pumpJobs,
  timeoutCodeFor,
  type HookName,
  type VmFailure,
} from './plugin/limits';
import { isRegistered, normalizeSpecifier, shimFileName } from './sandbox-modules/registry';

/** 沙箱对象（P1.5） */
export interface Sandbox {
  /** 加载 ESM bundle；成功后保留模块命名空间（后续钩子从这里取导出） */
  runModule(name: string, source: string): Promise<void>;
  /** 该导出是否存在且为函数（导出契约校验 / theme 豁免分支用；不抛错） */
  hasFunctionExport(name: string): boolean;
  /** 调用插件钩子 init/start/stop（CPU 中断 + job 泵 + 上下文注入） */
  callHook(name: 'init' | 'start' | 'stop', timeoutMs: number): Promise<void>;
  /** 是否正在执行插件代码（定时器回调据此避让，避免重入同一 VM） */
  isBusy(): boolean;
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
const JSON_RESULT_GROUPS = new Set(['fs', 'lifecycle', 'events']);

/**
 * 沙箱内引导代码：装两个宿主可用、插件不可见的内部函数。
 * - `__spcMakeCtx`：把 ctx 事实 JSON + logger 组装成**深度冻结**的上下文对象
 *   （冻结在沙箱侧做，宿主只传 JSON——这样"只读快照"是 VM 语义保证的，不是靠约定）；
 * - `__spcInvoke`：统一同步/异步钩子的调用与错误落点。
 *   为什么要它：桥只传字符串，宿主不该去猜"返回值是不是 Promise"；
 *   让 VM 自己把结果归一化成 {status, error}，宿主只泵 job + 读状态。
 */
const BOOTSTRAP = `
(function () {
  function freeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      var keys = Object.keys(o);
      for (var i = 0; i < keys.length; i++) freeze(o[keys[i]]);
    }
    return o;
  }
  globalThis.__spcMakeCtx = function (factsJson, logger) {
    var facts = JSON.parse(factsJson);
    facts.logger = logger;
    return freeze(facts);
  };
  globalThis.__spcInvoke = function (fn, ctx) {
    var state = { status: 'done', error: null };
    try {
      var r = fn(ctx);
      if (r && typeof r.then === 'function') {
        state.status = 'async';
        r.then(
          function () { state.status = 'done'; },
          function (e) { state.status = 'error'; state.error = e === undefined ? { message: 'rejected' } : e; }
        );
      }
    } catch (e) {
      state.status = 'error';
      state.error = e === undefined ? { message: 'thrown' } : e;
    }
    return state;
  };
  // 定时器回调注册表由**引导层**拥有（@host/api 只往里登记）。
  // 为什么不在模块里定义 __spcTimerInvoke：模块是 runModule 时才求值的，而宿主在
  // createSandbox 时就要抓住这个函数句柄——那时模块还不存在，抓到的会是 undefined。
  globalThis.__spcTimerCallbacks = new Map();
  globalThis.__spcTimerInvoke = function (id, ctx) {
    var fn = globalThis.__spcTimerCallbacks.get(String(id));
    if (typeof fn !== 'function') {
      return { status: 'error', error: { message: 'TIMER_HANDLER_MISSING' } };
    }
    return globalThis.__spcInvoke(fn, ctx);
  };
})();
`;

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
  /** manifest.permissions 提取的权限请求（可含通配） */
  permissions: string[];
  /** 管理员逐点授予的权限点（精确；宿主侧唯一真相，见 plugin-signature-design.md §9） */
  grants?: string[];
  /** 四层限额（缺省用 DEFAULT_LIMITS） */
  limits?: PluginLimits;
  facts?: SandboxFacts;
  /** 插件日志出口（缺省打宿主 console，带插件前缀） */
  logger?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 定时器回填桥 */
  bridge?: SandboxBridge;
}

/** 生成 @host/api 的导出清单（模块正文来自 sandbox-modules/host-api.js，按方法组分组） */
function exportLines(apiKeys: string[]): string {
  const groups = new Map<string, string[]>();
  for (const key of apiKeys) {
    const idx = key.indexOf('.');
    const g = idx === -1 ? key : key.slice(0, idx);
    if (SELF_IMPLEMENTED_GROUPS.has(g)) continue; // 该组在模块文件里自己实现
    const prop = idx === -1 ? key : key.slice(idx + 1);
    const wrap = JSON_RESULT_GROUPS.has(g) ? '__json' : '__wrap';
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
function moduleSource(moduleName: string, apiKeys: string[]): string | null {
  if (moduleName === '@host/api') {
    return HOST_API_SOURCE.replace(EXPORTS_MARKER, exportLines(apiKeys));
  }
  if (isRegistered(moduleName)) {
    return shimSource(normalizeSpecifier(moduleName));
  }
  return null;
}

/** shim 源码按需读取 + 缓存（一个模块一个真实文件，见 registry.ts 的文件名约定） */
const shimCache = new Map<string, string>();
function shimSource(canonical: string): string {
  let source = shimCache.get(canonical);
  if (source === undefined) {
    const url = new URL(`./sandbox-modules/${shimFileName(canonical)}`, import.meta.url);
    source = readFileSync(url, 'utf8');
    shimCache.set(canonical, source);
  }
  return source;
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
  const base = { pluginId, hook, ...(extra ?? {}) };
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

export async function createSandbox(api: HostApi, options: SandboxOptions): Promise<Sandbox> {
  const limits: PluginLimits = options.limits ?? DEFAULT_LIMITS;
  const log =
    options.logger ??
    ((level: 'info' | 'warn' | 'error', message: string) => {
      console[level](`[${options.pluginId}] ${message}`);
    });

  // asyncify 变体：宿主 API 可返回 Promise（exec/网络必须异步，见设计结论）
  // 注：quickjs-emscripten@0.32.0 的 asyncify newRuntime 释放顺序有 bug（deleteRuntime 先于
  // QTS_FreeRuntime），上游 Issue #261（justjake/quickjs-emscripten，OPEN）已确认：
  // https://github.com/justjake/quickjs-emscripten/issues/261
  // 本地通过 pnpm patch（patches/quickjs-emscripten-core.patch）修复，回归测试见
  // scripts/verify-quickjs-patch.mjs（pnpm verify:sandbox）
  const runtime = await newRuntimeForSandbox();

  // 四层限额：内存 + 栈在这里落地；CPU 用 deadline 中断（下面装 handler），
  // "挂起"那层由宿主 API 自带超时负责（exec 的 timeoutMs 是样板）。
  applyLimits(runtime, limits);
  const deadline = installDeadlineHandler(runtime);

  // ESM 加载器（v0.32 API）：loader 返回模块"源码字符串"
  // 白名单外模块一律拒绝——零环境权力的执行点
  runtime.setModuleLoader((moduleName: string): string => {
    const src = moduleSource(moduleName, Object.keys(api));
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
  });

  const vm = runtime.newContext();
  const scope = new Scope(); // 统一管理宿主侧创建的 handle，dispose 时按序释放

  // 注入 __host 全局（宿主调用桥：沙箱内唯一的能力来源）
  const hostObj = scope.manage(vm.newObject());
  for (const [name, method] of Object.entries(api)) {
    const wrapped = scope.manage(
      vm.newFunction(`host.${name}`, (...args) => {
        const start = Date.now();
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
            return vm.newString(
              hostErrorPayload('INVALID_ARGS', { reason: 'binary-arg-not-arraybuffer' }),
            );
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
          audit({
            ts: Date.now(),
            pluginId: options.pluginId,
            method: name,
            target: typeof strings[0] === 'string' ? strings[0] : undefined,
            paramsDigest: callDigest,
            result: 'denied',
            permission: { decision: 'deny', code: shape.code, paramsDigest: digestParams(shape.params) },
            durationMs: Date.now() - start,
          });
          return vm.newString(hostErrorPayload(shape.code, shape.params));
        }

        // ② 权限判定（宿主侧强制 + 审计）；判定只记码与参数摘要，不记本地化文本
        const check = checkPermission(registry, requested, options.permissions, options.grants ?? []);
        if (check.decision === 'deny') {
          audit({
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
          return vm.newString(
            hostErrorPayload('PERMISSION_DENIED', {
              permission: requested,
              reason: check.code,
            }),
          );
        }

        // ③ 执行宿主实现
        try {
          const result = method.fn(...raw);
          // 二进制结果走 newArrayBuffer（一次拷贝）；其余仍是 JSON 文本信封。
          // 失败路径**一律**回字符串信封，于是沙箱侧可以按「ArrayBuffer = 数据 / 字符串 = 错误」区分。
          const bytes = method.binaryResult ? toExactBytes(result) : null;
          const serialized = bytes ? null : JSON.stringify(result ?? null);
          audit({
            ts: Date.now(),
            pluginId: options.pluginId,
            method: name,
            target: requested,
            paramsDigest: callDigest,
            result: 'ok',
            permission: {
              decision: 'allow',
              code: check.code,
              paramsDigest: digestParams(check.params),
            },
            resultBytes: bytes ? bytes.byteLength : Buffer.byteLength(serialized as string),
            durationMs: Date.now() - start,
          });
          return bytes ? vm.newArrayBuffer(bytes) : vm.newString(serialized as string);
        } catch (err) {
          // 宿主错误 → 英文码 + 参数摘要入审计；插件面拿到 code/params（未分类错误记 INTERNAL）
          const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
          audit({
            ts: Date.now(),
            pluginId: options.pluginId,
            method: name,
            target: requested,
            paramsDigest: callDigest,
            result: 'error',
            permission: {
              decision: 'allow',
              code: check.code,
              paramsDigest: digestParams(check.params),
            },
            error: { code: shape.code, paramsDigest: digestParams(shape.params) },
            durationMs: Date.now() - start,
          });
          return vm.newString(hostErrorPayload(shape.code, shape.params));
        }
      }),
    );
    vm.setProp(hostObj, name, wrapped);
  }
  vm.setProp(vm.global, '__host', hostObj);

  // 注入最小 console（QuickJS 沙箱默认无 console）
  const consoleObj = scope.manage(vm.newObject());
  for (const level of ['log', 'error', 'warn', 'info'] as const) {
    const fn = scope.manage(
      vm.newFunction(`console.${level}`, (...args) => {
        console[level](...args.map((h) => vm.getString(h)));
        return vm.undefined;
      }),
    );
    vm.setProp(consoleObj, level, fn);
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
  const ctxFactory = scope.manage(vm.getProp(vm.global, '__spcMakeCtx'));
  const invokeFn = scope.manage(vm.getProp(vm.global, '__spcInvoke'));
  const timerInvokeFn = scope.manage(vm.getProp(vm.global, '__spcTimerInvoke'));

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
      dataDir: process.cwd(),
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
   * 统一的钩子/定时器回调调用：
   * 设 deadline → 调 __spcInvoke / __spcTimerInvoke → 泵 job → 读归一化状态 → 归类失败。
   */
  async function invoke(
    kind: 'hook' | 'timer',
    name: string,
    hook: HookName,
    timeoutMs: number,
  ): Promise<void> {
    busy = true;
    const dl = Date.now() + timeoutMs;
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
        const pump = pumpJobs(runtime, dl);
        if (pump.status === 'failed') {
          throw hookError(options.pluginId, hook, pump.failure);
        }
        const status = readProp(state, 'status');
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
    } finally {
      deadline.setDeadline(Number.POSITIVE_INFINITY);
      busy = false;
    }
  }

  /** 定时器回调：与钩子同样的限额；失败只落审计，不改变插件状态（由 manager 决定策略） */
  async function runTimer(callbackId: string, timerId: string): Promise<void> {
    if (busy || disposed) return; // 重入保护：正在执行插件代码就跳过一次，绝不并发进同一 VM
    const started = Date.now();
    try {
      await invoke('timer', callbackId, 'timer', limits.timerTimeoutMs);
      audit({
        ts: Date.now(),
        pluginId: options.pluginId,
        method: 'timers.tick',
        target: timerId,
        paramsDigest: digest(callbackId),
        result: 'ok',
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
      audit({
        ts: Date.now(),
        pluginId: options.pluginId,
        method: 'timers.tick',
        target: timerId,
        paramsDigest: digest(callbackId),
        result: 'error',
        error: { code: shape.code, paramsDigest: digestParams(shape.params) },
        durationMs: Date.now() - started,
      });
    }
  }

  // 回填桥：hostApi 的 timers.* 转发到这里（此时 VM 已就绪）
  if (options.bridge) {
    options.bridge.timers = {
      every(intervalMs: number, callbackId: string) {
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 86_400_000) {
          throw new SpcError('TIMER_INTERVAL_INVALID', { intervalMs: String(intervalMs) });
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
      // import 语句自动走 setModuleLoader；evalCodeAsync 返回 SuccessOrFail<QuickJSHandle>
      //
      // **必须显式传 `{ type: 'module' }`**：不传时 quickjs-emscripten 会打开模块自动探测
      // （QTS_Eval_MaybeAsync 的 detectModule=1 → `JS_DetectModule`），而它**只看第一个 token**
      // （quickjs.c:23792）。esbuild 会把导出提升到文件末尾（`function init(){}` + `export { init };`），
      // 于是首 token 是 `function` → 判成脚本模式 → `unsupported keyword: export`。
      // 插件契约本来就是 ESM-only（ADR-005），显式声明模块模式既正确又不再依赖首 token 的运气。
      const started = Date.now();
      // **装载也必须计时**：顶层代码同样是插件代码，`while(true)` 可以就写在这里。
      // 少了这段 deadline，一个死循环会把整个核心占死——无超时、无审计、无恢复路径。
      // 与钩子同一套做法：设 deadline → 无论成败都在 finally 复位（复位成 Infinity 即"永不触发"）。
      deadline.setDeadline(started + limits.loadTimeoutMs);
      let result;
      try {
        result = await vm.evalCodeAsync(source, 'plugin.js', { type: 'module' });
      } finally {
        deadline.setDeadline(Number.POSITIVE_INFINITY);
      }
      if (isSuccess(result)) {
        // 命名空间句柄**保留**（钩子从这里取导出），由 Scope 在 dispose 时释放
        namespace = scope.manage(result.value);
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
      audit({
        ts: Date.now(),
        pluginId: options.pluginId,
        method: 'lifecycle.load',
        paramsDigest: digest(name),
        result: 'error',
        error: {
          code: err.code,
          paramsDigest: digestParams({ cause: err.params.cause ?? err.code }),
        },
        durationMs: Date.now() - started,
      });
      throw err;
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
      if (!namespace) throw new SpcError('PLUGIN_NO_ENTRY', { pluginId: options.pluginId, hook: name });
      await invoke('hook', name, name, timeoutMs);
    },

    isBusy() {
      return busy;
    },

    dispose() {
      if (disposed) return; // 幂等：stop 失败路径与正常卸载路径都可能调到这里
      disposed = true;
      for (const handle of timers.values()) clearInterval(handle);
      timers.clear();
      deadline.setDeadline(Number.POSITIVE_INFINITY);
      scope.dispose(); // 先释放宿主侧 handle
      vm.dispose();
      runtime.dispose();
    },
  };
}
