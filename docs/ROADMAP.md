# 开发路线（Roadmap）

> 依据 docs 内 ADR-001~005 与 api-contract.md（v0.2）、interface-audit-exec-fs.md。单人开发节奏，每阶段可演示、可测试、由本人提交。
> v2 更新（2026-08）：核心语言 Go → Node；插件运行时 QuickJS 沙箱（ADR-005）；通信改进程内注入；P0/P1 内容对齐。

## 规划原则

1. **纵向切片优先**：先打通"Node 核心 → QuickJS 沙箱 → @host/api 注入 → 权限门 → 审计 → CLI"的完整薄切片，再横向扩充。避免"平台做半年才发现模型不成立"。
2. **契约最小化**：API 面 = 攻击面（ADR-001）。契约只锁最小可用子集（exec/fs/kv/timers），随插件真实需求扩充。
3. **安全内建非后置**：非 root、权限门、审计从第一个切片就有；exec/fs 审计（interface-audit-exec-fs.md）是 P1 验收硬指标。
4. **高风险先验证**：①QuickJS 沙箱与 @host/api 注入（性能 benchmark 前置）；②exec 模板设计；③前端运行时加载。全部在前三阶段内验证。
5. **非 root 从第一天**：daemon 检测到以 root 运行 → **拒绝启动**（fail-closed）；插件随 daemon 跑在同一低权限用户下（ADR-004）。

## 阶段总览

| 阶段 | 名称 | 体量 | 依赖 |
|---|---|---|---|
| P0 | 契约定稿（v0.2 最小集） | S | — |
| P1 | 纵向切片：Node 核心 + QuickJS 沙箱 + exec/fs 审计 | M | P0 |
| **P1.5** | **插件生命周期与装载器（冻结装载契约）** ✅ **已落地** | M | P1 |
| P2 | 构建层 + 事件面 + 驱动插件扩展点 + **权限档位（`grant` 三档）** | L | P1.5 |
| P3 | 核心 Web Shell + 主题系统 + 插件前端容器 | L | P1（可与 P2 并行） |
| P4 | 市场签名与源管理 + 市场 | M | P1 + P3 |
| P5 | 核心插件集 + 加固 + 发布 | L | P2 + P3 |

---

## P0：契约定稿（最小可用集）

- api-contract v0.2 定稿：
  - 双通道传输（进程内 @host/api 注入为主 + stdio JSON-RPC 次通道）定死，含版本协商（`lifecycle.version`）；
  - 方法组最小集：exec（模板）、fs（受限）、kv、timers、events、lifecycle、audit（api-contract §4）；
  - 权限注册表（`scope` + 等级）+ 三态判定（§6/§7）；
  - manifest schema 2 编译成 JSON Schema（sdk/schema/manifest.schema.json）。
- **明确不做**：db/ssh/网络能力（驱动插件，P2+）；事件 topic 细化授权（**已定**：订阅他人事件须先声明依赖发布方，见 `docs/events-and-hooks-design.md` §1.7）。
- 交付：api-contract.md v0.2 + manifest JSON Schema + interface-audit-exec-fs.md 评审通过。
- 验收：核心方法 ≤ 10 个；威胁建模清单（interface-audit-exec-fs）过审。

## P1：纵向切片（最高优先级）

**目标**：`spc plugin list` 看到一个真实插件在 QuickJS 沙箱里跑，能调 `@host/api`，且 exec/fs 审计全绿。

**现状（据实核对，2026-09）**：

| 状态 | 项 |
|---|---|
| ✅ 已完成 | core 初始化 + 非 root fail-closed；QuickJS 沙箱宿主（错误桥 + 模块白名单 + dispose 修复）；权限注册表与判定（v3：`scope` + 逐点授予）；审计链路；**exec 模板基线**（模板注册表 + 原生写法匹配 + 参数校验 + env/超时/截断 + 内置 git 模板集）；exec 沙箱设计（声明层）；**P1.5 的装载器与生命周期**（见下） |
| ⚠️ 部分 | CLI（`about`/`status`/插件全命令面；缺 `audit tail`）；sdk（清单校验器 + 两个手写 `.d.ts`；构建模板缺）；性能 benchmark（R1）未做 |
| ❌ 待补 | `exec.spawn` 任务模型（P2）；构建流水线（P2）；`audit tail`；事件面本体（P2：**核心不发流程事件、不做强制裁决**，见 `docs/events-and-hooks-design.md` §1）；钩子链（P2 不做，见同文档 §2） |

