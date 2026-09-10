// @host/api 沙箱抽象模块的类型声明
//
// 插件代码 import { fs } from '@host/api' 在沙箱内由宿主注入实现；
// 本文件提供编译期类型（IDE 提示 + 构建期校验）。
// 正式版：类型应从权限注册表 / 宿主 API 契约自动生成（ROADMAP P1），
// 当前与 core/hostApi.ts 的注入实现手写对齐。

declare module '@host/api' {
  /**
   * 宿主错误：所有宿主调用失败都以该形状抛出（沙箱内由包装层还原）。
   * - `message` = `code`（英文，机器可读；文案请插件自行本地化，宿主不下发本地化文本）；
   * - 请按 `code` 分支，不要匹配文案：`catch (e) { if (e.code === 'SYMLINK_DANGLING') … }`；
   * - 码是契约（只增不改），完整清单见 docs/api-contract.md §2 与 core/i18n/locales 的 `err.*`。
   */
  export interface HostError extends Error {
    /** 英文错误码，如 PERMISSION_DENIED / PATH_OUT_OF_SCOPE / SYMLINK_DANGLING / INTERNAL */
    code: string;
    /** 结构化参数（渲染/诊断用；敏感值可能缺省） */
    params?: Record<string, string>;
  }

  export interface WriteResult {
    ok: boolean;
    path: string;
    bytes: number;
  }

  // 注意（P1 待办）：宿主方法的返回值目前以 **JSON 文本**回传（spike 约定），
  // 与下方声明中的对象形态尚未对齐；SDK 层将在 P1 统一为对象（ROADMAP P1 sdk 条目）。
  export const fs: {
    /** 写入文件（spike：fs.write.home 权限点；正式版走 fs 受限 + 路径收敛） */
    write(path: string, content: string): WriteResult;
  };
}
