<!-- markdownlint-disable MD033 -->

<div align="center">

# 🧩 ServerPluginCore

### 插件化服务器管理核心 —— *本体最小，能力全插件化*

[![Stars](https://img.shields.io/github/stars/xfy2412/ServerPluginCore?label=Stars)](https://github.com/xfy2412/ServerPluginCore)
[![Release](https://img.shields.io/github/v/release/xfy2412/ServerPluginCore?label=Release)](https://github.com/xfy2412/ServerPluginCore/releases)

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![QuickJS](https://img.shields.io/badge/QuickJS-FFD700?logo=javascript&logoColor=black)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen)](https://github.com/xfy2412/ServerPluginCore/pulls)
![License](https://img.shields.io/badge/License-MIT-yellow)

</div>

ServerPluginCore 是一个**插件化的服务器管理平台核心**。它受 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的启发：**本体只做最少的事，一切能力由插件提供**——认证、权限、审计、插件生命周期，仅此而已。

我们不做"功能堆砌的一体化面板"：很多功能你可能永远用不到，界面却为它们腾出了位置。一切功能都由插件提供，按需加载功能和页面，甚至**面板本身只是一个默认内置的插件**（面板插件，可整体卸载）——禁用它，一切操作回到命令行，干净利落。

## ✨ 核心特性

- 🧩 **一切皆插件**：核心不实现任何业务功能；面板、监控、文件管理……都是插件，连 Web UI 本身都是
- 🛡️ **零环境权力沙箱**：插件运行在 QuickJS 沙箱中，只能调用宿主审核过的 API，**无法直接接触操作系统**——安全边界是"接口审计"，不是"事后隔离"
- 🔑 **市场签名 + 源**：包由**市场**签名（不是开发者），信任根是管理员自己的 keyring（以域名为主键，公钥可远程 TOFU 拉取或离线手填）；本地安装不验签，装进来的插件标记为**无更新渠道**。所有调用的审查由权限系统完成（声明 + 逐点授予）
- 📦 **四类插件**：面板插件（Web 壳与组件库）、能力插件（沙箱内管理界面）、驱动插件（核心端领域能力，严审）、协作插件（事件钩子，设计中）
- 📦 **驱动插件机制**：数据库、SSH 等协议能力由**驱动插件**（核心端特权）注册进宿主 API；沙箱内的**能力插件**经 `@host/api` 调用——核心保持最小
- 🚀 **轻量**：Node 核心 + QuickJS 沙箱（~1MB），资源占用可运行在微型设备上

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────┐
│  Node Core（无头，非 root 运行）                       │
│  auth/RBAC/audit · 插件生命周期 · CLI · 资源限制       │
│  基础宿主 API（exec模板/fs/kv/timers）· 权限注册表      │
│  【API 扩展注册点】←─ 驱动插件注册 @host/api/db 等       │
└───────────┬─────────────────────────────────────────┘
            │ 进程内注入 @host/api（QuickJS 沙箱）
┌───────────▼──────────┐   ┌───────────▼──────────────┐
│ QuickJS 沙箱：能力插件 │   │ 驱动插件（特权档，核心侧）  │
│ ESM bundle · 零依赖   │   │ 引 pg/mysql2 等驱动       │
│ 只调 @host/api        │   │ 注册端点并自行鉴权         │
└──────────────────────┘   └──────────────────────────┘
```

- **面板插件**（panel，内置可卸载）：构建 Web 前端页面并提供**组件库**，其他插件按统一规范挂载页面、使用组件；不想要面板可整体禁用/删除，一切管理回到 CLI；
- **能力插件**（ability）：ESM bundle + manifest（声明权限与能力），运行在 QuickJS 沙箱内，在面板挂载页面提供管理能力，只调注入的 `@host/api`；
- **驱动插件**（driver，特权档）：运行在核心端，拥有 Node API、可下载自己的依赖，实现数据库/SSH/Docker 等协议能力，经扩展注册点注册**权限节点 + API 端点**暴露给沙箱，并按面板给的权限列表自行鉴权；
- **协作插件**（hook，设计中）：通过钩子参与核心事件生命周期并干预/修改；运行位置（核心/沙箱）与默认权限（网络/文件）待 ADR 定稿；
- **安全模型**：插件不碰 OS → 接口审查成为安全工程中心；宿主侧强制检查权限声明（三态判定 + `scope` 规则 + 管理员逐点授予），每个调用落审计。

## 📦 插件类型

| 类型 | 运行位置 | 职责 | 示例 | 信任/分发 |
|---|---|---|---|---|
| **面板插件** `panel` | 前端（宿主侧） | 构建 Web 壳与页面、提供**组件库**，其他插件按统一规范挂载页面、使用组件 | panel（内置，可卸载） | 内置 |
| **能力插件** `ability` | QuickJS **沙箱** | 挂载管理页面并提供管理能力（文件管理、远程终端…） | files、terminal | 常规 |
| **驱动插件** `driver` | **核心端** | 注册权限节点 + API 端点暴露给沙箱、自行鉴权；可下载依赖 | db（pg/mysql2）、ssh | **独立安装界面 + 最高强度提示**（不限制来源） |
| **协作插件** `hook` | **设计中**（核心/沙箱） | 钩子触发逻辑，参与核心事件生命周期并干预/修改 | 审计、流控（规划） | 设计中 |

> 关系一句话：面板提供舞台（页面 + 组件），能力插件在沙箱里演、经 `@host/api` 调驱动插件注入的端点，驱动插件在核心侧提供道具并自行鉴权，协作插件在幕后改剧本（位置/权限待定）。

## 📚 文档

**架构决策（ADR）与契约**：

| 文档 | 内容 |
|---|---|
| [ADR-001](docs/ADR-001-plugin-trust-model.md) | 信任模型：零环境权力 + 市场签名（来源只管更新渠道） |
| [ADR-002](docs/ADR-002-core-and-runtime.md) | 核心与运行时选型（Node 核心 + QuickJS 沙箱，跨平台） |
| [ADR-003](docs/ADR-003-market-openness.md) | 市场开源决策：代码全开、密钥全闭 |
| [ADR-004](docs/ADR-004-os-boundary.md) | OS 底线：非 root + 资源限制 |
| [ADR-005](docs/ADR-005-plugin-sandbox-and-plugin-types.md) | 插件沙箱与四类插件机制（面板/能力/驱动/协作） |
| [宿主 API 契约](docs/api-contract.md) | 双通道传输、方法组、权限注册表、manifest schema 2 |
| [签名与源设计](docs/plugin-signature-design.md) | 元数据结构、规范化签名、keyring 与源、链式密钥轮换、校验流程与错误码（P4） |
| [市场授权设计](docs/market-license-design.md) | 永久授权 + 维护窗口、下载控制面（P4 付费市场基线） |
| [接口审计：exec + fs](docs/interface-audit-exec-fs.md) | 危险接口威胁建模清单（P1 验收依据） |
| [exec 沙箱与模板注册制](docs/exec-sandbox-design.md) | 模板三方来源与命名空间、双层安全模型、E1–E10、系统级沙箱（P1/P2） |
| [官方模块仿真](docs/module-emulation-design.md) | Node 写法兼容（node:fs/path/…）、兼容性天花板、错误码 errno 映射、构建期校验（P2） |
| [开发路线](docs/ROADMAP.md) | P0–P5 阶段规划 |

**记录**：

- [Spike 记录：QuickJS 沙箱可行性验证](docs/spike-01-quickjs-sandbox.md)——核心链路验证 + 上游 bug（quickjs-emscripten#261）排查与 pnpm 补丁记录
- [manifest 设计](docs/manifest-design.md)（Android 权限系统参考）

## 🚀 快速开始

> ⚠️ 项目处于**核心链路验证完成（spike）、P1 待开工**阶段。当前可运行：
> ```bash
> pnpm install
> pnpm spike              # 运行样板插件（沙箱 → @host/api → 写入 ~/test.txt）
> pnpm verify:sandbox     # 验证 quickjs-emscripten 补丁有效性（8/8 用例）
> ```
> 注意：本项目使用 **pnpm** 作为包管理器（patchedDependencies 依赖 pnpm 机制）。

## 🗺️ 开发路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 宿主 API 契约定稿（exec/fs/kv/timers + 权限注册表 + manifest schema） | 规划完成 |
| P1 | 纵向切片：Node 核心 + QuickJS 沙箱 + exec/fs 接口审计 | **待开工** |
| P2 | 构建层与依赖三层 + 事件总线 + 驱动插件扩展点 | 待定 |
| P3 | 面板插件 + 前端运行时加载 | 待定 |
| P4 | 市场签名与源管理 + 插件市场 | 待定 |
| P5 | 核心插件集 + 加固 + v1.0 发布 | 待定 |


## 📄 许可证

MIT License

---

*受 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件化哲学启发；安全模型参考了 Velocity / Paper / AstrBot 等开源项目的权限设计经验。命令执行模块参考了 MCSManager 开源项目的设计经验，在此对全体开源项目贡献者致谢！*

*Author: [xfy2412](https://github.com/xfy2412)*

*本项目由AI协助开发*