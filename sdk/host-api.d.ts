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

  export interface ExecResult {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    /** 输出达到模板上限被截断 */
    truncated: boolean;
    durationMs: number;
  }

  // 注意（P1 待办）：宿主方法的返回值目前以 **JSON 文本**回传（spike 约定），
  // 与下方声明中的对象形态尚未对齐；SDK 层将在 P1 统一为对象（ROADMAP P1 sdk 条目）。
  export const fs: {
    /** 写入文件（spike：fs.write.home 权限点；正式版走 fs 受限 + 路径收敛） */
    write(path: string, content: string): WriteResult;
  };

  export const exec: {
    /**
     * 执行**已注册模板**（没有自由命令，`docs/interface-audit-exec-fs.md` §1）。
     *
     * 两种写法都接受：
     * - **模板 ID 形式**（精确）：`exec.run('core:git.status', JSON.stringify({ repo: '/srv/demo' }))`；
     * - **原生写法**：`exec.run('git -C /srv/demo status --porcelain=v1 --branch')`、
     *   `exec.run('git', ['-C', '/srv/demo', 'status'])`、`exec.run(['git', '-C', '/srv/demo', 'status'])`。
     *
     * 原生写法**只用于匹配模板**：宿主把命令与每个模板的固定命令按"字面量 / 占位符"逐位对齐
     * （`argv[0]` 只比 basename），**字面量优先**（占位符更少的模板先命中），匹配到才执行，
     * 而且**执行的永远是模板里的固定 argv**；匹配不到 → `TEMPLATE_NOT_FOUND`（拒绝执行）。
     * 参数照样逐个过模板校验（path 收敛等），权限点也仍是模板的 `exec.template.<action>.<op>`
     * ——因此原生写法**绕不过授权**，也变不出新命令。
     *
     * @throws `TEMPLATE_NOT_FOUND`（模板未注册 / 原生写法匹配不到）、
     *         `TEMPLATE_PARAM_*`（参数缺失/未知/非法）、`PERMISSION_DENIED`（未授予该模板权限点）、
     *         `EXEC_TIMEOUT` / `EXEC_FAILED`
     */
    run(templateId: string, paramsJson?: string): ExecResult;
    /** 原生写法：整条命令字符串（按空白/引号分词后匹配模板） */
    run(command: string): ExecResult;
    /** 原生写法：命令名 + 参数数组 */
    run(command: string, argv: readonly string[]): ExecResult;
    /** 原生写法：完整 argv 数组 */
    run(argv: readonly string[]): ExecResult;
  };
}
