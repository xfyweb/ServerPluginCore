# 插件生命周期与装载器设计


- 状态：**已落地（P1.5a，2026-09）**——交付物与**实现偏差**见 §14
- 关联：ADR-001（零环境权力）、ADR-005（沙箱与插件类型）、api-contract §4/§4.1（方法组）、exec-sandbox-design §3（运行时限额）、plugin-signature-design §9（安装记录）、ROADMAP P1.5
- 定位：**冻结"什么是插件、宿主怎么把它跑起来"这份契约**。构建层（打包/签名产物）、开发工具（`new`/`dev`）都以本文件为输入。
- 参考：AstrBot 的插件生命周期（`astrbot/core/star/{star_manager,base,star}.py`）——`initialize`/`terminate` 钩子、metadata 与代码分离、**插件配置 schema**、失败隔离与"重载失败插件"。借鉴点与取舍见 §13。

## 0. 两个 "lifecycle" 别搞混

| 名称 | 方向 | 内容 |
|---|---|---|
| 宿主 API `lifecycle.*` | **插件 → 宿主** | `lifecycle.version`（契约协商）、`lifecycle.health`（心跳）；见 api-contract §4 |
| 插件钩子 `init/start/stop` | **宿主 → 插件** | 本文件定义：装载器调用插件导出的钩子 |

## 1. 装载契约

### 1.1 产物形态

- **ESM 单文件 bundle**，QuickJS 可直接加载（模块加载器只接受源码文本，见 `core/sandbox.ts` 注释）；
- 入口由安装记录/清单指定（P1 从插件目录读 `manifest.entry`；构建层落地后读 `dist/`）；
- **前端产物**（P3，见 intent-capture.md §5）：
  - `frontend.mode = 'declarative'`：组件树由 **manifest `exports.routes` 声明**，核心渲染，**没有前端代码产物**；
  - `frontend.mode = 'iframe'`：插件自带前端 bundle（核心侧静态服务，`sandbox` 隔离 + CSP 零出网），随 `files[]` 一起被签名覆盖；
- **主题包**（`type: theme`）：产物是 `theme.json`（声明式令牌 + 资源），**没有 JS、没有 bundle**；
- **实测结论**：`evalCodeAsync(ESM 源码)` 返回**模块命名空间对象**，可以直接 `getProp(ns, 'init')` 取到导出函数——因此契约用标准 ESM 导出即可，不需要挂全局变量。

### 1.2 导出契约

```ts
export async function init(ctx: PluginContext): Promise<void>;   // 必需（type=theme 除外）
export async function start(ctx: PluginContext): Promise<void>;  // 可选
export async function stop(ctx: PluginContext): Promise<void>;   // 可选
```

- **必须导出 `init`**；缺失 → `PLUGIN_NO_ENTRY`（fail-closed）；
- **`type: theme` 豁免**：主题包无后端脚本 → 不建沙箱、不要求 `init`，装载只做"登记 CSS + 主题令牌"（见 intent-capture.md §9）；
- 三者都允许 `async`（宿主会泵 job 队列，见 §4.4）；
- `init` = 准备（读配置、建目录）；`start` = 开始工作（订阅、调度）；`stop` = 优雅收尾（必须幂等，可能被重复调用）；
- 钩子抛错即视为该插件失败，**不影响核心与其它插件**。

### 1.3 两种注入的分工

| 注入方式 | 给什么 | 例子 |
|---|---|---|
| `@host/api`（模块注入） | **能力** | `fs.write`、`exec.run` |
| `ctx`（参数注入） | **环境事实** | `pluginId`、`dataDir`、`grants` |

插件拿不到第三种东西——没有 `process`、没有 `require`、没有网络（ADR-001 零环境权力）。

### 1.4 `PluginContext`

```ts
interface PluginContext {
  pluginId: string;                     // 如 @xfy2412/hello
  version: { code: number; name: string };
  dataDir: string;                      // 宿主创建并保证存在；插件唯一可写位置
  manifest: Readonly<Manifest>;         // 只读副本（自查声明用，改不了）
  grants: readonly string[];            // 本插件已获授予的权限点（只读；判定仍由宿主侧强制）
  config: Readonly<Record<string, unknown>>;  // 插件配置（按 configSchema 校验后的只读快照，见 §1.6）
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}
```

- `dataDir` 规则：`<SPC_DATA_DIR ?? <cwd>/.spc>/data/plugins/<sanitized-id>/`，其中 `sanitized-id = pluginId.replace(/^@/, '').replace(/\//g, '__')`（`@xfy2412/hello` → `xfy2412__hello`；该映射唯一且可读）。
- `logger` P1 转发到宿主 console（带插件前缀）；P2-4 日志聚合器接管后落聚合流；**日志等级可按插件覆盖**（P2-4）。
- `config` 是**只读快照**：插件改不了自己的配置，写配置属管理员/面板动作（见 §1.6）。

### 1.5 最小插件形态

```ts
import { fs } from '@host/api';
import type { PluginContext } from '@spc/sdk';

export async function init(ctx: PluginContext) {
  ctx.logger.info('ready, dataDir=' + ctx.dataDir);
  fs.write(ctx.dataDir + '/hello.txt', 'HelloWorld');
}

export async function stop(ctx: PluginContext) {
  ctx.logger.info('bye');
}
```

### 1.6 插件配置（config schema）

插件一定需要用户可调的参数（端口、路径、开关）。契约三件套：

1. **声明**：manifest 增 `configSchema`（JSON Schema 子集：`type/object`；字段支持 `string | number | boolean | enum | array`，带 `default` 与 `description`）——加进 `sdk/schema` 与本阶段一起落地，面板渲染在 P3；
2. **取值与存储**：值存 `<SPC_STATE_DIR>/config/plugins/<sanitized-id>.json`；读取时**按 schema 校验 → 补默认值**；非法值拒绝保存（`PLUGIN_CONFIG_INVALID`）；
3. **注入**：`ctx.config` 是**只读快照**；插件只能读。配置变更后由 manager 重启该插件（P1.5 用 `reload` 生效；热更新留给 P2-4 配置中心）。

