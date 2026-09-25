# 命令执行沙箱与模板注册制设计（exec-sandbox）

- 状态：**设计定稿（2026-08）**；实现：P1 做"降权 + env + 超时"基线，系统级强制 P2/P5
- 关联：interface-audit-exec-fs.md（exec 模板规范）、api-contract §4.1（任务模型）、ADR-005（分层 hook ⑤内核层）、docs/privilege-gate.md（特权执行器）

## 1. 问题

exec 模板（命令固定 + 参数白名单）无法覆盖全部场景（MC 启动参数千变万化，MCSM 以自由命令 `startCommand` 覆盖该场景）。但"自由命令"是最危险原语——**本设计不引入它**，改用模板注册制覆盖同一场景（§6）。需要解决：

1. **模板覆盖不全** → 模板注册制（插件声明模板）
2. **路径/类型声明依赖插件自觉** → 系统级沙箱强制（不信任声明）
3. **沙箱通道完整性**（bash→Windows interop 绕过 Landlock 的实测教训）

## 2. 模板注册制（契约修复）

### 2.1 问题：管理员自定义模板的契约断裂

管理员定义模板 → 插件作者开发时不知道 → 插件无法可靠调用。**模板定义方应是插件，管理员是审批方**。

### 2.2 模板来源两方（统一注册表 + 命名空间）

模板的定义方**必须是调用方在开发时能看到的人**：管理员临时定义的模板，插件作者开发时根本不知道，也就无法可靠调用（§2.1 的契约断裂）。因此模板只有两方来源，**管理员是审批方而不是定义方**：

| 来源 | 命名空间 | 定义方 | 谁能调用 |
|---|---|---|---|
| 核心内置 | `core:nginx.reload` | 核心 | 按该模板自动生成的权限点 |
| **插件声明** | `<pluginId>:mc.start` | 插件（manifest `execTemplates`） | 声明插件 + 管理员逐点授予 |

> 插件命名空间 = **插件 ID 原样**（如 `@xfy2412/docker:mc.start`，见 plugin-signature-design.md §8；**点式命名空间属于核心 · 驱动 · 协作那条线**，见 `api-contract.md` §4.0）。插件 ID 中不含 `:`，因此按**第一个 `:`** 切分命名空间即可；`core:` 是唯一保留命名空间，插件 ID 的命名空间部分不得取该值。
>
> 权限点由 `<action>.<op>` 生成：`exec.template.<action>.<op>`（如 `exec.template.nginx.reload`）。因为它不含命名空间，**注册表强制 `action.op` 全局唯一**——两个插件声明同名 action.op 时后注册者失败，这是模板注册的碰撞闸门。
>
> 同理，**命令形状也必须全局唯一**（字面量/占位符布局相同即视为同形状）：否则一条原生写法命令能同时对上两个模板，权限点归属就有歧义。原生写法匹配时**字面量优先**（占位符更少的模板先命中），匹配不到一律拒绝（详见 interface-audit-exec-fs.md §2）。

### 2.3 插件声明模板流程

```
① manifest 声明 execTemplates（作者开发时定义，契约不断裂）
② 加载时核心做【静态威胁建模校验】（E1–E10 应用到模板定义）
   ——模板是可审查的静态数据，不是运行时任意代码
③ 管理员批准（安装/配置时）→ 进注册表（带来源标记）
④ 调用：exec.run('<pluginId>:mc.start', params)；未知模板 → 报错
```

### 2.4 TemplateDef

```ts
interface TemplateDef {
  id: string;                    // 命名空间内唯一
  command: string[];             // 固定命令数组（禁止字符串拼接，E1）
  params?: {
    name: string;
    type: 'enum' | 'pattern' | 'whitelist' | 'path';
    allowed?: string[];          // enum / whitelist
    pattern?: string;            // pattern（正则）
    scope?: string[];            // path 类型：作用域白名单（validatePath 复用）
    mustExist?: boolean;         // path 类型
  }[];
  cwd?: string;                  // 固定（E8）
  env?: string[];                // env 白名单（E3/E6）
  timeoutMs: number;             // E5
  maxOutputBytes: number;        // E4
  privileged?: boolean;          // P5 特权执行器
}
```

## 3. 双层安全模型（关键）

### 3.1 声明层（E9 路径校验）——**不是安全边界**

- 参数类型（path/pattern）是插件声明的元数据——恶意插件可声明成 string 绕过；
- 作用：**提前报错（UX）、审计可读**；
- 定位：防御纵深第一层。

### 3.2 强制层（系统级沙箱）——**真正的安全边界**

命令进程是真实 OS 进程，**可以被系统级沙箱约束**（ADR-005 分层 hook ⑤内核层在 exec 场景的落地）：

