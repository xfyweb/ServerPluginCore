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
  /** `fs.statFull` 的全字段结果（日期是 ISO 字符串：桥只过 JSON） */
  export interface StatFullResult {
    path: string;
    kind: 'file' | 'dir' | 'symlink' | 'block' | 'char' | 'fifo' | 'socket' | 'unknown';
    size: number;
    mode: number;
    dev: number;
    ino: number;
    nlink: number;
    uid: number;
    gid: number;
    rdev: number;
    blksize: number;
    blocks: number;
    atimeMs: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
    atime: string;
    mtime: string;
    ctime: string;
    birthtime: string;
  }
  export interface DirEntryInfo {
    name: string;
    kind: StatFullResult['kind'];
  }
  export interface ReaddirResult {
    path: string;
    entries: DirEntryInfo[];
  }
  export interface PathResult {
    path: string;
  }
  export interface OkResult {
    ok: boolean;
    path: string;
  }
  export interface WriteBytesResult extends OkResult {
    bytes: number;
  }
  export interface RemoveResult {
    path: string;
    /** false = 本来就不存在（`{force:true}` 时不报错） */
    removed: boolean;
  }
  export interface MkdirResult extends PathResult {
    /** recursive 下 Node 给"第一个被创建的目录"；已存在时为 null */
    created: string | null;
  }
  export interface RenameResult {
    from: string;
    to: string;
  }
  export interface CopyFileResult extends RenameResult {
    bytes: number;
  }

  export const fs: {
    /** 读文件（上限 1MB：更大的内容进不了 32MiB 的沙箱堆） */
    read(path: string): ReadResult;
    /** 写文件（相对路径按数据目录解析；越界 → PATH_OUT_OF_SCOPE）。**唯一会补建父目录的写入口**（Node 的 `writeFileSync` 不补） */
    write(path: string, content: string): WriteResult;
    /** 列目录（最多 1000 条，超出时 truncated=true） */
    list(path: string): ListResult;
    /** 取文件/目录属性 */
    stat(path: string): StatResult;

    // ---- 以下原语服务 `node:fs` 仿真（同样走权限点与审计；不做 Node 的 API 形状）----
    /** 读原始字节（**二进制通道**：返回 `Uint8Array`；上限 1MB） */
    readBytes(path: string): Uint8Array;
    /** 写原始字节；`opts` 是 JSON 文本 `{"append"?:boolean,"exclusive"?:boolean}`。**不补建父目录**（Node 语义） */
    writeBytes(path: string, data: Uint8Array | ArrayBuffer, opts?: string): WriteBytesResult;
    /** 全字段属性；`follow='false'` 等价于 lstat（但路径收敛仍会解析软链，见 module-emulation-design §9） */
    statFull(path: string, follow?: string): StatFullResult;
    /** 列目录（含类型；上限 10000 条，超限 `ENTRY_LIMIT_EXCEEDED`） */
    readdirEntries(path: string): ReaddirResult;
    /** 建目录；`opts` 是 JSON 文本 `{"recursive"?:boolean,"mode"?:number}` */
    mkdir(path: string, opts?: string): MkdirResult;
    /** 建随机名临时目录（宿主 CSPRNG 起名）；`prefix` 所在目录必须已存在 */
    mkdtemp(prefix: string): PathResult;
    /** 删除；`opts` 是 JSON 文本 `{"recursive"?:boolean,"force"?:boolean}`；目录必须显式 recursive */
    rm(path: string, opts?: string): RemoveResult;
    /** 删**空**目录（非空 → ENOTEMPTY，不是目录 → ENOTDIR；与 rm 的语义刻意不同） */
    rmdir(path: string): RemoveResult;
    /** 改名 / 移动（目标父目录必须已存在） */
    rename(from: string, to: string): RenameResult;
    /** 拷贝；`opts` 是 JSON 文本 `{"exclusive"?:boolean}`（对应 `COPYFILE_EXCL`） */
    copyFile(from: string, to: string, opts?: string): CopyFileResult;
    /** 规范化真实路径（不存在的路径 → ENOENT，与 Node 一致） */
    realpath(path: string): PathResult;
    /** 可访问性检查；`mode` 是 `F_OK`/`R_OK`/`W_OK`/`X_OK` 的数字（缺省 `F_OK`） */
    access(path: string, mode?: string): OkResult;
  };

  // ---- url：WHATWG URL 解析与百分号编码的宿主代工（对象身份在 node:url 里）----
  export interface UrlSnapshot {
    href: string;
    origin: string;
    protocol: string;
    username: string;
    password: string;
    host: string;
    hostname: string;
    port: string;
    pathname: string;
    search: string;
    hash: string;
    params: [string, string][];
  }

  export const url: {
    /** 解析（等价 `new URL(input, base)`）；非法 → `ERR_INVALID_URL` */
    resolveHref(input: string, base?: string): UrlSnapshot;
    /**
     * 给已解析的 href 的某个部件赋值，返回新快照。
     * `part` ∈ href/protocol/username/password/host/hostname/port/pathname/search/hash；
     * 非法值照 WHATWG **静默忽略**（不抛错）。
     */
    setPart(href: string, part: string, value: string): UrlSnapshot;
    /** 解析查询串 → `[k, v]` 数组（`+` 解成空格、百分号解码照规范） */
    paramsParse(text: string): [string, string][];
    /** `[k, v]` 数组（JSON 文本）→ 查询串（`application/x-www-form-urlencoded` 序列化） */
    paramsStringify(pairsJson: string): string;
    /** 域名 → punycode（IDNA） */
    domainToASCII(domain: string): string;
    /** punycode → 域名 */
    domainToUnicode(domain: string): string;
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
