# ADR-005: 插件沙箱与能力插件机制（定稿）

- 状态：**已接受**
- 日期：2026-08
- 关联：ADR-001（信任模型）、ADR-002（核心语言修订为 Node，本 ADR 是其依据）、ADR-004（OS 底线）、api-contract.md（v0.2）、manifest-design.md

## 背景（演进摘要）

围绕"插件怎么跑"经历了多轮讨论：

1. Go 核心 + Node 子进程（每插件一进程，JSON-RPC over stdio）——微型设备开销大；
2. isolated-vm（in-process V8）——隔离原语但不是安全边界（CVE 2021/2022/2023/2026 逃逸史、V8 Sandbox 未完成）；
3. Deno 运行时——权限模型不是边界（CVE 证据），npm 兼容"开发期友好、离线 vendored 不成熟"（denoland/deno #19740、#24322）；
4. **QuickJS + ESM-only**——真沙箱（解释器无 JIT）、微设备友好（~1MB）、依赖图静态可审计；
5. 能力收编：插件需要 node API 的能力（db/ssh/docker）→ 由**核心侧的能力插件**提供审核过的接口，沙箱插件只调 `@host/api`。

## 决策

### 1. 核心语言：Node.js（修订 ADR-002 v1 的 Go）

核心提供 node API 能力是能力插件机制的基础；单一语言栈（核心/SDK/插件同为 TS）把插件门槛降到最低。详见 ADR-002 v2。

### 2. 默认插件运行时：QuickJS

- 形态：**quickjs-emscripten（WASM 版，进程内）**为默认（无 cgo、双保险：解释器 + WASM 线性内存隔离、微设备友好）；**原生 QuickJS 子进程**为隔离增强档（第三方插件）。
- 理由：无 JIT → 攻击面比 V8 小一个量级，是当前可选 JS 运行时里**最接近安全边界**的一个；ESM 模块加载；注入什么就是什么（无 require/process 可绕）。
- 诚实备注：解释器不是零漏洞（有 CVE/fuzz 崩溃史）；注入面极小 + 持续跟进修复。

### 3. 能力插件机制（特权档，非沙箱）

- 能力插件跑在**核心侧**（或独立 Node 进程），拥有 node API，**自己引驱动**（pg/mysql2/ioredis 等）；
- 经核心的 **API 扩展注册点**注册 `@host/api/db` 等方法，走**同一套权限注册表（D4）+ 网关强制检查（D3）+ 审计**；
- **核心不内置任何领域 API**（数据库、SSH、Docker 客户端等一律由能力插件提供）；
- 能力插件必须是官方签名 + 特权档，每个注册的方法过威胁建模评审。

### 4. ESM-only（全后端统一）

