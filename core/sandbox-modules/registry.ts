// 仿真模块登记表：specifier 归一化 + 已登记清单（唯一真相）
//
// **这张表有两个消费者，必须同源**——否则会出现"构建器放行、沙箱拒绝"这种最难查的错：
//   · 沙箱 loader（core/sandbox.ts）：按规范名服务 shim 源码（开发期直装路径）
//   · 构建层第一道闸（P2-2）：未登记的 node 内建 → **构建失败**
//
// 设计约束（来自 build-layer-evidence §4.2，实测结论）：
// **shim 必须能被构建层内联进插件产物**。因此每个 shim 都必须是
//   · 静态、**无构建期占位符**（插件 id / 数据目录等一律运行时从全局取）
//   · 不依赖"被沙箱 loader 单独服务"这一前提
// 这是 CJS 依赖能用到仿真的前提——CJS 里的 require 无法标记为外部（会退化成运行期欠条）。

/** 仿真阶段（与 module-emulation-design §3 对应，供文档与报告使用） */
export type EmulationStage = 'P2-A' | 'P2-B' | 'P2-C' | 'P2-D' | 'P2-E' | 'P3';

export interface SandboxModule {
  /** 规范名（已去 `node:` 前缀，保留子路径），如 `path` / `fs/promises` */
  readonly canonical: string;
  readonly stage: EmulationStage;
  /** 需要宿主能力吗（false = 完全自包含的纯 JS） */
  readonly needsHost: boolean;
  /** 一句话说明；构建期报错文案与文档从这里取，避免两处各写一份 */
  readonly note: string;
  /**
   * 复用另一个 shim 文件（别名条目）。
   * 缺省按 `shimFileName` 的约定生成；只有"同一个实现服务多个 specifier"时才需要它
   * （如 `path/posix` 与 `path` 在 POSIX 基线下是**同一份**实现）。
   */
  readonly shimFile?: string;
}

/**
 * **已登记**的仿真模块。
 *
 * 未登记的 `node:*` 一律拒绝（零环境权力的执行点）——构建期失败，不是运行期才报
 * "module not allowed"。沙箱设计上**永不提供**的能力（net/tls/http/child_process …）
 * 见 build-layer-evidence §4.3：那些走驱动插件，不走仿真。
 */
