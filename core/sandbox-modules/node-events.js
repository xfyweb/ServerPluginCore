// node:events 仿真——EventEmitter
//
// 依赖生态里 `EventEmitter` 几乎是通用基类（`ws`、`chokidar`、`pino` 一类都继承它），
// 所以这一块要对齐的不只是几个方法，还有**几条容易被忽略的语义**（都按 `lib/events.js` 复刻）：
//   · `on`/`off`/`once` 返回 `this`（链式写法很常见）
//   · `emit` 返回"当时有没有监听器"的布尔值（不少库靠它决定要不要走降级分支）
//   · `emit('error', err)` 且无监听器 → **把 err 抛出去**（Node 的硬规矩，静默吞掉会掩盖故障）
//   · `listeners()` 返回**原始函数**，`rawListeners()` 才返回 once 包装器
//   · **`newListener` / `removeListener` 元事件**（`events.js:559` / `:702`）——"第一个监听器到来时
//     惰性订阅"这种写法完全依赖它，缺了它那些代码**永远不会触发**，而且是静默的
//   · **`errorMonitor`**（`events.js:494`）：错误观测旁路，无论有没有 `'error'` 监听都要通知它
//   · **`captureRejections`**（`events.js:356`）：async 监听器的 rejection 会被送到 `'error'`
//     （或 `Symbol.for('nodejs.rejection')` 钩子），而不是变成未处理拒绝
//   · **静态 `on()` 异步迭代器**（`events.js:1085`）：`for await (const [v] of on(em,'x'))`
//   · **函数式构造器**：`util.inherits(Foo, EventEmitter)` + `EventEmitter.call(this)` 是 ES5 常态，
//     用 `class` 会让它直接抛（`Class constructor cannot be invoked without 'new'`），
//     而且 class 的方法**不可枚举**，与 Node 的普通赋值不一致
//
// 内联约束：静态、无占位符。本模块**不碰宿主**（纯计算）。
//
// **已知边界**（无法在沙箱里复刻，写在这里以免被当成 bug）：
//   · `MaxListenersExceededWarning`：Node 走 `process.emitWarning`，沙箱里没有 `process`
//     ——超限**不告警**，但监听器照常加（`defaultMaxListeners` 的读数与继承语义仍然对齐）
//   · `addCatch` 里 Node 用 `process.nextTick`，这里用微任务（`queueMicrotask`）代替；
//     差异只在"同一轮里的先后"，可观测结果一致
//   · `domain` / `EventEmitterAsyncResource` / `getEventListeners` / `addAbortListener` 的 AbortSignal
//     细节不在仿真范围（`addAbortListener` 只做最小实现）

const kCapture = Symbol('spc.capture');
const kRejection = Symbol.for('nodejs.rejection');

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

// ── 构造函数（函数式，见文件头 A18 说明）──

function EventEmitter(options) {
  EventEmitter.init.call(this, options);
}

/**
 * `init` 是**公开静态**的（Node 也是）：有些库会 `EventEmitter.init.call(this)` 二次初始化。
 * `this._events === 原型上的 _events` 这个判据让"子类已经初始化过"时不会把监听器清空
 * （`events.js:334`）——`EventEmitter.call(this)` 在 ES5 继承里非常常见，判错就是丢监听器。
 */
EventEmitter.init = function init(options) {
  if (this._events === undefined || this._events === Object.getPrototypeOf(this)._events) {
    this._events = Object.create(null);
    this._eventsCount = 0;
  }
  this._maxListeners = this._maxListeners || undefined;
  if (options && options.captureRejections !== undefined) {
    this[kCapture] = Boolean(options.captureRejections);
  } else {
    this[kCapture] = EventEmitter.prototype[kCapture];
  }
};

// 原型上的默认值。`_events` 这一个同时充当"是否已初始化"的判据（Node 同款，`events.js:256`）
EventEmitter.prototype._events = undefined;
EventEmitter.prototype._eventsCount = 0;
EventEmitter.prototype._maxListeners = undefined;
EventEmitter.prototype[kCapture] = false;

