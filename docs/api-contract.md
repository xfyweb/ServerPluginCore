# 宿主 API 契约（v0.2）

> 依据：ADR-001（零环境权力）、ADR-005（QuickJS 沙箱 + 驱动插件机制）、manifest-design.md（schema 2）。
> v0.2 变更：传输模型从"JSON-RPC over stdio"改为**进程内 `@host/api` 注入为主**（QuickJS 沙箱），stdio JSON-RPC 降级为子进程档次通道；新增权限注册表、事件推送、API 扩展注册点。

## 1. 传输模型（双通道，同一套方法签名）

| 通道 | 适用 | 形态 | 说明 |
|---|---|---|---|
| **主通道** | QuickJS 沙箱（默认档） | 进程内 `@host/api` 模块注入（函数调用） | 插件 `import { fs, exec } from '@host/api'`；µs 级调用；注入即能力 |
| **次通道** | 子进程档（第三方隔离档）/ 驱动插件 | stdio JSON-RPC 2.0 | 与主通道**共用同一套方法签名、参数 schema、错误码**，仅传输不同 |

- **版本协商**：`lifecycle.version`（核心返回契约版本，插件 SDK 校验兼容）；契约按 semver 演进，破坏性变更走废弃期；
- 沙箱插件**只能**通过注入拿到 `@host/api`；子进程档插件通过 RPC 信封拿同一组方法。

## 2. 调用约定

- 每个方法有 JSON Schema 参数校验（宿主侧执行，跨通道共用一份 schema）；
- **错误模型（两层码，全英文，无本地化文本）**：
  - **顶层码**（传输/契约层）：`PERMISSION_DENIED` / `INVALID_ARGS` / `NOT_FOUND` / `TIMEOUT` / `INTERNAL` / `CONTRACT_MISMATCH`；
  - **领域码**（`detail.code` + `detail.params`）：如 `PATH_OUT_OF_SCOPE` / `SYMLINK_DANGLING` / `NOT_DECLARED` / `TIER_DENIED`；
  - 响应形状：`{ "error": "<顶层码>", "detail": { "code": "<领域码>", "params": { … } } }`；
  - **HTTP 不承载本地化文本**：CLI 用 `tError()` 渲染，面板自行请求 locale 文件在**前端渲染层**翻译；
  - **插件面（沙箱）**：`@host/api` 抛出的 `Error` 携带 `code` / `params`（`message` = 码），插件按码分支而非匹配文案；
  - **码是契约**：只增不改；新增码必须同步补 `locales/zh-CN.json` 的 `err.<code>`；
  - **全量清单的单一事实源是代码**：`core/errors.ts`（`SpcError`）+ 各模块的 code 类型联合（`PathErrorCode` / `CheckCode` / …）+ locales 的 `err.*`；本节与 module-emulation-design §7 只列举常用码与映射，**不重复维护全量列表**；
- 超时与并发上限宿主侧强制（防失控，不防恶意）。

## 3. 事件与钩子（宿主 ↔ 插件，反向通道）

> 事件订阅方主要是**协作插件**（hook，类型设计中）：钩子触发逻辑，参与核心事件生命周期并干预/修改；notify/arbitrate 语义即协作插件的工作方式。运行位置（核心/沙箱）与默认权限（网络/文件）待 ADR 定稿。

### 3.1 事件分类（manifest 声明）

插件在 manifest `exports.events` 中**显式声明**发布与订阅，两类语义分开：

```json
"exports": {
  "events": {
    "publish": [
      { "topic": "backup.done", "classification": "public" }
    ],
    "subscribe": [
      { "topic": "job.finished", "mode": "notify" },        // 只读通知（宽松）
      { "topic": "exec.before",  "mode": "arbitrate" }      // 裁决修改（严格）
    ]
  }
}
```

- **notify（只读通知）**：fire-and-forget，订阅方只读事件负载；
- **arbitrate（裁决修改）**：可返回 EventResult（allow/deny/modify/pass）影响核心流程（如 SSO 裁决登录）；
- topic 授权：**枚举声明，无通配**；事件负载可能含敏感信息（如 exec.after 的命令输出），订阅门槛见 §3.3。

