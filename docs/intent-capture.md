# 用户意图捕获与双通道权限模型（Intent Capture）

- 状态：**设计基线**（接口现在定，P3 落地）
- 关联：ADR-001 v4（意图信任根在前端）、ADR-002（核心前端与 Web Shell）、ADR-005 v3（主题包 / iframe 前端）、api-contract（前端 API）、manifest-design（`intent` 声明）、plugin-lifecycle-design（前端产物）
- 定位：回答"**用户意图怎么安全地到达核心**"，以及"插件能替用户做多少事"。

## 0. 一句话

**用户意图只能由可信前端捕获**；授权有两个来源——管理员预先授予（长期，管插件自主行为）与用户实时确认（短期，管用户此刻想做的事），两者最终都在核心侧校验后执行。

## 1. 三条通道

| 通道 | 起点 | 认证 | 授权来源 | 能否碰用户资源 |
|---|---|---|---|---|
| **前端通道** | 核心 Web Shell（**可信**） | frontend-token（用户会话） | **用户在核心 UI 的实时确认** | 能：确认即授权，核心前端**直接调核心 REST**，不经任何插件 |
| **插件通道** | 插件后端（沙箱，**不可信**） | 沙箱桥（宿主侧强制） | ① 管理员预先授予的权限点 ② 用户确认签发的 grantId | 只能：能力边界内 + 持 grantId 的资源操作 |
| **管理通道** | CLI（本地） | daemon 握手（ed25519 临时密钥） | 本机管理员 | **只做插件/主题管理**，不承载业务操作（TUI 落地后复用前端通道） |

要点：**核心自己做得到的操作根本不进插件**。删除文件、建立会话、重启服务这类核心原生能力，用户确认后由核心前端直连 REST 完成；插件只在"它自己是执行者"（Docker、MC 服务器等自有能力）时才介入，而那时它必须持 grantId。

## 2. 不变量

1. 插件**不产生**意图，也不**解释**意图——只传递与使用凭证；
2. **插件 UI 里的"点击"不构成授权**（可伪造），插件前端的任何请求都必须回到**核心渲染的确认窗口**才生效；
3. 核心前端是浏览器侧唯一意图捕获点；CLI 是**管理意图**的场所（只管插件与主题）；
4. **核心 UI 与插件 UI 必须视觉可区分**，且安全关键 UI（确认窗口 / 来源角标 / 提权输入）的呈现**不受主题与插件影响**。

## 3. 双源授权

```
自主发起（插件自有逻辑）  → 权限点：manifest 声明 + 管理员预先授予        长期
代理执行（用户此刻意图）  → grantId：核心签发，绑定 资源+操作+时效+受众   短期 / 一次性
```

- **核心原生能力**（fs、会话、服务、敏感命令）→ 核心执行，插件最多提供视图；
- **插件自有能力** → 插件后端执行；涉及用户选中资源时必须持 grantId；
- **资源类操作不受管理员作用域限制**：用户选中的路径可以在插件 manifest 声明的作用域之外（否则"插件的限制会变成对用户的限制"）；
- **安全底线仍受**：`/proc`、`/sys`、`/dev`、socket 与设备节点、管理员显式 deny 列表；
- **提权**：若前端能经 `sudo` 之类合法方式提权，**不阻拦**——这属于"用户意图 + 用户自带的凭据"；凭据只驻内存、绝不落盘，审计只记摘要。

## 4. grantId 规范

```ts
interface Grant {
  grantId: string;                    // 随机（防枚举）
  audience: string;                   // 只允许哪个插件使用（pluginId）
  operation: string;                  // read | write | delete | session:open | exec:sudo …
  resource: { kind: 'path' | 'session' | 'template'; ref: string };  // realpath / sessionId
  issuedBy: 'user';                   // ★ 只有"用户确认"能签发；管理员预授权走权限点，不签发 grantId
  userId: string;
  issuedAt: string;
  expiresAt: string;                  // 默认 60s
  oneShot: boolean;                   // 离散操作默认一次性；会话类绑定 sessionId 可复用
  signature: string;
}
```

- **签发密钥**：核心**持久化实例密钥**（状态目录 `intent-key`，首次启动生成）。不能复用 daemon 的临时内存密钥——重启即失效，会话类 grant 无法校验。CLI 握手仍用临时密钥，两者用途分离。
- **签发端点只接受前端的 frontend-token**；插件后端无权签发（"插件后端请求签发 grantId"是最直白的越权尝试，必须在此处断掉）。
- **校验**：验签 → `audience` 等于调用插件 → `operation` 匹配 → 资源（realpath 后）一致 → 未过期 → 一次性未消费（消费记录 + 审计）。
- **与 `grants: string[]` 的关系**：管理员授予保持"权限点列表、长期"，**不生成 grantId 实体**——长期凭证只有一种，避免两套模型并存。