- 插件 = ESM；禁 CommonJS。理由：import/export 静态可分析 → 依赖图可审计；无 CJS 动态 require 绕过面；与现代生态一致（npm 正经历 [CJS→ESM 大迁移](https://www.pkgpulse.com/guides/great-migration-cjs-to-esm-npm-ecosystem-2026)）。
- 注意：ESM 解决"格式"不解决"API"——沙箱插件仍无 node API，需要能力时走 `@host/api`。

### 5. 模块表面契约（Module Surface Contract）

**注入面 = 安全边界**（沙箱里插件只能碰到注入的东西）：

- 显式声明"提供哪些标准模块子集"与"明确拦截哪些"（QuickJS 里本无 require/process，注入什么就是什么）；
- 能力类操作（exec/网络/pty）不走沙箱内实现，只走 `@host/api` 模板；
- 第一版表面最小化：`@host/api`（exec 模板、fs、kv、timers、events）+ 纯计算 ESM 依赖白名单；不提供 net 裸 socket、子进程、原生模块。

### 6. 构建层 hook（编译期不可达）—— 依赖管控的执行点

- 插件发布走构建流水线：依赖图静态解析 → 白名单校验（禁原生模块、禁禁用模块）→ esbuild 打包成**单文件 ESM bundle** → 签名（manifest + bundle 哈希）；
- 禁用的模块在编译期解析失败，**恶意代码根本构建不出来**；动态 require 被拒绝 → 依赖图永远完整可审计；
- 供应链配套：lockfile 锁定 + [OSV 漏洞扫描](https://osv.dev) + 最小依赖年龄策略；
- 官方档 = 平台构建；第三方档 = 自构建 + 可复现验证（同输入同输出比对哈希）。

### 7. 依赖三层

| 层 | 依赖 | 决策者 | 机制 |
|---|---|---|---|
| L1 白名单 | 宿主 curated 纯 JS ESM 包（协议/计算类） | 平台 | 构建层托管：锁定版本 + 签名 + 离线 bundle |
| L2 用户放行 | 白名单外纯 JS 包 | 用户 | 安装时风险提示 + 显式勾选 + 审计；按"插件+版本"生效，更新需重新确认 |
| L3 禁区 | 原生模块（.node）、重型二进制 | 平台强制 | 技术原因（沙箱跑不了）；能力由宿主 API/能力插件提供 |

### 8. 分层 hook 组合

| 档位 | hook 组合 | 兜底 |
|---|---|---|
| QuickJS（进程内，默认） | ③构建层 + ①注入层 | 无内核层（进程内）→ 靠"无注入=无能力" + QuickJS 攻击面小 |
| 原生 QuickJS 子进程（第三方档） | ③ + ① + **⑤内核层（Landlock/seccomp）** | 内核层兜底，逃逸最多伤插件进程 |

### 9. 通信协议

- **主通道**：进程内 `@host/api` 模块注入（函数调用，µs 级）；
- **次通道**：stdio JSON-RPC（子进程档/能力插件），**同一套方法签名 + JSON Schema 校验 + 错误码**；
- 版本协商 `lifecycle.version`，契约 semver（详见 api-contract v0.2）。

### 10. 核心第一版审计焦点：exec + fs

核心第一版只做两个危险接口的审计设计（最危险、最基础设施、最难），领域能力全部外置：

- **exec 模板**：白名单 + 参数枚举/正则 + 输出限制 + 超时；
- **fs 路径收敛**：realpath + 符号链接检查 + `..` 防逃逸 + 大小限制。
- 详细规范与威胁建模清单见 **interface-audit-exec-fs.md**。

## 证据

- isolated-vm 逃逸史：[CVE-2021-21413](https://www.acunetix.com/vulnerabilities/sca/cve-2021-21413-vulnerability-in-npm-package-isolated-vm/)、[CVE-2022-39266](https://www.acunetix.com/vulnerabilities/sca/cve-2022-39266-vulnerability-in-npm-package-isolated-vm/)、CVE-2023-29199（堆溢出 RCE）、[2026 GHSA-864f Type Confusion](https://compliancehub.wiki/isolated-vm-sandbox-escape-ghsa-864f-ai-agent-code-execution-governance-2026/)；
- [V8 Sandbox 未完成](https://issues.chromium.org/issues/390453039)（V8 本身不是内存安全边界）；
- Deno npm 离线 vendored 缺口：[#19740](https://github.com/denoland/deno/issues/19740)、[#24322](https://github.com/denoland/deno/issues/24322)；
- 三开源项目权限研究结论（D1–D10 设计决策）已内化于 api-contract.md 与相关 ADR。

## 后果

- SDK 需提供：`@host/api` 类型声明、esbuild 构建模板（ESM-only + 白名单）、manifest 校验器；
- 核心需实现：基础宿主 API、**API 扩展注册点**、权限注册表、审计、QuickJS 沙箱宿主；
- 面板插件与示例插件按新协议（进程内注入）编写；
- 微型设备无需额外档位（QuickJS 资源占用极小）。

## 遗留待办

1. QuickJS 性能 benchmark（典型插件负载：JSON/正则/宿主 API 往返）验证"薄适配器无感"假设；
2. 能力插件第一版候选：db（pg/mysql2）——核心只提供扩展点；
3. exec 模板第一版：nginx reload/test、git pull（repo 白名单）、psql/mysql（凭据走环境变量）。
