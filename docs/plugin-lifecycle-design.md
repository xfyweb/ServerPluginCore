# 插件生命周期与装载器设计

- 状态：**设计基线（P1.5a，待实现）**
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
- **实测结论**：`evalCodeAsync(ESM 源码)` 返回**模块命名空间对象**，可以直接 `getProp(ns, 'init')` 取到导出函数——因此契约用标准 ESM 导出即可，不需要挂全局变量。

### 1.2 导出契约

```ts
export async function init(ctx: PluginContext): Promise<void>;   // 必需
export async function start(ctx: PluginContext): Promise<void>;  // 可选
export async function stop(ctx: PluginContext): Promise<void>;   // 可选
```

- **必须导出 `init`**；缺失 → `PLUGIN_NO_ENTRY`（fail-closed）；
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
  pluginId: string;                     // 如 @xfy2412/sample
  version: { code: number; name: string };
  dataDir: string;                      // 宿主创建并保证存在；插件唯一可写位置
  manifest: Readonly<Manifest>;         // 只读副本（自查声明用，改不了）
  grants: readonly string[];            // 本插件已获授予的权限点（只读；判定仍由宿主侧强制）
  config: Readonly<Record<string, unknown>>;  // 插件配置（按 configSchema 校验后的只读快照，见 §1.6）
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}
```

- `dataDir` 规则：`<SPC_DATA_DIR ?? <cwd>/.spc>/data/plugins/<sanitized-id>/`，其中 `sanitized-id = pluginId.replace(/^@/, '').replace(/\//g, '__')`（`@xfy2412/sample` → `xfy2412__sample`；该映射唯一且可读）。
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
| Web API | `exports.webApis` | ✅ 登记 + 网关按 `permission` 字段鉴权 |
| 事件发布/订阅 | `exports.events` | ✅ 登记进事件总线（总线本体 P2） |
| exec 模板 | `execTemplates` | ⏳ B 阶段：走同一套 `registerTemplate()`（自动获得形状唯一性、E1–E10、原生写法匹配） |

**为什么不由插件 `ctx.register()` 动态注册**：manifest 是审核对象与唯一事实源；loader 按 manifest 登记，卸载时可精确撤销，插件说了不算。

- 登记冲突（路由撞车、topic 撞车、权限点未知）→ `PLUGIN_EXPORT_INVALID`，并**回滚本次已登记的部分**（不留半登记状态）。
- **登记结果写进安装记录**（`capabilities: string[]`，如 `route:/docker`、`api:/api/docker/*`、`event:backup.done`、`template:mc.start`）：卸载按它精确撤销、CLI/面板可展示、审计可追溯；
- **重载必须幂等**：`reload` 先撤销该插件的全部已登记能力，再重新登记（避免重复绑定/能力叠加）；
- **`disabled` 不做任何求值**：禁用的插件连 bundle 都不加载（不建沙箱、不执行任何插件代码）。

## 4. 运行时限额与超时（四层）

### 4.1 四层防线

| 层 | 手段 | 抓什么 | 默认值（可配） |
|---|---|---|---|
| **CPU** | `runtime.setInterruptHandler(() => Date.now() > deadline)` | 死循环、无限递归、正则灾难性回溯 | init 5s / start 5s / stop 3s |
| **内存** | `runtime.setMemoryLimit(bytes)` | 无限分配、大数组 | 32 MiB |
| **栈** | `runtime.setMaxStackSize(bytes)` | 深递归爆 C 栈 | 512 KiB |
| **挂起** | **宿主 API 自带超时**（接口强制） | `await` 一个永不 resolve 的宿主调用 | 每个 API 自己定（exec 已有 `timeoutMs`） |

### 4.2 QuickJS 语义（本地源码实测，`D:\git-repo\quickjs`）

- **中断轮询**：`js_poll_interrupts()` 递减计数器，初值 `JS_INTERRUPT_COUNTER_INIT = 10000`（`quickjs.c:512`、`:7877-7884`）；轮询点覆盖解释器主循环每个 opcode/跳转（`:18824-18917`）、函数调用入口（`:17787`）、字符串/大对象操作（`:16373`/`:16443`）。
- **正则回溯也会被打断**：`libregexp.c:63` 有独立的 `INTERRUPT_COUNTER_INIT`（回溯循环里轮询）→ `(a+)+$` 这类灾难性回溯拦得住。
- **中断异常不可捕获**：`JS_ThrowInterrupted()` = `InternalError("interrupted")` + **`JS_SetUncatchableException(ctx, TRUE)`**（`quickjs.c:7858-7862`）→ 插件**无法 `try/catch` 吞掉超时**。
- **内存**：`JS_SetMemoryLimit` 写 `malloc_limit`（`:2221-2224`），分配/重分配时检查（`:2160`、`:2198`），超限先 GC（`js_trigger_gc`）再抛 `out of memory`（`:7783`）。
- **栈**：`JS_SetMaxStackSize`（`:2850`）。

### 4.3 超时不是一层能解决的

VM 在等宿主 Promise 时处于 asyncify 挂起状态、**不执行代码**，中断轮询不会发生 → "卡住的 await"只能用宿主侧超时兜。因此：

> **契约（对宿主 API 作者）**：任何可能阻塞或依赖外部输入的宿主 API **必须自带超时**（`exec.run` 的 `timeoutMs` 是第一个样板）。

### 4.4 job 泵（async 钩子能跑起来的前提）

QuickJS 里 promise 的续体是 job，需要宿主驱动（`JS_ExecutePendingJob`，`quickjs.c:2303`）：

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
2  依赖检查：dependencies.plugins 声明的插件已安装且 enabled，否则 PLUGIN_DEPENDENCY_MISSING
3  createSandbox(hostApi, { pluginId, permissions, grants }) → 施加 §4 四层限额
4  runModule(bundle) → 取命名空间 → 校验导出契约（缺 init → PLUGIN_NO_ENTRY）
5  依 manifest 登记能力（§3）→ 冲突/非法 → PLUGIN_EXPORT_INVALID（回滚）
6  init(ctx) → PLUGIN_INIT_FAILED / PLUGIN_INIT_TIMEOUT
7  start(ctx) → PLUGIN_START_FAILED / PLUGIN_START_TIMEOUT（回滚能力登记）
8  state = running（审计 lifecycle.start）

卸载（stop + dispose）：
1  state = stopping
2  stop(ctx)（幂等；超时 → PLUGIN_STOP_TIMEOUT，**强制继续**，绝不为一个插件卡住核心）
3  撤销能力登记 → dispose 沙箱（Scope 顺序释放）
4  state = stopped（审计 lifecycle.unload）
```

**并发与失败隔离**：

- manager 的每个状态变更（load / start / stop / reload / enable / disable）都走**同一把锁**串行执行——插件管理操作不并发；
- **单插件失败不影响其它插件**：逐个 `try/catch`，失败进 `failed` + `lastError`，继续装载下一个；
- **`stop` 抛错或超时都继续卸载**（只告警 + 审计）：绝不因一个插件卡住核心停机；
- 卸载顺序固定：`stop` → 撤销能力登记 → `dispose`（Scope 顺序释放 handle）。

**错误码**（只增不改）：`PLUGIN_NOT_FOUND`、`PLUGIN_DIR_MISSING`、`PLUGIN_MANIFEST_INVALID`、`PLUGIN_NO_ENTRY`、`PLUGIN_EXPORT_INVALID`、`PLUGIN_DEPENDENCY_MISSING`、`PLUGIN_INIT_FAILED`、`PLUGIN_INIT_TIMEOUT`、`PLUGIN_START_FAILED`、`PLUGIN_START_TIMEOUT`、`PLUGIN_STOP_TIMEOUT`、`PLUGIN_MEMORY_LIMIT`、`PLUGIN_JOB_PENDING`、`PLUGIN_CONFIG_INVALID`、`PLUGIN_DISABLED`、`PLUGIN_ALREADY_RUNNING`、`PLUGIN_RESERVED`、`PLUGIN_FILE_MISMATCH`（P4 预留）。（加载期求值失败沿用已有的 `PLUGIN_LOAD_FAILED`。）

## 6. 安装记录（P1 最小版）

```jsonc
// <SPC_STATE_DIR ?? <cwd>/.spc>/plugins.json
{
  "pluginsSchema": 1,
  "plugins": [{
    "id": "@xfy2412/sample",
    "dir": "plugin/sample",
    "version": { "code": 1, "name": "0.0.1" },
    "enabled": true,
    "grants": ["fs.write.home", "exec.template.git.version"],
    "capabilities": ["route:/sample", "api:/api/sample/*"],
    "configPath": "config/plugins/xfy2412__sample.json",
    "reserved": false,
    "state": "stopped",
    "installedAt": "2026-09-15T00:00:00Z",
    "lastError": null,
    "restartAttempts": 0,

    // ↓ 字段与 plugin-signature-design.md §9 对齐；本地安装为 null（unanchored）
    "origin": null,
    "signedBy": null,
    "verifiedMeta": null
  }]
}
```

- **记录由 daemon 拥有**（写操作必须经过 daemon），CLI 只读时可离线读取；
- 同一 `id` 只有一条记录；`dir` 为绝对路径或相对核心工作目录的相对路径（写入时归一化为绝对路径）；
- `reserved: true` = 内置/保留插件（**可禁用、不可卸载**），普通插件可卸载（`uninstall` 对 reserved 报 `PLUGIN_RESERVED`）；
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
spc plugin install <dir>              # 写记录（本地安装 ⇒ unanchored，提示"无更新渠道"）
spc plugin enable|disable <id>        # 写操作经 daemon
spc plugin reload <id>                # failed 恢复 / 配置变更后重启
spc plugin status <id>                # 详情：state / grants / lastError / dataDir
spc plugin grant <id> <point>...      # 逐点授予（isValidGrantPoint 校验，拒绝通配）
spc plugin revoke <id> <point>...
```

**HTTP**（daemon）

```
GET  /api/plugins                     # 列表 + 状态（已有雏形，补 state/grants/lastError）
POST /api/plugins/<id>/enable|disable|reload
POST /api/plugins/<id>/grants         # { add: [...], remove: [...] }
```

## 9. 明确不做（P1.5）

- **依赖拓扑排序与版本区间解析**：P1 只检查"声明的插件已安装且 enabled"；顺序按记录顺序（P2 补）；
- **热重载注入**：`reload` = 整插件 stop → 重新 load（不做模块热替换）；
- **插件间调用**：`dependencies.plugins` 目前只是可见性声明 + 依赖存在性检查，调用通道属 P2（事件总线 / 注册点）；
- **driver / panel / hook 的加载档**：P1.5 只做 `ability`（沙箱 / QuickJS）；driver 是核心侧进程（P2+），panel 是前端产物（P3），hook 待 ADR；
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
      "initTimeoutMs": 5000,
      "startTimeoutMs": 5000,
      "stopTimeoutMs": 3000
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
| `core/plugin/capabilities.ts` | manifest 能力登记与回滚（routes / webApis / events；`execTemplates` 留槽） |
| `core/plugin/config.ts` | 插件配置：`configSchema` 校验、默认值填充、只读快照与落盘 |
| `core/config.ts` | 最小配置面（文件 + `SPC_*` 覆盖） |
| `core/sandbox.ts`（改） | 暴露"带限额的运行时"与"取模块导出"的能力（handle 全部纳入 Scope） |
| `core/cli.ts` / `core/server.ts`（改） | §8 的命令与端点；`plugin list` 加状态列 |
| `core/main.ts`（改） | `pnpm spike` 走真链路：记录 → 装载 → init/start → stop → 卸载 |

**测试**（新增 `core/__tests__/lifecycle.test.ts`）

1. 状态机：每个迁移 + 非法迁移被拒；
2. 导出契约：缺 `init` → `PLUGIN_NO_ENTRY`；非函数导出 → `PLUGIN_EXPORT_INVALID`；
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
13. 依赖检查：声明未安装的插件 → `PLUGIN_DEPENDENCY_MISSING`；
14. 插件配置：缺省值填充、非法值被拒（`PLUGIN_CONFIG_INVALID`）、`ctx.config` 只读（插件写入无效、不污染宿主）；
15. 能力登记幂等：连续两次 `reload` 后登记表与 `capabilities` 完全一致（撤销后重建，不叠加）；
16. 并发：同时发起同一插件的两个 `load`/`reload` → 锁串行，终态一致且无重复登记；
17. `reserved` 插件：可 `disable`，`uninstall` 被拒（`PLUGIN_RESERVED`）。

**验收**：以上全绿 + `pnpm spike` 走"记录 → 装载 → init/start → stop"真实链路且输出与现在等价；`spc plugin list` 显示状态。

## 12. 待定

1. 钩子命名是否就用 `init/start/stop`（备选：`activate/deactivate`）；
2. `stop` 是否需要接收"关闭原因"（`stop(ctx, {reason})`：`reload` / `disable` / `shutdown`）——**倾向要**，便于插件区分优雅停机与重启；
3. `dataDir` 清理策略（`disable` 是否保留数据；卸载是否删数据）——**倾向：都保留，卸载提供 `--purge`**；
4. hook 插件的钩子形态与 `init/start/stop` 的关系（待 ADR 定稿）；
5. **状态目录统一**：建议 `SPC_STATE_DIR`（默认 `<cwd>/.spc`）作为基目录，其下是 `config.json` / `plugins.json` / `keyring.json` / `audit/` / `data/plugins/`；现有的 `SPC_AUDIT_DIR`、`SPC_KEYRING_DIR` 降级为**覆盖项**（实现时一并收编，避免三套状态目录变量共存）。

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
| `reserved` 插件在 `builtin_stars`，不可卸载 | 记录 `reserved: true` ⇒ 可禁用、不可卸载（§6） |
| 单插件 `try/except` 包住整段装载，失败进 `failed_plugin_dict` 并清理状态后**继续下一个** | 逐个 try/catch，失败进 `failed` + `lastError`，继续装载其它插件（§5） |
| `reload_failed_plugin(dir_name)` 专治失败插件 | `failed` + `spc plugin reload <id>`（默认不自动重启；`failedRestart=auto` 可选） |
| `_terminate_plugin`：不在跑就跳过；`__del__` 丢 executor 并捕获异常；terminate 抛错只告警、继续卸载 | `stop` 抛错/超时都继续卸载，随后强制 `dispose`（§5） |
| 所有管理操作走 `_pm_lock` | manager 的每次状态变更串行化（一把锁，§5） |
| `plugin_id = author/name`（对类属性注入 `name/author/plugin_id`） | `id = @publisher/name`（多一个 `@`；身份与来源解耦见 ADR-001 v3） |
| 插件专用 logger，且支持按插件覆盖日志等级 | `ctx.logger`；日志等级覆盖记在 P2-4 日志聚合器 |
| `astrbot_version`（PEP 440 区间）不满足即拒载 | `compat.minCore/targetCore`：不满足即拒载，不静默降级 |
| `OnPluginLoadedEvent` 钩子（插件间可监听"某插件已加载"） | hook 插件 + 事件总线（P2；P1.5 只登记 `exports.events`） |
| 旧版插件类兼容加载（`Plugin`/`Main` 命名回退） | **不做兼容回退**：导出契约唯一（缺 `init` 即 `PLUGIN_NO_ENTRY`），fail-closed |