- **为什么不做 `ctx.config.set()`**：写配置 = 改持久状态，必须走管理员与审计路径；插件要存运行期数据用 `dataDir`（kv 在 P2）。
- **敏感值**：schema 字段可标 `secret: true` → 面板掩码显示，审计与日志一律摘要（不落明文）。
- 与 AstrBot 的对应：它把 `_conf_schema.json` 放在插件目录、用 `AstrBotConfig(config_path, schema)` 管值、并把配置作为构造参数注入。我们把 schema 放进 manifest（与其它的声明同一份单一事实源），注入**只读快照**而不是可变对象。

## 2. 状态机

```
                 ┌────────────────────────────────────────────┐
   installed ──load──▶ loading ──▶ loaded ──start──▶ starting ──▶ running
        ▲                  │           │                 │            │
        │                  ▼           ▼                 ▼            │
     enable             failed ◀───────┴─────────────────┘         stop
        │                  │                                        │
     disabled ◀──disable───┴──────────── stopping ◀─────────────────┘
```

| 当前 | 事件 | 下一个 | 备注 |
|---|---|---|---|
| installed / stopped | `load` + `start` | running | 启动时自动装载 `enabled` 的插件 |
| loading / starting / running | 钩子抛错、超时、限额命中 | failed | 已登记能力回滚，沙箱 dispose |
| running | `stop` | stopping → stopped | `stop` 超时 → 强制 dispose |
| stopped / installed | `enable` | loading | 管理员 CLI |
| 任意 | `disable` | disabled | 先 stop 再置 disabled；不装载 |
| failed | `reload` | loading | 管理员手动恢复；**不自动重启（默认）** |

**失败重启配置项**（用户要求做成配置）：

```jsonc
"plugin": {
  "failedRestart": "manual",      // manual（默认）| auto
  "maxRestartAttempts": 3,         // auto 时生效：连续失败到此为止
  "restartBackoffMs": 1000         // auto 时生效：每次重试前等待（线性；P2 退避策略再升级）
}
```

- `manual`：失败只落审计 + 状态置 `failed`，等管理员 `spc plugin reload`；
- `auto`：按 `restartBackoffMs` 重试，超过 `maxRestartAttempts` 后放弃并停在 `failed`（并在审计里记 `attempts`）。计数在**一次成功 `running` 后清零**。

## 3. 能力登记（loader 读 manifest，插件不参与）

| 能力 | manifest 来源 | P1.5 |
|---|---|---|
| 路由（面板页面） | `exports.routes` | ✅ 登记进宿主路由表（前端渲染 P3） |
| 端点（API） | `exports.endpoints`（原 `webApis`） | ✅ 登记 + 网关按 `permission` 字段鉴权（网关属 P3）；"谁能调"（`callable`）与 path 命名空间随插件间调用面落地 |
| 事件发布/订阅 | `exports.events` | ✅ 登记（事件面本体 P2：投递只给"声明订阅 + 声明依赖发布方 + 管理员批准"的插件，见 `docs/events-and-hooks-design.md` §1） |
| **前端页面** | `exports.routes` + `frontend.mode` | ✅ 登记路由（`declarative` 渲染组件树 / `iframe` 提供 bundle，P3，见 intent-capture.md） |
| **主题** | `type: theme` + `theme.json` | ✅ 登记主题令牌（无沙箱、无钩子，P3） |
| exec 模板 | `execTemplates` | ⏳ B 阶段：走同一套 `registerTemplate()`（自动获得形状唯一性、E1–E10、原生写法匹配） |

**为什么不由插件 `ctx.register()` 动态注册**：manifest 是审核对象与唯一事实源；loader 按 manifest 登记，卸载时可精确撤销，插件说了不算。

- 登记冲突（路由撞车、topic 撞车、权限点未知）→ `PLUGIN_EXPORT_INVALID`，并**回滚本次已登记的部分**（不留半登记状态）。
- **登记结果写进安装记录**（`capabilities: string[]`，如 `route:/docker`、`endpoint:/api/docker/*`、`event:backup.done`、`template:mc.start`）：卸载按它精确撤销、CLI/面板可展示、审计可追溯；
- **重载必须幂等**：`reload` 先撤销该插件的全部已登记能力，再重新登记（避免重复绑定/能力叠加）；
- **`disabled` 不做任何求值**：禁用的插件连 bundle 都不加载（不建沙箱、不执行任何插件代码）。

## 4. 运行时限额与超时（四层）

### 4.1 四层防线

| 层 | 手段 | 抓什么 | 默认值（可配） |
|---|---|---|---|
| **CPU** | `runtime.setInterruptHandler(() => Date.now() > deadline)` | 死循环、无限递归、正则灾难性回溯 | **load 5s** / init 5s / start 5s / stop 3s |
| **内存** | `runtime.setMemoryLimit(bytes)` | 无限分配、大数组 | 32 MiB |
| **栈** | `runtime.setMaxStackSize(bytes)` | 深递归爆 C 栈 | 512 KiB |
| **挂起** | **宿主方法自带超时 + 预算封顶**（`bridge.remainingMs()`） | `await` 一个永不 resolve 的宿主调用；**同步阻塞**的宿主调用（`spawnSync`） | 每个 API 自己定（exec 已有 `timeoutMs`），且被阶段剩余预算压低 |

> **`load` 是独立的一档，不是借 init 的**：**顶层代码同样是插件代码**——`while(true)` 可以就写在模块顶层。
> 少了这一档，`runModule` 会是唯一没有 deadline 的 VM 入口，一个死循环就能把整个核心占死
> （无超时、无审计、无恢复）。四个入口（load / init / start / stop）+ 定时器回调，各自有各自的预算。

> **CPU 中断有盲区：宿主方法里的同步阻塞。** 插件一进宿主方法，解释器就停了 ——
> `setInterruptHandler` 一次都不会被调用，中间件到点了也没人查。实测：1 秒预算的钩子里
> 一次阻塞式 exec 跑了 **40777ms**，而且当时被记成了**成功**。两道补丁（缺一不可）：
> 1. **预算穿透**：沙箱把"本阶段还剩多少预算"放到桥上（`SandboxBridge.remainingMs`），
>    宿主方法给**自己的**超时封顶 —— `exec.run` 的实际超时 = `min(模板 timeoutMs, 剩余预算)`；
> 2. **墙钟事后校验**：钩子/定时器"成功返回"时再比一次墙钟，超了按 `PLUGIN_*_TIMEOUT`
>    上报（带 `overrunMs`），**绝不记成成功**。
>
> 只做 1 挡不住别的阻塞源（磁盘、锁、其它同步 API）；只做 2 则核心仍会被阻塞满一个模板超时。
> 另外 `effectiveTimeoutMs` 把 0/负数余额夹到 1ms —— `spawnSync` 的 `timeout: 0` 是"**不超时**"，
> 顺势传下去就是 fail-open。

