# 宿主 API 契约（v0.2）

> 依据：ADR-001（零环境权力）、ADR-005（QuickJS 沙箱 + 能力插件）、manifest-design.md（schema 2）、permission-research.md（D1–D10）。
> v0.2 变更：传输模型从"JSON-RPC over stdio"改为**进程内 `@host/api` 注入为主**（QuickJS 沙箱），stdio JSON-RPC 降级为子进程档次通道；新增权限注册表、事件推送、API 扩展注册点。

## 1. 传输模型（双通道，同一套方法签名）

| 通道 | 适用 | 形态 | 说明 |
|---|---|---|---|
| **主通道** | QuickJS 沙箱（默认档） | 进程内 `@host/api` 模块注入（函数调用） | 插件 `import { fs, exec } from '@host/api'`；µs 级调用；注入即能力 |
| **次通道** | 子进程档（第三方隔离档）/ 能力插件 | stdio JSON-RPC 2.0 | 与主通道**共用同一套方法签名、参数 schema、错误码**，仅传输不同 |

- **版本协商**：`lifecycle.version`（核心返回契约版本，插件 SDK 校验兼容）；契约按 semver 演进，破坏性变更走废弃期；
- 沙箱插件**只能**通过注入拿到 `@host/api`；子进程档插件通过 RPC 信封拿同一组方法。

## 2. 调用约定

- 每个方法有 JSON Schema 参数校验（宿主侧执行，跨通道共用一份 schema）；
- 错误码规范：`PERMISSION_DENIED` / `INVALID_ARGS` / `NOT_FOUND` / `TIMEOUT` / `INTERNAL` / `CONTRACT_MISMATCH`；
- 超时与并发上限宿主侧强制（防失控，不防恶意）。

## 3. 事件推送（宿主 → 插件，反向通道）

- 事件总线：插件在 manifest `exports.events.subscribe` **显式声明**订阅的 topic；
- 宿主推送（进程内：注入的回调；子进程：RPC notification）；
- topic 授权：**枚举声明，无通配**（manifest-design 要点 6）；发布同样显式声明 `exports.events.publish`；
- 典型事件：`docker.container.crash`、`backup.done`、`timers.fired`。

## 4. 方法组（核心第一版）

| 方法组 | 方法 | 权限点 | 说明 |
|---|---|---|---|
| **exec（模板）** | `exec.runTemplate` | `exec.template.<action>.<op>` | **无自由命令**，仅模板 + 参数校验（详 §5） |
| **fs（受限）** | `fs.read` `fs.write` `fs.list` `fs.stat` | `fs.read.<scope>` `fs.write.<scope>` | 路径收敛 + realpath（详 §5） |
| **kv** | `kv.get` `kv.set` `kv.delete` | `kv.<namespace>` | 插件作用域持久化存储 |
| **timers** | `timers.every` `timers.cron` | `timers.schedule` | 宿主侧调度，插件不保活 |
| **events** | `events.publish`（订阅走 manifest 声明） | `events.<topic>` | §3 |
| **lifecycle** | `lifecycle.health` `lifecycle.version` | 自动授予 | 心跳、契约协商 |
| **audit** | （无需插件调用） | — | 宿主对每个调用落审计（§8） |

**核心不提供**（由能力插件经扩展注册点提供，见 §10）：db 连接代理、SSH、Docker 客户端、net 裸 socket、pty、媒体处理。

## 5. 危险原语策略

**exec 模板**（核心第一版审计焦点，详细规范见 interface-audit-exec-fs.md）：
- 模板注册表（核心侧）：`{action, op, paramsSchema}`；参数用枚举/正则/白名单校验；
- 命令构造禁止字符串拼接用户输入（数组传参）；凭据禁明文 `-p`，走 `MYSQL_PWD`/`--defaults-extra-file`（chmod 600，用完即删）；
- 输出大小限制、超时、工作目录固定、环境变量白名单；
- 第一版模板：nginx（reload/test）、git（pull，repo 白名单）、psql/mysql（凭据走环境）。

