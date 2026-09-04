# 开发路线（Roadmap）

> 依据 docs 内 ADR-001~005 与 api-contract.md（v0.2）、interface-audit-exec-fs.md。单人开发节奏，每阶段可演示、可测试、由本人提交。
> v2 更新（2026-08）：核心语言 Go → Node；插件运行时 QuickJS 沙箱（ADR-005）；通信改进程内注入；P0/P1 内容对齐。

## 规划原则

1. **纵向切片优先**：先打通"Node 核心 → QuickJS 沙箱 → @host/api 注入 → 权限门 → 审计 → CLI"的完整薄切片，再横向扩充。避免"平台做半年才发现模型不成立"。
2. **契约最小化**：API 面 = 攻击面（ADR-001）。契约只锁最小可用子集（exec/fs/kv/timers），随插件真实需求扩充。
3. **安全内建非后置**：非 root、权限门、审计从第一个切片就有；exec/fs 审计（interface-audit-exec-fs.md）是 P1 验收硬指标。
4. **高风险先验证**：①QuickJS 沙箱与 @host/api 注入（性能 benchmark 前置）；②exec 模板设计；③前端运行时加载。全部在前三阶段内验证。
5. **非 root 从第一天**：core 检测到以 root 运行 → 拒绝启动插件（fail-closed）。

## 阶段总览

| 阶段 | 名称 | 体量 | 依赖 |
|---|---|---|---|
| P0 | 契约定稿（v0.2 最小集） | S | — |
| P1 | 纵向切片：Node 核心 + QuickJS 沙箱 + exec/fs 审计 | M | P0 |
| P2 | 构建层与依赖三层 + 事件总线 + 驱动插件扩展点 | L | P1 |
| P3 | 面板插件 + 前端运行时加载 | L | P1（可与 P2 并行） |
| P4 | 签名与市场（双档落地） | M | P1 + P3 |
| P5 | 核心插件集 + 加固 + 发布 | L | P2 + P3 |

---

## P0：契约定稿（最小可用集）

- api-contract v0.2 定稿：
  - 双通道传输（进程内 @host/api 注入为主 + stdio JSON-RPC 次通道）定死，含版本协商（`lifecycle.version`）；
  - 方法组最小集：exec（模板）、fs（受限）、kv、timers、events、lifecycle、audit（api-contract §4）；
  - 权限注册表 + protectionLevel（normal/dangerous/signature）+ 三态判定（§6/§7）；
  - manifest schema 2 编译成 JSON Schema（sdk/schema/manifest.schema.json）。
- **明确不做**：db/ssh/网络能力（驱动插件，P2+）；事件总线细化授权（v0.3）。
- 交付：api-contract.md v0.2 + manifest JSON Schema + interface-audit-exec-fs.md 评审通过。
- 验收：核心方法 ≤ 10 个；威胁建模清单（interface-audit-exec-fs）过审。

## P1：纵向切片（最高优先级）

**目标**：`spc plugin list` 看到一个真实插件在 QuickJS 沙箱里跑，能调 `@host/api`，且 exec/fs 审计全绿。

- `core/` 初始化：Node + TS，入口、配置、非 root fail-closed；
- **QuickJS 沙箱宿主**（quickjs-emscripten）：ESM bundle 加载、`@host/api` 注入、生命周期（init/start/stop）、崩溃/超时处理、**性能 benchmark**（JSON/正则/API 往返，验证"薄适配器无感"）；
- **基础宿主 API**：exec 模板（nginx/git 起步）+ fs 受限 + kv + timers + lifecycle；**权限注册表 + 三态判定 + 审计**（interface-audit-exec-fs E1–E8/F1–F7 全部测试用例）；
- **CLI**：`plugin list / install <dir> / enable / disable`、`panel status`、`audit tail`；
- **sdk**：`@host/api` 类型声明、esbuild 构建模板（ESM-only）、manifest 校验器；
- **demo 插件**（内置示例）：kv 写入 + 定时器 + fs.data 读写 + 一次 exec 模板调用。
- 验收：威胁建模测试清单（§5）全部通过；kill 沙箱插件 → 核心不挂；审计有条目；`panel disable` 后 CLI 一切可用。

## P2：命令任务模型 + 构建层 + 驱动插件

1. **命令执行任务模型**（api-contract §4.1，参考 MCSManager）：exec.spawn → TaskHandle（wait/output/kill）、世代号防竞态、取消三层链（杀进程树）、优雅停止契约、输出环形缓冲 + 截断标记；**进程管理器**（process.* 组：长驻进程状态机 + 崩溃自动重启）——MC 管理场景的落地；
2. **构建流水线**：依赖图静态解析 → 白名单校验（禁原生模块/禁用模块）→ esbuild ESM bundle → 签名（ADR-005 §6）；依赖三层（L1 平台托管 / L2 用户放行 / L3 禁区）落地；
3. **事件总线完备化**：事件清单扩展（job.finished/process.exit/process.crash + 钩子事件 auth.*/exec.before 等）+ 事务裁决语义（EventResult 四态，协作插件地基）；
4. **日志聚合器 + 配置中心**：沙箱 console → 聚合（分级/标签/检索，插件仅见自身日志）；配置 = kv 结构化上层（schema 校验 + 热更新）；
5. **API 扩展注册点**：驱动插件注册协议（§10）+ 第一个驱动插件候选：db（pg/mysql2，社区）；
6. 契约随实现演进 v0.3（事件授权模型、类型声明自动生成）。
- 验收：恶意依赖（含原生模块）构建失败；L2 用户放行 + 审计生效；驱动插件注册的方法进注册表且可被沙箱能力插件调用；TaskHandle 全生命周期测试（阻塞/异步/取消/超时/杀树）。

## P3：面板插件 + 前端运行时加载

- 前端运行时加载（先最小 proof）：React shell 按 manifest 资源路径运行时加载插件 bundle；
- **面板插件**（panel，默认内置、可卸载）：构建 Web 壳 + 组件库，其他插件按统一规范挂载页面；承载登录/auth、仪表盘、插件管理页、审计查看、市场页（P4 后接入）。
- 验收：卸载/禁用 panel → Web 不可用、CLI 全可用；第三方插件前端无需重编译。

## P4：签名与市场（双档落地）

- 签名工具链（ed25519，manifest+代码哈希）；registry 服务（market/，列表/上传/下载）；客户端安装流（签名失败拒绝）；双档降级 + 风险提示 UI；密钥管理文档（离线/轮换/吊销，密钥永不进仓库）。

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
| R2 构建层静态分析误伤合法插件（动态 require） | 白名单内允许受限动态 require；文档明确"静态可审计优先" |
| R3 exec 模板设计不足 → 插件做不了事 | P1 先做 2 个真实模板（nginx/git）验证；模板注册表是核心评审对象 |
| R4 驱动插件与核心进程边界不清 | api-contract §11-3 待定项，P2 落地时定 |
| R5 单人节奏拖垮 | 每阶段小步可演示；P2 与 P3 可并行 |

## 明确不做（现阶段）

- Windows 原生支持（架构无阻碍，v1.x 目标，见 ADR-002 v3）；容器/WASM 沙箱（ADR-004/005）；付费插件；微型设备额外档位（QuickJS 已天然适配）。