### 4.2 QuickJS 语义（本地源码实测，`D:\git-repo\quickjs`）

- **中断轮询**：`js_poll_interrupts()` 递减计数器，初值 `JS_INTERRUPT_COUNTER_INIT = 10000`（`vendor/quickjs/quickjs.c:445`、`:7461-7468`）；轮询点覆盖解释器主循环每个 opcode/跳转（`:18430-18523`）、函数调用入口（`:17393`）、`for-in` 枚举循环（`:15976`/`:16046`）。
- **正则回溯也会被打断**：`vendor/quickjs/libregexp.c:63` 有独立的 `INTERRUPT_COUNTER_INIT`（回溯循环里轮询）→ `(a+)+$` 这类灾难性回溯拦得住。
- **中断异常不可捕获**：`JS_ThrowInterrupted()` = `InternalError("interrupted")` + **`JS_SetUncatchableException(ctx, TRUE)`**（`vendor/quickjs/quickjs.c:7442-7446`）→ 插件**无法 `try/catch` 吞掉超时**。
- **内存**：`JS_SetMemoryLimit` 写 `malloc_limit`（`:2221-2224`），分配/重分配时检查（`:2160`、`:2198`），超限先 GC（`js_trigger_gc`）再抛 `out of memory`（`:7783`）。
- **栈**：`JS_SetMaxStackSize`（`:2850`）。

### 4.3 超时不是一层能解决的

VM 在等宿主 Promise 时处于 asyncify 挂起状态、**不执行代码**，中断轮询不会发生 → "卡住的 await"只能用宿主侧超时兜。因此：

> **契约（对宿主 API 作者）**：任何可能阻塞或依赖外部输入的宿主 API **必须自带超时**，且必须用
> `bridge.remainingMs()` 把超时压到当前阶段的剩余预算之内（`exec.run` 的 `timeoutMs` 是第一个示例）。

**兜底那道在核心侧（契约：宿主 Promise 永不落地也不能挂住核心）**：声明了 `async: true` 的宿主方法，
其 Promise 会被 `core/sandbox.ts` 的 `asyncHostCall` 与**当前阶段的剩余预算**做一次 race；预算到点就
把这次挂起**落地**成一个内部错误信封（`INTERNAL` + `reason: 'host-call-deadline'`）。这不是"新造一个超时"，
而是**让解释器有机会醒过来**：挂起落地 → 泵恢复 job → 下一条 opcode 的中断轮询看到 deadline 已过 →
`JS_ThrowInterrupted()`（不可捕获）→ 归类成既有的 `PLUGIN_<阶段>_TIMEOUT`。
少了这一步，"宿主方法返回一个永不 settle 的 Promise"就是**核心级挂死**：泵里的 `await` 永不返回，
`executePendingJobsAsync` 的循环条件根本没机会再判 deadline（实测过这条：只有把宿主调用本身封顶才收得住）。

于是四条契约（2026-09-21 定，用户拍板）：

| 契约 | 判据 |
|---|---|
| 挂起吃**墙钟不吃 CPU** | 挂起期间解释器没在跑 ⇒ 中断不触发、CPU 预算不动；时间由阶段 deadline 与事后墙钟校验收口 |
| **并发先定 1（串行）** | 同一 VM 不许并发进：`busy` 时再调钩子/装载 ⇒ `PLUGIN_BUSY`（定时器回调仍是**静默跳过一次**，见 §4.4） |
| **卸载 abort 挂起** | 挂起期间 `dispose()` ⇒ 先标记 `disposed`（后续调用一律 `PLUGIN_DISPOSED`），**真正拆 VM 延后**到在飞阶段收尾：在 WASM 栈还 unwind 着的时候拆 VM 会让收尾命中 `assert(list_empty(&rt->gc_obj_list))` |
| 审计 `suspendedMs` | `lifecycle.<hook>` / `timers.tick` 条目带"本阶段等宿主 Promise 花掉的墙钟"，与 `durationMs` 分列（否则分不清"插件自己算得慢"与"宿主 I/O 慢"） |

### 4.4 job 泵（async 钩子能跑起来的前提）

QuickJS 里 promise 的续体是 job，需要宿主驱动（`JS_ExecutePendingJob`，`vendor/quickjs/quickjs.c:1875`）：

```
调用钩子 → 等它返回 → 若返回值是 Promise，则循环：
  runtime.executePendingJobs() 直到 hasPendingJob() === false 或 deadline 到点
未泵完就超时 → PLUGIN_JOB_PENDING（说明插件留下了未回收的异步任务）
```
（实测：没有 `await` 的 async 函数不产生 job；有 `await` 且依赖宿主 Promise 时才会。）

### 4.5 实现注意：handle 生命周期（会 Aborted 的那种）

装载器每一次 `getProp` / `callFunction` / `evalCode` 都会产生新的 handle。**必须纳入现有 `Scope` 统一管理**，否则 `dispose()` 时命中 QuickJS 断言：

```
Aborted(Assertion failed: list_empty(&rt->gc_obj_list), quickjs.c:2036, JS_FreeRuntime)
```
（这条我在写本文件时用探针**复现过一次**——就是漏 dispose 了几个 handle。测试必须覆盖"钩子抛错后 dispose 不崩"。）

## 5. 加载与卸载流程