## 5. 前端两层结构与通信协议

```
核心 Web Shell（核心代码，可信）
├── 路由 / 布局 / 菜单 / 主题系统 / i18n
├── 意图捕获 UI：资源选择器 · 确认窗口 · 来源角标 · 提权凭据输入
├── frontend-token（只在核心前端内存）
└── 插件容器
    ├── 声明式页面：manifest 声明组件树 JSON → 核心渲染（插件代码不执行）★ 最安全
    └── iframe 页面：插件 bundle，`sandbox` 隔离 ★ 最灵活
```

**iframe 细节（写死，避免实现踩坑）**

- `<iframe sandbox="allow-scripts">`——最小集。**不给** `allow-same-origin`（opaque origin 是本模型基石；且它与会话同源同时存在时 iframe 可自行移除 `sandbox` 属性）、`allow-popups`、`allow-top-navigation`、`allow-downloads`（下载即外发）、`allow-forms`、`allow-modals`；
- opaque origin ⇒ `localStorage` / `IndexedDB` / `cookie` 全不可用，请求带 `Origin: null` → **插件前端不得依赖浏览器存储**；
- **通信走 `MessageChannel` 私有端口 + 一次性 nonce 握手**；校验 `event.source === iframe.contentWindow`。**不要依赖 `event.origin`**——opaque origin 的它恒为 `"null"`，校验等于没校验；
- **插件前端不直连核心 API**：一律 `postMessage` → 核心前端 → 核心 REST（由核心前端代理并附 frontend-token）；
- 核心控制插件文档的响应头，因此 CSP 与 `sandbox` 属性**插件无法覆盖**。

## 6. 意图负载与出网边界（三层防御）

> 问题：插件从前端拿到用户意图后要传回自己的后端；若前端能任意发网络请求，敏感内容（文件列表、文件内容）就可能被直接外发，或借沙箱外发。

**结论：不做内容级流向追踪**（跨不可信域不可判定——插件合法地回传字符串，我们无法区分"用户选项"与"分块外泄的数据"；长度限制只是启发式，分块即可绕）。改为三层结构性防御：

### 6.1 第一层：iframe 零出网（硬边界，浏览器强制执行）

核心在服务插件文档时下发：

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';          /* 或 nonce */
  style-src 'self';           /* 不给 'unsafe-inline'，否则 CSS url() 就是外发通道 */
  img-src data: blob:;        /* 不给远程 img */
  font-src 'self';
  connect-src 'none';         /* fetch / XHR / WebSocket / EventSource / sendBeacon 全断 */
  form-action 'none';
  frame-ancestors 'self';
  base-uri 'none';
