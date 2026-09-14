# 插件元数据清单设计（Android 权限系统参考）

> 依据：ADR-001（信任模型 v2）、plugin-signature-design.md（签名与身份）、api-contract.md（宿主 API 契约）。
> 参考：[AndroidManifest.xml 的 `<permission>`/`<uses-permission>` 元素](https://android.googlesource.com/platform/frameworks/base/+/3155825/docs/html/guide/topics/manifest/permission-element.jd)、[Android 权限与保护级别](https://github.com/apachecn/apachecn-sec-zh/blob/master/docs/android-app-sec-guidebook-zh/5.2.md)。

## 一、Android 概念 → 我们的对应（对照表）

| Android 概念 | 语义 | 我们的对应 |
|---|---|---|
| `package` 名 | 全局唯一标识 | 发布者命名空间 id：`@username/name`（**市场内唯一**；跨市场全局唯一性由完整引用 `<origin>/@username/name` 提供） |
| `versionCode` / `versionName` | 程序化比较 / 展示 | `version.code`（整数）/ `version.name`（字符串） |
| `minSdkVersion` / `targetSdkVersion` | 兼容下限 / 针对版本 | `compat.minCore` / `compat.targetCore`（核心 API 版本） |
| `<uses-permission>` | **声明"需要"，不是"拥有"** | `permissions[]`（请求） |
| `<permission protectionLevel>` | 权限定义 + **授予仪式** | **无对应**——宿主权限注册表（D4）不用"授予仪式"枚举，只用 `scope`（要不要管理员授予）+ 等级（提示强度），见 api-contract §6 |
| `protectionLevel=normal` | 安装时自动授予 | `scope: self`：只碰插件自身的数据 → 不需要授予 |
| `protectionLevel=dangerous` | 需用户同意、可随时撤销 | `scope: host`：默认拒绝 + 安装确认 + 风险提示 + 对具体权限点**显式授予**（deny→allow）；可撤销（D7） |
| `protectionLevel=signature` | 仅同签名应用可用 | **无对应**——来源（签名 / 市场）不参与权限判定（ADR-001 v3）；高敏感点靠 `secret` / `high` 等级的**二次确认** |
| `protectionLevel=signatureOrSystem` | 同签名或系统应用 | ≈ 内置插件（面板本身） |
| `android:exported` | 组件默认私有，显式导出才对外 | `exports` 块：Web API/路由/事件默认私有 |
| `<queries>`（包可见性） | 默认看不到其他应用 | 插件间默认不可见，通信需显式声明 |
| `<permission-group>` | 权限分组 | 权限点分组（`docker.*`、`fs.*`、`exec.*`） |
| `<intent-filter>` | 组件可被外部调用的声明 | 事件订阅 / 路由声明 |

## 二、manifest 草案（schema 2）

> `type` 声明插件类型，缺省 `ability`。四类：**ability** 能力插件（沙箱内挂载管理页面，调 `@host/api`，含驱动插件注册的领域端点）、**panel** 面板插件（Web 壳 + 组件库，内置可卸载）、**driver** 驱动插件（核心端注册权限节点 + API 端点并自行鉴权；安装走**独立界面与最高强度提示**，见 ADR-005 §3）、**hook** 协作插件（事件钩子，位置/权限设计中）。示例为能力插件（ability），其容器操作经配套驱动插件注入的端点完成：

```json
{
  "schema": 2,
  "type": "ability",

  "id": "@xfy2412/docker",
  "name": "Docker Management",
  "version": { "code": 12, "name": "1.2.0" },
  "compat": { "minCore": "0.1.0", "targetCore": "0.3.0" },
  "author": { "id": "xfy2412@market.spc.xfyweb.cn", "name": "...", "homepage": "..." },
  "runtime": { "type": "quickjs", "esm": true },
  "description": "Docker 容器/镜像/网络/卷管理（能力插件：面板页面 + 调驱动插件端点）",

  "permissions": [
    { "name": "docker.read", "reason": "列出容器与镜像" },
    { "name": "docker.write" }
  ],

  "exports": {
    "webApis": [
      { "path": "/api/docker/containers", "permission": "docker.read" }
    ],
    "routes": [
      { "path": "/docker", "title": "Docker", "icon": "container", "order": 10 }
    ],
    "events": {
      "publish":   [{ "topic": "backup.done", "classification": "public" }],
      "subscribe": [{ "topic": "job.finished", "mode": "notify" }]
    }
  },

  "dependencies": {
    "npm": [ { "name": "zod", "version": "3.x", "tier": "whitelist" } ],
    "plugins": [ { "id": "@xfy2412/docker-driver", "version": ">=0.1.0" } ]
  }
}
```

> **manifest 里没有签名块（v2 修订）**：签名属于交付信封，不属于插件自述——签名对象是 `plugin.meta.json`（规范化 JSON），它覆盖 manifest 与全部载荷文件的哈希，包内以 `plugin.meta.sig` 外挂。见 plugin-signature-design.md。

## 三、关键设计点

1. **请求 / 批准分离（Android 最核心的洞见）**：`permissions[]` 只是插件的**请求**；批准与否由宿主按"`scope` 规则 + 管理员逐点授予"决定——**来源（签名 / 市场 / 本地安装）不参与**。Android 的 `uses-permission` 与系统最终授权是两回事——这是"manifest 声明权限"最成熟的工业先例，直接支撑 D5（manifest 声明是请求，宿主判定才是批准）。

2. **权限模型两条轴（v3：删除 protectionLevel）**：
   | 轴 | 字段 | 规则 |
   |---|---|---|
   | 要不要管理员点头 | `scope`：`self` / `host` | `self`（只碰插件自身的数据目录 / kv / 定时器）不需要授予；`host`（碰宿主管理的资源）**逐个权限点授予** |
   | 要多大的动静 | `confidentiality` / `executionLevel` | 决定授予时的提示强度与二次确认、审计分级；`effective = max(...)` 只升不降 |
   - 例：`fs.write.data` → `scope: self`（不授予）；`docker.write` → `scope: host` + `sensitive/medium`（授予 + 提示）；任意 fs 读写 / secrets → `scope: host` + `secret/high`（授予 + 二次确认）。
   - **为什么删掉 protectionLevel**：它在本仓库里从未被判定逻辑读取（装饰性字段）；其中 `signature` 档把身份塞进权限定义，与"来源不参与权限判定"冲突；`normal` 真正表达的是"够不着别人"，用 `scope: self` 更准确（api-contract §6）。
   - 内置插件（面板插件本身）≈ Android 的 `signatureOrSystem`（同源内置、可卸载，见 ADR-002 v2）。

3. **`exports` 显式导出（默认私有）**：插件对外的一切（Web API、前端路由、事件 topic）默认不对外；必须显式声明且经宿主网关登记后才可路由（对应 Android `android:exported` 默认 false）。比 AstrBot/Bukkit 的"注册即对外"更严，与"插件 Web API/页面纳入宿主网关鉴权"（AstrBot 研究结论 5）一致。

4. **`version.code/name` 分离**：升级比较用整数 `code`，展示用 `name`（对应 Android versionCode/versionName），避免 `"1.2.0" < "1.10.0"` 这类字符串比较陷阱。

5. **`compat.minCore/targetCore`（对应 minSdk/targetSdk）**：解决插件与核心的版本耦合——`minCore` = 运行所需的核心 API 下限；`targetCore` = 开发针对的核心版本。核心 API 契约 semver + 废弃期（api-contract §6）由此可判定"此插件能否在此核心版本上运行 / 是否需要警告"。这是生态一旦建立就最难改的部分，第一天就要定。

6. **插件间可见性（对应 Android 11+ `<queries>`）**：插件默认看不见其他插件；要订阅他人事件或调用他人 Web API，必须在 `dependencies.plugins` 显式声明（同源依赖省略 `origin`，跨源依赖必须写明；**缺少的源不会被自动添加**，只提示管理员，见 plugin-signature-design.md §7.1）。顺带解决 api-contract §7 的待定项"事件总线 topic 授权模型（通配 vs 枚举）"——用显式声明替代通配。

7. **`reason` 字段**：每个权限请求附一行"为什么需要"，安装时展示给用户——安装风险提示的实体内容（对应 Android 安装时的权限用途说明），也是审核时的评审材料（ADR-001 v3 审核）。

8. **`dependencies.npm`（D8 载体）**：每项带 `tier`——`whitelist`（L1 平台托管，构建层锁定版本+签名）/ `user-opt-in`（L2 用户显式放行）；原生模块与重型二进制不进此表（L3 禁区，ADR-005 §7）。装依赖与插件安装分离，需显式授权。manifest 里声明的是"意图"，宿主侧白名单才是"批准"——与权限同一哲学。

9. **`configSchema`（插件配置声明，P1.5）**：声明用户可调参数（JSON Schema 子集：`string | number | boolean | enum | array`，带 `default`/`description`，敏感字段标 `secret: true`）。值存在宿主侧 `<SPC_STATE_DIR>/config/plugins/<sanitized-id>.json`，装载时按 schema 校验并补默认值，以**只读快照** `ctx.config` 注入（插件不能改自己的配置）。面板据此渲染配置表单（P3）。详见 plugin-lifecycle-design.md §1.6。

## 四、与 api-contract.md §5 旧草案（schema 1）的差异

| 旧（schema 1） | 新（schema 2） | 理由 |
|---|---|---|
| `permissions: ["docker.read"]` 字符串数组 | `permissions: [{name, reason}]` 对象数组 | reason 支撑风险提示与审核（要点 7） |
| 无 exports | `exports: {webApis, routes, events}` | 默认私有 + 显式导出（要点 3） |
| `version: "1.0.0"` 字符串 | `version: {code, name}` | 版本比较正确性（要点 4） |
| 无 compat | `compat: {minCore, targetCore}` | 插件-核心版本耦合（要点 5） |
| `runtime: "node"` 字符串 | `runtime: {type, esm}` | 运行时类型 + ESM-only 硬约束（ADR-005 §4） |
| 无 dependencies | `dependencies: {npm, plugins}` | 依赖管控 + 插件间可见性（要点 6/8） |
| 无 configSchema | `configSchema`（可选） | 插件配置声明 + 面板渲染 + `ctx.config` 只读注入（要点 9） |
| — | `schema: 2` | 清单 schema 版本化（D10） |

## 五、不照搬 Android 的部分

- **不做运行时逐次授权弹窗**（Android 6+ dangerous 权限每次使用要用户同意）——对服务器面板是噪音；用"安装时一次性确认 + 风险提示 + 可撤销"替代；
- **不照搬 protectionLevel**——Android 的"授予仪式"枚举（normal / dangerous / signature，以及 privileged / development / appop / instant / setup 等内部档）在我们这里退化成两条正交判断：`scope` 决定要不要管理员点头，等级决定提示强度；**身份 / 信任类档位（signature = 同签名才可用）整类删除**（ADR-001 v3）；
- **不做 intent-filter 级隐式分发**——插件间通信走显式声明的事件总线，不搞隐式意图匹配（那套是 Android 特有的复杂性与安全漏洞来源）。