```
装载（load + start）：
1  记录存在？目录/入口存在？（P4 之后在此加：验签 + verifiedMeta 文件哈希校验）
2  依赖检查：dependencies.plugins 声明的插件**已启用且已装载**，否则
   PLUGIN_DEPENDENCY_MISSING（未安装 / 未启用）或 PLUGIN_DEPENDENCY_NOT_LOADED（已启用但没在跑）
3  createSandbox(hostApi, { pluginId, permissions, grants }) → 施加 §4 四层限额
4  runModule(bundle) → 取命名空间 → 校验导出契约（缺 init → PLUGIN_NO_ENTRY）
5  依 manifest 登记能力（§3）→ 冲突/非法 → PLUGIN_EXPORT_INVALID（回滚）
6  init(ctx) → PLUGIN_INIT_FAILED / PLUGIN_INIT_TIMEOUT
7  start(ctx) → PLUGIN_START_FAILED / PLUGIN_START_TIMEOUT（回滚能力登记）
8  state = running（审计 lifecycle.start）

卸载（stop + dispose）：
0  **反向依赖检查**：被其它已启用插件依赖 → PLUGIN_IN_USE（先处理依赖方；disable 同样设防，
   因为 disable 会让依赖方失去依赖）
1  state = stopping
2  stop(ctx)（幂等；超时 → PLUGIN_STOP_TIMEOUT，**强制继续**，绝不为一个插件卡住核心）
3  撤销能力登记 → dispose 沙箱（Scope 顺序释放）
4  state = stopped（审计 lifecycle.unload）
```

**装载顺序 = 依赖优先（拓扑排序）**：

- `startAll` 先对"已启用且未装载"的插件做拓扑排序，**依赖方排在依赖之后**；单插件路径（install / enable / reload）同样受"依赖必须已在跑"约束；
- **环上的插件直接判 `failed`（`PLUGIN_DEPENDENCY_CYCLE`）**，而不是让它们各自报一个看不出所以然的"依赖缺失"——依赖死锁是配置错误，必须一眼能认出来；
- 反向依赖保护与拓扑排序是一对：前者保证"依赖不会在依赖方运行期间消失"，后者保证"依赖方不会先于依赖起来"。

**依赖管理的三条约定**（按落地时间排序）：

1. **运行时（现状）**：被**正在运行**的插件依赖时，`uninstall` / `disable` 一律拒绝（`PLUGIN_IN_USE`，参数里带上依赖方清单）。
   判据是**运行态**而不是记录里的 `enabled`——保护要防的是"依赖方正在跑、依赖却被抽走"，谁没在跑，就没有谁的运行会被悄悄打断。
2. **维护模式守护进程（CLI 完善后）**：主守护进程停止时，CLI 临时拉起一个**维护模式**守护进程——**不触发装载流程**、只处理 CLI 事件、**30 秒无交互自动退出**。
   因为没有任何插件被装载，反向保护**自然**不生效——不需要"跳过检查"的开关。
   分工要写清：**维护模式是"启动形态"（启不启动插件），不是"校验开关"（检查要不要执行）**；检查在任何形态下都照常执行，只是在不装载的形态下它没有对象可拦。
   于是"要拆依赖"的正路是**根本不进入运行态**，而不是"带着 flag 起来"。
3. **级联确认（CLI / 前端完善后）**：把硬拒绝换成一次确认，并绘制依赖树（**最多向下追溯 3 层**）：

   > 当前插件被以下插件依赖，您确定要禁用以下插件以卸载/禁用吗？

   确认后**连带禁用**（不是卸载）依赖方，再执行原操作——卸载是不可逆的，级联到不可逆操作上是危险设计。
   3 层之外的显示方式（折叠 / 只给数量）待定。

**并发与失败隔离**：

- manager 的每个状态变更（load / start / stop / reload / enable / disable）都走**同一把锁**串行执行——插件管理操作不并发；
- **单插件失败不影响其它插件**：逐个 `try/catch`，失败进 `failed` + `lastError`，继续装载下一个；
- **`stop` 抛错或超时都继续卸载**（只告警 + 审计）：绝不因一个插件卡住核心停机；
- 卸载顺序固定：`stop` → 撤销能力登记 → `dispose`（Scope 顺序释放 handle）。

**错误码**（只增不改）：`PLUGIN_NOT_FOUND`、`PLUGIN_DIR_MISSING`、`PLUGIN_MANIFEST_INVALID`、`PLUGIN_NO_ENTRY`、`PLUGIN_EXPORT_INVALID`、`PLUGIN_DEPENDENCY_MISSING`、`PLUGIN_DEPENDENCY_NOT_LOADED`、`PLUGIN_DEPENDENCY_CYCLE`、`PLUGIN_IN_USE`、`PLUGIN_LOAD_FAILED`、`PLUGIN_LOAD_TIMEOUT`、`PLUGIN_INIT_FAILED`、`PLUGIN_INIT_TIMEOUT`、`PLUGIN_START_FAILED`、`PLUGIN_START_TIMEOUT`、`PLUGIN_STOP_TIMEOUT`、`PLUGIN_MEMORY_LIMIT`、`PLUGIN_STACK_LIMIT`、`PLUGIN_JOB_PENDING`、`PLUGIN_BUSY`（同一 VM 已有阶段在跑，`params.busyWith` 说明是谁）、`PLUGIN_CONFIG_INVALID`、`PLUGIN_DISABLED`、`PLUGIN_ALREADY_RUNNING`、`PLUGIN_FILE_MISMATCH`（P4 预留）。~~`PLUGIN_RESERVED`~~ 随 `reserved` 特性一并**退役**（v2，未发布过，不占契约位）。

> **装载失败也分"限额"与"缺陷"**：`runModule` 与钩子共用同一套归类（`classifyVmFailure` + `hookError`），
> 于是装载期命中限额会得到 `PLUGIN_LOAD_TIMEOUT` / `PLUGIN_MEMORY_LIMIT` / `PLUGIN_STACK_LIMIT`，
> 插件自身的错误才是 `PLUGIN_LOAD_FAILED`（带 `cause`）。混成一个码的话，靠 `code` 分支的调用方分不清
> "该调预算"还是"该修代码"。

## 6. 安装记录（P1 最小版）