// ── 内部助手（模块级函数，不挂原型：Node 的原型上没有这些键）──

/** 该事件的监听器数组视图（内部**统一按数组**处理，存的是裸函数还是数组由 _events 决定） */
function listOf(emitter, type) {
  const list = emitter._events[type];
  return Array.isArray(list) ? list : list === undefined ? undefined : [list];
}

/** 取原始函数（once 包装器解包）——Node 用 `.listener` 这个约定属性 */
function unwrap(fn) {
  return fn.listener || fn;
}

/**
 * 加监听器（`events.js:545` `_addListener`）。
 * A14：`newListener` 必须在**加入之前**发；而且元事件处理器可能把 `_events` 整个换掉
 * （例如它自己 `removeAllListeners()`），所以发完要**重新读取** `_events`。
 */
function addListener(target, type, listener, prepend) {
  assertListener(listener, type);
  let events = target._events;
  if (events === undefined) {
    events = target._events = Object.create(null);
    target._eventsCount = 0;
  } else if (events.newListener !== undefined) {
    // 先发元事件再加：`type === 'newListener'` 时这条也是防递归的关键
    target.emit('newListener', type, unwrap(listener));
    events = target._events; // 处理器可能换掉了它
  }
  const existing = events[type];
  if (existing === undefined) {
    events[type] = listener;
    target._eventsCount++;
  } else if (typeof existing === 'function') {
    // 第二个监听器：裸函数 → 数组（Node 的存储形态就是这样，`_events` 的形状可观测）
    events[type] = prepend ? [listener, existing] : [existing, listener];
  } else if (prepend) {
    existing.unshift(listener);
  } else {
    existing.push(listener);
  }
  // Node 在这里检查 maxListeners 并发 `MaxListenersExceededWarning`：沙箱没有 process（见文件头）
  return target;
}

/** 摘监听器（`events.js:679` `removeListener`）：移除**之后**发 `removeListener` */
function removeListener(target, type, listener) {
  assertListener(listener, type);
  const events = target._events;
  if (events === undefined) return target;
  let list = events[type];
  if (list === undefined) return target;

  if (list === listener || list.listener === listener) {
    target._eventsCount--;
    if (target._eventsCount === 0) target._events = Object.create(null);
    else delete events[type];
    if (events.removeListener !== undefined) target.emit('removeListener', type, unwrap(list));
  } else if (typeof list !== 'function') {
    let position = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || list[i].listener === listener) {
        position = i;
        break;
      }
    }
    if (position < 0) return target;
    list.splice(position, 1);
    if (list.length === 1) events[type] = list[0];
    if (events.removeListener !== undefined) target.emit('removeListener', type, listener);
  }
  return target;
}

/**
 * A16：`captureRejections` 下把监听器返回的 thenable 的 rejection 送回 `'error'`
 * （`events.js:356` `addCatch`）。同步抛错**不**走这里——它照常冒泡（Node 同款）。
 */
function addCatch(that, promise, type, args) {
  if (!that[kCapture]) return;
  let then;
  try {
    then = promise.then; // 可能是 getter，取一次就抛（Node 也这么防）
  } catch (err) {
    that.emit('error', err);
    return;
  }
  if (typeof then !== 'function') return;
  then.call(promise, undefined, function (err) {
    queueMicrotask(function () {
      routeRejection(that, err, type, args);
    });
  });
}

/** 送进 rejection 钩子；没有钩子就送 `'error'`——送之前**临时关掉捕获**，否则会无限递归 */
function routeRejection(ee, err, type, args) {
  if (typeof ee[kRejection] === 'function') {
    ee[kRejection](err, type, ...args);
    return;
  }
  const prev = ee[kCapture];
  try {
    ee[kCapture] = false;
    ee.emit('error', err);
  } finally {
    ee[kCapture] = prev;
  }
}

