// node:process 仿真——**只读环境事实 + 极小的宿主交互面**
//
// 依赖里 `process` 几乎无处不在，但真正被用到的就那么几样（实测：`debug`/`ora` 一类只用
// `platform`/`versions`/`stdout.isTTY`/`env`）。这里按"能诚实回答的就回答、不能的就抛错"来做，
// 而不是把 Node 的 `process` 抄一遍——**抄一半的 process 比明确的报错危险得多**。
//
// 三条边界，写清楚免得被当 bug：
//   1. **环境事实固定为仿真基线**（platform/arch/version/versions）：与 `os`、`path`(posix)、
//      常量表同一取向，取值出处见 core/emulated-env.ts。`process.versions` 只报 `node` + `spc`，
//      **不编造** `v8`/`openssl` 那些（报了就等于承诺了不存在的实现）；
//   2. **`env` 是冻结的空对象**：沙箱里没有环境变量（宿主 env 可能含凭据，暴露面太大）；
//      将来要白名单再谈权限点，现在给空对象是**唯一诚实**的答案；
//   3. **不做**（明确抛错）：`exit`/`abort`/`kill`/`chdir`/`hrtime`/`uptime`/`memoryUsage`/
//      `cpuUsage`/`resourceUsage`/`getuid` 系列/`binding`/`dlopen`/`setUncaughtExceptionCaptureCallback`。
//      信号事件（`process.on('SIGINT')`）也抛错——设计文档 §9 已定"信号不做"，静默注册一个
//      永不触发的监听器，正是这个项目在 events 那轮吃过的亏（`newListener` 静默不触发）。
//
// 唯一由核心**主动触发**的事件是 `'exit'`：沙箱销毁前发一次（落点在 `__spcDisposeHooks`，
// 见 core/sandbox.ts 的引导层），于是 `process.on('exit', () => flush())` 这类常见写法是真的会跑的。
//
// 内联约束：静态、无占位符；事实只能运行时从 `globalThis.__spcEnv` 取。
import { EventEmitter } from './node-events.js';

const FACTS = JSON.parse(globalThis.__spcEnv);
if (!FACTS || typeof FACTS !== 'object') {
  const err = new Error('sandbox env facts missing (globalThis.__spcEnv)');
  err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
  throw err;
}