```jsonc
// <SPC_STATE_DIR ?? <cwd>/.spc>/plugins.json
{
  "pluginsSchema": 1,
  "plugins": [{
    "id": "@xfy2412/hello",
    "dir": "plugin/hello",
    "version": { "code": 1, "name": "0.0.1" },
    "enabled": true,
    "grants": ["fs.write.home", "exec.template.git.version"],
    "capabilities": ["route:/hello", "endpoint:/api/hello/*"],
    "configPath": "config/plugins/xfy2412__hello.json",
    "state": "stopped",
    "installedAt": "2026-09-15T00:00:00Z",
    "lastError": null,
    "restartAttempts": 0,

    // ↓ 字段与 plugin-signature-design.md §9 对齐
    //   v4 起：本地安装的来源是**具名的本地源**（`local:<名字>`），`unanchored` 指"没有市场签名 / 更新渠道"；
    //   身份是 `(origin, id)`，另记 `authorFingerprint`（作者公钥指纹，依赖身份判据）
    "origin": "local:default",
    "signedBy": null,
    "verifiedMeta": null,
    "authorFingerprint": "sha256:<作者公钥指纹>"
  }]
}
```

- **记录由 daemon 拥有**（写操作必须经过 daemon），CLI 只读时可离线读取；
- 同一 `id` 只有一条记录；`dir` 为绝对路径或相对核心工作目录的相对路径（写入时归一化为绝对路径）；
- ~~`reserved: true` = 内置/保留插件（**可禁用、不可卸载**）~~ —— **v2 取消**：**内置只表示"随核心分发、默认安装"**，它仍是普通插件——可禁用、可卸载、**可独立于核心更新**。原 `reserved` 借自 AstrBot 的 `builtin_stars`，那里的前提是"内置插件几乎不更新"，对本项目不成立（我们的内置插件就是普通插件，跟着生态一起更新）。因此 `uninstall` 不再有 `PLUGIN_RESERVED` 这条拒绝路径；
- `capabilities` 是"该插件登记了哪些能力"的清单（撤销依据 + 展示 + 审计）；
- 插件配置值不在本文件，单独存 `config/plugins/<sanitized-id>.json`（见 §1.6）。

## 7. 审计

| method | 何时 | 备注 |
|---|---|---|
| `lifecycle.load` | 求值 bundle 失败 | 已实现（沿用现有条目） |
| `lifecycle.init` / `lifecycle.start` / `lifecycle.stop` / `lifecycle.unload` | 每个钩子 | `result: ok/error`，失败带 `error.code` |
| `lifecycle.restart` | `failedRestart=auto` 触发 | 带 `attempts` |

`target` = 插件 ID（非敏感）；所有条目沿用"只记码与参数摘要"的规矩（api-contract §8）。

## 8. CLI 与 HTTP 面

**CLI**

```
spc plugin list                       # 状态列：state / enabled / version
spc plugin install <dir>              # 写记录（本地安装 ⇒ unanchored，提示"无更新渠道"）；auto/install 档权限随安装清单生效
spc plugin enable|disable <id>        # 写操作经 daemon
spc plugin reload <id>                # failed 恢复 / 配置变更后重启
spc plugin status <id>                # 详情：state / grants / lastError / dataDir
spc plugin grant <id> <point>...      # 逐点授予（isValidGrantPoint 校验，拒绝通配；只对 explicit 档）
spc plugin revoke <id> <point>...
```

> 授权面（intent-capture §8）：**安装即一次授权**——`auto` / `install` 档权限点在安装清单里一次看全即生效，`grant` 只用于 `explicit` 档（写宿主资源 / 执行模板 / 提权 / 出网）；升级新增的 `install`/`explicit` 点走**增量同意**。CLI 的 `grant` 与核心前端的逐点授予写的是同一份记录。

**HTTP**（daemon）

```
GET  /api/plugins                     # 列表 + 状态（已有雏形，补 state/grants/lastError）
POST /api/plugins/<id>/enable|disable|reload
POST /api/plugins/<id>/grants         # { add: [...], remove: [...] }
```

## 9. 明确不做（P1.5）

- **依赖的版本区间解析**：`dependencies.plugins[].version` 字段已在 schema 里，但装载期**不读**它——只检查依赖是否存在、启用、已装载（P2 补）；
- **依赖的传递检查**：只查直接依赖。B→A→C 时，C 的问题会先让 A 装载失败，B 随即以 `PLUGIN_DEPENDENCY_NOT_LOADED` 被拒——报错准确，但不是一次性给出完整依赖链；
- **热重载注入**：`reload` = 整插件 stop → 重新 load（不做模块热替换）；
- **插件间调用**：`dependencies.plugins` 目前只是可见性声明 + 依赖检查，调用通道属 P2（注册点；**事件面只做通知与意见征询，不做调用**，见 `docs/events-and-hooks-design.md` §1）；
- **依赖失效的运行时通知**：A 在 B 运行期间被 `reload`（先 stop 后 load）时，B 不会收到任何通知——依赖图的一致性只在管理操作的那一刻检查。**已定做法**：核心发**定向通知**（只发给声明依赖 A 的插件；单向、不可裁决），见 `docs/events-and-hooks-design.md` §2.5。当前没有插件间调用通道，所以在窗口期"失去依赖"不会立刻出错，但这是 P2 必须补的；
- **driver / theme / hook 的加载档**：P1.5 只做 `ability`（沙箱 / QuickJS）与 `theme`（无沙箱、只登记令牌）；driver 是核心侧进程（P2+），hook 待 ADR；
- **自动重启的退避策略**：只做线性 `restartBackoffMs`；
- **进程外隔离**：单进程内沙箱；子进程档与系统级沙箱见 ADR-005 §8 / exec-sandbox-design §3。

## 10. 配置项（P1.5 最小面）

```jsonc
// <SPC_STATE_DIR ?? <cwd>/.spc>/config.json
{
  "configSchema": 1,
  "plugin": {
    "limits": {
      "memoryBytes": 33554432,
      "maxStackBytes": 524288,
      "loadTimeoutMs": 5000,
      "initTimeoutMs": 5000,
      "startTimeoutMs": 5000,
      "stopTimeoutMs": 3000,
      "timerTimeoutMs": 5000
    },
    "failedRestart": "manual",
    "maxRestartAttempts": 3,
    "restartBackoffMs": 1000
  }
}
```