// ── 公开方法（普通赋值 → 可枚举，与 Node 一致）──

EventEmitter.prototype.addListener = function addListenerMethod(type, listener) {
  return addListener(this, type, listener, false);
};
EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.prependListener = function prependListener(type, listener) {
  return addListener(this, type, listener, true);
};

EventEmitter.prototype.once = function once(type, listener) {
  assertListener(listener, type);
  return addListener(this, type, onceWrap(this, type, listener), false);
};

EventEmitter.prototype.prependOnceListener = function prependOnceListener(type, listener) {
  assertListener(listener, type);
  return addListener(this, type, onceWrap(this, type, listener), true);
};

EventEmitter.prototype.removeListener = function removeListenerMethod(type, listener) {
  return removeListener(this, type, listener);
};
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype.removeAllListeners = function removeAllListeners(type) {
  const events = this._events;
  if (events === undefined) return this;

  // 用 `arguments.length` 而不是判 undefined：Node 里**显式传 undefined** 只是删名为
  // `undefined` 的那个事件，而**不传参**才是"全清"。写成判 undefined 会让
  // `e.removeAllListeners(opts.event)`（opts.event 恰好是 undefined）**静默拆掉所有监听器**。
  if (arguments.length === 0) {
    if (events.removeListener === undefined) {
      // 快路径：没人监听元事件，直接换掉整张表
      this._events = Object.create(null);
      this._eventsCount = 0;
    } else {
      // 有 removeListener 监听器 → 逐个事件走正常摘除路径（元事件照发），最后再摘它自己
      for (const key of Reflect.ownKeys(events)) {
        if (key === 'removeListener') continue;
        this.removeAllListeners(key);
      }
      this.removeAllListeners('removeListener');
      this._events = Object.create(null);
      this._eventsCount = 0;
    }
    return this;
  }

  const list = events[type];
  if (typeof list === 'function') {
    this.removeListener(type, list);
  } else if (list !== undefined) {
    // LIFO（Node 同款）：反向逐个摘，于是元事件的顺序与"后进先出"一致
    for (let i = list.length - 1; i >= 0; i--) this.removeListener(type, list[i]);
  }
  return this;
};

/**
 * 返回"当时有没有监听器"。
 *
 * `'error'` 且无监听器时**必须抛出**——Node 靠这条把未处理的错误暴露出来，
 * 静默返回 false 会让依赖以为"错误已处理"。
 * 非 Error 值要包成带 `ERR_UNHANDLED_ERROR` 与 `context` 的错误（Node 的形状），
 * 否则靠 `e.code` / `e.context` 分支的调用方会走错路。
 *
 * A15：`errorMonitor` 是**旁路**——`'error'` 事件无论有没有人监听都要先通知它，
 * 而且它**不算** `'error'` 的监听器（通知完仍然要抛）。
 */
EventEmitter.prototype.emit = function emit(type, ...args) {
  let doError = type === 'error';
  const events = this._events;

  if (events !== undefined) {
    if (doError && events[EventEmitter.errorMonitor] !== undefined) {
      this.emit(EventEmitter.errorMonitor, ...args);
    }
    if (doError && events.error !== undefined) doError = false;
  } else if (!doError) {
    return false;
  }

  if (doError) {
    const err = args[0];
    if (err instanceof Error) throw err;
    const wrapped = new Error('Unhandled error. (' + describe(err) + ')');
    wrapped.code = 'ERR_UNHANDLED_ERROR';
    wrapped.context = err;
    throw wrapped;
  }

  const handler = events[type];
  if (handler === undefined) return false;

  if (typeof handler === 'function') {
    const result = handler.apply(this, args);
    if (result !== undefined && result !== null) addCatch(this, result, type, args);
    return true;
  }
  // 快照后再迭代：与 Node 的 kEmitting 拷贝等价——emit 期间被摘掉的监听器不该"少调一次"，
  // 而 emit 期间新加的也不该被这一轮看到
  for (const fn of handler.slice()) {
    const result = fn.apply(this, args);
    if (result !== undefined && result !== null) addCatch(this, result, type, args);
  }
  return true;
};

