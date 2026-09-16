// node:events 仿真——EventEmitter
//
// 依赖生态里 `EventEmitter` 几乎是通用基类（`ws`、`chokidar`、`pino` 一类都继承它），
// 所以这一块要对齐的不只是几个方法，还有**几条容易被忽略的语义**：
//   · `on`/`off`/`once` 返回 `this`（链式写法很常见）
//   · `emit` 返回"当时有没有监听器"的布尔值（不少库靠它决定要不要走降级分支）
//   · `emit('error', err)` 且无监听器 → **把 err 抛出去**（Node 的硬规矩，静默吞掉会掩盖故障）
//   · `listeners()` 返回**原始函数**，`rawListeners()` 才返回 once 包装器
//
// 内联约束：静态、无占位符。本模块**不碰宿主**（纯计算）。

const kOnce = Symbol('spc.once');
const kOriginal = Symbol('spc.original');

function assertListener(fn, name) {
  if (typeof fn !== 'function') {
    const err = new TypeError(
      'The "listener" argument must be of type function. Received ' +
        (fn === null ? 'null' : typeof fn) +
        (name === undefined ? '' : ' for event "' + name + '"'),
    );
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
}

/** 非 Error 值在 `Unhandled error. (…)` 里的展示形式（对齐 Node：字符串带引号） */
function describe(value) {
  return typeof value === 'string' ? "'" + value + "'" : String(value);
}

export class EventEmitter {
  constructor(options) {
    this._events = Object.create(null);
    // 不在这里取 defaultMaxListeners 的值：Node 是**惰性继承**的——
    // 构造时不设，getMaxListeners() 每次现读静态属性。快照会让后续改静态值不生效。
    this._maxListeners =
      options && typeof options.maxListeners === 'number' ? options.maxListeners : undefined;
    this.captureRejections = !!(options && options.captureRejections);
  }

  _list(event) {
    const list = this._events[event];
    return Array.isArray(list) ? list : list === undefined ? undefined : [list];
  }

  _store(event, list) {
    if (list === undefined || list.length === 0) delete this._events[event];
    else this._events[event] = list.length === 1 ? list[0] : list;
  }

  _add(event, fn, prepend, once) {
    assertListener(fn, event);
    const entry = once ? makeOnceWrapper(this, event, fn) : fn;
    const current = this._list(event);
    const list = current === undefined ? [] : current.slice();
    if (prepend) list.unshift(entry);
    else list.push(entry);
    this._store(event, list);
    return this;
  }

  on(event, fn) {
    return this._add(event, fn, false, false);
  }
  addListener(event, fn) {
    return this._add(event, fn, false, false);
  }
  prependListener(event, fn) {
    return this._add(event, fn, true, false);
  }
  once(event, fn) {
    return this._add(event, fn, false, true);
  }
  prependOnceListener(event, fn) {
    return this._add(event, fn, true, true);
  }

  removeListener(event, fn) {
    assertListener(fn, event);
    const current = this._list(event);
    if (current === undefined) return this;
    const list = current.slice();
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === fn || list[i][kOriginal] === fn) {
        list.splice(i, 1);
        break;
      }
    }
    this._store(event, list);
    return this;
  }
  off(event, fn) {
    return this.removeListener(event, fn);
  }

  removeAllListeners(event) {
    // 用 `arguments.length` 而不是判 undefined：Node 里**显式传 undefined** 只是删名为
    // `undefined` 的那个事件，而**不传参**才是"全清"。写成判 undefined 会让
    // `e.removeAllListeners(opts.event)`（opts.event 恰好是 undefined）**静默拆掉所有监听器**。
    if (arguments.length === 0) this._events = Object.create(null);
    else delete this._events[event];
    return this;
  }

  /**
   * 返回"当时有没有监听器"。
   * `'error'` 且无监听器时**必须抛出**——Node 靠这条把未处理的错误暴露出来，
   * 静默返回 false 会让依赖以为"错误已处理"。
   * 非 Error 值要包成带 `ERR_UNHANDLED_ERROR` 与 `context` 的错误（Node 的形状），
   * 否则靠 `e.code` / `e.context` 分支的调用方会走错路。
   */
  emit(event, ...args) {
    const list = this._list(event);
    if (event === 'error') {
      if (list === undefined || list.length === 0) {
        const err = args[0];
        if (err instanceof Error) throw err;
        const wrapped = new Error('Unhandled error. (' + describe(err) + ')');
        wrapped.code = 'ERR_UNHANDLED_ERROR';
        wrapped.context = err;
        throw wrapped;
      }
    }
    if (list === undefined || list.length === 0) return false;
    for (const fn of list.slice()) fn.apply(this, args);
    return true;
  }

  /** 原始函数（once 包装器**解包**后）——与 Node 一致 */
  listeners(event) {
    const list = this._list(event);
    if (list === undefined) return [];
    return list.map((fn) => fn[kOriginal] || fn);
  }

  /** 含 once 包装器——与 Node 一致 */
  rawListeners(event) {
    const list = this._list(event);
    return list === undefined ? [] : list.slice();
  }

  listenerCount(event, fn) {
    const list = this._list(event);
    if (list === undefined) return 0;
    // Node 用 `listener != null`：`null` 与"不传"**等价**。
    // 只判 undefined 的话，把可能为 null 的引用透传进来会得到 0 → 误判"没人监听"。
    if (fn === undefined || fn === null) return list.length;
    return list.filter((l) => l === fn || l[kOriginal] === fn).length;
  }

  eventNames() {
    return Reflect.ownKeys(this._events);
  }

  setMaxListeners(n) {
    if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
      const err = new RangeError('The value of "n" is out of range. It must be a non-negative number. Received ' + String(n));
      err.code = 'ERR_OUT_OF_RANGE';
      throw err;
    }
    this._maxListeners = n;
    return this;
  }
  getMaxListeners() {
    return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners;
  }

  // ── 静态面 ──
  static listenerCount(emitter, event) {
    return emitter.listenerCount(event);
  }
  /** `await once(emitter, 'x')`：等到事件（或 'error' 时拒绝） */
  static once(emitter, event) {
    return new Promise((resolve, reject) => {
      const onEvent = (...args) => {
        emitter.removeListener(event, onEvent);
        emitter.removeListener('error', onError);
        resolve(args);
      };
      const onError = (err) => {
        emitter.removeListener(event, onEvent);
        emitter.removeListener('error', onError);
        reject(err);
      };
      emitter.on(event, onEvent);
      if (event !== 'error') emitter.on('error', onError);
    });
  }
  static on(emitter, event) {
    // 异步迭代的极简实现：足够覆盖 `for await (const [v] of on(em, 'x'))`
    const queue = [];
    let done = false;
    let wake;
    emitter.on(event, (...args) => {
      queue.push(args);
      if (wake) wake();
    });
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          wake = () => resolve({ value: queue.shift(), done: false });
        });
      },
      return() {
        done = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

EventEmitter.defaultMaxListeners = 10;
EventEmitter.captureRejectionSymbol = Symbol.for('nodejs.rejection');
EventEmitter.errorMonitor = Symbol('events.errorMonitor');

/** once 包装器：调用一次后自动摘除；`.listener` 指回原函数（Node 的约定） */
function makeOnceWrapper(emitter, event, fn) {
  const wrapper = function (...args) {
    emitter.removeListener(event, wrapper);
    return fn.apply(this, args);
  };
  wrapper[kOriginal] = fn;
  wrapper.listener = fn;
  return wrapper;
}

export const once = EventEmitter.once;
export const on = EventEmitter.on;
export const addAbortListener = function (signal, listener) {
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
};
export default EventEmitter;