环境变量覆盖（测试/CI 用，沿用 `SPC_*` 惯例）：`SPC_STATE_DIR`、`SPC_PLUGIN_FAILED_RESTART`、`SPC_PLUGIN_MEMORY_LIMIT`、`SPC_PLUGIN_INIT_TIMEOUT_MS`、`SPC_PLUGIN_START_TIMEOUT_MS`、`SPC_PLUGIN_STOP_TIMEOUT_MS`。
（P2-4 配置中心接管后，本文件的键原样收编。）

## 11. 落地清单与验收

**代码**

| 文件 | 职责 |
|---|---|
| `core/plugin/limits.ts` | 四层限额装配 + 中断 deadline + job 泵（纯函数，可单测） |
| `core/plugin/records.ts` | 记录读写（`plugins.json`），字段校验，与 P4 字段对齐 |
| `core/plugin/loader.ts` | 单插件装载：沙箱创建 → 导出校验 → 能力登记 → init/start；以及卸载 |
| `core/plugin/manager.ts` | **唯一状态机**：多插件、enable/disable/reload、失败重启策略、审计 |
| `core/plugin/capabilities.ts` | manifest 能力登记与回滚（routes / endpoints / events / frontend；`execTemplates` 留槽） |
| `core/plugin/config.ts` | 插件配置：`configSchema` 校验、默认值填充、只读快照与落盘 |
| `core/plugin/theme.ts`（P3） | 主题包装载分支：登记 `theme.json` 令牌与资源；**不建沙箱、豁免 `init`** |
| `core/config.ts` | 最小配置面（文件 + `SPC_*` 覆盖） |
| `core/sandbox.ts`（改） | 暴露"带限额的运行时"与"取模块导出"的能力（handle 全部纳入 Scope） |
| `core/cli.ts` / `core/server.ts`（改） | §8 的命令与端点；`plugin list` 加状态列 |
| `core/main.ts`（改） | `pnpm spike` 走真链路：记录 → 装载 → init/start → stop → 卸载 |

**测试**（新增 `core/__tests__/lifecycle.test.ts`）

1. 状态机：每个迁移 + 非法迁移被拒；
2. 导出契约：缺 `init` → `PLUGIN_NO_ENTRY`；非函数导出 → `PLUGIN_EXPORT_INVALID`；**`type: theme` 豁免**（无 `init` 也应装载成功，且不创建沙箱）；
3. 失败语义：`init` 抛错 → `PLUGIN_INIT_FAILED` 且核心不挂；`start` 抛错 → 能力回滚；
4. **死循环**：`export function init(){ while(true){} }` → 300ms 内 `PLUGIN_INIT_TIMEOUT`，且进程存活；
5. **灾难性正则**：`/(a+)+$/.test('a'.repeat(40))` → 同样被中断；
6. **内存超限**：大数组分配 → `PLUGIN_MEMORY_LIMIT`（OOM 映射）；
7. **挂起 await**：宿主 API 永不 resolve → 宿主侧超时生效（这条等第一个带超时的宿主 API 落地后补）；
8. job 泵：`async init` 里 `await` 宿主 Promise → 续体确实执行；留下未回收任务 → `PLUGIN_JOB_PENDING`；
9. `stop` 超时 → 强制卸载，状态仍到 `stopped`；
10. **dispose 不崩**：钩子抛错 / 超时 / 提前 return 三种情况下 `dispose()` 都不命中 GC 断言（D1/D2 回归）；
11. 记录：`install` 写记录、`enable/disable` 生效、启动时自动装载 `enabled` 插件；
12. `failedRestart=auto`：连续失败 `maxRestartAttempts` 次后停在 `failed`，审计有 `attempts`；
13. 依赖检查：声明未安装的插件 → `PLUGIN_DEPENDENCY_MISSING`；依赖已启用但没在跑 → `PLUGIN_DEPENDENCY_NOT_LOADED`；被依赖时卸载/禁用 → `PLUGIN_IN_USE`；依赖成环 → `PLUGIN_DEPENDENCY_CYCLE`；装载顺序按依赖拓扑序（依赖先 init）；
14. 插件配置：缺省值填充、非法值被拒（`PLUGIN_CONFIG_INVALID`）、`ctx.config` 只读（插件写入无效、不污染宿主）；
15. 能力登记幂等：连续两次 `reload` 后登记表与 `capabilities` 完全一致（撤销后重建，不叠加）；
16. 并发：同时发起同一插件的两个 `load`/`reload` → 锁串行，终态一致且无重复登记；
17. ~~`reserved` 插件：可 `disable`，`uninstall` 被拒~~ → **v2 取消 `reserved`**（内置 = 随核心分发、可卸载、可独立更新），改为验证：内置插件同样能 `uninstall` 且记录被移除。

**验收**：以上全绿 + `pnpm spike` 走"记录 → 装载 → init/start → stop"真实链路且输出与现在等价；`spc plugin list` 显示状态。

## 12. 待定

1. 钩子命名是否就用 `init/start/stop`（备选：`activate/deactivate`）——**已按 init/start/stop 落地**，改名窗口关闭；
2. `stop` 是否需要接收"关闭原因"（`stop(ctx, {reason})`：`reload` / `disable` / `shutdown`）——**倾向要**，便于插件区分优雅停机与重启。**现状**：原因只进审计（`lifecycle.unload` 的 `paramsDigest`），还没进钩子签名；
3. `dataDir` 清理策略（`disable` 是否保留数据；卸载是否删数据）——**倾向：都保留，卸载提供 `--purge`**。**现状**：都保留，`--purge` 未做；
4. hook 插件的钩子形态与 `init/start/stop` 的关系——**已定**：hook = **核心在决策点上回调插件、答复进核心决策**（中间件，跑沙箱即可；**P2 不做**），设计见 `docs/events-and-hooks-design.md` §2；
5. **状态目录统一**：建议 `SPC_STATE_DIR`（默认 `<cwd>/.spc`）作为基目录，其下是 `config.json` / `plugins.json` / `keyring.json` / `audit/` / `data/plugins/`；现有的 `SPC_AUDIT_DIR`、`SPC_KEYRING_DIR` 降级为**覆盖项**（实现时一并收编，避免三套状态目录变量共存）。**已按此落地**（`core/config.ts`，另加 `SPC_DATA_DIR` 覆盖数据根）。


## 13. 参考：AstrBot 的可借鉴做法与我们的取舍