- `core/` 初始化：Node + TS，入口、配置、非 root fail-closed；
- **spike 起点**（spike-01 已产出，P1 在其上补齐）：`core/sandbox.ts`（asyncify 沙箱 + 错误桥 + 模块白名单注册表）、`core/hostApi.ts`、`core/audit.ts`、`core/fs/safe-path.ts`、`plugin/hello/`、`patches/` + `scripts/verify-quickjs-patch.mjs`；P1 待补：权限门覆盖、生命周期（init/start/stop）、崩溃/超时处理；
- **QuickJS 沙箱宿主**（quickjs-emscripten）：ESM bundle 加载、`@host/api` 注入、生命周期（init/start/stop）、崩溃/超时处理、**性能 benchmark**（JSON/正则/API 往返，验证"薄适配器无感"）；
- **基础宿主 API**：exec 模板（nginx + git 一族起步）+ fs 受限 + kv + timers + lifecycle；**权限注册表 + 判定 + 审计**（F1–F7 已覆盖；E1–E8 的注册/参数/执行三类已覆盖）。**已落地**：模板注册表 + `exec.run`（阻塞，支持**模板 ID 与原生写法**两种调用，原生写法匹配不到即拒绝）+ 参数校验（enum/pattern/whitelist/path）+ env 白名单 + 超时 + 输出截断 + 动态权限点 `exec.template.<action>.<op>`（`scope: host`，需逐点授予；P2 起统一为 `grant: explicit`）+ 审计 `target`/`resultBytes` 字段 + 跨平台可执行解析（E10）+ 内置 git 模板集（version/status/log/rev-parse/branch/fetch/pull）与 `SPC_REPO_ROOTS`；样板插件已示范 `exec.run` 调用；**待补**：kv / timers / lifecycle、`exec.spawn` 任务模型（P2）；
- **exec 基线与沙箱设计**（docs/exec-sandbox-design.md）：P1 落地"降权（spc）+ env 白名单 + 超时/输出截断"基线，声明层为过渡期唯一防线；注册制与系统级沙箱见 P2/P5；
- **CLI**：`plugin list / install <dir> / enable / disable`、`web status`、`audit tail`；
- **sdk**：`@host/api` 类型声明、esbuild 构建模板（ESM-only）、manifest 校验器；
- **demo 插件**（内置示例）：kv 写入 + 定时器 + fs.data 读写 + 一次 exec 模板调用。
- 验收：威胁建模测试清单（§5）全部通过；kill 沙箱插件 → 核心不挂；审计有条目；**headless**（关闭 Web 前端）后 CLI 一切可用。

## P1.5：插件生命周期与装载器 ✅ 已落地（2026-09）

**为什么排在构建层之前**：装载契约没冻结，插件怎么写、产物怎么打包全是猜。完整设计见 **plugin-lifecycle-design.md**（§14 是落地记录与 13 条实现偏差）。