function unsupported(name, why) {
  const fn = function () {
    const err = new Error('process.' + name + ' is not supported in the sandbox (' + why + ')');
    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
    throw err;
  };
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

/** 信号事件名（`SIGINT`/`SIGTERM`…）：沙箱没有信号，注册它只会得到一个永不触发的监听器 */
const SIGNAL_EVENT = /^SIG[A-Z0-9]+$/;

/** 写出口：沙箱里没有真终端，所有写都汇到插件日志（`stdout.isTTY` 恒 false，与 `node:tty` 一致） */
function makeWriteStream(level) {
  const stream = new EventEmitter();
  stream.write = function (chunk) {
    // 形状照 Node：`write(chunk[, encoding][, callback])`，返回值是"要不要继续写"（我们从不背压）
    const args = Array.prototype.slice.call(arguments);
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    globalThis.console[level](text.replace(/\n$/, ''));
    if (cb) cb();
    return true;
  };
  stream.end = function () {};
  stream.isTTY = false;
  stream.columns = 80;
  stream.rows = 24;
  stream.fd = level === 'error' ? 2 : 1;
  return stream;
}

/** `process` 本体：Node 里它就是个 EventEmitter 实例，这里保持同一形态 */
const process = new EventEmitter();

process.platform = FACTS.platform;
process.arch = FACTS.arch;
process.version = 'v' + FACTS.nodeVersion;
// 只报我们真有的：`node` 是仿真版本，`spc` 是核心自己的版本位（宿主不告诉我们具体号，
// 这里是占位字符串，语义是"这是沙箱"）。**不编造 v8/openssl**：报了就是承诺了不存在的实现。
process.versions = Object.freeze({ node: FACTS.nodeVersion, spc: 'sandbox' });
process.pid = FACTS.pid;
process.execPath = 'node';
process.argv = Object.freeze(['node', 'plugin.js']);
/** 沙箱不退出：写它只作记录（读得回来），不会真的影响任何东西——注释写清楚免得有人依赖它 */
process.exitCode = 0;
// 冻结的**空**对象（普通对象，不是 null 原型）：`process.env.hasOwnProperty(...)` 这类写法不该炸
process.env = Object.freeze({});

process.cwd = function cwd() {
  return FACTS.dataDir;
};
process.nextTick = function nextTick(fn) {
  const args = Array.prototype.slice.call(arguments, 1);
  // 沙箱里没有真正的 nextTick 队列；微任务语义最接近（Node 的 nextTick 也先于宏任务）。
  // 差异写在文件头"已知边界"级别：不追求与 Node 的 nextTick/promise 交织顺序完全一致。
  queueMicrotask(function () {
    fn.apply(null, args);
  });
};
process.emitWarning = function emitWarning(warning, options) {
  const message = typeof warning === 'string'
    ? warning
    : (warning && warning.message) || String(warning);
  const name = typeof options === 'string' ? options : (options && options.type) || 'Warning';
  globalThis.console.warn(name + ': ' + message);
};
process.stdout = makeWriteStream('log');
process.stderr = makeWriteStream('error');

process.exit = /* @__PURE__ */ unsupported('exit', 'plugin lifetime is managed by the core (init/start/stop)');
process.abort = /* @__PURE__ */ unsupported('abort', 'plugin lifetime is managed by the core');
process.kill = /* @__PURE__ */ unsupported('kill', 'sending signals is a host capability');
process.chdir = /* @__PURE__ */ unsupported('chdir', 'the sandbox has no working directory of its own');
process.hrtime = /* @__PURE__ */ unsupported('hrtime', 'no monotonic clock is exposed yet');
process.uptime = /* @__PURE__ */ unsupported('uptime', 'process uptime is not tracked in the sandbox');
process.memoryUsage = /* @__PURE__ */ unsupported('memoryUsage', 'heap accounting is not exposed yet');
process.cpuUsage = /* @__PURE__ */ unsupported('cpuUsage', 'cpu accounting is not exposed yet');
process.resourceUsage = /* @__PURE__ */ unsupported('resourceUsage', 'resource accounting is not exposed yet');
process.umask = /* @__PURE__ */ unsupported('umask', 'file modes are not configurable from the sandbox');
process.binding = /* @__PURE__ */ unsupported('binding', 'internal bindings are never exposed');
process.dlopen = /* @__PURE__ */ unsupported('dlopen', 'native addons are never exposed');
process.setUncaughtExceptionCaptureCallback = /* @__PURE__ */ unsupported(
  'setUncaughtExceptionCaptureCallback',
  'hook failures are reported to the core, not to the plugin',
);
process.getuid = /* @__PURE__ */ unsupported('getuid', 'host identity is not exposed to plugins');
process.getgid = /* @__PURE__ */ unsupported('getgid', 'host identity is not exposed to plugins');
process.geteuid = /* @__PURE__ */ unsupported('geteuid', 'host identity is not exposed to plugins');
process.getegid = /* @__PURE__ */ unsupported('getegid', 'host identity is not exposed to plugins');
process.setuid = /* @__PURE__ */ unsupported('setuid', 'privilege changes are never exposed');
process.setgid = /* @__PURE__ */ unsupported('setgid', 'privilege changes are never exposed');

// 信号事件：注册即抛错（见文件头第 3 条），而不是留一个永不触发的监听器
for (const method of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']) {
  const original = process[method].bind(process);
  process[method] = function (event) {
    if (typeof event === 'string' && SIGNAL_EVENT.test(event)) {
      const err = new Error('process.on("' + event + '") is not supported in the sandbox (signals are not delivered)');
      err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
      throw err;
    }
    return original.apply(null, arguments);
  };
}

// 卸载时发一次 'exit'：核心在销毁沙箱前调用（句柄在 core/sandbox.ts 的引导层）
globalThis.__spcDisposeHooks.push(function () {
  process.emit('exit', process.exitCode);
});

export default process;

/**
 * 具名导出 = 对象自身的全部公开面。
 *
 * 为什么必须补齐：`node:process` 在 Node 里是 CJS，`import * as p from 'node:process'` 拿到的命名空间
 * **含** `stdout`/`exit`/`on` 这些（CJS 互操作会把 module.exports 的自有属性做成具名导出）。
 * 只导出几个"事实"字段的话，`import { stdout } from 'node:process'` 会得到 undefined —— 表面上看
 * 是"少导出了一个名字"，实际是把插件的 `process.stdout.write(...)` 变成 TypeError。
 */
export const {
  stdout,
  stderr,
  exit,
  abort,
  kill,
  chdir,
  hrtime,
  uptime,
  memoryUsage,
  cpuUsage,
  resourceUsage,
  umask,
  binding,
  dlopen,
  getuid,
  getgid,
  geteuid,
  getegid,
  setuid,
  setgid,
  setUncaughtExceptionCaptureCallback,
  exitCode,
  // EventEmitter 面（Node 的 process 自身就继承它）
  on,
  once,
  off,
  addListener,
  removeListener,
  prependListener,
  prependOnceListener,
  removeAllListeners,
  emit,
  listeners,
  rawListeners,
  listenerCount,
  eventNames,
  setMaxListeners,
  getMaxListeners,
} = process;

// 事实字段（`process` 对象上已赋值，这里按 Node 的具名导出一致性再导出一次）
export const platform = process.platform;
export const arch = process.arch;
export const version = process.version;
export const versions = process.versions;
export const env = process.env;
export const pid = process.pid;
export const argv = process.argv;
export const execPath = process.execPath;
export const nextTick = process.nextTick;
export const emitWarning = process.emitWarning;
export const cwd = process.cwd;
