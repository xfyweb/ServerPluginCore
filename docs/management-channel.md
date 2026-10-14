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
| `/api/status` | GET | 核心健康、版本（`version`）、**契约版本（`contract`）** |
| `/api/plugins` | GET | 插件列表（记录驱动：state/grants/capabilities，不是扫目录） |
| `/api/sources` | GET | 来源（keyring）清单：kind / alias / 启停 / 暂停 / 指纹 / 作者锚 / 已装个数 |
| `/api/sources/{add,remove,enable,disable,alias,anchor}` | POST | 来源管理（`add` 不带 `pub` ⇒ 远程 TOFU 拉取状态文档；`anchor` 不带 `pub` ⇒ 解绑锚） |
| `/api/plugins/reanchor[/plan]` | POST | **换源（搬家）**：`/plan` 是只读预检、执行在锁内重算（TOCTOU）；`refs` 走 body（完整引用含 `@` 与 `/`，塞 URL 只会自找编码麻烦） |
| `/api/audit?tail=N` | GET | 审计日志尾部（2026-10-14 落地）。过滤器：`plugin`（**完整引用或裸 id**，与其它管理命令同一套解析；匹配 `actor.ref` **或** `subject.ref`）/ `method` / `result` / **`actor`（plugin/operator/core）** / **`via`（cli/console/internal）**；`tail` 与 `limit` 同义（前者是最早写进契约的名字，**只增不改**）。**尾部读**：最多读文件末尾 1 MiB（审计文件只增不减），从中间截断时的半行丢掉并计进 `skipped`，坏行同样计数 —— 不让一行坏数据把读面打哑。**游标是字节偏移**（入 `since` / 出 `nextOffset`）：审计文件**只追加**，偏移是稳定游标；**不能用时间戳**（同一毫秒可以有多条，续读会漏会重）。`spc audit tail -f` 就是按它每 500ms 轮询（**不引 SSE**：多一条通道就多一处要维护的语义） |
| `/api/logs?limit=N` | GET | **插件日志**（2026-10-14 落地；内存环形的读面，见 `core/logs.ts`）。过滤器：`plugin`（同上）/ `level`（**至少**该等级）/ `since`（游标，**用 `seq` 不用时间戳** —— 同一毫秒可以有多条）。响应带 `nextSeq` 与 `dropped`（被环形淘汰掉的条数），让调用方说得出"窗口之前有缺口"。`spc log -f` 同样按游标轮询 |
| `/api/daemon/shutdown` | POST | **优雅停机**（2026-09-23）：先回 200，再异步走完整停机路径 |

> **停机契约**（`POST /api/daemon/shutdown` 与 `SIGINT`/`SIGTERM` 走**同一条**路径，退出码是契约）：
> ① 不再接新请求 + **主动断开空闲连接**（`server.closeIdleConnections()` —— 只 `server.close()` 会等
> keep-alive 连接自然断开，那正是"Ctrl+C 退不掉、只能强杀 255"的根因）；
> ② `stopAll('shutdown', { budgetMs })`：每个插件的 stop 预算被压成 `min(自己的 stopTimeoutMs, 剩余总预算)`
> （插件 `stop` 里的死循环会**同步阻塞宿主**，全局定时器轮不上，只能在进沙箱前压预算）；
> ③ 落一条 `core.shutdown` 审计（actor = `<core>`）+ flush 审计缓冲，然后退出。
> **退出码**：优雅停完 = `0`；第二次信号 = `130`；停机超时兜底 = `124`；停机自身出错 = `1`。
> CLI 入口：**`spc daemon stop`**（Windows 上这是唯一优雅的停法：Ctrl+C 只对前台控制台有效、`taskkill` 是硬杀）。
> **前台控制台**（2026-10-13 加）：在**真终端**里直接跑核心时，stdin 上挂一个控制台：
> `status` / `list` / **`show <引用>`**（单个插件的详情：声明 / 已授予 / **未授予**的权限点）/ `stop`，外加**插件生命周期** —— `install <目录|.spc 文件>` / `uninstall <引用>` /
> `reload <引用>` / `enable|disable <引用>`（`stop` 走的就是上面这条 `shutdown()` 路径，reason = `console`）。
> 它是**唯一不需要信号**的停机方式 —— 绕开"Windows 上 Ctrl+C 要过 cmd / pm2 那几层"。
>
> **语法三规矩**：① **扁平**（这里是 `install <目录>`，CLI 是 `spc plugin install <目录>`）；
> ② 旗标与 `spc` **同名同义**（`--source` / `--grant` / `--accept-key-change`），**不新增** `spc` 里没有的东西；
> ③ **语义与审计复用 manager** —— 与 CLI 走 HTTP 最终落到的是**同一批方法**（审计写在 manager 层），
> 所以这里没有第二份实现，只是换了个传输；错误也走 `core/i18n` 同一套渲染。
> 不认识的旗标、多余的参数一律拒（fail-closed）：`--sorce` 被忽略就会按缺省源装错桶，而"装错桶"在
> 身份模型（`(origin, id)`）里等于装成了**另一个插件**。
>
> ⚠️ **只在 stdin 是 TTY 时挂**（`cli-contract.md` §3「非 TTY 不猜」）：pm2 / systemd / 管道下**连 stdin 都不碰**；
> stdin 被关闭 = 终端没了 ⇒ **只摘控制台，不停机**。**作者工具不进**（`keygen` / `new` / `build` / `pack`）；
> **客户端专属不进**（`--json` / 退出码 / `about`）。
> 超时可用 `SPC_SHUTDOWN_TIMEOUT_MS` 覆盖（默认 10s）。

插件的 `plugin` 参数是**引用**：完整引用 / 裸 `@作者/名字` / 裸名字都能用（**只要没有歧义**；不唯一报 409 的
`PLUGIN_REF_AMBIGUOUS`，见 api-contract.md「引用的缩写阶梯」）。

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
