// path/win32 子路径入口（Node：`require('path/win32')` === `path.win32`）
//
// 为什么"不支持也要有入口"：沙箱基线固定 POSIX，Windows 路径语义**没有实现**。
// 但入口缺失与"实现了却不对"是两种不同的失败：
//   · 模块不存在 → 报错指向构建层（"module not allowed"），作者会去查打包配置，方向就错了；
//   · 入口存在、方法明确抛错 → 报错直接指向真正的原因（沙箱只有 POSIX 路径）。
// 所以这里与 `path.win32`（node-path.js 里**同一个对象**）保持同一行为：不静默给 posix 结果。
//
// `import './node-path.js'`：构建层由 esbuild 内联，沙箱里由 loader 服务同目录 shim。
import { win32 } from './node-path.js';

export default win32;

export const sep = win32.sep;
export const delimiter = win32.delimiter;
export const resolve = win32.resolve;
export const normalize = win32.normalize;
export const isAbsolute = win32.isAbsolute;
export const join = win32.join;
export const relative = win32.relative;
export const toNamespacedPath = win32.toNamespacedPath;
export const dirname = win32.dirname;
export const basename = win32.basename;
export const extname = win32.extname;
export const format = win32.format;
export const parse = win32.parse;
