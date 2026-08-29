# 插件元数据清单设计（Android 权限系统参考）

> 依据：ADR-001（信任双档）、api-contract.md（宿主 API 契约）、permission-research.md（D1–D10 设计决策）。
> 参考：[AndroidManifest.xml 的 `<permission>`/`<uses-permission>` 元素](https://android.googlesource.com/platform/frameworks/base/+/3155825/docs/html/guide/topics/manifest/permission-element.jd)、[Android 权限与保护级别](https://github.com/apachecn/apachecn-sec-zh/blob/master/docs/android-app-sec-guidebook-zh/5.2.md)。

## 一、Android 概念 → 我们的对应（对照表）

| Android 概念 | 语义 | 我们的对应 |
|---|---|---|
| `package` 名 | 全局唯一标识 | 命名空间 id：`official:docker` / `thirdparty:xxx` |
| `versionCode` / `versionName` | 程序化比较 / 展示 | `version.code`（整数）/ `version.name`（字符串） |
| `minSdkVersion` / `targetSdkVersion` | 兼容下限 / 针对版本 | `compat.minCore` / `compat.targetCore`（核心 API 版本） |
| `<uses-permission>` | **声明"需要"，不是"拥有"** | `permissions[]`（请求） |
| `<permission protectionLevel>` | 权限定义 + 保护级别 | 宿主权限注册表（D4）每项带 protectionLevel |
| `protectionLevel=normal` | 安装时自动授予 | 官方档自动批准 |
| `protectionLevel=dangerous` | 需用户同意、可随时撤销 | 第三方档安装确认 + 风险提示 + 降级；可撤销（D7） |
| `protectionLevel=signature` | 仅同签名应用可用 | **仅官方签名插件可申请**（官方专属能力） |
| `protectionLevel=signatureOrSystem` | 同签名或系统应用 | ≈ 内置插件（面板本身） |
| `android:exported` | 组件默认私有，显式导出才对外 | `exports` 块：Web API/路由/事件默认私有 |
| `<queries>`（包可见性） | 默认看不到其他应用 | 插件间默认不可见，通信需显式声明 |
| `<permission-group>` | 权限分组 | 权限点分组（`docker.*`、`fs.*`、`exec.*`） |
| `<intent-filter>` | 组件可被外部调用的声明 | 事件订阅 / 路由声明 |

## 二、manifest 草案（schema 2）

```json
{
  "schema": 2,

  "id": "official:docker",
  "name": "Docker Management",
  "version": { "code": 12, "name": "1.2.0" },
  "compat": { "minCore": "0.1.0", "targetCore": "0.3.0" },
  "author": { "name": "...", "homepage": "..." },
  "runtime": { "type": "quickjs", "esm": true },
  "description": "Docker 容器/镜像/网络/卷管理（薄适配器）",

  "permissions": [
    { "name": "docker.read", "reason": "列出容器与镜像" },
    { "name": "docker.write" },
    { "name": "exec.template.nginx.reload" }
  ],

  "exports": {
    "webApis": [
      { "path": "/api/docker/containers", "permission": "docker.read" }
    ],
    "routes": [
      { "path": "/docker", "title": "Docker", "icon": "container", "order": 10 }
    ],
    "events": {
      "publish":   ["backup.done"],
      "subscribe": ["docker.container.crash"]
    }
  },

  "dependencies": {
    "npm": [ { "name": "zod", "version": "3.x", "tier": "whitelist" } ],
    "plugins": []
  },

  "signature": {
    "algorithm": "ed25519",
    "keyId": "official-2026",
    "digest": "<sha256 of manifest+code>",
    "sig": "<base64>"
  }
}
```

## 三、关键设计点

1. **请求 / 批准分离（Android 最核心的洞见）**：`permissions[]` 只是插件的**请求**；批准与否由宿主按"双档画像 × protectionLevel"决定。Android 的 `uses-permission` 与系统最终授权是两回事——这是"manifest 声明权限"最成熟的工业先例，直接支撑 D5（manifest 声明是请求，宿主画像才是批准）。

2. **protectionLevel 三档（精简自 Android 的八档）**：
   | 档位 | 授予条件 | 例子 |
   |---|---|---|
   | `normal` | 官方档自动授予 | `docker.read`、`fs.read.data` |
   | `dangerous` | 第三方档需安装确认 + 降级映射（D5） | `docker.write`、exec 模板、`net.fetch.*` |
   | `signature` | **仅官方签名插件可申请**，第三方声明即无效 | 任意 fs 读写、`net.listen`、secrets |
   - 内置插件（面板本身）≈ Android 的 `signatureOrSystem`（特权但同源）。
   - **signature 档是 Android 模型对我们最有价值的一点**：官方专属能力由签名链保证，第三方插件连"请求"都不会被受理——比我们在 manifest 里写死"官方插件才允许 X"更优雅、更可审计。

3. **`exports` 显式导出（默认私有）**：插件对外的一切（Web API、前端路由、事件 topic）默认不对外；必须显式声明且经宿主网关登记后才可路由（对应 Android `android:exported` 默认 false）。比 AstrBot/Bukkit 的"注册即对外"更严，与"插件 Web API/页面纳入宿主网关鉴权"（AstrBot 研究结论 5）一致。

4. **`version.code/name` 分离**：升级比较用整数 `code`，展示用 `name`（对应 Android versionCode/versionName），避免 `"1.2.0" < "1.10.0"` 这类字符串比较陷阱。

5. **`compat.minCore/targetCore`（对应 minSdk/targetSdk）**：解决插件与核心的版本耦合——`minCore` = 运行所需的核心 API 下限；`targetCore` = 开发针对的核心版本。核心 API 契约 semver + 废弃期（api-contract §6）由此可判定"此插件能否在此核心版本上运行 / 是否需要警告"。这是生态一旦建立就最难改的部分，第一天就要定。

6. **插件间可见性（对应 Android 11+ `<queries>`）**：插件默认看不见其他插件；要订阅他人事件或调用他人 Web API，必须在 `dependencies.plugins` 显式声明。顺带解决 api-contract §7 的待定项"事件总线 topic 授权模型（通配 vs 枚举）"——用显式声明替代通配。

7. **`reason` 字段**：每个权限请求附一行"为什么需要"，安装时展示给用户——第三方档风险提示的实体内容（对应 Android 安装时的权限用途说明），也是审核时的评审材料（ADR-001 双档审核）。

8. **`dependencies.npm`（D8 载体）**：每项带 `tier`——`whitelist`（L1 平台托管，构建层锁定版本+签名）/ `user-opt-in`（L2 用户显式放行）；原生模块与重型二进制不进此表（L3 禁区，ADR-005 §7）。装依赖与插件安装分离，需显式授权。manifest 里声明的是"意图"，宿主侧白名单才是"批准"——与权限同一哲学。

## 四、与 api-contract.md §5 旧草案（schema 1）的差异

| 旧（schema 1） | 新（schema 2） | 理由 |
|---|---|---|
| `permissions: ["docker.read"]` 字符串数组 | `permissions: [{name, reason}]` 对象数组 | reason 支撑风险提示与审核（要点 7） |
| 无 exports | `exports: {webApis, routes, events}` | 默认私有 + 显式导出（要点 3） |
| `version: "1.0.0"` 字符串 | `version: {code, name}` | 版本比较正确性（要点 4） |
| 无 compat | `compat: {minCore, targetCore}` | 插件-核心版本耦合（要点 5） |
| `runtime: "node"` 字符串 | `runtime: {type, version}` | 运行时版本约束 |
| 无 dependencies | `dependencies: {npm, plugins}` | 依赖管控 + 插件间可见性（要点 6/8） |
| — | `schema: 2` | 清单 schema 版本化（D10） |

## 五、不照搬 Android 的部分

- **不做运行时逐次授权弹窗**（Android 6+ dangerous 权限每次使用要用户同意）——对服务器面板是噪音；用"安装时一次性确认 + 风险提示 + 可撤销"替代；
- **protectionLevel 精简为三档**——Android 的 privileged/development/appop/instant/setup 等内部档位对我们无用；
- **不做 intent-filter 级隐式分发**——插件间通信走显式声明的事件总线，不搞隐式意图匹配（那套是 Android 特有的复杂性与安全漏洞来源）。
