// @host/api 沙箱抽象模块的类型声明
//
// 插件代码 import { ... } from '@host/api' 在沙箱内由宿主注入实现；
// 本文件提供编译期类型（IDE 提示 + 构建期校验）。
// 正式版：类型应从权限注册表 / 宿主 API 契约自动生成（ROADMAP P1），
// 当前与 core/hostApi.ts 的注入实现手写对齐。

declare module '@host/api' {
  export interface WriteResult {
    ok: boolean;
    path: string;
    bytes: number;
  }

  /** 写入文件（spike：无鉴权；正式版走 fs 受限 + 权限检查） */
  export function write(path: string, content: string): WriteResult;
}
