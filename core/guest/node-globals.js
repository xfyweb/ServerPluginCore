// 沙箱里的 **Node 全局**：在引导层之后、任何插件代码之前**求值一次**（作为模块求值，所以能 `import`）。
//
// ⚠️ 这是 **guest 代码**（跑在 VM 里）：由 `core/sandbox.ts` 读成字符串后求值；**不进 tsc**。
//   为什么用"求值一段模块"而不是宿主侧 `vm.setProp(global, …)`：实现在 `node-*.js` 仿真模块里，
//   而**宿主拿不到沙箱内的对象** —— 只有沙箱自己 `import` 才拿得到那份单例。
//
// 为什么是独立文件（2026-09-25 抽出）：见 `bootstrap.js` 的同一段理由（可评审 + 根除反引号坑）。

import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL, URLSearchParams } from 'node:url';
import { TextEncoder, TextDecoder } from 'node:util';
import nodeCrypto from 'node:crypto';
globalThis.process = process;
globalThis.Buffer = Buffer;
globalThis.URL = URL;
globalThis.URLSearchParams = URLSearchParams;
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
globalThis.global = globalThis;
// Node 19+ 的**全局 crypto** 等于 WebCrypto（不是整个 node:crypto 模块）——实测有真实依赖只用裸全局：
// uuid v14 的 rng.js 就是 `crypto.getRandomValues(...)` / `crypto.randomUUID()`，没有 import。
globalThis.crypto = nodeCrypto.webcrypto;
// CJS 的 per-module 全局：esbuild 把 CJS 包搬进 ESM 产物时**自己**会留下对它们的引用
// （包源码里没有；实测 `write-file-atomic` 的临时文件名就是 `hash(__filename, pid, threadId, n)`）。
// 值 = 插件入口在**沙箱形态**下的路径（与 `process.argv[1]`、`process.cwd()` 同源）。
// 只用于"派生一个稳定的字符串"，不是在指一个真文件——单个 bundle 根本没有源文件路径可指，
// 所以给一个**稳定且显然是沙箱内**的值，而不是编造一个宿主机路径（那会随部署漂移）。
// ⚠️ 分隔符随仿真平台（P2-E）：win32 上必须是 `D:\…\plugin.js` 而不是混合形态——混合形态会让
// `path.dirname(__filename)` 之类的推理出错，依赖拿它跟别处拼出来的路径做字符串比较也会失败。
const __spcSep = process.platform === 'win32' ? '\\' : '/';
Object.defineProperty(globalThis, '__filename', {
  value: process.cwd() + __spcSep + process.argv[1], writable: true, configurable: true, enumerable: false,
});
Object.defineProperty(globalThis, '__dirname', {
  value: process.cwd(), writable: true, configurable: true, enumerable: false,
});
export const __filename = globalThis.__filename;
export const __dirname = globalThis.__dirname;
