// node:stream/promises 仿真——B1 阶段**明确抛错**
//
// 为什么现在是抛错而不是实现：没有实测需求。`csv-parse`（唯一的 Transform 靶子）用的是
// **回调形态**的 `finished`，`fast-glob`/`graceful-fs` 连 `finished` 都不用 —— 补它要动
// promise 状态机与错误传播的边角（已结束的流、destroy 与 error 并存、多路错误），
// 收益是 0 个包。等真实依赖卡住再补（那时把 `node-stream.js` 里的 `promisesExports` 换成真实现）。
//
// 登记它而不是不登记：**"未登记"与"登记但抛错"对插件是不同的信号**
// 前者是构建期失败（"沙箱尚未支持"），后者能在运行期给出准确的原因。
//
// 内联约束：静态、无占位符。

function unsupported(name, why) {
  const fn = function () {
    const err = new Error('stream/promises.' + name + ' is not supported in the sandbox (' + why + ')');
    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
    throw err;
  };
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

const WHY = 'use the callback form (stream.finished / stream.pipeline) — the promise form is not needed yet';

export const finished = /* @__PURE__ */ unsupported('finished', WHY);
export const pipeline = /* @__PURE__ */ unsupported('pipeline', WHY);

export default { finished: finished, pipeline: pipeline };