| 机制 | 平台 | 作用 |
|---|---|---|
| **Landlock**（Linux 5.13+） | Linux | **文件路径强制**：进程只能访问白名单路径（read/write/exec 分类），其他一律 EACCES——不管插件传什么 |
| **AppContainer + restricted token + Job Object** | Windows | 路径白名单 = ACL 授予（ALL_APPLICATION_PACKAGES SID），内核在对象打开时强制 |
| **seccomp** | Linux | syscall 过滤（禁 ptrace/mount 等） |
| **降权执行** | 双平台 | 命令以低权限用户运行 |
| env 白名单 / 超时 / 输出截断 | 双平台 | 已有基线 |

### 3.3 降级模式（必须）

Landlock 需内核 5.13+。2020 年前后的 LTS（Ubuntu 20.04 GA=5.4、Debian 11=5.10、RHEL 8=4.18）仍在服役且不满足。**helper 启动时检测内核能力 → 不支持则明确告警并退回"降权 + env 白名单"基线，绝不静默**。

### 3.4 通道完整性（实测教训）

本机沙箱实测（2026-08）：Landlock 只约束 Linux 进程；**bash → powershell.exe/cmd.exe（Windows 原生进程）可写 C:\、F:\，完全绕过 Landlock**（WSL interop 走 Windows 内核）。

对我们的约束：
- **exec 沙箱必须约束"进程树"，不只第一层进程**（递归约束：spawn 的进程不能再启动不受限的进程；Windows/WSL 部署禁用/限制跨系统进程启动）；
- 纯 Linux 部署无此绕过面；Windows 原生部署走 AppContainer 不经 WSL；
- 平台差异写进 ADR-002 v3（Windows/WSL 部署注意事项）。

### 3.5 运行时限额与中断（QuickJS 实测，P1.5 落地）

插件代码跑在宿主进程内，所以"不能让它拖垮核心"必须靠运行时限额。四条防线（本地源码 `quickjs` 核对过语义）：

| 层 | 手段 | 抓什么 |
|---|---|---|
| CPU | `runtime.setInterruptHandler(() => 超过 deadline)` | 死循环、无限递归、**正则灾难性回溯** |
| 内存 | `runtime.setMemoryLimit(bytes)` | 无限分配、大数组 |
| 栈 | `runtime.setMaxStackSize(bytes)` | 深递归爆 C 栈 |
| 挂起 | **宿主 API 自带超时**（接口强制） | `await` 一个永不 resolve 的宿主调用 |

源码依据：

- 轮询点：`js_poll_interrupts()` 递减计数器（初值 `JS_INTERRUPT_COUNTER_INIT = 10000`，`vendor/quickjs/quickjs.c:445`、`:7461-7468`），覆盖解释器主循环每个 opcode/跳转（`:18430-18523`）、函数调用入口（`:17393`）、`for-in` 枚举循环（`:15976`/`:16046`）；**正则引擎有独立计数器**（`vendor/quickjs/libregexp.c:63`），回溯里也轮询。
- 中断异常**不可捕获**：`JS_ThrowInterrupted()` = `InternalError("interrupted")` + `JS_SetUncatchableException(ctx, TRUE)`（`vendor/quickjs/quickjs.c:7442-7446`）→ 插件无法 `try/catch` 吞掉超时。
- 内存：`JS_SetMemoryLimit` 写 `malloc_limit`（`:2221-2224`），分配/重分配时检查（`:2160`、`:2198`），超限先 GC（`js_trigger_gc`）再抛 `out of memory`（`:7783`）。
- job 队列：promise 续体是 job，需宿主驱动（`JS_ExecutePendingJob`，`:2303`）——`executePendingJobs()` 不跑，`await` 之后的代码就不执行。

**为什么超时不能只靠中断**：VM 在等宿主 Promise 时处于 asyncify 挂起状态、不执行代码，中断轮询不会发生。因此"卡住的 await"只能由宿主侧超时兜——这也是把"每个宿主 API 必须自带超时"写进契约的原因（plugin-lifecycle-design.md §4.3）。

**实现注意**：装载器每次 `getProp`/`callFunction` 产生的 handle 必须纳入 `Scope` 统一释放，否则 dispose 会命中 `Aborted(Assertion failed: list_empty(&rt->gc_obj_list), quickjs.c:2036, JS_FreeRuntime)`（本项目已修过的 D1/D2 同类问题）。

## 4. 实现形态：Rust 单二进制 helper

```
Node 核心 ──spawn──► exec-sandbox（Rust 静态单二进制）
                       ├─ 检测平台/内核能力 → 降级模式
                       ├─ 施加：Landlock / AppContainer + seccomp + 降权
                       └─ exec 实际命令（被锁定的环境）
```

| 选型 | 理由 |
|---|---|
| **Rust（统一跨平台）** | 内存安全（安全关键路径）；单二进制（musl 全静态）；Windows 系统 API 绑定完整（windows-sys crate 的 AppContainer API） |
| landlock crate | Landlock 官方维护者提供，比 Go 绑定权威 |
| seccompiler | Firecracker 同款 |
| ~~Go~~（否决） | Windows 侧系统 API 绑定不完整（`x/sys/windows` 缺 AppContainer 等接口）——安全关键路径需要完整的平台绑定 |

