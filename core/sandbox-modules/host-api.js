// @host/api 模块源码（沙箱内注入的模块正文）
//
// 为什么是"真实文件 + 占位符"而不是 TypeScript 里拼模板串：
//   1) QuickJS 的模块加载器只接受**源码文本**（quickjs-emscripten 把返回值转成 C 字符串指针，
//      不暴露字节码 / JSModuleDef 级接口），所以"生成"这一步无法避免；
//   2) 但生成的部分可以只剩**导出清单**——本文件的逻辑全部静态可评审、可高亮、可单测；
//   3) 下一阶段的官方模块仿真（node:fs / node:path / …）延用同一模式：一个模块一个真实文件，
//      注册进 core/sandbox.ts 的模块白名单。
//
// 生成方式：core/sandbox.ts 读取本文件，把下方 __SPC_EXPORTS__ 标记替换成实际导出语句。
// **本文件自己实现的组**（kv / timers）由 core/sandbox.ts 的 SELF_IMPLEMENTED_GROUPS 跳过生成，
// 因为它们需要 JSON 编解码与回调注册，不能直接套 __wrap。
// 运行环境约束：QuickJS 纯 ES2020 语义——**没有 Node API、没有 require、没有 process**。

/**
 * 桥契约（参数）：允许插件按原生写法传数组/对象——非字符串参数在这里序列化成
 * `__spcJson:<JSON>` 再交给宿主（宿主侧用 core/exec/request.ts 的 decodeBridgeArg 还原）。
 * 字符串原样传递，因此既有调用完全不受影响。
 */
const __JSON_PREFIX = '__spcJson:';
const __marshal = (a) => (typeof a === 'string' ? a : __JSON_PREFIX + JSON.stringify(a === undefined ? null : a));

/**
 * 宿主桥把失败以"回执单"形式回传（JSON 文本 {__spcError:{code,params}}），
 * 这里翻译成带 code / params 的异常抛给插件。
 * 为什么不用 vm.throw：asyncify 模式下宿主函数抛出的异常会随正常返回值被吞掉
 * （@experimental 路径不可靠），所以错误一律走"返回值 + 沙箱内还原"。
 *
 * 判定收紧为"**只有键信封**"：单键 + __spcError 对象 + code 是字符串才算错误，
 * 避免插件自己的数据里出现 `__spcError` 字样时被误判（旧实现只看 indexOf）。
 */
const __unwrap = (raw) => {
  if (typeof raw !== 'string' || raw.indexOf('__spcError') === -1) return raw;
  let env = null;
  try {
    env = JSON.parse(raw);
  } catch {
    return raw; // 不是 JSON（普通字符串结果），原样返回
  }
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const keys = Object.keys(env);
    if (keys.length === 1 && keys[0] === '__spcError' && env.__spcError && typeof env.__spcError.code === 'string') {
      const err = new Error(env.__spcError.code);
      err.code = env.__spcError.code;
      if (env.__spcError.params) err.params = env.__spcError.params;
      throw err;
    }
  }
  return raw;
};

const __wrap = (fn) => (...args) => __unwrap(fn(...args.map(__marshal)));

/**
 * 需要**返回值 JSON 解码**的方法组用这个包装（fs / lifecycle / events …）。
 * 桥只有字符串：对象/数组/数字结果都是 JSON 文本回传，插件侧统一在这里还原成真值，
 * 免得每个插件都要 `JSON.parse(fs.read(...))`。
 * exec 例外：它的返回值本身是带 stdout/stderr 的文本协议，由插件自己解析（见 exec.run 文档）。
 */
const __json = (fn) => (...args) => {
  const raw = __unwrap(fn(...args.map(__marshal)));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
};

/**
 * kv：插件作用域持久化存储（宿主侧 <dataDir>/kv.json）。
 * 值用 JSON 编解码，插件因此可以直接存取对象/数组；键必须是字符串。
 * 权限点：kv.read / kv.write（scope=self —— 碰的是插件自己的数据，不需要管理员授予）。
 */
export const kv = {
  get(key) {
    const raw = __unwrap(globalThis.__host['kv.get'](String(key)));
    return raw === null || raw === undefined || raw === 'null' ? undefined : JSON.parse(raw);
  },
  set(key, value) {
    return JSON.parse(__unwrap(globalThis.__host['kv.set'](String(key), JSON.stringify(value === undefined ? null : value))));
  },
  delete(key) {
    return JSON.parse(__unwrap(globalThis.__host['kv.delete'](String(key))));
  },
  keys() {
    return JSON.parse(__unwrap(globalThis.__host['kv.keys']()));
  },
};

/**
 * timers：宿主侧调度，**插件不保活**（定时器 unref，不阻止核心退出）。
 *
 * 回调注册在沙箱内：桥只传字符串，所以这里给每个回调分配一个 id 交给宿主，
 * 宿主到点回来调 `__spcTimerInvoke(id, ctx)`（引导层提供，见 core/sandbox.ts 的 BOOTSTRAP）。
 * 回调函数拿不到 ctx 之外的任何东西——它就是一个普通插件函数。
 *
 * 注册表在**引导层**（`globalThis.__spcTimerCallbacks`），不在这里：宿主在 createSandbox 时
 * 就要抓住 `__spcTimerInvoke` 的句柄，而本模块是 runModule 时才求值的。
 */
let __timerSeq = 0;
/** timerId（宿主给的）→ callbackId（本模块给的），clear 时两边一起清 */
const __timerIds = new Map();

export const timers = {
  every(intervalMs, fn) {
    if (typeof fn !== 'function') {
      const e = new Error('TIMER_HANDLER_INVALID');
      e.code = 'TIMER_HANDLER_INVALID';
      throw e;
    }
    const callbackId = String(++__timerSeq);
    globalThis.__spcTimerCallbacks.set(callbackId, fn);
    try {
      const handle = JSON.parse(__unwrap(globalThis.__host['timers.every'](String(intervalMs), callbackId)));
      __timerIds.set(String(handle.timerId), callbackId);
      return handle;
    } catch (e) {
      // 调度失败就别留着这个回调
      globalThis.__spcTimerCallbacks.delete(callbackId);
      throw e;
    }
  },
  clear(timerId) {
    const key = String(timerId);
    const result = JSON.parse(__unwrap(globalThis.__host['timers.clear'](key)));
    const callbackId = __timerIds.get(key);
    if (callbackId !== undefined) {
      globalThis.__spcTimerCallbacks.delete(callbackId);
      __timerIds.delete(key);
    }
    return result;
  },
};

// __SPC_EXPORTS__
