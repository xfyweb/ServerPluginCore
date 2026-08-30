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

我们不做"功能堆砌的一体化面板"：很多功能你可能永远用不到，界面却为它们腾出了位置。**ServerPluginCore 的 Web 面板本身也只是一个默认内置的插件**——禁用它，一切操作回到命令行，干净利落。

## ✨ 核心特性

- 🧩 **一切皆插件**：核心不实现任何业务功能；面板、监控、文件管理……都是插件，连 Web UI 本身都是
- 🛡️ **零环境权力沙箱**：插件运行在 QuickJS 沙箱中，只能调用宿主审核过的 API，**无法直接接触操作系统**——安全边界是"接口审计"，不是"事后隔离"
- 🔑 **信任双档**：官方市场插件经审核签名验证，也可自行安装第三方插件，所有插件均由权限系统完成操作审查
- 📦 **能力插件机制**：数据库、SSH 等协议能力由**能力插件**提供并注册进宿主 API——核心保持最小
- 📦 **能力插件机制**：数据库、SSH 等协议能力由**能力插件**提供并注册进宿主 API——核心保持最小
- 🚀 **轻量**：Node 核心 + QuickJS 沙箱（~1MB），资源占用可运行在微型设备上

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────┐
│  Node Core（无头，非 root 运行）                       │
│  auth/RBAC/audit · 插件生命周期 · CLI · 资源限制       │
│  基础宿主 API（exec模板/fs/kv/timers）· 权限注册表      │
│  【API 扩展注册点】←─ 能力插件注册 @host/api/db 等       │
└───────────┬─────────────────────────────────────────┘
            │ 进程内注入 @host/api（QuickJS 沙箱）
┌───────────▼──────────┐   ┌───────────▼──────────────┐
│ QuickJS 沙箱：普通插件 │   │ 能力插件（特权档，核心侧）  │
│ ESM bundle · 零依赖   │   │ 引 pg/mysql2 等驱动       │
│ 只调 @host/api        │   │ 实现并注册领域能力         │
└──────────────────────┘   └──────────────────────────┘
```

- **插件**：ESM bundle + manifest（声明权限与能力），运行在 QuickJS 沙箱内，只调注入的 `@host/api`；
- **能力插件**（特权档）：拥有 Node API，实现数据库/SSH/Docker 等协议能力，经扩展注册点注册，走同一套权限与审计；
- **安全模型**：插件不碰 OS → 接口审查成为安全工程中心；宿主侧强制检查权限声明（三态判定 + 双档画像），每个调用落审计。

## 📦 插件分类（规划）

| 类别 | 职责 | 示例 |
|---|---|---|
| **面板类** | 提供统一前端设计系统（按钮/输入框等组件），供其他插件挂载 | panel（默认内置） |
| **数据类** | 采集数据并输出小组件，挂载到面板类的自定义页面 | monitor、nginx 状态 |
| **管理类** | 执行命令、管理文件等操作型能力，自建前端模块由核心分发、面板类组件保证风格统一 | docker、files、backup |

## 📚 文档

**架构决策（ADR）与契约**：

| 文档 | 内容 |
|---|---|
| [ADR-001](docs/ADR-001-plugin-trust-model.md) | 信任模型：零环境权力 + 双档信任 + 签名链 |
| [ADR-002](docs/ADR-002-core-and-runtime.md) | 核心与运行时选型（Node 核心 + QuickJS 沙箱，跨平台） |
| [ADR-003](docs/ADR-003-market-openness.md) | 市场开源决策：代码全开、密钥全闭 |
| [ADR-004](docs/ADR-004-os-boundary.md) | OS 底线：非 root + 资源限制 |
| [ADR-005](docs/ADR-005-plugin-sandbox-and-capability-plugins.md) | 插件沙箱与能力插件机制 |
| [宿主 API 契约](docs/api-contract.md) | 双通道传输、方法组、权限注册表、manifest schema 2 |
| [接口审计：exec + fs](docs/interface-audit-exec-fs.md) | 危险接口威胁建模清单（P1 验收依据） |
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
| P2 | 构建层与依赖三层 + 事件总线 + 能力插件扩展点 | 待定 |
| P3 | 面板插件 + 前端运行时加载 | 待定 |
| P4 | 签名与插件市场（双档落地） | 待定 |
| P5 | 核心插件集 + 加固 + v1.0 发布 | 待定 |


## 📄 许可证

MIT License

---

*受 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件化哲学启发；安全模型参考了 Velocity / Paper / AstrBot 等开源项目的权限设计经验。*

*Author: [xfy2412](https://github.com/xfy2412)*

*本项目由AI协助开发*