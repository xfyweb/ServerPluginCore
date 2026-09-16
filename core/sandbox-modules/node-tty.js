// node:tty 仿真——沙箱里**没有终端**
//
// `isatty()` 恒返回 `false`。这不是"近似"，是**如实回答**：沙箱不接管任何真实终端。
// 生态里这条路径的用法很典型——`debug` / `chalk` 一类靠它判断"要不要上颜色"，
// 拿到 false 就走非交互降级路径，正是我们想要的结果。
//
// 内联约束：本文件**静态、无占位符**，可以被构建层直接打进插件产物（见 registry.ts 头注释）。

export function isatty() {
  return false;
}

/**
 * `ReadStream` / `WriteStream` 需要真实终端才能成立。沙箱没有 ⇒ **明确抛错，不静默假装**。
 *
 * 为什么不做成 `undefined`：`undefined` 会让 `if (tty.WriteStream)` 之类的探测安静地转向另一条路，
 * 而 Node 上它永远存在——那是**静默的行为差异**。抛错是 loud 的，符合本项目的 fail-closed 取向。
 */
function unsupportedCtor(name) {
  const ctor = function () {
    const err = new Error(
      'tty.' + name + ' is not supported in the sandbox (no terminal is attached)',
    );
    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
    throw err;
  };
  Object.defineProperty(ctor, 'name', { value: name, configurable: true });
  return ctor;
}

export var ReadStream = /* @__PURE__ */ unsupportedCtor('ReadStream');
export var WriteStream = /* @__PURE__ */ unsupportedCtor('WriteStream');

export default {
  isatty: isatty,
  ReadStream: ReadStream,
  WriteStream: WriteStream,
};