export const SANDBOX_MODULES: readonly SandboxModule[] = [
  // ── P2-A：纯计算，不碰宿主 ──
  {
    canonical: 'path',
    stage: 'P2-A',
    needsHost: false,
    note: 'POSIX 语义（沙箱路径语义固定为 posix，与"暂不支持 Windows 部署"一致）',
  },
  {
    canonical: 'path/posix',
    stage: 'P2-A',
    needsHost: false,
    // ⚠️ **不是** alias 到 `node-path.js`：P2-E 之后 `node:path` 的导出跟随仿真平台
    // （Windows 上给 `\`），而 `node:path/posix` 在 Node 里**永远**是 posix 语义。
    // 共用一份实现就没法区分"谁在问"（ESM 模块不知道自己的 specifier）。
    shimFile: 'node-path-posix.js',
    note: '子路径入口；**语义固定 POSIX**（与 `path` 的默认导出不同：后者跟随仿真平台）',
  },
  {
    canonical: 'path/win32',
    stage: 'P2-A',
    needsHost: false,
    note: '入口存在但方法**一律抛错**：Windows 路径语义未实现，不静默给 posix 结果（同 `path.win32`）。⚠️ **P2-E 会把它改成真实现**（模型 B：仿真平台跟随宿主 ⇒ Windows 部署上 `path` 本身就是 win32 语义）',
  },
  {
    canonical: 'events',
    stage: 'P2-A',
    needsHost: false,
    note: 'EventEmitter',
  },
  {
    canonical: 'assert',
    stage: 'P2-A',
    needsHost: false,
    note: '常用断言子集（依赖常拿它做参数校验）',
  },
  {
    canonical: 'assert/strict',
    stage: 'P2-A',
    needsHost: false,
    note: '严格断言入口（宽松方法被严格方法覆盖，默认导出**可调用**）——与 `assert` 不是同一份 shim',
  },
  {
    canonical: 'util',
    stage: 'P2-B',
    needsHost: true,
    note: 'format/inspect(结构子集)/types/inherits/deprecate/debuglog/promisify/callbackify/isDeepStrictEqual 沙箱自实现（要遍历沙箱值）；**TextEncoder/TextDecoder 宿主代工**（QuickJS 没有这两个全局）',
  },
  {
    canonical: 'util/types',
    stage: 'P2-B',
    needsHost: false,
    note: '子路径入口：转发 `util.types` 那一份实现（Node 里 `util/types` 拿到的就是 types 对象本身）',
  },
  {
    canonical: 'tty',
    stage: 'P2-A',
    needsHost: false,
    note: '沙箱内没有终端：isatty 恒 false（如实回答，让依赖走非交互降级路径）',
  },
  {
    canonical: 'constants',
    stage: 'P2-A',
    needsHost: false,
    note: 'POSIX/Linux 常量值（与 path 的 posix 取向一致）',
  },
  {
    canonical: 'url',
    stage: 'P2-A',
    needsHost: true,
    note: 'WHATWG `URL`/`URLSearchParams` **宿主代工**（解析一次 → 全量快照，赋值时回宿主重算）；`pathToFileURL`/`fileURLToPath`/legacy `parse`/`format`/`resolve` 沙箱自实现（POSIX 基线）',
  },
  // ── P2-B：真实资源（宿主能力 + 权限点 + 审计；路径收敛见 core/fs/safe-path.ts）──
  {
    canonical: 'fs',
    stage: 'P2-B',
    needsHost: true,
    note: '作用域 = 插件数据目录：真实动作在宿主（core/hostApi.ts 的 fs.* 原语 + 路径收敛 F1–F7 + 大小上限），**形状/errno 翻译在沙箱**；同步 + promises + 回调三风格同一实现；fd 类与 `fs.watch` 明确抛错',
  },
  {
    canonical: 'fs/promises',
    stage: 'P2-B',
    needsHost: true,
    note: '子路径入口：与 `fs.promises` 同一份实现（Node 里就是同一个对象）',
  },
  // ── P2-B：环境事实（只读，值来自建沙箱时注入的 `globalThis.__spcEnv`）──
  {
    canonical: 'os',
    stage: 'P2-B',
    needsHost: true,
    note: '只读环境事实：行为性事实固定为 Linux/POSIX 仿真基线、容量类给宿主真值、**身份类（cpus/hostname/networkInterfaces/userInfo）明确抛错**',
  },
  {
    canonical: 'process',
    stage: 'P2-B',
    needsHost: true,
    note: '只读子集：platform/arch/version/versions/env(冻结空对象)/cwd/argv/pid/nextTick/emitWarning/stdout·stderr；`exit` 与信号事件明确抛错；核心在卸载前发一次 `exit`',
  },
  // ── P2-B：二进制面（字节存沙箱、编解码宿主代工；设计 §3.2）──
  {
    canonical: 'buffer',
    stage: 'P2-B',
    needsHost: true,
    note: '最小集：字节存沙箱（Uint8Array 子类）、storage/index/slice 原生，**编解码走宿主**（bytes 通道）；不池化（池化会把同池别人的字节经 slice().buffer 带出去）。⚠️ 用到编解码（`Buffer.from(str)`/`buf.toString(enc)`）的插件要在 manifest 里声明 `bytes.encode`/`bytes.decode`（scope=self，安装即生效）；纯字节操作（alloc/isBuffer/subarray）不需要',
  },
  {
    canonical: 'string_decoder',
    stage: 'P2-B',
    needsHost: true,
    note: 'StringDecoder：跨 chunk 的不完整多字节序列由**宿主**处理（状态机不自己复刻），沙箱侧只做切片与缓存',
  },
  // ── P2-C：加密（**原语一律宿主代工**，沙箱里只有形状与状态搬运）──
  {
    canonical: 'crypto',
    stage: 'P2-C',
    needsHost: true,
    note: '最小集：摘要/HMAC（`createHash`/`createHmac`/一次性 `hash`）、随机源（`randomBytes`/`randomUUID`/`getRandomValues`/`randomFillSync`/`randomInt`）、`timingSafeEqual`、**对称解密** `createDecipheriv`、静态清单（`getHashes`/`getCiphers`/`getCurves`/`constants`，**固定基线**）。`sign`/`verify`/`KeyObject`/`createPublicKey`/`diffieHellman`/`generateKeyPair` 等**一律明确抛错**（密钥对象要求对象身份，见设计 §3.2.1 阻断 1）',
  },
  {
    canonical: 'zlib',
    stage: 'P2-C',
    needsHost: true,
    note: '最小集：**同步面 + 回调面**（\`deflateRawSync\`/\`inflateRawSync\`/\`gzipSync\`/\`crc32\` … 与对应的回调形态），宿主代工、字节进字节出；错误保真（\`Z_DATA_ERROR\`/\`Z_BUF_ERROR\` + message + errno）。**流式入口**（\`createGzip\` 一族）与 brotli/zstd **明确抛错**（前者等 \`stream\`，后者无实测需求）',
  },
  // ── P2-C：纯计算兼容面（不碰宿主、不扩能力面）──
  {
    canonical: 'querystring',
    stage: 'P2-C',
    needsHost: true,
    note: '查询串的 legacy 编解码：`parse`/`stringify`（`encode`/`decode` 是**同一个函数**）+ `escape`/`unescape`/`unescapeBuffer`；逐行移植 `node/lib/querystring.js`（含自定义 `sep`/`eq`/`maxKeys`/`decodeURIComponent`）。坏转义的回退解码要 UTF-8 语义 ⇒ 宿主代工（同 `string_decoder`）',
  },
  {
    canonical: 'worker_threads',
    stage: 'P2-C',
    needsHost: false,
    note: '**只报事实，不解锁线程**：`threadId`(0)/`isMainThread`(true)/`workerData`(null)/`parentPort`(null)；`Worker`/`MessageChannel`/`MessagePort`/`receiveMessageOnPort` 等**一律明确抛错**。存在理由：`write-file-atomic` 等包靠 `require("worker_threads").threadId` 决定临时文件名后缀',
  },
  // ── P2-D：流（**极小形状**，范围逐包实测得出，见 §9 的已知差异）──
  {
    canonical: 'stream',
    stage: 'P2-D',
    needsHost: false,
    note: '极小形状：`Stream`（**legacy 函数基类**，`Stream.call(this)` 可用）+ `Readable`/`Writable`/`Duplex`/`Transform`/`PassThrough` + `pipe`/`push`/`_transform`/`_flush`/objectMode + `finished`/`pipeline`。**不做**：完整背压阈值、`AbortSignal`、`stream/web`、`compose`（一律明确抛错）。已知差异：只有微任务（没有 `nextTick`/`setImmediate` 的区分）⇒ 事件**顺序**不保证与 Node 相同，交付的是"终态 + 事件集合"',
  },
  {
    canonical: 'stream/promises',
    stage: 'P2-D',
    needsHost: false,
    note: '子路径入口：`finished`/`pipeline` 的 promise 形态。⚠️ 当前**明确抛错**（B1 不做，等真实依赖卡住再补——CSV 那条路用的是回调形态）',
  },
  {
    canonical: 'stream/web',
    stage: 'P2-D',
    needsHost: false,
    note: '子路径入口：WHATWG `TransformStream`/`ReadableStream`。⚠️ 当前**明确抛错**（`csv-parse/lib/stream.js` 用它，但那条入口不在 `main` 链上）',
  },
  {
    canonical: 'stream/consumers',
    stage: 'P2-D',
    needsHost: false,
    note: '子路径入口：把流读成 `text()`/`buffer()`/`json()` 的小工具。⚠️ 当前**明确抛错**（本批无实测需求，登记它是为了让"沙箱尚未支持"以运行期准确报错的形式出现）',
  },
];

