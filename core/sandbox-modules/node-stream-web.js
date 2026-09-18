// node:stream/web 仿真——**明确抛错**（WHATWG 流不做）
//
// 为什么不实现：WHATWG 的 `ReadableStream`/`TransformStream` 是**另一套**流模型（拉模型 + controller
// + 队列策略），与 Node 的 `stream` 没有共享实现。复刻它等于再写一个模块，而当前唯一的调用点是
// `csv-parse/lib/stream.js`（那条入口不在它的 `main` 链上）。
//
// 登记它而不是不登记：让"沙箱尚未支持 WHATWG 流"以运行期准确报错的形式出现，
// 而不是构建期的"模块未登记"（两者对插件作者的含义不同）。
//
// 内联约束：静态、无占位符。

function unsupported(name, why) {
  const ctor = function () {
    const err = new Error('stream/web.' + name + ' is not supported in the sandbox (' + why + ')');
    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
    throw err;
  };
  Object.defineProperty(ctor, 'name', { value: name, configurable: true });
  return ctor;
}

const WHY = 'WHATWG streams are a different model; the sandbox only emulates the node:stream surface';

export const ReadableStream = /* @__PURE__ */ unsupported('ReadableStream', WHY);
export const WritableStream = /* @__PURE__ */ unsupported('WritableStream', WHY);
export const TransformStream = /* @__PURE__ */ unsupported('TransformStream', WHY);
export const ByteLengthQueuingStrategy = /* @__PURE__ */ unsupported('ByteLengthQueuingStrategy', WHY);
export const CountQueuingStrategy = /* @__PURE__ */ unsupported('CountQueuingStrategy', WHY);

export default {
  ReadableStream: ReadableStream,
  WritableStream: WritableStream,
  TransformStream: TransformStream,
  ByteLengthQueuingStrategy: ByteLengthQueuingStrategy,
  CountQueuingStrategy: CountQueuingStrategy,
};