**接口（平台无关）**：

```ts
interface SandboxProfile {
  readPaths: string[];   // → Linux Landlock read / Windows ACL
  writePaths: string[];
  execPaths: string[];
}
```

## 5. 模板静态校验清单（E1–E10，注册时执行）

| # | 校验项 | 防什么 |
|---|---|---|
| E1 | 参数注入（枚举/正则/白名单 + 数组传参不拼 shell） | 命令注入 |
| E2 | 路径类参数穿越（realpath + 白名单） | 越界文件访问 |
| E3 | 凭据泄露（禁明文参数密码，走 env 白名单） | 凭据窃取 |
| E4 | 输出放大（maxOutputBytes 截断） | 内存放大 |
| E5 | 失控进程（timeoutMs + 进程组 kill） | 资源耗尽 |
| E6 | 环境泄露（env 白名单） | 信息泄露 |
| E7 | 命令被改写（固定数组） | 命令劫持 |
| E8 | cwd/命令 TOCTOU（绝对路径 + cwd 固定） | 路径替换 |
| **E9** | **路径类参数 → validatePath + scope**（声明层，非边界） | 参数间接读写绕过 fs |
| **E10** | **可执行文件路径 ∈ 系统/管理员目录白名单** + 解析后仍在该白名单内 + 存在 + 可执行 | 插件"先写脚本再执行"的任意代码执行旁路 |

**E10 详解**：若允许模板可执行文件指向插件可写目录（数据目录），插件可 fs.write.data 写脚本 → 模板执行 → 任意代码执行。必须禁止。判定依据是"**插件写不到那里**"，所以白名单按平台给：

- Linux：`/bin`、`/sbin`、`/usr/bin`、`/usr/sbin`、`/usr/local/bin`；
- Windows：`%SystemRoot%\System32`、`%ProgramFiles%`、`%ProgramFiles(x86)%`、`%LOCALAPPDATA%\Programs`（Git for Windows 的用户级安装就在这里）。

可执行文件先用 `resolveExecutable`（候选目录 + PATH）解析成绝对路径（realpath 之后）再比对白名单——PATH 上任何位置都可能被插件污染，白名单是最终判据。内置模板逐个注册，**单个模板注册失败只告警、不影响核心启动**（内置能力缺失是可接受的降级）。

## 6. 命令执行能力分层（完整梯度）

```
① 内置模板（核心定义，命令固定 + 参数校验）              —— 按模板自动生成的权限点
② 插件声明模板（注册制 + 管理员批准，E1–E10 静态校验）    —— 声明插件 + 管理员逐点授予
③ 特权模板（`privileged: true`，P5 特权执行器）          —— 仅特权路径
```

**没有自由命令**（api-contract §4、interface-audit-exec-fs §1）：沙箱插件永远只能调用注册表里的模板——参数按模板定义校验、命令数组传参、禁止拼接。需要任意命令的场景（pty / 远程终端 / db / ssh）一律由**驱动插件**在核心端提供并自行鉴权，不在沙箱侧开口子。

安全边界 = **模板白名单（静态可审查）+ 注册制（E1–E10）**；系统级沙箱（Landlock / AppContainer，P2/P5）是第二层兜底。

## 7. 沙箱实现研究参考（2026-08）

deepseek-harness 的 code-runtime-worker-thread（本地后端）：

```
worker_threads（V8 isolate）+ env:{}（零环境）+ execArgv:[]（hermetic）
+ resourceLimits（内存上限）
+ bindings 注入（null-prototype 全局，防原型链攻击）
+ RPC 桥（namespace 函数调用 → postMessage → 宿主执行）
+ LogBuffer 字节预算截断 + 宿主侧 hostile traffic revalidate
多后端：本地 worker / E2B 云沙箱 / Python
```

启示：
1. **"零环境"是共同答案**（env:{} 与本项目"注入即能力"一致）；
2. bindings 校验（标识符/保留字/重复）可借鉴到 manifest 校验；
3. E2B 云沙箱 = 终极隔离档位（RuntimeBackend 预留）；
4. 本地后端以"注入面 + 宿主信任"为边界，不额外依赖 OS 级沙箱——与本项目路线一致（OS 层兜底见 ADR-004）。

## 8. 阶段划分

| 阶段 | 内容 |
|---|---|
| P1 | exec.run 阻塞 + 内置模板（nginx.test/reload、git.pull）+ 降权（spc）+ env 白名单 + 超时/输出 —— 声明层为唯一防线（过渡） |
| P2 | exec.spawn/TaskHandle（api-contract §4.1）+ 模板注册制落地（manifest execTemplates + 注册校验 E1–E10） |
| P2/P5 | exec-sandbox Rust helper：Landlock + AppContainer + seccomp + 降级模式（系统级强制落地，声明层降级为 UX） |
