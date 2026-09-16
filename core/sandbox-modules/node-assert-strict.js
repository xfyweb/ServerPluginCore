// assert/strict（Node：`require('assert/strict')` === `assert.strict`）
//
// 为什么不把它做成 `assert` 的**别名条目**（像 `path/posix` 那样直接复用同一份源码）：
// **默认导出不是同一个东西**。Node 里 `assert/strict` 自己就是**可调用**的
// （`assertStrict(value, msg)` 等价严格版 `ok`），且 `equal` / `notEqual` / `deepEqual` /
// `notDeepEqual` 四个宽松名字被**严格实现**覆盖。别名过去会让 `require('assert/strict')(x)`
// 拿到宽松版、`equal` 拿到宽松版——静默给出更弱的断言，比报错危险得多。
//
// 这里 `import './node-assert.js'` 是允许的：构建层由 esbuild 内联（同目录相对引用），
// 沙箱里由 loader 服务同目录 shim（见 core/sandbox.ts 的 moduleSource，形状限 `./node-*.js`）。
import assert from './node-assert.js';

/** Node 的 `assert.strict`：API 全集 + 四个宽松名字指向严格实现 */
const strictApi = assert.strict;

export default strictApi;
export const strict = strictApi;

export const {
  AssertionError,
  ok,
  strictEqual,
  notStrictEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  ifError,
  match,
  doesNotMatch,
  fail,
} = strictApi;

// 宽松名字 → 严格实现（Node 的映射；漏掉任何一个都会让 `assert/strict` 比 Node 弱）
export const equal = strictApi.strictEqual;
export const notEqual = strictApi.notStrictEqual;
export const deepEqual = strictApi.deepStrictEqual;
export const notDeepEqual = strictApi.notDeepStrictEqual;