### 3.2 事件实例结构

```ts
interface EventContext {
  event: string;              // "auth.login.before"
  pluginId: string;           // 处理方
  ts: number;
  subject: string;            // 触发者
  payload: unknown;           // 事件数据（只读）
  state: Record<string, unknown>;  // 跨 before→after 可变上下文
}

interface EventResult {
  status: 'allow' | 'deny' | 'modify' | 'pass';  // 放行/拒绝/改写后继续/不处理
  data?: unknown;     // modify 时的改写内容
  reason?: string;    // deny 时的原因（进审计）
}
```

### 3.3 安全等级（三级矩阵）

两个正交维度：**保密等级**（读门槛，管谁能订阅通知）与**执行等级**（写门槛，管谁能裁决）。

> 与 §6 **同一套等级、两处门槛**：本节的 confidentiality / executionLevel 管"事件订阅与裁决"的门槛（插件调用时通过 `meta` 声明、用户目录覆盖兜底）；§6 的同名字段是**权限点的默认等级**。两处不是两个维度——判定时按 `effective = max(...)` 合成，只取最高。

| 等级 | 通知订阅（读） | 裁决修改（写） |
|---|---|---|
| `public` / `low` | 无需额外授权 | 无需额外授权 |
| `sensitive` / `medium` | 显式授权（安装时确认） | 显式授权 |
| `secret` / `high` | 显式授予 + 二次确认 | 显式授予 + 二次确认 |

- **调用时声明**：插件每次调用宿主 API 时通过 `meta` 声明本次操作的等级（不同目录/命令敏感度不同）；权限点的 `confidentiality/executionLevel` 是**默认值**（未声明时兜底）；
- **用户目录覆盖（只升不降）**：管理员可配置目录 → 等级映射（`pathLevels`，P2 进配置中心），涉及指定目录时 `effective = max(调用方声明, 用户配置)`——用户设置高于调用方时升级，低于时尊重调用方；
- 审计记录 effective 等级。

## 4. 方法组（核心第一版）

> 「落地」列 = 当前代码状态。P1.5 起 fs/kv/timers/events/lifecycle 全部可用（`core/hostApi.ts`）。

