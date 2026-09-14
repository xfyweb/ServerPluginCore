// @host/api 沙箱抽象模块的类型声明
//
// 插件代码 `import { fs } from '@host/api'` 在沙箱内由宿主注入实现；
// 本文件提供编译期类型（IDE 提示 + 构建期校验）。
// 正式版：类型应从权限注册表 / 宿主 API 契约自动生成（ROADMAP P1 待补），
// 当前与 core/hostApi.ts 的注入实现手写对齐——**改注入实现必须同步改本文件**。
//
// 返回值约定（P1.5）：除 `exec.run` 外的组都由沙箱侧做 JSON 解码，插件拿到的是真值
// （对象/数组/布尔/数字），不需要自己 `JSON.parse`。exec 的返回值是文本协议（带 stdout/stderr），
// 由插件自己解析——它是唯一保留"原始文本"的方法。
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

  // ---- fs：作用域 = 本插件的数据目录（路径收敛 F1–F7）----
  export interface WriteResult {
    ok: boolean;
    path: string;
    bytes: number;
  }
  export interface ReadResult {
    path: string;
    content: string;
    bytes: number;
  }
  export interface ListEntry {
    name: string;
    type: 'file' | 'dir';
    size: number;
  }
  export interface ListResult {
    path: string;
    /** 条目数超过宿主上限（1000）时被截断 */
    truncated: boolean;
    entries: ListEntry[];
  }
  export interface StatResult {
    path: string;
    size: number;
    isFile: boolean;
    isDirectory: boolean;
    mtimeMs: number;
  }

  export const fs: {
    /** 读文件（上限 1MB：更大的内容进不了 32MiB 的沙箱堆） */
    read(path: string): ReadResult;
    /** 写文件（相对路径按数据目录解析；越界 → PATH_OUT_OF_SCOPE） */
    write(path: string, content: string): WriteResult;
    /** 列目录（最多 1000 条，超出时 truncated=true） */
    list(path: string): ListResult;
    /** 取文件/目录属性 */
    stat(path: string): StatResult;
  };

  // ---- kv：插件作用域持久化存储（落 <dataDir>/kv.json）----
  export interface KvSetResult {
    ok: boolean;
    key: string;
    bytes: number;
  }
  export interface KvDeleteResult {
    ok: boolean;
    key: string;
    /** 删除前是否存在（幂等：重复删除不报错） */
    existed: boolean;
  }

  export const kv: {
    /** 键不存在返回 undefined；值可以是任意可 JSON 化的数据 */
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): KvSetResult;
    delete(key: string): KvDeleteResult;
    keys(): string[];
  };

  // ---- timers：宿主侧调度，插件不保活 ----
  export interface TimerHandle {
    timerId: string;
    intervalMs: number;
  }

  export const timers: {
    /**
     * 每 intervalMs 毫秒调用一次 fn（100ms–24h）。
     * - 回调在**沙箱内**执行，与钩子享受同样的限额与超时；
     * - 上一次回调还在跑时跳过本次（不并发进同一 VM）；
     * - 卸载（stop/disable）时宿主自动清掉全部定时器，**不必**手工 clear 也不会有泄漏；
     *   仍建议在 `stop` 里显式 clear，语义更清楚。
     */
    every(intervalMs: number, fn: () => void | Promise<void>): TimerHandle;
    clear(timerId: string): { ok: boolean };
  };

  // ---- events：发布（订阅方向走 manifest 声明，宿主 → 插件）----
  export interface PublishResult {
    ok: boolean;
    topic: string;
    bytes: number;
  }

  export const events: {
    /**
     * 发布事件。`topic` 必须先在 manifest `exports.events.publish` 声明，
     * 否则 EVENT_TOPIC_NOT_DECLARED（声明即审核面）。
     * 事件总线本体是 P2，P1.5 只保证"声明内 + 可审计"。
     */
    publish(topic: string, payload?: unknown): PublishResult;
  };

  // ---- lifecycle：插件 → 宿主的契约协商与心跳 ----
  export interface VersionInfo {
    /** 核心版本（semver） */
    core: string;
    /** 宿主 API 契约版本（整数，破坏性变更才 +1） */
    api: number;
    pluginId: string;
  }
  export interface HealthInfo {
    ok: boolean;
    pluginId: string;
    at: number;
  }

  export const lifecycle: {
    /** 契约协商：启动时确认"这个核心提供的是哪一版 API" */
    version(): VersionInfo;
    /** 心跳回执（P1.5 只回执；超时判定在宿主侧） */
    health(): HealthInfo;
  };

  // ---- exec：只能调用**已注册模板**（没有自由命令）----
  export interface ExecResult {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    /** 输出达到模板上限被截断 */
    truncated: boolean;
    durationMs: number;
  }

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
     * 注意：返回值是**原始 JSON 文本**（唯一不做自动解码的方法），需要 `JSON.parse`。
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