- **装载契约**：ESM bundle 导出 `init(ctx)`（必需）+ `start`/`stop`（可选，均可 async）；`@host/api` 给**能力**、`ctx` 给**环境**（`pluginId`/`version`/`dataDir`/`manifest`/`grants`/`config`/`logger`，沙箱侧 deepFreeze ⇒ 只读是 VM 语义保证的）；
- **插件配置**：manifest `configSchema`（JSON Schema 子集，含 `secret`）+ 值文件 + `ctx.config` 只读快照；非法值拒绝保存；
- **状态机**：installed/loading/loaded/starting/running/stopping/stopped + `failed`/`disabled`，**唯一状态机在 manager**，每次变更过唯一锁；失败重启是配置项（默认 `manual`）；
- **能力登记**：loader 依 manifest 登记 routes / webApis / events / theme（`execTemplates` 留槽给 P2-5），**全有或全无**、重载幂等，结果写进记录的 `capabilities`；
- **四层限额**：CPU 中断 / 内存 / 栈 / 宿主 API 自带超时（QuickJS 语义见 exec-sandbox-design §3.5 与 limits.ts 注释）；
- **安装记录**：`plugins.json`（字段与 plugin-signature-design §9 对齐；**v4 起本地安装也有具名来源** `local:<名字>`——`unanchored` 指"没有市场签名 / 更新渠道"，不是 `origin` 为空；**v2 起没有 `reserved`**——内置只表示随核心分发，仍可禁用/卸载/独立更新）；
- **依赖图**：依赖必须**已启用且已装载**（`PLUGIN_DEPENDENCY_NOT_LOADED`）；装载按**拓扑序**（依赖先 init）；**环检测**（环上直接判 `failed`）；**反向保护**（被依赖时不许 `uninstall`／`disable` → `PLUGIN_IN_USE`）。版本区间解析与运行时失效通知仍待 P2；
- **CLI / HTTP**：`plugin install/enable/disable/reload/uninstall/status/list/grant/revoke` + `GET /api/plugins`（带 state/grants/lastError/capabilities）；
- **验收（已过）**：`pnpm spike` 走"记录 → 装载 → init/start → stop → 卸载"真实链路；32 例 lifecycle 测试 + 11 例宿主 API 测试全绿；**190 例全量测试**通过；`tsc --noEmit` 干净。

## P2：命令任务模型 + 构建层 + 驱动插件

> **顺序与开源触发点（已定，2026-09）**：**先把模块仿真做完 → 再做构建层 → 构建层能产出插件文件、能构建，即开源**，请广大开发者参与插件开发。
> 理由：仿真是能力插件的**前提**（核心不提供 fs/exec，插件无从落地）；构建层是插件**可分发**的前提。两者都就绪之前开源，来的开发者会卡在"写得出但装不上"。

1. **命令执行任务模型**（api-contract §4.1，参考 MCSManager）：exec.spawn → TaskHandle（wait/output/kill）、世代号防竞态、取消三层链（杀进程树）、优雅停止契约、输出环形缓冲 + 截断标记；**进程管理器**（process.* 组：长驻进程状态机 + 崩溃自动重启）——MC 管理场景的落地；
2. **构建流水线**（设计见 **docs/build-layer-design.md**，证据见 **docs/build-layer-evidence.md**）：依赖闭包静态解析（含传递）→ 内建登记表校验（两道闸：① 未登记内建 / 原生模块 → **构建失败**，已登记内建 → **内联仿真正文**；② 产物自检）→ esbuild 单文件 ESM bundle → 产物事实写进清单文件。**依赖不分级**（ADR-005 §7 v2：装完之后不存在"加载依赖"这个动作，勾选拦不住任何东西）。**esbuild 行为与依赖面已实测**（27 个包、417 处运行期欠条 = 413 字面量 + 4 动态）；
3. **事件面**（设计已定：`docs/events-and-hooks-design.md`）：**插件自己发布事实、声明过关系的插件收到、核心只搬运**（两种用法：通知 / 意见征询）。
   **核心不发布流程事件**（`exec.*` / `job.*` / `process.*` / `auth.*` 一律不做——exec/job/process 是插件自己的动作、结果它自己拿得到；`auth.*` 属下面那条）；
   **能力插件之间不做强制裁决**（核心只转发意见，采纳与否由发布方决定）。
   **钩子链**（≈ 协作插件 `hook`：核心在决策点上回调插件、答复进核心决策）**结论保留、P2 不做**，等 hook 轮——那时 `auth.*` 的 SSO 场景才有落点；