/** 原始函数（once 包装器**解包**后）——与 Node 一致 */
EventEmitter.prototype.listeners = function listeners(type) {
  const list = listOf(this, type);
  return list === undefined ? [] : list.map(unwrap);
};

/** 含 once 包装器——与 Node 一致 */
EventEmitter.prototype.rawListeners = function rawListeners(type) {
  const list = listOf(this, type);
  return list === undefined ? [] : list.slice();
};

EventEmitter.prototype.listenerCount = function listenerCount(type, fn) {
  const list = listOf(this, type);
  if (list === undefined) return 0;
  // Node 用 `listener != null`：`null` 与"不传"**等价**。
  // 只判 undefined 的话，把可能为 null 的引用透传进来会得到 0 → 误判"没人监听"。
  if (fn === undefined || fn === null) return list.length;
  return list.filter((l) => l === fn || l.listener === fn).length;
};

EventEmitter.prototype.eventNames = function eventNames() {
  return Reflect.ownKeys(this._events);
};

EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
    const err = new RangeError(
      'The value of "n" is out of range. It must be a non-negative number. Received ' + String(n),
    );
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  // 不缓存 defaultMaxListeners：Node 是**惰性继承**的——构造时不设，
  // 每次现读静态属性，于是"构造后改静态值"对已有实例也生效
  return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners;
};

// 注意：**实例上没有 `captureRejections` 属性**（Node 用内部符号 `kCapture` 存，
// `new EventEmitter({captureRejections:true}).captureRejections` 在 Node 里是 `undefined`）。
// 想读/写这个开关只有两个口子：构造选项，或静态的 `EventEmitter.captureRejections`（原型默认值）。

// ── 静态面 ──

EventEmitter.EventEmitter = EventEmitter; // 生态里 `require('events').EventEmitter` 很常见
EventEmitter.usingDomains = false; // Node 的遗留开关，老依赖会读

/**
 * 模块级 `let` + 静态存取器共用一个变量：于是 `export { defaultMaxListeners }` 是**活绑定**
 * （ESM 语义），改静态值后具名导入的读数跟着变。写成 `export const x = 10` 会是快照——
 * 那是"静默过期"，比不导出更坏。
 */
let defaultMaxListeners = 10;
Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
  enumerable: true,
  configurable: true,
  get() {
    return defaultMaxListeners;
  },
  set(value) {
    if (typeof value !== 'number' || value < 0 || Number.isNaN(value)) {
      const err = new RangeError(
        'The value of "defaultMaxListeners" is out of range. It must be a non-negative number. Received ' +
          String(value),
      );
      err.code = 'ERR_OUT_OF_RANGE';
      throw err;
    }
    defaultMaxListeners = value;
  },
});

/** 静态读写 `captureRejections` 改的是**原型默认值** → 只影响之后新建的实例（Node 同款） */
Object.defineProperty(EventEmitter, 'captureRejections', {
  enumerable: true,
  configurable: true,
  get() {
    return EventEmitter.prototype[kCapture];
  },
  set(value) {
    EventEmitter.prototype[kCapture] = Boolean(value);
  },
});

/** 已废弃的静态写法：等价于改 `defaultMaxListeners`，Node 保留是为了兼容 */
EventEmitter.setMaxListeners = function setMaxListenersStatic(n) {
  EventEmitter.defaultMaxListeners = n;
  return EventEmitter;
};

EventEmitter.listenerCount = function listenerCountStatic(emitter, event) {
  return emitter.listenerCount(event);
};

EventEmitter.captureRejectionSymbol = kRejection;
EventEmitter.errorMonitor = Symbol('events.errorMonitor');