**fs 路径收敛**：
- 所有路径 `realpath` 规范化后校验前缀；拒绝符号链接逃逸、`..`、特殊文件（/dev、/proc、socket）；
- 写操作默认只落插件数据目录；大小限制、文件类型白名单；
- 详细威胁建模清单见 interface-audit-exec-fs.md。

## 6. 权限注册表（D4，核心侧集中登记）

每个权限点一条记录：

```json
{
  "name": "docker.write",
  "group": "docker",
  "description": "修改容器配置",
  "protectionLevel": "dangerous",   // normal | dangerous | signature
  "defaults": { "official": "allow", "thirdparty": "deny" }
}
```

- **protectionLevel**（Android 参考，manifest-design）：
  - `normal`：官方档自动授予（docker.read、fs.read.data）；
  - `dangerous`：第三方档需安装确认 + 降级映射（docker.write、exec 模板）；
  - `signature`：仅官方签名插件可申请（任意 fs 读写、secrets），第三方声明即无效。
- 注册表是审计、管理 UI、测试、能力插件枚举的单一事实源。

## 7. 权限判定（三态 + 匹配算法）

- 判定结果：`ALLOW / DENY / UNSET→DENY`（Velocity Tristate 模式，未设置 = 拒绝）；
- 匹配：精确 > 前缀通配（`docker.*`）> `*`；**显式 DENY 优先于任何授予**；
- 插件 manifest 声明的是"请求"（uses-permission），宿主双档画像才是"批准"（请求/批准分离，Android 模型）。

## 8. 审计

每条调用落：`{ts, pluginId, method, paramsDigest, result, permission: {decision, reason}}`——审计日志只增不改，插件不可达；权限拒绝单独告警。

## 9. manifest（schema 2）

完整设计见 manifest-design.md，要点（与旧 schema 1 的差异）：

```json
{
  "schema": 2,
  "id": "official:docker",
  "name": "Docker Management",
  "version": { "code": 12, "name": "1.2.0" },
  "compat": { "minCore": "0.1.0", "targetCore": "0.3.0" },
  "runtime": { "type": "quickjs", "esm": true },
  "permissions": [ { "name": "docker.read", "reason": "列出容器与镜像" } ],
  "exports": {
    "webApis": [ { "path": "/api/docker/containers", "permission": "docker.read" } ],
    "routes": [ { "path": "/docker", "title": "Docker", "icon": "container" } ],
    "events": { "publish": ["backup.done"], "subscribe": ["docker.container.crash"] }
  },
  "dependencies": { "npm": [ { "name": "zod", "version": "3.x", "tier": "whitelist" } ], "plugins": [] },
  "signature": { "algorithm": "ed25519", "keyId": "official-2026", "digest": "...", "sig": "..." }
}
```

- `permissions` 必填（无默认放行，permission-research 共识 3）；
- `dependencies.npm.tier`：`whitelist`（L1，平台托管）/ `user-opt-in`（L2，需用户放行）；原生模块与重型二进制不进此表（L3 禁区）；
- `runtime.type`：`quickjs`（默认）| `node-child`（子进程档）；ESM-only 全后端统一。

## 10. API 扩展注册点（能力插件机制）

核心提供注册协议，让**特权能力插件**扩展 `@host/api`：

```
注册请求：{ capability: "db", methods: [{ name: "query", schema, permission: "db.query" }] }
```

- 能力插件必须：官方签名 + 特权档（跑在核心侧/独立 Node 进程，拥有 node API）；
- 每个注册方法：进权限注册表（D4）、过威胁建模评审、随核心一起审计；
- 普通沙箱插件通过 `import { db } from '@host/api/db'` 调用，**与基础 API 无感知差异**。

## 11. 待定项（v0.3 再议）

1. 事件总线 topic 与插件可见性（dependencies.plugins 显式声明）的细化授权模型；
2. `@host/api` 类型声明的自动生成（从注册表生成 TS 类型，保证 IDE 体验与运行时一致）；
3. 能力插件与核心的进程边界（同进程 vs 独立进程的取舍与配置）；
4. QuickJS 性能 benchmark 结论对 §5 超时/并发默认值的影响。