| 方法组 | 方法 | 权限点 | 落地 | 说明 |
|---|---|---|---|---|
| **exec（模板）** | `exec.run`（阻塞）`exec.spawn`（异步→句柄） | `exec.template.<action>.<op>` | `run` ✅ / `spawn` P2 | **无自由命令**，仅模板 + 参数校验（详 §5、§4.1）；返回值是**原始 JSON 文本**（唯一不自动解码的方法） |
| **fs（受限）** | `fs.read` `fs.write` `fs.list` `fs.stat` | `fs.read.data` `fs.write.data` | ✅ | 作用域 = **插件数据目录**；路径收敛 + realpath；`fs.write` 在"最近存在祖先的 realpath 在数据目录内"时补建父目录；读取上限 1MB（写 64MB） |
| **fs 原语（`node:fs` 仿真用）** | `fs.readBytes`（二进制通道）`fs.writeBytes` `fs.statFull` `fs.readdirEntries` `fs.mkdir` `fs.mkdtemp` `fs.rm` `fs.rmdir` `fs.rename` `fs.copyFile` `fs.realpath` `fs.access` | `fs.read.data` `fs.write.data` | ✅（第二批） | 上面那四个是**能力面**（形状已发布，保持不变），这一组是**同一批安全机制上的更低层原语**：同样是路径收敛 F1–F7 + 权限点 + 审计，只是不做 Node 的 API 形状（不解析 options、不造 `Stats`）。`node:fs` / `node:fs/promises` 的仿真层把这一组组装成 Node 的形状（见 module-emulation-design §6）。**写这类原语不补建父目录**（Node 的 `writeFileSync('a/b/c')` 在父目录缺失时就是 `ENOENT`），补建是 `fs.write` 能力面独有的行为；`fs.readdirEntries` 条目上限 10000（超限 `ENTRY_LIMIT_EXCEEDED`） |
| **url（宿主代工）** | `url.resolveHref` `url.setPart` `url.paramsParse` `url.paramsStringify` `url.domainToASCII` `url.domainToUnicode` | `url.parse` `url.encode` | ✅（第二批） | WHATWG `URL`/`URLSearchParams` 的解析与百分号编码：QuickJS **没有** `URL`（实测），而畸形输入多到无法穷举 ⇒ 交给宿主（就是 Node）。**对象身份留在沙箱**（`node:url` 里的 `URL` 类），桥只过"解析一次 → 全量快照"，赋值时回宿主重算（≈0.21ms/次，赋值不是热路径） |
| **kv** | `kv.get` `kv.set` `kv.delete` `kv.keys` | `kv.read` `kv.write` | ✅ | 插件作用域持久化存储（`<dataDir>/kv.json`）；值 JSON 编解码（可存对象/数组）；键 `[A-Za-z0-9_.:-]{1,256}`、值 ≤256KB、键数 ≤1000、**总容量 ≤8MiB**；落盘是**合并写 + 原子替换**，确定性的落盘点在**阶段边界**（钩子/装载结束、卸载前）——`kv.set` 返回后读回立即可见，但同一钩子内多次写只落盘一次 |
| **timers** | `timers.every` `timers.clear` | `timers.schedule` | `every`/`clear` ✅ / `cron` P2 | 宿主侧调度，插件不保活（定时器 unref）；回调在沙箱内执行、与钩子同样限额；卸载时宿主自动清掉；**同时存活上限 64 个**（计活着的，`clear` 即释放；超限 `TIMER_LIMIT_EXCEEDED`） |
| **events** | `events.publish`（订阅走 manifest 声明） | `events.publish` | ✅（总线本体 P2） | topic 必须已在 manifest `exports.events.publish` 声明，否则 `EVENT_TOPIC_NOT_DECLARED`；同一 topic 只能有一个发布者 |
| **lifecycle（宿主 API）** | `lifecycle.health` `lifecycle.version` | `lifecycle.health` `lifecycle.version` | ✅ | 心跳、契约协商；**插件自身钩子（宿主→插件）方向相反，见 §4.2 与 plugin-lifecycle-design.md** |
| **bytes（编解码）** | `bytes.fromString` `bytes.toString` `bytes.byteLength` | `bytes.encode` `bytes.decode` | P2-B | **宿主代工的编解码**（utf8 / latin1 / base64 / hex）：沙箱侧**字节存本地**（`Uint8Array` 子类），只有编解码整块过桥。**为什么代工**：QuickJS 没有 `TextEncoder`，沙箱内纯 JS 逐字节只有 ≈2.6 MB/s；而且交给宿主即**天然与 Node 逐字节一致**（畸形输入不必复刻）。它**不是 `node:buffer` 的私有细节**——仿真模块与插件作者用**同一批**方法。详见 module-emulation-design §3.2 |
| **audit** | （无需插件调用） | — | ✅ | 宿主对每个调用落审计（§8） |

- **作用域**：上表除 `exec.template.*`（`scope: host`，必须管理员逐点授予）外，其余全部 `scope: self`——碰的都是插件自己的数据/自己的调度，安装即生效（见 intent-capture §8.1 的三档模型，`grant` 档位落地位于 P2）；
- **返回值约定**：除 `exec.run` 外的组由沙箱侧做 JSON 解码，插件拿到真值（对象/数组/布尔），不需要自己 `JSON.parse`；
- **命名约定**：权限点 = 方法名（同样的字符串让插件作者一眼看懂要哪几个点），差别只出现在"同一方法因目标不同而敏感度不同"的场合（`exec.run` 的动态模板点）。

**核心不向插件暴露网络原语**：不仿真 `node:net`/`http`/`dns`/`tls`、不提供裸 socket、**也不设 `net.*` API**。db 连接代理、SSH、Docker 客户端、pty、媒体处理同样**由驱动插件经扩展注册点提供**（见 §10）。插件出网只有两条路：**`exec` 模板**（核心）与**驱动插件注册的端点**（插件），两条都是显式权限点（intent-capture §6.3）。

