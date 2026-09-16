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
export type EmulationStage = 'P2-A' | 'P2-B' | 'P2-C';

export interface SandboxModule {
  /** 规范名（已去 `node:` 前缀，保留子路径），如 `path` / `fs/promises` */
  readonly canonical: string;
  readonly stage: EmulationStage;
  /** 需要宿主能力吗（false = 完全自包含的纯 JS） */
  readonly needsHost: boolean;
  /** 一句话说明；构建期报错文案与文档从这里取，避免两处各写一份 */
  readonly note: string;
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
 */
export function shimFileName(canonical: string): string {
  return `node-${normalizeSpecifier(canonical).replace(/\//g, '-')}.js`;
}