4. **日志聚合器 + 配置中心**：沙箱 console → 聚合（分级/标签/检索，插件仅见自身日志）；配置 = kv 结构化上层（schema 校验 + 热更新）；
5. **模板注册制 + API 扩展注册点**：插件在 manifest 声明 `execTemplates`（两方来源：核心内置 / 插件声明；**管理员是审批方，不定义模板**；静态校验 E1–E10，详见 exec-sandbox-design.md）+ 驱动插件注册协议（§10）+ 第一个驱动插件候选：db（pg/mysql2，社区）；
6. **官方模块仿真**（docs/module-emulation-design.md，**当前最高优先**）：让插件作者按 Node 原生写法写插件、并可用"只用官方模块"的依赖。
   **原则：语法与行为对齐 Node——Node 是契约宗主**；用对齐测试守住（同一输入喂真 Node 与 shim 比输出），无法对齐的一律**明确报错**，不给近似值。
   - **已完成（P2-A 前半）**：`path`（POSIX）/ `events` / `assert` / `tty` / `constants` + **登记表**（`core/sandbox-modules/registry.ts`，构建层将来共用）+ loader 接线 + 对齐测试骨架（`core/__tests__/sandbox-modules.test.ts`）；
   - **已完成（第二批）**：`util`(+`util/types`) / `os` / `process` / `buffer` / `string_decoder` / `url` / **`fs` + `fs/promises`**（作用域=数据目录、errno 映射见 module-emulation-design §7）。`url` 的 WHATWG 部分**走宿主**（实测 QuickJS **没有** `URL`/`URLSearchParams`，不能"包装内置"，只能自实现或代工；且**禁止**启用 `quickjs-libc` 的 std：它带 fs/进程/curl，是能力泄漏），legacy `parse`/`format`/`resolve` 与 `pathToFileURL`/`fileURLToPath` 照 `node/lib/url.js` 移植；
   - **第二批的验收口径**（可复跑）：`node tools/dep-survey.mjs --set utils --coverage` 从 17/43 抬到 **26/43**（`debug` `ora` `cli-table3` `properties` `handlebars` `eta` `ejs` `which` 等 9 个包过闸，`joi` 由 `url` 解锁）；每模块一份与宿主 Node 的差分测试 + 至少一条**真沙箱冒烟**（宿主进程里的差分**测不出**"沙箱里缺某个全局"，这个坑踩过）；
   - **已完成（第三批）**：`crypto`（摘要/HMAC/随机/`timingSafeEqual`/一次性 `createDecipheriv` + 固定基线静态表；非对称与密钥对象明确抛错）、`zlib`（同步 + 回调面 + `crc32`）、**收口三项**（`worker_threads` 只报事实 / `process.getuid` 一族 → 固定 1000 / `querystring` 完整面）、**`stream` B1**（`Stream` legacy 函数基类 + `Readable`/`Writable`/`Duplex`/`Transform`/`PassThrough` + `finished`/`pipeline`；已知差异见设计 §9.1）。**`csv-parse` 的流式入口（B2）与 `stream/promises` 真实现留到有靶子卡住时再做**。
     覆盖度（**构建闸静态口径**，`node tools/dep-survey.mjs --set utils|core --coverage`）：utils **36/43**、core **16/27**；
     ⚠️ 这个口径是"产物里出现过且已登记"，与"真能跑通"不是一回事——真实依赖冒烟 **10/11**（`tools/smoke/dep-smoke.mts all`）。
   - **已完成（第四批 A：Windows 支持 / 模型 B）**：**仿真平台跟随宿主**——`platform` / `path` 语义 / `EOL` /
     `devNull` / 常量表 / 沙箱可见路径形态**六者同源**（设计 §9.3）。`constants` 拆**两张平台真值表**
     （Windows v22.22.1 实跑采真值：键集差 59/51、同名不同值 49、形状差一处），`path.win32` 换成**真实现**
     （照 `node/lib/path.js` 重写，UNC / `\\?\` / 保留设备名 / 盘符相对 / 反冒名补偿），
     `path/posix` 拆成独立 shim（语义**固定** POSIX，不再与 `path` 共用）。
     **判卷人**：官方 `node-v22.22.1-win-x64`（`_tools/`，不进仓库）——常量是编译期定的，本地源码给不出 Windows 的数值。
     `path.win32` 与判卷人逐条差分 **363/366 一致 + 3 条明确记账的已知边界**（"每盘 cwd"沙箱复现不了）。
     真实依赖冒烟 10/11 不变（`mkdirp` 一度因"具名导出没跟随平台"回退，已修）。
   - **第三批顺带修掉的三个"非仿真模块"缺陷**（都由真实依赖冒烟暴露，不是模块清单里的活）：
     ① `os.cpus` 改成**混合口径**（条数=容量类真值、`model`/`speed` 给空值）——`fast-glob` 在模块顶层取核数，抛错等于整包装载失败；
     ② 引导层补 CJS 全局 `__filename`/`__dirname` 与 `setImmediate` 壳子（esbuild 搬 CJS 包与 `@nodelib/fs.walk` 都要）；
     ③ **`path.resolve` 认盘符**——之前 `resolve('C:/…/tree')` 会拼成 `C:/C:/…`，`fast-glob` 因此**一个条目都匹配不到且不报错**。
   - **第三批遗留（1 项，落点在构建层不是仿真层）**：`graceful-fs` 在装载期给 `fs` 打补丁，而 QuickJS 对"写只读访问器"是**抛错**（V8 静默）⇒ 现状装载失败；方案已定并记档（构建层把它别名成 `fs` shim + 产物清单记一笔，理由见设计 §14.8）。
   - **交付物**：`core/sandbox-modules/*.js`（一模块一真实文件）+ 登记表 + 各模块对齐测试；
   - **排期依据是实测**（`tools/dep-survey.mjs --set utils --coverage`）：P2-A 在当前样本里解锁 **0** 个包（是**前置**、不是解锁项），真正的杠杆在 P2-B；`stream` 是单模块收益最高的（单独补它解锁 5 个包，且按包拆开多为 1–2 个属性）；
     ⚠️ **实测修正**：`stream` 落地后那"5 个包"里 `fast-glob` 已真正跑通（第三批顺带修了三处）、`csv-parse` 待加靶子；`graceful-fs` 卡"装载期给 `fs` 打补丁"（方案已定）、`proper-lockfile`/`chokidar` 还缺 `fs.watch` 与 fd 面。**"解锁 N 个包"是候选估计，落地后要按真实冒烟重算**（设计 §14.7）。
7. **权限档位落地**（intent-capture §8.1/§8.2）：`PermissionPoint.grant` 三档（`auto` / `install` / `explicit`）+ 注册期约束 `self ⇒ auto`（`SCOPE_GRANT_INVALID`）+ 判定链第 2/3 步改为"**只看 grant**"——`auto` 免声明免授予、`install` 要声明但免逐点授予、`explicit` 要声明 + 逐点授予（`auto`/`install` 审计记 `installed-grant`）；升级新增的 `install`/`explicit` 点走**增量同意**（P3 前端）。
   **✅ 已落地（2026-09，第四批 B）**：判定链 + 注册期约束 + 17 个 API 点的档位清单（`core/__tests__/permissions-meta.test.ts` 钉成显式表）；
   **遗留**：`fs.read.data`/`fs.write.data` 暂留 `self`/`auto`（"内容式权限"要单独讨论），增量同意 UI 属 P3；
8. **CLI 完善**（依赖管理约定的后半，plugin-lifecycle-design §5）：① **维护模式守护进程**——主进程停止时由 CLI 临时拉起，不触发装载、只处理 CLI 事件、30 秒无交互自动退出；② 卸载/禁用的**依赖树级联确认**（最多向下追溯 3 层，确认后连带**禁用**依赖方）；
9. 契约随实现演进 v0.3（事件授权模型、类型声明自动生成）。
- 验收：**未登记内建 / 原生模块 → 构建期失败**；**解析不到的非内建可选依赖 → 自动 stub（不失败，行为与 Node 一致）**；**动态 require → 构建期失败**；产物自检（无 `"Dynamic require of "` 标记、残留 specifier ⊆ 白名单）；驱动插件注册的方法进注册表且可被沙箱能力插件调用；TaskHandle 全生命周期测试（阻塞/异步/取消/超时/杀树）；**权限档位判定**——`auto`/`install` 免逐点授予、`explicit` 未授予 → `NOT_GRANTED`、`scope: self` + `grant: explicit` 注册报 `SCOPE_GRANT_INVALID`。

## P3：核心 Web Shell + 主题系统 + 插件前端容器

**为什么是核心**：用户意图只能由可信前端捕获（ADR-001 v4），因此 Web Shell 不能是"插件"——面板插件已降级为主题包（ADR-005 v3）。完整模型见 **intent-capture.md**。

- **核心 Web Shell（可信前端）**：路由 / 布局 / 菜单 / i18n / 主题系统 + 组件库；承载登录/auth、仪表盘、插件与主题管理页、审计查看、市场页（P4 后接入）；**可 headless**（关闭 Web 服务，一切回管理 CLI）；
- **意图捕获 UI**：资源选择器、确认窗口、来源角标、提权凭据输入（样式不可被主题覆盖）；
- **前端 API（核心 REST）**：`/api/intent/{grant,revoke,forward}` + 核心原生能力端点（api-contract §11）；frontend-token 只存核心前端内存；
- **插件前端容器**：`declarative`（manifest 组件树 → 核心渲染）与 `iframe`（`sandbox` 无 `allow-same-origin` + CSP 零出网 + `MessageChannel` 代理）；
- **主题系统**：`theme.json`（声明式令牌 + 资源 + 受限样式，无 JS），核心与插件 iframe 共用同一批 CSS 变量；
- **确认 UI 与档位**：L0 静默 / L1 toast+撤销（回收站）/ L2 确认弹窗 / L3 二次确认；判据 = 意图经不可信方转述 或 点击时后果不可见（intent-capture §7）；`intent.confirm` 三档 + 新装/升级蜜月期 `strict`；
- **grantId**：核心持久实例密钥签发 / 校验 / 消费（`core/intent/`）；
- 验收：① CSP 与 `sandbox` 属性生效（插件前端无法直连核心、无法外发）；② 意图负载不合声明 → `INTENT_SCHEMA_VIOLATION`；③ grantId 绑定校验（错受众 / 错资源 / 过期 / 重放全部拒绝）；④ 主题无法覆盖安全 UI；⑤ 关闭 Web 服务后 CLI 全可用；⑥ **六场景档位判定**（intent-capture §8.6）——特别是场景 1（用户直选 → 0 弹窗）与场景 3（用户亲手敲 sudo → 仍 L3）的对照，以及场景 4（插件自主越界 → 拒绝而非弹窗）。

## P4：市场签名与源管理 + 市场

**已提前落地（P4 核心库，随 P1 一起做的）**：`core/sources/{canonical,keys,keyring,status,verify}.ts` —— 规范化 JSON、公钥指纹与验签、keyring（域名主键 + TOFU/手填 + 暂停 + 防回滚高水位）、链式密钥轮换验证、包校验（meta 签名 + `files[]` + manifest 交叉校验 + 作者一致性），26 条测试。**未落地**：registry 服务、安装流接线（含 `verifiedMeta` 与启动哈希校验）、CLI 源管理、市场页面。

- 签名工具链（ed25519；签名对象 = 规范化元数据，覆盖 manifest 与逐文件哈希，**由市场私钥签名**，见 **plugin-signature-design.md**）；registry 服务（market/，列表 / 上传 / 下载）；客户端安装流（清单校验 + 验签失败拒绝 + **本地安装不验签**）；
- 源管理：keyring（域名主键 + 可选公钥 + `firstTrust` + `suspended` + 防回滚高水位）、添加源（TOFU 拉公钥 / 离线手填公钥）、状态文档拉取与**链式密钥轮换验证**、`revoked[]` 吊销信息（累计展示与审计，**不参与判定**）、暂停与管理员确认流程、**源信息展示**（含已吊销密钥与原因码）；
- 安装界面：驱动插件的**独立界面与最高强度提示**；无源（本地安装）插件的额外确认；
- **不做**：CRL/OCSP、在线吊销检查、镜像、域名组、证书随包分发、**去中心化分发与身份文档**（**作者签名 v4 做，但只做依赖身份**，见 `events-and-hooks-design.md` §3.5）、"紧急模式"开关；
- 密钥管理文档（每个市场一套密钥；离线保管 / 轮换 / 泄露应急；密钥永不进仓库）。
- 下载控制面与授权模型（download-token 配额防滥用 + 永久授权/维护窗口判定）见 **market-license-design.md**：P4-A（下载控制面，免费/付费双通道）与 P4-B（license 授权模型）在此阶段落地。

## P5：核心插件集 + 加固 + 发布

- 插件集（薄适配器）：monitor、files、nginx、backup（调用外部工具而非重写）；
- 加固：systemd 单元模板（资源配额）、安装脚本、非 root 部署文档、运行时自动更新链路；
- 安全评审轮：全方法威胁建模复核 + @host/api 注入面 fuzz；
- 验收：面板可日常管理服务器；全新服务器按文档 10 分钟部署；v1.0 发布。

---

## 风险清单

| 风险 | 应对 |
|---|---|
| R1 QuickJS 性能不足（薄适配器假设不成立） | P1 前置 benchmark，不成立则回退子进程档或混合 |
| R2 构建层静态分析误伤合法插件 | **已用实测收敛**：字面量可选依赖 → 自动 stub（不失败，Node 上也没装）；动态 require → 失败，但实测占比 4/417。证据见 docs/build-layer-evidence.md §2/§3 |
| R3 exec 模板设计不足 → 插件做不了事 | P1 先做 2 个真实模板（nginx/git）验证；模板注册表是核心评审对象 |
| R4 驱动插件与核心进程边界不清 | api-contract §11-3 待定项，P2 落地时定 |
| R5 单人节奏拖垮 | 每阶段小步可演示；P2 与 P3 可并行 |
| R6 **确认点过多 → 管理员/开发者折损率上升**（每个弹窗都是一次流失机会） | 默认边界按"确认判据二条件"压降（intent-capture §7）：用户直选的意图**不再重复确认**；`auto`/`install` 档**安装清单即授权**；可逆写用回收站 + toast 替代弹窗。六场景（§8.6）作为验收硬指标 |

## 开源后：社区讨论项

**定性**：这些不是"待排期的功能"，是**需要真实生态数据才能算清的账**。现在推演等于没有数据的推演——
与构建层那两次推错是同一个毛病（见 docs/build-layer-evidence.md §0）。开源后拿真实插件当样本再定。

| # | 议题 | 为什么现在定不了 | 已知约束 |
|---|---|---|---|
| C1 | **依赖托管**（平台提供依赖源码，不打进插件产物） | 三个关键变量只有真实生态能回答：插件是否真的重复携带同一大依赖、作者是否接受"版本由平台定"、版本矩阵要多大才够用 | ① 托管模块**必须与沙箱同级运行**（这些库不是为本平台设计的，绝不能进信任基）⇒ **唯一收益是省磁盘与下载**；② 版本需钉死 ⇒ 平台要维护 **(包 × 版本) 矩阵**；③ 它被取消分级时**连带误伤**——详情见 ADR-005 §7 v3 补记 |

**当前立场**：托管是**机制**不是政策，纯增量、不改变能力模型；在拿到数据之前**不排期、不实现**。
草案见 `.github/ISSUE_DRAFT-hosted-dependencies.md`。

## 明确不做（现阶段）

- Windows 原生支持（架构无阻碍，v1.x 目标，见 ADR-002 v3）；容器/WASM 沙箱（ADR-004/005）；付费插件；微型设备额外档位（QuickJS 已天然适配）。
