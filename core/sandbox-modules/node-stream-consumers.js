// node:stream/consumers 仿真——**明确抛错**（本批无实测需求）
//
// `text`/`buffer`/`json`/`arrayBuffer`/`blob` 都是"把流读完再转换"的小工具，实现成本很低，
// 但当前没有任何靶子用到它们（`fast-glob`/`graceful-fs`/`csv-parse` 都不用）。
// 登记它而不是不登记：让"沙箱尚未支持"以**运行期准确报错**的形式出现，而不是构建期的"模块未登记"。
//
// 内联约束：静态、无占位符。

function unsupported(name) {
  const fn = function () {
    const err = new Error(
      'stream/consumers.' + name + ' is not supported in the sandbox (no target dependency needs it yet)',
    );
    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
    throw err;
  };
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

export const text = /* @__PURE__ */ unsupported('text');
export const buffer = /* @__PURE__ */ unsupported('buffer');
export const json = /* @__PURE__ */ unsupported('json');
export const arrayBuffer = /* @__PURE__ */ unsupported('arrayBuffer');
export const blob = /* @__PURE__ */ unsupported('blob');

export default { text: text, buffer: buffer, json: json, arrayBuffer: arrayBuffer, blob: blob };
