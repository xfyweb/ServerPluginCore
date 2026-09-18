// node:path/posix 子路径入口——**语义固定为 POSIX**（与 `node:path` 的默认导出不同！）
//
// 为什么必须是独立文件（而不是像原来那样与 `path` 共用 `node-path.js`）：
// P2-E（模型 B）之后 `node:path` 的**默认导出与具名导出都跟随仿真平台**——
// Windows 宿主上 `import { join } from 'node:path'` 给的是 `\`。而 `node:path/posix`
// 在 Node 里**永远**是 posix 语义（`require('path/posix').sep === '/'`），与平台无关。
// 共用一个文件就没法区分"谁在问"（ESM 模块不知道自己被哪个 specifier 引入），
// 于是 Windows 上 `import { join } from 'node:path/posix'` 会错给 `\a\b`（实测踩到）。
//
// 内联约束：静态、无占位符。
import { posix } from './node-path.js';

export default posix;

export const sep = posix.sep;
export const delimiter = posix.delimiter;
export const resolve = posix.resolve;
export const normalize = posix.normalize;
export const isAbsolute = posix.isAbsolute;
export const join = posix.join;
export const relative = posix.relative;
export const toNamespacedPath = posix.toNamespacedPath;
export const dirname = posix.dirname;
export const basename = posix.basename;
export const extname = posix.extname;
export const format = posix.format;
export const parse = posix.parse;
export const win32 = posix.win32;