参考实现：`astrbot/core/star/star_manager.py`（`load` / `reload` / `reload_failed_plugin` / `_terminate_plugin`）、`base.py`（`Star` 基类）、`star.py`（`StarMetadata`）。

| AstrBot 的做法 | 我们的对应 |
|---|---|
| `initialize()` / `terminate()` 作为基类空实现钩子；`__del__` 已标 Deprecated | 模块级导出 `init` / `start` / `stop`（ESM，无类继承；沙箱里没有装饰器与动态导入） |
| metadata 与代码分离（`metadata.yaml` 优先于装饰器推断），校验失败即拒载 | `manifest.json` + JSON Schema 校验（构建期与装载期各一次） |
| `_conf_schema.json` + `AstrBotConfig(config_path, schema)`，配置作为构造参数注入，面板据此渲染 | manifest `configSchema` + 记录旁的值文件 + `ctx.config` **只读快照**（§1.6） |
| `StarMetadata.star_handler_full_names` 记录该插件注册了哪些 handler | 记录里的 `capabilities: string[]`（§3、§6） |
| 重载前把 handler 还原成 raw、再重新绑定，防重复叠加 | `reload` 先撤销全部能力登记再重建（幂等，§3） |
| `inactivated_plugins` ⇒ 不实例化插件类（`star_cls = None`） | `disabled` ⇒ 连 bundle 都不加载（零求值，§3） |
| `reserved` 插件在 `builtin_stars`，不可卸载 | **不采纳**（v2）：内置只表示"随核心分发、默认安装"，仍可禁用/卸载/独立更新（§6） |
| 单插件 `try/except` 包住整段装载，失败进 `failed_plugin_dict` 并清理状态后**继续下一个** | 逐个 try/catch，失败进 `failed` + `lastError`，继续装载其它插件（§5） |
| `reload_failed_plugin(dir_name)` 专治失败插件 | `failed` + `spc plugin reload <id>`（默认不自动重启；`failedRestart=auto` 可选） |
| `_terminate_plugin`：不在跑就跳过；`__del__` 丢 executor 并捕获异常；terminate 抛错只告警、继续卸载 | `stop` 抛错/超时都继续卸载，随后强制 `dispose`（§5） |
| 所有管理操作走 `_pm_lock` | manager 的每次状态变更串行化（一把锁，§5） |
| `plugin_id = author/name`（对类属性注入 `name/author/plugin_id`） | `id = @publisher/name`（多一个 `@`；身份与来源解耦见 ADR-001 v3） |
| 插件专用 logger，且支持按插件覆盖日志等级 | `ctx.logger`；日志等级覆盖记在 P2-4 日志聚合器 |
| `astrbot_version`（PEP 440 区间）不满足即拒载 | `compat.minCore/targetCore`：不满足即拒载，不静默降级 |
| `OnPluginLoadedEvent` 钩子（插件间可监听"某插件已加载"） | **改成"依赖变更定向通知"**（只发给**声明依赖它的插件**；单向、不可裁决），设计见 `docs/events-and-hooks-design.md` §2.5。**不做广播**："所有插件都能监听别人加载"与"插件默认看不见其他插件"（manifest-design §6）冲突 |
| 旧版插件类兼容加载（`Plugin`/`Main` 命名回退） | **不做兼容回退**：导出契约唯一（缺 `init` 即 `PLUGIN_NO_ENTRY`），fail-closed |

## 14. 实现记录与偏差（P1.5a）

**交付物**（`core/`，共 8 个新文件 + 8 个改动）：

| 文件 | 内容 |
|---|---|
| `core/config.ts`（新） | 状态目录统一（`SPC_STATE_DIR` 基座 + `SPC_AUDIT_DIR`/`SPC_DATA_DIR`/`SPC_KEYRING_DIR` 覆盖）、配置面（限额 / `failedRestart` / 退避）、`SPC_*` 环境变量覆盖、`sanitizePluginId` |
| `core/plugin/limits.ts`（新） | 四层限额装配、deadline 中断、`classifyVmFailure`（InternalError 三态归类）、job 泵 |
| `core/plugin/records.ts`（新） | `plugins.json` 读写（原子写）、记录字段校验、状态枚举 |
| `core/plugin/capabilities.ts`（新） | 能力登记/回滚/快照（routes / endpoints / events / 订阅 / theme），**全有或全无** |
| `core/plugin/config.ts`（新） | 插件配置：`configSchema` 校验 + 默认值填充 + 值文件读写 |
| `core/plugin/loader.ts`（新） | 单插件装载（目录→依赖→沙箱→bundle→能力→init→start）与卸载（stop→撤销→dispose） |
| `core/plugin/manager.ts`（新） | **唯一状态机** + 唯一锁、install/enable/disable/reload/uninstall/grant/revoke、失败重启策略 |
| `core/sandbox.ts`（改） | 限额接线、导出钩子调用（`callHook`）、ctx 注入（沙箱侧 deepFreeze）、`hasFunctionExport`、定时器宿主回填 |
| `core/hostApi.ts`（改） | 由单例改为**工厂**（`buildHostApi(ctx)`）；新增 fs.read/list/stat、kv.*、timers.*、events.publish、lifecycle.* |
| `core/permissions/registry.ts`（改） | 权限点扩到 8 个静态点（fs.read.data / fs.write.data / kv.read / kv.write / timers.schedule / events.publish / lifecycle.version / lifecycle.health），删 `fs.write.home` |
| `core/cli.ts` / `core/server.ts`（改） | §8 的全命令面 + 端点；daemon 启动 `initAudit()` + `manager.startAll()` |
| `core/main.ts`（改） | `pnpm spike` 走真实链路（记录 → 装载 → init/start → stop → 卸载） |
| `core/__tests__/lifecycle.test.ts`（新，28 例）、`core/__tests__/hostapi.test.ts`（新，11 例） | 见 §11 的 17 条 + 宿主 API 行为 |

**实现偏差（与本文档正文不一致的地方，以本节为准）**