> 注意区分：**核心自身有出网**——市场下载与密钥状态文档拉取（plugin-signature-design §6 的 `GET https://{origin}/.well-known/spc-key-status`）。那是核心的运维行为，与插件能力面无关，也不出现在权限注册表里。

## 4.1 命令执行任务模型（参考 MCSManager）

> 设计参考：MCSManager 的 AsyncTask 模型（daemon/src/service/async_task_service）+ 进程适配器 + 状态机。
> 落地：P2（进程管理器），P1 仅 `exec.run` 阻塞形态。

**统一任务模型**：阻塞与异步是同一任务对象的两种消费方式，不是两套 API。

```
exec.run(template, params, {timeoutMs})       // 阻塞：spawn + await handle.wait()
exec.spawn(template, params) → TaskHandle     // 异步：立即返回句柄
```

**TaskHandle（沙箱内句柄对象，方法调用走宿主桥）**——插件三态切换：

```ts
interface TaskHandle {
  id: string;                    // 复杂随机，防枚举（MCSM：taskId 防越权）
  status(): 'running' | 'done' | 'error' | 'killed';
  wait(): Promise<{ exitCode: number }>;      // 阻塞等待（STOP→resolve / ERROR→reject）
  output(opts?): string[];                   // 拉取输出（增量/尾部）
  kill(): Promise<void>;                     // 取消（先软后硬杀树）
  events: EventEmitter;                       // started/exit/data/error（或走事件总线）
}
```

**关键机制**（MCSM 验证过的坑，必须内置）：

| 机制 | 说明 |
|---|---|
| **世代号（startCount）** | 句柄记录代际；所有超时/取消回调先校验"还是不是原来那个任务"再动手——防竞态 |
| **取消三层链** | abort 流 → 销毁句柄 → **杀进程树**（Linux `/proc` 递归子进程、Windows `taskkill /T /F`）——防子进程逃逸 |
| **优雅停止契约** | 停止策略配置化：`{ stopCommand?, signal, timeoutMs }`——先命令式停止 → ^C/SIGINT → 超时升级 SIGKILL → 杀树兜底 |
| **`detached: false`** | 不分离子进程——父进程异常退出时子进程不继续运行 |
| **输出环形缓冲** | 固定容量（默认 256 块 × 256 字符，50ms flush），**截断时插入 `[截断]` 标记**；内存固定不增长 |
| **任务归属** | 句柄绑定创建者插件——只能控制自己的任务（`jobs.manage` 区分"自己/全局"） |
| **任务级资源限制** | 非容器场景务实方案：磁盘配额 + 降权运行（runAs）+ 超时杀树；硬限制（内存/CPU）留给 docker/未来 |

**长驻进程（MC 服务器等）**——任务模型的特殊形态（无终态，状态机）：

```
process.start(id, template, params) → ProcessHandle   // spawn（低权限用户，数组参数不拼 shell）
process.output(id) / process.signal(id, sig) / process.stop(id, {timeoutMs})
权限点：process.start / process.signal / process.stop（dangerous 级）
状态机：STOPPING → STARTING → RUNNING（+ 崩溃自动重启：autoRestart + 次数上限）
```

**事件扩展**（进 §3 事件清单）：`job.finished`、`process.exit`、`process.crash`、`process.data`（输出流订阅可选）。

## 4.2 插件钩子（宿主 → 插件）

与 §4 的方法组**方向相反**：装载器调用插件导出的钩子。完整契约、状态机、配置与验收见 **plugin-lifecycle-design.md**。

```ts
export async function init(ctx: PluginContext): Promise<void>;   // 必需
export async function start(ctx: PluginContext): Promise<void>;  // 可选
export async function stop(ctx: PluginContext): Promise<void>;   // 可选
```

