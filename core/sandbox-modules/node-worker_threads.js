// node:worker_threads 仿真——**只报事实，不做线程**
//
// 这个模块的存在理由很具体：`write-file-atomic`（`npm`/`jest`/`eslint` 一堆工具都间接依赖它）
// 在装载时会 `require('worker_threads').threadId` 来决定临时文件名后缀
// （`node/lib` 之外的生态写法，见其 `lib/index.js:16-23`，整段包在 try/catch 里）。
// 于是"这个模块存不存在"直接决定那个包能不能用；而"能不能真开线程"是另一回事——**永远不能**。
//
// 事实三项（在 Node 里主线程就是这个值，插件在我们这里就是主线程，所以这是**如实回答**）：
//   threadId = 0、isMainThread = true、workerData = null
//
// 其余**一律抛错**（`Worker`/`MessageChannel`/`MessagePort`/`parentPort`/`receiveMessageOnPort`/
// `markAsUntransferable`/`setEnvironmentData`/`SHARE_ENV`/`resourceLimits`）：
//   · 沙箱没有线程、没有结构化克隆、没有 `MessagePort` 事件面——**假装有** 比报错危险得多
//     （典型后果：`new Worker(...)` 返回一个永不发 `'message'` 的空壳，依赖卡死在 await 上，
//     而错误信息里什么都看不到）；
//   · 做成"构造时才抛错的函数"（照 `node-tty.js` 的做法）而不是 `undefined`：Node 上这些名字
//     永远存在，`if (wt.MessageChannel)` 这种特性探测不能因为沙箱而走另一条分支。
//
// 内联约束：静态、无占位符（见 registry.ts 头注释）。

/** 显式说明"这里没有线程"的错误 */
function unsupported(name, why) {
  const fn = function () {
    const err = new Error('worker_threads.' + name + ' is not supported in the sandbox (' + why + ')');
    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
    throw err;
  };
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

const NO_THREADS = 'the sandbox runs plugins in a single thread';

export var Worker = /* @__PURE__ */ unsupported('Worker', NO_THREADS);
export var MessageChannel = /* @__PURE__ */ unsupported('MessageChannel', NO_THREADS);
export var MessagePort = /* @__PURE__ */ unsupported('MessagePort', NO_THREADS);
export var BroadcastChannel = /* @__PURE__ */ unsupported('BroadcastChannel', NO_THREADS);
export var receiveMessageOnPort = /* @__PURE__ */ unsupported('receiveMessageOnPort', NO_THREADS);
export var setEnvironmentData = /* @__PURE__ */ unsupported(
  'setEnvironmentData',
  'there is no worker environment to share data with',
);
export var getEnvironmentData = /* @__PURE__ */ unsupported(
  'getEnvironmentData',
  'there is no worker environment to share data with',
);
// Node 里它是 WeakSet 记账；QuickJS **没有 WeakSet**（见设计 §9），照抄不了，
// 而"静默什么都不做"会让依赖以为标记生效了 —— 抛错更诚实。
export var markAsUntransferable = /* @__PURE__ */ unsupported(
  'markAsUntransferable',
  'no transferable-object bookkeeping exists (QuickJS has no WeakSet)',
);
export var markAsUncloneable = /* @__PURE__ */ unsupported(
  'markAsUncloneable',
  'structured clone is not emulated',
);

/** 事实三项：值固定，可写（依赖里有 `wt.threadId ||= 0` 这类兜底写法） */
export var threadId = 0;
export var isMainThread = true;
export var workerData = null;
/** `parentPort` 在主线程上就是 `null`——这不是"缺失"，是 Node 的原值 */
export var parentPort = null;
/** `SHARE_ENV` 是 Symbol；主线程上存在但只对 `new Worker` 有意义（而我们没有 Worker） */
export var SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');
/** `resourceLimits` 只有 Worker 会用；保留字段以对齐 Node 的形状，但取它没有意义 */
export var resourceLimits = Object.freeze({});

export default {
  isMainThread: isMainThread,
  threadId: threadId,
  workerData: workerData,
  parentPort: parentPort,
  SHARE_ENV: SHARE_ENV,
  resourceLimits: resourceLimits,
  Worker: Worker,
  MessageChannel: MessageChannel,
  MessagePort: MessagePort,
  BroadcastChannel: BroadcastChannel,
  receiveMessageOnPort: receiveMessageOnPort,
  setEnvironmentData: setEnvironmentData,
  getEnvironmentData: getEnvironmentData,
  markAsUntransferable: markAsUntransferable,
  markAsUncloneable: markAsUncloneable,
};