1. **`fs.write.home` 已删除**：它是 spike 遗留（写用户主目录）。P1.5 起 fs 的作用域**统一为插件数据目录**，`fs.read.data` / `fs.write.data` 两个点覆盖读写。
2. **`fs.write` 会补建缺失的父目录**——但**仅当最近的已存在祖先的 realpath 落在数据目录内**，建完再走一遍完整校验。没有这一步插件写不了 `backups/2026-09-18/x.tar`（F6 会报 `PARENT_MISSING`），而按日期分目录是最基本的用法。这不是放松 F6：它防的是逃逸，不是禁止插件建自己的目录树。
3. **求值必须显式按模块**：`evalCodeAsync(src, 'plugin.js', { type: 'module' })`。不传 options 时 quickjs-emscripten 会打开模块自动探测，而 `JS_DetectModule` **只看第一个 token**（`vendor/quickjs/quickjs.c:23205`）；esbuild 会把导出提升到文件末尾（`function init(){}` + `export { init };`），首 token 变成 `function` → 判成脚本模式 → `unsupported keyword: export`。**没有 `import` 的插件会全部加载失败**——这是实测抓到的真 bug，不是理论风险。
4. **WASM 模块实例不可复用**：`setMaxStackSize` 在 asyncify 变体上是**整个模块的全局副作用**（上游 d.ts 明确写了会一并调整 `ASYNCIFY_STACK_SIZE`）。复用模块换速度 = 让栈限额退化成进程级且互相污染。实测复用只省 12ms/沙箱，不值得，因此**每个沙箱各起一份模块实例**。
5. **新增错误码**（§5 的清单未列，但实现需要）：`PLUGIN_STACK_LIMIT`（栈超限，与内存分开）、`PLUGIN_STOP_FAILED`、`PLUGIN_TIMER_FAILED`、`PLUGIN_TIMER_TIMEOUT`、`PLUGIN_DISPOSED`、`GRANT_WILDCARD`（管理员写 `kv.*` 时给专门的提示，比"权限被拒绝"准确）、`CONFIG_INVALID`、`RECORDS_INVALID`、`KV_INVALID`/`KV_KEY_INVALID`/`KV_VALUE_INVALID`/`KV_VALUE_TOO_LARGE`/`KV_LIMIT_EXCEEDED`/`KV_TOTAL_LIMIT_EXCEEDED`、`NOT_A_FILE`、`NOT_A_DIRECTORY`、`EVENT_TOPIC_NOT_DECLARED`、`TIMER_INTERVAL_INVALID`/`TIMER_HANDLER_INVALID`/`TIMER_UNAVAILABLE`/`TIMER_LIMIT_EXCEEDED`。全部只增不改，中英文都补了词条。
6. **新增配置项 `timerTimeoutMs`**（默认 5000）：定时器回调与钩子享受同样的限额，需要一个 deadline 来源；§10 的键表没列它。
7. **`kv` 的权限点命名**：定为 `kv.read` / `kv.write`，**不采用** api-contract §4 写的 `kv.<namespace>`——namespace 就是插件自己，为它生成权限点等于"每个插件都有专属权限点"，只会让注册表膨胀。
8. **`events.publish` 定为 `scope: self`**：边界由"topic 必须在 manifest 声明 + 同一 topic 只有一个发布者"提供。按 intent-capture §8.1 的 `grant` 三档，它应当是 `install` 档（安装清单里可见即可，不必逐点授予）——**该档位属 P2，尚未实现**，当前 self 档等价于"声明即可用"。
9. **`capabilities` 在卸载/失败后清空**：记录里的 `capabilities` 表示"**当前**登记了哪些能力"，不是历史。历史在审计里（`lifecycle.*` 条目）。
10. **`install` 装载失败会抛出，但记录已写入**（state=`failed` + `lastError`）。这是有意的：管理面必须能看到坏插件，而不是"装失败了却什么都没留下"。
11. **定时器回调的实现方式**：回调注册表（`__spcTimerCallbacks`）与派发函数（`__spcTimerInvoke`）都放在**沙箱引导层**，`@host/api` 只往表里登记。原因是宿主在 `createSandbox` 时就要抓住 `__spcTimerInvoke` 的句柄，而 `@host/api` 是 `runModule` 才求值的——放在模块里会让宿主抓到 `undefined`（实测踩到）。
12. **daemon 启动即 `initAudit()`**：之前只有 `pnpm spike` 会探测审计目录，daemon 不会。审计目录不可写时 `audit()` 会静默退化成内存缓冲——运维会以为审计正常、实际读不到。现在两条入口都是 fail-closed。
13. **fs 读取上限 1MB**（写入仍是 64MB）：读到的内容会变成沙箱内的 JS 字符串，而沙箱堆只有 32 MiB——给插件读一个 64MB 文件只会把 VM 撑爆并报成 `PLUGIN_MEMORY_LIMIT`（误导）。所以在宿主侧就按"能安全进 VM"的尺寸拒绝。

### 14.1 依赖机制补强（P1.5a 后补）

首版依赖检查只有一行：`Boolean(findRecord(id)?.enabled)`。补成一张真正的依赖图：

| 补的东西 | 语义 | 错误码 |
|---|---|---|
| **依赖必须已装载**（不只是"已启用"） | 依赖没跑起来，依赖方不许起——否则它会进入一个本不该能进入的状态 | `PLUGIN_DEPENDENCY_NOT_LOADED`（含 `state` 参数，便于直接看出"是它自己 failed"） |
| **反向依赖保护** | 被**运行中**的插件依赖时，不许 `uninstall`／`disable`（disable 同样让依赖方失去依赖）。判据是运行态 → 维护模式（不装载）天然无阻拦，不需要旁路开关 | `PLUGIN_IN_USE`（含 `dependents` 参数，直接告诉管理员该先处理谁） |
| **拓扑排序装载** | `startAll` 对"已启用且未装载"的集合做拓扑排序，**依赖先 init** | — |
| **依赖环检测** | 环上插件直接判 `failed`，而不是互相报"依赖缺失"（死锁是配置错误，要一眼认出来） | `PLUGIN_DEPENDENCY_CYCLE` |

**仍不做**（见 §9）：版本区间解析、传递依赖的完整链式报告、依赖失效的运行时通知。

**测试**：`pnpm test` **190 例全绿**（lifecycle 32 + hostapi 11 + manifest 24 + exec/sandbox/signature/cli-e2e 等），`tsc --noEmit` 干净，`pnpm spike` 走通真实链路。