- **两种注入分工**：`@host/api`（模块注入）= **能力**；`ctx`（参数注入）= **环境事实**（`{ pluginId, version, dataDir, manifest(只读), grants(只读), logger }`）；
- **能力登记由 loader 依 manifest 完成**（routes / webApis / events；`execTemplates` 随 P2-5），插件不能自己注册；
- **四层限额**：CPU 中断（`setInterruptHandler`：死循环与正则灾难性回溯都拦得住）/ 内存（`setMemoryLimit`）/ 栈（`setMaxStackSize`）/ **宿主 API 自带超时**；
- **契约要求（对宿主 API 作者）**：asyncify 挂起期间 VM 不执行代码，中断不触发——所以**任何可能阻塞或依赖外部输入的宿主 API 必须自带超时**（`exec.run` 的 `timeoutMs` 是样板）；
- async 钩子由宿主泵 job 队列（`executePendingJobs`），未泵完即报 `PLUGIN_JOB_PENDING`。

## 5. 危险原语策略

**exec 模板**（核心第一版审计焦点，详细规范见 interface-audit-exec-fs.md，沙箱与注册制见 exec-sandbox-design.md）：
- 模板注册表（**注册制**，两方来源 + 命名空间 `core:` / `<pluginId>:`）：插件在 manifest `execTemplates` 声明 → 核心静态校验（E1–E10）→ 管理员批准 → 进注册表；参数用枚举/正则/白名单校验；**管理员是审批方，不定义模板**（他定义的模板插件开发时看不见）；
- 调用写法：模板 ID 形式（`exec.run('core:git.status', {repo})`）与**原生写法**（`exec.run('git -C /srv/demo status …')`）等价——原生写法只用于**匹配模板**，执行的永远是模板的 argv，匹配不到即 `TEMPLATE_NOT_FOUND`；匹配时**字面量优先**，命令形状全局唯一（详见 interface-audit-exec-fs.md §2）；
- 命令构造禁止字符串拼接用户输入（数组传参）；凭据禁明文 `-p`，走 `MYSQL_PWD`/`--defaults-extra-file`（chmod 600，用完即删）；
- 输出大小限制、超时、工作目录固定、环境变量白名单；
- 第一版内置模板（**无自由命令**；命令固定 + 参数校验，见 interface-audit-exec-fs §2）：
  - **git**：`core:git.version`（诊断，无参数）、`core:git.status`、`core:git.log`（`count` 限 1–3 位数字）、`core:git.rev-parse`、`core:git.branch`（只读）、`core:git.fetch`、`core:git.pull --ff-only`（动仓库 / 走网络）；除 `version` 外都以 `repo`（path，**白名单作用域**）为参数；
  - **nginx**：`core:nginx.test`、`core:nginx.reload`（找得到 nginx 才注册）；
  - psql/mysql（凭据走 env）待补。
  - 仓库白名单根默认按平台取（Windows `%ProgramData%\spc\repos`；Linux `/srv`、`/var/lib/spc/repos`），可用 `SPC_REPO_ROOTS`（平台分隔符）覆盖——"哪些目录里的仓库允许被模板操作"由管理员决定；
  - 可执行文件解析跨平台（Windows 常见 `%ProgramFiles%\Git\cmd\git.exe`），但解析结果仍要过 E10 白名单；单个内置模板注册失败只告警，不影响核心启动。

**fs 路径收敛**：
- 所有路径 `realpath` 规范化后校验前缀；拒绝符号链接逃逸、`..`、特殊文件（/dev、/proc、socket）；
- 写操作默认只落插件数据目录；大小限制、文件类型白名单；
- 详细威胁建模清单见 interface-audit-exec-fs.md。

## 6. 权限注册表（D4，核心侧集中登记）

每个权限点一条记录：

```json
{
  "name": "docker.write",
  "group": "docker",
  "description": "修改容器配置",
  "scope": "host",                  // self | host：资源作用域（碰不碰宿主资源）
  "grant": "explicit",              // auto | install | explicit：授予方式（判定链读取）
  "confidentiality": "sensitive",   // 读门槛
  "executionLevel": "medium"        // 写门槛
}
```

三个维度，各管一件事：