Permissions-Policy: camera=(), microphone=(), geolocation=(), …
```

**"插件前端直接把内容传给恶意后端"在浏览器层就被关掉**——不需要我们追踪任何数据。

### 6.2 第二层：意图结构化——默认只给"引用"，不给"内容"

插件在 manifest 里声明它能收到什么形状的意图，核心代理层按声明校验：

```jsonc
"intent": [
  { "name": "pickFile",   "kind": "selection", "resource": "path", "types": ["file"], "maxBytes": 512 },
  { "name": "targetPath", "kind": "text",      "maxLength": 256 },
  { "name": "mode",       "kind": "enum",      "values": ["fast", "safe"] }
]
```

1. 意图负载**只能是声明过的形状**：`selection`（资源**引用** + 元数据摘要）｜`text`（短字符串 + 长度上限）｜`enum`。**不接受任意 JSON、不接受嵌套、不接受 blob**；
2. 违反 → `INTENT_SCHEMA_VIOLATION`：拒绝转发 + 审计（这也是给管理员与市场审核的信号）；
3. **资源内容默认不随意图下发**：插件拿到引用 / grantId；要内容必须带 grantId 调沙箱 API 取——核心按 grantId 决定给什么、给多少，并记账；
4. 声明即审核面：管理员安装时能看到"这个插件会收到什么样的用户输入"。需要文件内容的插件（编辑器类）必须显式声明。

### 6.3 第三层：出网能力 = 唯一的 exfil 闸门

数据一旦进入插件后端，只剩一条外发路径：**用宿主 API 把数据带出去**。因此"谁能把数据带出去"有确定答案——**看它的权限点清单**：

- `exec.run` 模板：静态可审查数据 + E1–E10 + 管理员逐点批准（出网类模板如 `git.pull` 必须单独批准）；
- 未来的 `net.*`：域名白名单 + 权限点 + 体积/速率上限 + 审计；
- **能力级管控 + 每次外发可归因**（谁、哪个插件、多大、什么时候、走的哪个模板/端点）。

### 6.4 第四层（免费）：声明式页面天然免疫

敏感数据（文件列表、服务列表、日志、配置）**默认走声明式页面**：数据在核心进程与核心前端之间流动，**插件代码从不接触**。

| 场景 | 走哪条路 |
|---|---|
| 列出文件、看配置、看日志、看服务状态 | **声明式页面**（插件不接触数据） |
| 需要选择资源（"选这个文件去备份"） | 核心选择器 → 意图只回**引用** → 插件用 grantId 取 |
| 终端 / 编辑器 / diff（必然接触内容） | iframe + 声明 `intent.text` + 出网能力受权限点约束 + 审计 |
| 富交互但不碰敏感数据（图表、表单、向导） | iframe（它拿不到不该拿的东西） |

判据：**"这个 UI 需要看到数据本身吗？"** —— 不需要 → 声明式；需要 → iframe，且它的出网能力必须能在权限点清单里被一眼看穿。

### 6.5 不做的与轻量可做的

- **不做**内容级 taint / 流向追踪（不可判定）；
- **不做**纯长度限制当边界（分块可绕）；长度只作为**滥用降级**；
- **可做**：① 核心代理给"插件前端 → 后端"的消息加体积与频率配额；② 每条意图消息记 `{pluginId, intentName, bytes}` 入审计（事后取证）。

## 7. 确认窗口边界与强度

| 操作 | 确认 | 备注 |
|---|---|---|
| 离散写（删除 / 复制 / 重命名 / 上传 / 覆盖） | ✅ | 弹窗展示资源摘要 + **插件来源角标** |
| 离散读（打开 / 浏览） | ✖（normal） | `strict` 下也确认 |
| 会话建立（pty / SSH / DB） | ✅ | 一次确认 → 签发绑定 `sessionId` 的 grantId |
| 会话内敏感命令（`rm -rf` / `dd` / `sudo`） | ✅ | **强制点在核心/驱动端点**——能力插件没有 socket，命令流必经核心 |
| 持续交互 UI（终端、文件管理器界面） | ✖ | UI 归插件，数据面归核心 |

配置：`intent.confirm = strict | normal | relaxed`（默认 `normal`），支持按操作类别覆盖。

## 8. 默认边界（**待定——下一轮讨论**）

已经明确的张力：**确认点越多，管理员与开发者的折损率越高**（每个弹窗都是一次流失机会，每次声明都是一道开发门槛）。所以真正要设计的不是"哪些操作要确认"，而是"**默认允许多少**"：

- 哪些操作 **静默放行**（连提示都不要）？
- 哪些操作 **只提示不阻断**（toast / 角标）？
- 哪些操作 **必须确认**（弹窗 + 资源摘要）？
- 哪些操作 **必须二次确认**（危险命令 / 提权 / 越出作用域）？
- 插件声明（`permissions` / `intent`）的**默认授予面**到哪里为止（是否"声明即可用"而不是"逐点授予"）？

本节的答案将决定 §7 那张表的实际行数，以及 `intent.confirm` 各档的具体规则。**下一轮专门讨论。**

## 9. 主题模型

主题不是"插件"，也不是纯 CSS，而是**声明式设计令牌 + 资源 + 受限样式，无 JS**：

```jsonc
// theme.json
{ "themeSchema": 1, "id": "@xfy2412/nord", "name": "Nord",
  "tokens": {                                  // 核心与插件 iframe 共用同一批变量
    "color.bg": "#2e3440", "color.fg": "#d8dee9", "color.accent": "#88c0d0",
    "radius.md": "8px", "space.unit": "4px", "font.sans": "Inter, system-ui",
    "density": "comfortable"                   // compact | comfortable | spacious
  },
  "icons": "icons.svg",                        // 图标集（symbol sprite）
  "assets": ["fonts/inter.woff2"],
  "css": "overrides.css",                      // 受限：只作用在 [data-spc-skin] 作用域内
  "layout": "sidebar"                          // 只做"选择"，布局变体由核心实现
}
```

- **可换**：颜色 / 字体 / 间距 / 圆角 / 密度 / 图标 / 资源 / 受限样式 / 布局变体的选择；
- **不可换**：安全关键 UI——确认窗口、来源角标、权限提示、提权输入框。核心给它们固定样式与**独立渲染层**，主题 CSS 限定在 `[data-spc-skin]` 内。否则恶意主题能画一个假确认框，直接把"视觉区分"这条防御绕过——**这是主题的安全边界，不只是美观问题**；
- **插件 iframe 也吃主题**：核心把 tokens 作为 CSS 变量 + `theme` 消息推给 iframe（插件用 `var(--spc-color-accent)`），两边视觉一致而无需共享 DOM；
- **无 JS** ⇒ 装 / 启 / 切换不需要沙箱与生命周期钩子（但进同一套安装记录：`type: theme`，用 `theme.json` 代替入口，**豁免 `init`**）；
- 留作后续（P5）：分区/插槽（主题只选排布变体，不能注入结构）、组件皮肤选择器白名单。

## 10. CLI 与 TUI 的定位

- 当前 CLI = **插件与主题管理**：`plugin install / enable / disable / reload / status / grant / revoke`、`theme list / enable`、`about / status`；
- **不承载业务操作**：业务操作是用户意图，走核心 REST；
- 未来 TUI = **前端通道的终端形态**（复用同一批核心 REST），那时业务操作才进 CLI；在此之前 CLI 就保持"只有插件管理"；
- 管理员预授权（插件通道的长期授权来源）自然落在 CLI。

## 11. 审计

意图类操作统一落：`{ ts, userId, channel: 'frontend' | 'plugin' | 'cli', pluginId?, grantId?, operation, resourceDigest, decision, result, durationMs }`；grantId 的**签发 / 消费 / 拒绝**各一条；资源只记摘要；提权凭据永不落盘。插件前端消息额外记 `{ intentName, bytes }`。

## 12. 攻击面与消解

| 攻击 | 防御 |
|---|---|
| 插件后端伪造 grantId | 核心持久密钥签名，验签失败 |
| 插件后端自行签发 grantId | 签发端点只接受 frontend-token |
| 插件前端伪造"用户点了删除" | iframe 内的点击不算授权，必须回核心确认窗口 |
| 插件前端窃取 frontend-token | opaque origin + 不直连核心 API + token 只在核心前端内存 |
| 插件前端读核心 DOM / 变量 | `sandbox`（无 `allow-same-origin`）+ CSP |
| 插件前端窃听消息 | `MessageChannel` 私有端口 + nonce + `event.source` 校验 |
| 插件前端外发内容 | CSP `connect-src 'none'` 等（§6.1，浏览器强制） |
| 插件借沙箱外发内容 | 出网能力受权限点 + 模板审查 + 审计约束（§6.3） |
| 插件复用 grantId | 绑定 audience / operation / resource + 一次性 + 短时效 |
| 主题伪装安全 UI | 安全 UI 固定样式 + CSS 限定 `[data-spc-skin]` + 主题无 JS |
| 插件 UI 冒充核心 UI | iframe 视觉分区 + 来源角标 + 确认窗口独立渲染层 |
| **唯一实质残留** | **用户被欺骗点击** → 视觉区分 + 敏感操作二次确认 + 资源摘要展示 |

## 13. 前置依赖与未决

- **用户与会话身份**（硬前置）：本模型要回答"谁在确认"。本轮只留接口位——`userId` 字段、frontend-token 绑定会话；认证方式（单管理员 / 多用户 / RBAC）后续参考开源项目实现；
- **未决**：会话型 grantId 的续期与撤销语义（会话断开 vs grant 过期）；提权凭据的输入渠道与"是否记录已授权提权"；声明式页面的组件树 schema（P3 定）；**默认边界（§8）**。

## 14. 落地清单（P3，接口现在就定）

| 位置 | 内容 |
|---|---|
| 核心前端（新） | Web Shell + 组件库 + 意图捕获 UI + 插件容器（声明式渲染 + iframe 宿主 + `MessageChannel` 代理） |
| `core/intent/`（新） | grantId 签发 / 校验 / 消费；持久实例密钥 |
| `api-contract` | 前端 API（核心 REST）端点 + `intent` 转发校验（§6.2）+ §10 驱动端点声明"是否需意图确认" |
| `sdk/schema` | manifest `intent[]`、`frontend`、`type: theme` |
| `plugin-lifecycle-design` | 前端产物；`frontend` 能力登记；`theme` 豁免分支 |
| 测试 | ① CSP 头与 `sandbox` 属性存在且无 `allow-same-origin`；② 插件前端越权直连被拒；③ 意图负载不合 schema → `INTENT_SCHEMA_VIOLATION`；④ grantId 绑定校验（错 audience / 错资源 / 过期 / 重放）；⑤ 主题不能覆盖安全 UI |