/** `await once(emitter, 'x')`：等到事件（或 'error' 时拒绝），resolve 的是**参数数组** */
EventEmitter.once = function onceStatic(emitter, event) {
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
};

/**
 * `for await (const [v] of on(emitter, 'x'))`（`events.js:1085` 的最小子集）。
 *
 * 为什么不能省：老实现既不注册 `'error'` 监听、`return()` 也不摘监听，于是
 *   · 出错时挂起的 `next()` **永久挂起**（在沙箱里退化成 `PLUGIN_JOB_PENDING`）
 *   · `break` 之后监听器**留在 emitter 上**（泄漏，且后续 emit 还会进队列）
 * 这里按 Node 的队列语义复刻：事件/错误各一条队列，`next()` 先消费事件、再抛错误、否则等。
 * （水位线 `highWaterMark`、`pause/resume`、`options.signal/close` 不在仿真范围，没实现。）
 */
EventEmitter.on = function onStatic(emitter, event) {
  const unconsumedEvents = [];
  const unconsumedPromises = [];
  let error = null;
  let finished = false;

  const iterator = {
    next() {
      if (unconsumedEvents.length) {
        return Promise.resolve({ value: unconsumedEvents.shift(), done: false });
      }
      if (error !== null) {
        const rejected = Promise.reject(error);
        error = null; // 只抛一次（Node 同款）
        return rejected;
      }
      if (finished) return closeHandler();
      return new Promise((resolve, reject) => {
        unconsumedPromises.push({ resolve, reject });
      });
    },
    return() {
      return closeHandler();
    },
    throw(err) {
      if (!err || !(err instanceof Error)) {
        const bad = new TypeError(
          'The "EventEmitter.AsyncIterator" argument must be of type Error. Received ' +
            (err === null ? 'null' : typeof err),
        );
        bad.code = 'ERR_INVALID_ARG_TYPE';
        throw bad;
      }
      errorHandler(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  const onEvent = function (...args) {
    eventHandler(args);
  };
  emitter.on(event, onEvent);
  // `on(emitter, 'error')` 不该再额外注册一个 error 监听（那会把迭代本身变成错误处理器）
  if (event !== 'error' && typeof emitter.on === 'function') emitter.on('error', errorHandler);
  return iterator;

  function eventHandler(value) {
    if (unconsumedPromises.length === 0) unconsumedEvents.push(value);
    else unconsumedPromises.shift().resolve({ value, done: false });
  }

  function errorHandler(err) {
    if (unconsumedPromises.length === 0) error = err;
    else unconsumedPromises.shift().reject(err);
    closeHandler();
  }

  function closeHandler() {
    if (!finished) {
      finished = true;
      // 摘干净：迭代器结束/中断后不该继续在 emitter 上留监听器（旧实现在这里泄漏）
      emitter.removeListener(event, onEvent);
      if (event !== 'error') emitter.removeListener('error', errorHandler);
      const doneResult = { value: undefined, done: true };
      while (unconsumedPromises.length) unconsumedPromises.shift().resolve(doneResult);
    }
    return Promise.resolve({ value: undefined, done: true });
  }
};

/** once 包装器：调用一次后自动摘除；`.listener` 指回原函数（Node 的约定） */
function onceWrap(emitter, event, fn) {
  const wrapper = function (...args) {
    emitter.removeListener(event, wrapper);
    return fn.apply(this, args);
  };
  wrapper.listener = fn;
  return wrapper;
}

export const once = EventEmitter.once;
export const on = EventEmitter.on;
export { EventEmitter };
export const init = EventEmitter.init;
export const listenerCount = EventEmitter.listenerCount;
export const setMaxListeners = EventEmitter.setMaxListeners;
export const errorMonitor = EventEmitter.errorMonitor;
export const captureRejectionSymbol = kRejection;
export { defaultMaxListeners };
export const addAbortListener = function (signal, listener) {
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
};
export default EventEmitter;
