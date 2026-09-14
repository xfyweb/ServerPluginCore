# 管理面通道设计（CLI ↔ 核心守护进程）

- 状态：**已接受（第一版）**
- 关联：ROADMAP P1（管理面通道）、ADR-002（无头核心）、ADR-005（插件面通道）

## 1. 定位

两套通道的分工：

| 通道 | 通信双方 | 协议 | 状态 |
|---|---|---|---|
| **插件面** | 核心 ↔ QuickJS 沙箱 | `@host/api` 注入 / JSON-RPC 次通道 | 已设计（api-contract） |
| **管理面** | 核心 daemon ↔ CLI / Web 面板 | **本设计**：HTTP over 平台传输 | 本设计 |

核心为常驻 daemon；CLI 与 Web 面板都是客户端（CLI = 无 UI 的面板）。

## 2. Transport 抽象（平台分发）

```
核心侧 ServerTransport / 客户端侧 ClientTransport
    ├── TcpTransport        # 127.0.0.1:<port>（第一版，跨平台统一）
    ├── UnixSocketTransport # Linux UDS（增强，后置）+ SO_PEERCRED 身份背书
    └── NamedPipeTransport  # Windows \\.\pipe\spc（增强，后置）
```

实现要点：

- Node `http server.listen(path)`：Linux 自动创建 UDS，Windows 自动创建命名管道——**平台实现成本≈零**；
- 工厂按 `process.platform` 分发，第一版全部走 TcpTransport，抽象层预留平台实现；
- HTTP 应用层协议（REST）在所有 Transport 上一致。

## 3. 鉴权：ed25519 临时密钥挑战握手（第一版）

### 3.1 为什么不用静态 token

| 威胁 | 静态 token | 临时密钥方案 |
|---|---|---|
| token 泄露长期有效 | ❌ 手动轮换 | ✅ **重启即失效**（每次启动新密钥） |
| 假冒 daemon 钓鱼 | ❌ 无防护 | ✅ CLI 验签确认 daemon 身份 |
| 重放攻击 | ❌ | ✅ 一次性 challenge（nonce） |
| 私钥被读走 | token 文件可读 | ✅ **私钥仅内存，不落盘** |

### 3.2 握手协议（三步）

```
daemon 启动：
  生成临时 ed25519 密钥对（crypto.generateKeyPairSync('ed25519')）
  私钥只存内存；公钥写 <runtime-dir>/pubkey（644，公钥公开）

CLI:
  ① GET  /auth/handshake
     → { challenge: <random nonce>, signature: <daemon 私钥签名>, pubkey }
  ② CLI 用 pubkey 验签 ✅ 确认对面是真正的 daemon
  ③ POST /auth/session { challenge }
     → daemon 校验 challenge 未使用过（一次性）→ 签发短时会话 token
  ④ 后续请求：Authorization: Bearer <session-token>
```

- 算法：**ed25519**（非 RSA——生成微秒级、密钥 32B、与插件市场签名体系一致，见 plugin-signature-design.md）；
- 会话 token：短时（如 5 分钟）+ 重启失效；daemon 重启后所有旧 token/challenge 作废；
- 防重放：challenge 一次性（daemon 记录已用 nonce，重启清空）。

### 3.3 身份边界说明

本机 CLI 场景：

- **谁能用 CLI** = 谁能读 `pubkey` 文件 / 谁能连上本机 daemon（文件权限 600 的 runtime 目录）；
- **谁是 daemon** = 握手验签（防假冒）；
- **传输加密不需要**：127.0.0.1/UDS 流量不出本机，能监听本机流量的攻击者基本也能读文件——别上 TLS（远程场景才需要）；
- **CLI 的职责范围**：只做**插件与主题管理**（安装/启停/授权/状态/审计查看），**不承载业务操作**——业务操作是用户意图，走核心前端与前端 API（见 intent-capture.md §10）；未来的 TUI 复用前端通道。

## 4. 管理 API（REST，第一版最小集）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/status` | GET | 核心健康、版本、契约版本 |
| `/api/plugins` | GET | 插件列表（扫描插件目录 + manifest 校验结果） |
| `/api/audit?tail=N` | GET | 审计日志尾部 |

后续：`/api/plugins/{id}`（enable/disable/install）、面板专用端点（P3）。

### 4.1 响应与错误（全英文码，无本地化文本）

- 成功：直接返回数据对象；
- 失败：`{ "error": "<顶层码>", "detail": { "code": "<领域码>", "params": { … } } }`（契约见 api-contract §2）；
- **本地化不经过本通道**：CLI 是本地化渲染点（`t()` / `tError()`）；面板（P3）自行请求 locale 文件，在**前端渲染层**翻译。

### 4.2 locale 分发（P3）

- 核心把 locale 作为静态资源暴露（如 `GET /i18n/<locale>.json`，随核心构建产物版本化）；
- 命名空间：`core.*`（核心错误码 `err.<code>` 与通用文案）/ `<pluginId>.*`（插件自带文案，随插件包分发；键前缀就是插件 ID 原样，如 `@xfy2412/docker.*`）；
- 面板启动时按 `SPC_LANG` 或浏览器语言拉取并缓存；缺 key 时回退到英文码（不回退到空文案）。

## 5. 运行目录与配置

```
<runtime-dir>/        # 默认 ~/.spc（开发）/ /var/run/spc（生产，属主 spc）
├── pubkey            # daemon 公钥（握手用）
└── state/            # 插件状态、kv、审计（P1 后续）
```

- 端口：第一版固定（配置项），后续可随机端口 + runtime-dir 写 `port` 文件；
- 非 root fail-closed：daemon 检测 `uid === 0` → 拒绝启动（ADR-004）。

## 6. 平台特性增强（后置，不阻塞第一版）

| 特性 | 平台 | 内容 |
|---|---|---|
| UDS + SO_PEERCRED | Linux | 内核背书对端 uid，替代"读 pubkey 文件"的身份边界 |
| 命名管道 | Windows | 走 Transport 抽象，协议不变 |
| 会话续期/撤销 | 全平台 | RBAC 落地面（P3 面板）后细化 |