| 字段 | 管什么 | 规则 |
|---|---|---|
| `scope` | **碰不碰宿主资源**（资源作用域，用于路径收敛与文案） | `self` = 只碰插件自身（自己的数据目录 / kv / 定时器）；`host` = 碰宿主管理的资源。注册期一致性约束：**`self` 只能是 `auto`**（违反 → `SCOPE_GRANT_INVALID`），与既有的 `executionLevel ≥ confidentiality` 同属注册期校验 |
| `grant` | **要不要管理员逐点授予**（判定链第 3 步读取） | `auto` 安装即生效；`install` 读安装清单即生效、可一键收回；`explicit` 默认拒绝、**必须逐点授予**（intent-capture §8.1） |
| `confidentiality` / `executionLevel` | 授予时的**提示强度**、审计分级与 `effective` 合成 | `effective = max(调用方声明, 用户目录覆盖, 权限点默认)`，**只升不降**；不变式 `executionLevel ≥ confidentiality`（封死仲裁旁路） |

> v3 修订：**删除 `protectionLevel`**（Android 的"授予仪式"枚举：normal / dangerous / signature）。理由：(1) 它在本仓库里从未被判定逻辑读取，是装饰性字段；(2) 其中 `signature`（仅同签名可申请）把身份塞进权限定义，与"来源不参与权限判定"冲突；(3) `normal` 真正表达的是"这个能力够不着别人"，用 `scope: self` 表达更准确。按信任档分档的 `defaults` 同时删除。
>
> v4 修订：**新增 `grant` 三档**（intent-capture §8.1）。它和刚删掉的 `protectionLevel` 的区别是本质的——`grant` **被判定链读取**（第 3 步只看它），而 `protectionLevel` 是死字段；`scope` 则从"要不要授予"退为"碰不碰宿主资源"，并在注册期约束 `grant`。**目标态尚未落地**：当前代码仍是 `scope = host ⇒ 未授予即拒绝`，改动随 P2 权限层一起做。

- **权限点不设 identity / trust 类字段**：它只描述"这个能力是什么、有多敏感"，不描述"谁有资格申请"。
- 注册表是审计、管理 UI、测试、驱动插件注册方法时枚举的单一事实源。

## 7. 权限判定（三态 + 匹配算法）

判定链（宿主侧强制，D3 单一强制点）：

```
1  权限点未在注册表登记               → UNKNOWN_POINT（未知即拒绝）
2  manifest 未声明该点                → NOT_DECLARED（无默认放行）
3  grant = explicit 且管理员未授予    → NOT_GRANTED（auto / install 档免逐点授予，见 intent-capture §8）
4  通过 → 作用域与参数校验在各方法内层（auto / install 通过时审计记 installed-grant）
```

- `grant` 三档（`auto` / `install` / `explicit`）是权限点的属性：`auto` = self 域 + `lifecycle.*`；`install` = host 级只读 + 插件自有能力（安装清单即生效，可一键收回）；`explicit` = 写宿主资源 / `exec.template.*` / `process.*` / **出网类权限点（exec 模板或驱动插件注册的端点）** / 提权，默认拒绝。**升级新增的 `install`/`explicit` 点必须重新展示（增量同意）**；
- 判定结果：`ALLOW / DENY / UNSET→DENY`（Tristate：未设置 = 拒绝）；
- **声明可用通配，授予不可**：manifest 声明可写 `docker.*` / `*` 图省事；**管理员的授予必须是具体权限点**（不允许通配，防止一次点击等于全授）；
- 插件 manifest 声明的是"请求"（uses-permission）；宿主按"`scope` + `grant` 档 + 管理员逐点授予"做出"批准"（请求/批准分离，Android 模型）；
- **来源（签名 / 市场 / 本地安装）不参与判定**：有源与无源插件在权限面前完全平等（ADR-001 v3）。

## 8. 审计

每条调用落：`{ts, pluginId, method, target?, paramsDigest, result, permission: {decision, code, paramsDigest}, error?: {code, paramsDigest}, resultBytes?, durationMs}`——审计日志只增不改，插件不可达；**只记机器可读的码与参数摘要**（不落明文参数、不落本地化文本；本地化在 `spc audit tail` / 面板渲染层完成）；权限拒绝单独告警。`target` 是动态权限点的解析结果（如 `exec.template.nginx.reload`），`resultBytes` 是结果序列化字节数（exec 的命令输出量），两者都非敏感，便于排障与统计。