const BY_CANONICAL = new Map(SANDBOX_MODULES.map((m) => [m.canonical, m]));
/**
 * specifier 归一化：`node:path` / `path` → `path`；**保留子路径**（`node:fs/promises` → `fs/promises`）。
 *
 * 裸名与 `node:` 前缀等价（真实生态两种都写，见 module-emulation-design §4）。
 * 子路径是**独立登记名**——`fs/promises` 与 `fs` 不是一回事。
 */
export function normalizeSpecifier(spec: string): string {
  return spec.startsWith('node:') ? spec.slice(5) : spec;
}

/** 该 specifier 是否已登记（接受裸名 / `node:` 前缀两种写法） */
export function isRegistered(spec: string): boolean {
  return BY_CANONICAL.has(normalizeSpecifier(spec));
}

/** 取登记项；未登记返回 undefined（调用方据此给出"沙箱尚未支持 X"的准确文案） */
export function sandboxModule(spec: string): SandboxModule | undefined {
  return BY_CANONICAL.get(normalizeSpecifier(spec));
}

/**
 * 规范名 → shim 文件名（**约定**，构建层与沙箱共用）。
 * `path` → `node-path.js`；`fs/promises` → `node-fs-promises.js`（子路径的 `/` 变 `-`）。
 * 别名条目（`shimFile`）优先——它们的文件名不必与规范名一一对应。
 */
export function shimFileName(canonical: string): string {
  const norm = normalizeSpecifier(canonical);
  return BY_CANONICAL.get(norm)?.shimFile ?? `node-${norm.replace(/\//g, '-')}.js`;
}

/**
 * 文件名是不是"本约定下的 shim 文件"（`node-*.js` 形状）。
 *
 * 为什么这条规则放在这里而不是散在加载器里：它就是**命名约定的另一半**——
 * `shimFileName()` 说"规范名怎么变成文件名"，这里说"哪些文件名算数"。两处一旦漂移，
 * 表现是"文件名按约定写了、加载器却不服务它"这种最难查的错：
 * 曾经这里只认 `[a-z0-9-]`，于是 `node-string_decoder.js`（**下划线是规范名的一部分**，
 * 见 `string_decoder` 条目）过不了——现在没有 shim 去 import 它所以没炸，
 * 但 `stream` 那一批一定会（`node-stream.js` 要用 StringDecoder）。
 *
 * 注意：连字符只来自**路径分隔符**的替换（`fs/promises` → `node-fs-promises.js`），
 * 下划线一律保留（`string_decoder` → `node-string_decoder.js`）。
 */
export function isShimFileName(fileName: string): boolean {
  return /^node-[a-z0-9_-]+\.js$/.test(fileName);
}
