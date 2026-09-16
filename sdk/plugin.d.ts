// @spc/sdk：插件侧的**环境事实**类型声明（ctx 参数）
//
// 分工（plugin-lifecycle-design.md §1.3）：
//   · `@host/api`（模块注入）= **能力**（fs / exec / kv / timers / events / lifecycle）
//   · `@spc/sdk`（参数注入）= **环境事实**（pluginId / dataDir / manifest / grants / config / logger）
// 插件拿不到第三种东西——没有 process、没有 require、没有网络（ADR-001 零环境权力）。
declare module '@spc/sdk' {
  import type { Manifest } from './types.ts';

  export interface PluginLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  }

  export interface PluginContext {
    /** 如 @xfy2412/hello */
    pluginId: string;
    version: { code: number; name: string };
    /** 宿主创建并保证存在；插件唯一可写位置（fs 权限点的作用域） */
    dataDir: string;
    /** 只读副本（自查声明用，改不了） */
    manifest: Readonly<Manifest>;
    /** 本插件已获授予的权限点（只读；判定仍由宿主侧强制） */
    grants: readonly string[];
    /** 按 configSchema 校验并补默认值后的**只读快照**（深度冻结） */
    config: Readonly<Record<string, unknown>>;
    logger: PluginLogger;
  }
}