**生命周期条目**（plugin-lifecycle-design §7）：`lifecycle.load`（求值失败）、`lifecycle.init` / `lifecycle.start` / `lifecycle.stop` / `lifecycle.unload`（每个钩子，`result: ok/error` + durationMs）、`lifecycle.restart`（`failedRestart=auto` 触发，带 `attempts`）；`target` = 插件 ID。**定时器回调**落 `timers.tick`（`target` = timerId，`paramsDigest` = callbackId 摘要）——它不经过宿主桥，所以由沙箱侧显式记账。

## 9. manifest（schema 2）

> `type` 声明插件类型（ability/driver/hook/theme），缺省 `ability`。四类定义见 README「插件类型」与 ADR-005 v3；type 目前不改变核心加载行为（**现状**档位仍由 id 前缀推导；**目标态**：**来源只决定更新渠道与安装界面，与加载和权限无关**，见 plugin-signature-design.md），P2/P3 起按类型分派运行档与安装流程（`theme` 无沙箱、豁免 `init`）。

完整设计见 manifest-design.md，要点（与旧 schema 1 的差异）：

```json
{
  "schema": 2,
  "id": "@xfy2412/docker",
  "name": "Docker Management",
  "author": { "id": "xfy2412@market.spc.xfyweb.cn", "name": "xfy2412" },
  "version": { "code": 12, "name": "1.2.0" },
  "compat": { "minCore": "0.1.0", "targetCore": "0.3.0" },
  "runtime": { "type": "quickjs", "esm": true },
  "permissions": [ { "name": "docker.read", "reason": "列出容器与镜像" } ],
  "exports": {
    "webApis": [ { "path": "/api/docker/containers", "permission": "docker.read" } ],
    "routes": [ { "path": "/docker", "title": "Docker", "icon": "container" } ],
    "events": {
      "publish":   [ { "topic": "backup.done", "classification": "public" } ],
      "subscribe": [ { "topic": "docker.container.crash", "mode": "notify" } ]
    }
  },
  "dependencies": { "npm": [ { "name": "zod", "version": "3.x" } ], "plugins": [] }
}
```

- `permissions` 必填（无默认放行）；
- `id` 为**市场内唯一**的发布者命名空间 `@<username>/<name>`；跨市场全局唯一性由完整引用 `<origin>/@<username>/<name>` 提供（plugin-signature-design.md §8）；
- `author.id`（可选）= `<username>@<源域名>`；填写时须与 `id` 的命名空间和源域名一致，否则 `AUTHOR_MISMATCH`；
- `dependencies.plugins[]`：`{ id, origin?, version? }`——同源依赖省略 `origin`，跨源依赖必须写明；缺少的源**不会自动添加**，只会提示管理员（plugin-signature-design.md §7.1）；
- `dependencies.npm[]`：npm 依赖**声明**（`{ name, version }`）。**没有 `tier` 字段**——依赖不分信任档（ADR-005 §7 v2）：真实闭包由**构建器**解析，构建期只做"能不能带"的能力检查，不产生任何用户放行动作（旧 `tier` 枚举与 `protectionLevel` 同因删除：判定链不读的字段不留）；
- `runtime.type`：`quickjs`（默认）| `node-child`（子进程档）；ESM-only 全后端统一。

## 10. API 扩展注册点（驱动插件机制）

核心提供注册协议，让**驱动插件**（driver，核心端特权档）扩展 `@host/api`：

```
注册请求：{ capability: "db", methods: [{ name: "query", schema, permission: "db.query", intent: "none", operation: "db.query" }] }
```

- 驱动插件**不限制来源**（自建市场与官方市场等价），安装走**独立界面与最高强度提示**（ADR-005 §3）；必须：特权档（跑在核心侧/独立 Node 进程，拥有 node API，可下载自己的依赖）；
- 驱动插件向面板注册**权限节点 + API 端点**暴露给沙箱：每个注册方法进权限注册表（D4）、过威胁建模评审、随核心一起审计；
- **`operation` 名必须与 `permission` 一同登记**：核心确认窗口据此签发 grantId，`grant.operation` 校验不上就执行不了（intent-capture §8.7②）——`operation` 缺省时取 `name`，但涉及资源操作的方法**必须显式写明**（如 `docker.remove` 而非 `remove`）；
- **每个注册方法必须声明是否需要"意图确认"**（`intent: 'none' | 'confirm' | 'session'`）：
  - `none`：仅权限点（插件**自主发起**的操作）；
  - `confirm`：每次调用都需要用户在核心 UI 确认（离散写类）；
  - `session`：建立会话时确认一次并签发**绑定该会话**的 grantId（pty / SSH / DB 类），会话内敏感命令仍由核心拦截二次确认。
  核心网关据此在调用前要求对应的 grantId（校验见 intent-capture.md §4/§7）；**强制点在核心/驱动端点**——沙箱插件没有 socket，会话数据面必经核心；
- **鉴权双层**：核心网关先强制检查"调用方（沙箱内能力插件）有没有该端点权限"（D3 单一强制点不放松）；驱动插件内部再按面板给的权限列表**自行鉴权**（参数是否越界等）——驱动插件是市场严审对象，第三方安装有严厉提醒；
- 沙箱内的**能力插件**（ability）通过 `import { db } from '@host/api/db'` 调用，**与基础 API 无感知差异**。

> 术语沿革：早期文档称驱动插件为"能力插件（特权档）"，v2 定稿后"能力插件"专指沙箱内挂载管理页面的插件（ability），核心端注册端点的插件称**驱动插件**（driver）。

## 11. 前端 API（核心 REST，P3）

**调用者只有核心前端**（浏览器里的可信 Web Shell），带 frontend-token。插件前端**不直连**这些端点（它处在 opaque origin、且 CSP 零出网），只能经 `postMessage` 由核心前端代理。完整模型见 **intent-capture.md**。

| 端点 | 作用 | 认证 |
|---|---|---|
| `POST /api/intent/grant` | 用户确认后签发 grantId（body：`audience` / `operation` / `resource`） | frontend-token |
| `POST /api/intent/revoke` | 撤销 grantId | frontend-token |
| `POST /api/intent/forward` | 插件前端 → 插件后端的意图转发（**按 manifest `intent[]` 声明校验**；违规 → `INTENT_SCHEMA_VIOLATION`） | frontend-token + `MessageChannel` 会话 |
| `POST /api/fs/{read,list,write,delete,move}`、`POST /api/session/{open,exec}` … | 核心原生能力（**核心执行，插件不参与**） | frontend-token；写类/会话类需带刚签发的 grantId |
| `GET /api/theme/active` | 当前主题令牌（核心与插件 iframe 共用同一批 CSS 变量） | frontend-token |

- **frontend-token**：绑定用户会话、只存核心前端内存、短时有效，**绝不下发给插件 iframe**；
- 插件文档的 **CSP 与 `sandbox` 属性由核心下发**（插件无法覆盖）：`default-src 'none'`、`connect-src 'none'`、`sandbox="allow-scripts"`（无 `allow-same-origin`）等，见 intent-capture.md §5/§6.1；
- 意图负载形状由 manifest `intent[]` 声明（`selection | text | enum`），**默认只给资源引用、不给内容**；要内容必须持 grantId 走沙箱 API；
- 核心可 **headless**：关闭 Web 服务后本组端点一并关闭，一切管理回到 CLI（ADR-002 v4）。

## 12. 待定项（v0.3 再议）

1. 事件总线 topic 与插件可见性（dependencies.plugins 显式声明）的细化授权模型；
2. `@host/api` 类型声明的自动生成（从注册表生成 TS 类型，保证 IDE 体验与运行时一致）；
3. 驱动插件与核心的进程边界（同进程 vs 独立进程的取舍与配置）；
4. QuickJS 性能 benchmark 结论对 §5 超时/并发默认值的影响；
5. **默认安全边界（已定，见 intent-capture §7/§8）**：确认判据 = ①意图经不可信方转述 或 ②点击时后果不可见；四档 L0–L3；权限点 `grant` 三档 `auto`/`install`/`explicit`；仅 `explicit` 需逐点授予。落地在 P2（`core/permissions/` 加 `grant` 字段 + 判定链第 3 步）与 P3（前端确认 UI）。
