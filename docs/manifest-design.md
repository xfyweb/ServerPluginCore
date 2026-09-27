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
| `<permission protectionLevel>` | 权限定义 + **授予仪式** | **无对应**——宿主权限注册表（D4）用 `scope`（碰不碰宿主资源）+ `grant`（三档授予方式）+ 等级（提示强度），见 api-contract §6 |
| `protectionLevel=normal` | 安装时自动授予 | `grant: auto`：只碰插件自身的数据 → 安装即生效 |
| `protectionLevel=dangerous` | 需用户同意、可随时撤销 | **按读取/写入再分**：`grant: install`（host 只读与插件自有能力 → 首次安装播种进白名单，之后与 explicit 同一条道）／`grant: explicit`（写宿主资源、执行模板、提权、出网、**跨插件调用/订阅** → 默认拒绝 + 逐点授予）；可撤销（D7） |
| `protectionLevel=signature` | 仅同签名应用可用 | **无对应**——来源（签名 / 市场）不参与权限判定（ADR-001 v3）；高敏感点靠 `secret` / `high` 等级的**二次确认** |
| `protectionLevel=signatureOrSystem` | 同签名或系统应用 | ≈ 内置插件（面板本身） |
| `android:exported` | 组件默认私有，显式导出才对外 | `exports` 块：Web API/路由/事件默认私有 |
| `<queries>`（包可见性） | 默认看不到其他应用 | 插件间默认不可见，通信需显式声明 |
| `<permission-group>` | 权限分组 | 权限点分组（`docker.*`、`fs.*`、`exec.*`） |
| `<intent-filter>` | 组件可被外部调用的声明 | 事件订阅 / 路由声明 |
| **SAF（系统选择器 + URI 而非路径）** | 用户主动选择资源，应用只拿到凭证 | **核心选择器 + `grantId`**：用户意图由可信前端捕获，插件只拿引用（intent-capture.md） |

## 二、manifest 草案（schema 2）

> `type` 声明插件类型，缺省 `ability`。四类（v3 起）：**ability** 能力插件（沙箱内挂载管理页面，调 `@host/api`，含驱动插件注册的领域端点；前端形态由 `frontend.mode` 决定）、**driver** 驱动插件（**核心进程内**注册权限节点 + API 端点并自行鉴权 —— 与核心同进程，**不提供隔离**；安装走**独立界面与最高强度提示**，见 ADR-005 §3 与 `api-contract.md` §10）、**hook** 协作插件（**核心在决策点上回调它、答复进核心决策**；与能力插件的差别是调用方向相反；**P2 不做**，设计见 `docs/events-and-hooks-design.md` §2）、**theme** 主题包（v3 由"面板插件"降级而来：`theme.json`，声明式令牌 + 资源，无 JS、无沙箱）。示例为能力插件（ability），其容器操作经配套驱动插件注入的端点完成：

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
    "endpoints": [
      { "path": "/api/docker/containers", "permission": "docker.read" }
    ],
    "routes": [
      { "path": "/docker", "title": "Docker", "icon": "container", "order": 10 }
    ],
    "events": {
      "publish":   [{ "topic": "@xfy2412/docker.backup-done", "classification": "public" }]
    }
  },

  "frontend": { "mode": "declarative" },
  "intent": [
    { "name": "pickContainer", "kind": "enum", "values": ["nginx", "redis"] }
  ],

  "dependencies": {
    "npm": [ { "name": "zod", "version": "3.x" } ],
    "plugins": [ { "id": "@xfy2412/docker-driver", "version": ">=0.1.0" } ]
  }
}
```

> **manifest 里没有签名块（v2 修订）**：签名属于交付信封，不属于插件自述——签名对象是 `plugin.meta.json`（规范化 JSON），它覆盖 manifest 与全部载荷文件的哈希，包内以 `plugin.meta.sig` 外挂。见 plugin-signature-design.md。

## 三、关键设计点

1. **请求 / 批准分离（Android 最核心的洞见）**：`permissions[]` 只是插件的**请求**；批准与否由宿主按"`scope` / `grant` 规则 + 管理员对 `explicit` 档的逐点授予"决定——**来源（签名 / 市场 / 本地安装）不参与**。Android 的 `uses-permission` 与系统最终授权是两回事——这是"manifest 声明权限"最成熟的工业先例，直接支撑 D5（manifest 声明是请求，宿主判定才是批准）。**安装清单本身就是同意书**（intent-capture §8.1）：`auto` / `install` 档一次看全即生效，只有 `explicit` 档才逐点问。
   - **点名的两种写法**（2026-09-23）：**静态点** `<group>.<action>[.<scope>]`（`fs.write.data`、`exec.template.nginx.reload`）；**动态点**由**别人的能力**派生、名字里带**完整引用**——`plugins.call.<origin>/@user/name.<path>`（调它的某个端点）、`events.subscribe.<origin>/@user/name.<topic>`（订阅它发布的某个事件）。两种都**不接受 `*`**（通配声明等于把对方将来新增的端点一次性全授）。见 api-contract §6.1 与 `events-and-hooks-design.md` §3.4。
     ⚠️ **形态分层**：这里两种都是**点式**名字 —— 点式命名空间属于**核心 · 驱动 · 协作**那条线（`db.query` / `auth.login.before`），能力插件对它们**只能申请与调用，不能占用**；能力插件自己的对外面是**路径式**（`/api/…`）。见 `api-contract.md` §4.0。

2. **权限模型三条轴（v4：新增 `grant`）**：
   | 轴 | 字段 | 规则 |
   |---|---|---|
   | 碰不碰宿主资源 | `scope`：`self` / `host` | `self`（只碰插件自身的数据目录 / kv / 定时器）；`host`（碰宿主管理的资源）；注册期约束 `self ⇒ grant: auto` |
   | 要不要管理员点头 | `grant`：`auto` / `install` / `explicit` | `auto` 安装即生效、**不可撤也不需要撤**；`install`（host 只读 + 插件自有能力）**首次安装时按清单播种进白名单**，之后与 `explicit` 同一条道；`explicit`（写宿主资源 / 执行模板 / 提权 / 出网 / 跨插件调用与订阅）默认拒绝 + 逐点授予 |
   | 要多大的动静 | `confidentiality` / `executionLevel` | 决定授予时的提示强度与二次确认、审计分级；`effective = max(...)` 只升不降 |
   - 例：`fs.write.data` → `self` + `auto`（不问）；`docker.read` → `host` + `install`（安装清单即生效）；`docker.write` → `host` + `explicit` + `sensitive/medium`（逐点授予 + 提示）；secrets / 任意 fs 读写 → `host` + `explicit` + `secret/high`（逐点授予 + 二次确认）。
   - **为什么删掉 protectionLevel**：它在本仓库里从未被判定逻辑读取（装饰性字段）；其中 `signature` 档把身份塞进权限定义，与"来源不参与权限判定"冲突；`normal` / `dangerous` 真正表达的是"够不着别人"与"要不要点头"，用 `scope` + `grant` 表达更准确（api-contract §6）。
   - **`grant` 与被删的 `protectionLevel` 的区别**：`grant` 被判定链第 3 步读取，不是装饰字段；`scope` 退为资源语义并在注册期约束 `grant`——两个字段各有一处读取点。
   - 核心前端（Web Shell）与内置主题 ≈ Android 的 `signatureOrSystem`（同源内置；v3 起界面不再由"面板插件"提供）。

3. **`exports` 显式导出（默认私有）**：插件对外的一切（Web API、前端路由、事件 topic）默认不对外；必须显式声明且经宿主网关登记后才可路由（对应 Android `android:exported` 默认 false）。比 AstrBot/Bukkit 的"注册即对外"更严，与"插件 Web API/页面纳入宿主网关鉴权"（AstrBot 研究结论 5）一致。

4. **`version.code/name` 分离**：升级比较用整数 `code`，展示用 `name`（对应 Android versionCode/versionName），避免 `"1.2.0" < "1.10.0"` 这类字符串比较陷阱。

5. **`compat.minCore/targetCore`（对应 minSdk/targetSdk）**：解决插件与核心的版本耦合——`minCore` = 运行所需的核心 API 下限；`targetCore` = 开发针对的核心版本。**`targetCore` 按清单值；缺省 = 构建时所在的核心版本**。用途有**两层**：① **可否运行** —— `minCore` 不满足 ⇒ **拒装**（fail-closed，不是"装但警告"）；② **兼容行为开关** —— 核心按 `targetCore` 决定"对这个插件启用哪一版兼容行为"（这才是安卓 `targetSdkVersion` 的真正用途，也是它最难改的原因）。**核心 API 契约发布前一律 `0.x`**——可以破坏，但每次都要写迁移说明。semver + 废弃期（api-contract §6）由此可判定"此插件能否在此核心版本上运行 / 是否需要警告"。这是生态一旦建立就最难改的部分，第一天就要定。

6. **插件间可见性（对应 Android 11+ `<queries>`）**：插件默认看不见其他插件；要订阅他人事件或调用他人 Web API，必须在 `dependencies.plugins` 显式声明（**`author.pub` 必填**；`origin` 的写法按目标分四格 —— 市场目标必填域名、**本地目标可省略**（在本地源范围内按 `author.pub + id` 唯一匹配）、**市场包不许依赖本地源**，见表下）。顺带解决了 api-contract §12 的待定项"事件 topic 授权模型（通配 vs 枚举）"——用显式声明替代通配：**订阅他人事件必须先声明依赖发布方**，见 `docs/events-and-hooks-design.md` §1.7。

   | 声明者 → 目标 | `origin` | 为什么 |
   |---|---|---|
   | 任意 → 市场包 | **必填**（市场域名） | 域名是作者发布时就知道的稳定标识 |
   | 本地包 → 本地包 | **省略** ⇒ 本地源范围内按 `author.pub + id` 唯一匹配 | 本地桶名是**装机人**起的标签（`std（小A）`），作者签名时不可能知道 ⇒ 于是 **promote 搬运不会打断本地→本地的依赖** |
   | 本地包 → 本地包（写明 `local:<名字>`） | 精确匹配该桶 | 作者自愿承担"对不上"的风险 |
   | 市场包 → 本地包 | **禁止** | 本地源不存在于别人的机器上 |

7. **`reason` 字段**：每个权限请求附一行"为什么需要"，安装时展示给用户——安装风险提示的实体内容（对应 Android 安装时的权限用途说明），也是审核时的评审材料（ADR-001 v3 审核）。

8. **`dependencies.npm`（D8 载体）**：npm 依赖**声明**（`{ name, version }`）。**没有 `tier`**——依赖不分信任档（ADR-005 §7 v2）：勾选拦不住内联的依赖、分级又建立在不可信的声明上，所以整套退化成**构建期能力检查**（能带 / 不能带）+ 把**真实闭包**（构建器算出来的，不是声明的）写进产物元数据供人查看。`dependencies.plugins`（插件间依赖）是另一回事，它走运行时检查（plugin-lifecycle-design §5）。
   **v4：依赖的身份是 `(origin, id)` + 作者公钥**（`id` 只是市场内的名字，同名不同来源是**两个插件**）：`dependencies.plugins[]` 写成 `{ as?, id, origin?, version?, author: { pub, fingerprint? }, call? }`，**`author.pub` 必填**（构建层强制签名 ⇒ 不存在无签名包；`id` 与 `author.id` 都不唯一，唯一性来自 `origin`、**同一性来自公钥**）。`origin` 省略的语义**按目标分**（见要点 6 的表）：市场目标省略 = 同源简写（照旧），**本地目标省略 = 本地源范围唯一匹配**。
   **2026-09-24 加两个字段**：`as` = **包内别名**（调用句柄；同一清单内 `id` 必须唯一，重名就必须给每条写 `as`，于是代码里 `plugins.call('backup', …)` 永远无歧义）；`call` = **调用面的请求**（"我要调它的哪些端点"）。
   ⇒ **包内被签名的字节里不含本地源名**：作者只声明"依赖谁、要调什么"，**宿主在装载时锚定解析成实际 ref**、生成带源的点名；**授权带源、声明不带源**，审计记实际锚定结果。详见 `docs/events-and-hooks-design.md` §3.2/§3.5/§3.7 与 `plugin-signature-design.md` §3bis。

    **2026-09-25（⑤）落地**：句柄唯一性由校验器的**语义闸**保证（`sdk/validate.ts`；JSON Schema 表达不了"两个字段拼出来的键要唯一"，所以它与 schema 同处生效：核心装载、SDK、将来市场上传共用）；端点侧新增 `exports.endpoints[].callable`（**缺省 `['panel']`** ⇒ 默认不给插件调），并新增一条**装载期不变式**：入口模块必须导出与声明同名的 `endpoints` 映射，对不上即 `PLUGIN_EXPORT_INVALID`（`kind=endpoint-handler`）。

9. **`configSchema`（插件配置声明，P1.5）**：声明用户可调参数（JSON Schema 子集：`string | number | boolean | enum | array`，带 `default`/`description`，敏感字段标 `secret: true`）。值存在宿主侧 `<SPC_STATE_DIR>/config/plugins/<sanitized-id>.json`，装载时按 schema 校验并补默认值，以**只读快照** `ctx.config` 注入（插件不能改自己的配置）。面板据此渲染配置表单（P3）。详见 plugin-lifecycle-design.md §1.6。

10. **`frontend`（前端形态，P3）**：`{ mode: 'declarative' | 'iframe' }`——
    - `declarative`：manifest 的 `exports.routes` 声明组件树，**核心渲染，插件代码不执行**（最安全，敏感数据首选）；
    - `iframe`：插件 bundle 在核心前端的隔离 iframe 里运行（`sandbox` 无 `allow-same-origin`、CSP 零出网、经 `MessageChannel` 与核心通信）。
    详见 intent-capture.md §5/§6。

11. **`intent[]`（意图负载声明，P3）**：声明插件**可以从核心前端收到什么样的用户意图**——`selection`（资源**引用** + 元数据摘要）｜`text`（短字符串 + 长度上限）｜`enum`。核心代理层按声明校验，违规即 `INTENT_SCHEMA_VIOLATION`；**资源内容默认不随意图下发**，插件要内容必须持 grantId 调沙箱 API。声明即审核面：管理员安装时能看到"这个插件会收到什么样的用户输入"。详见 intent-capture.md §6.2。

## 四、与 api-contract.md §5 旧草案（schema 1）的差异

| 旧（schema 1） | 新（schema 2） | 理由 |
|---|---|---|
| `permissions: ["docker.read"]` 字符串数组 | `permissions: [{name, reason}]` 对象数组 | reason 支撑风险提示与审核（要点 7） |
| 无 exports | `exports: {endpoints, routes, events}` | 默认私有 + 显式导出（要点 3） |
| `version: "1.0.0"` 字符串 | `version: {code, name}` | 版本比较正确性（要点 4） |
| 无 compat | `compat: {minCore, targetCore}` | 插件-核心版本耦合（要点 5） |
| `runtime: "node"` 字符串 | `runtime: {type, esm}` | 运行时类型 + ESM-only 硬约束（ADR-005 §4） |
| 无 dependencies | `dependencies: {npm, plugins}` | 依赖管控 + 插件间可见性（要点 6/8） |
| 无 configSchema | `configSchema`（可选） | 插件配置声明 + 面板渲染 + `ctx.config` 只读注入（要点 9） |
| 无 frontend / intent | `frontend: {mode}` / `intent[]` | 前端形态与意图负载声明（要点 10/11，P3） |
| `type` 含 `panel` | `type` 含 `theme`（移除 `panel`） | 面板插件降级为主题包（ADR-005 v3） |
| — | `schema: 2` | 清单 schema 版本化（D10） |

## 五、不照搬 Android 的部分

- **不做运行时逐次授权弹窗**（Android 6+ dangerous 权限每次使用要用户同意）——对服务器面板是噪音；用"**安装清单一次性授权**（`auto`/`install` 档）+ 只对 `explicit` 档逐点授予 + 可撤销"替代（intent-capture §8）；
- **不照搬 protectionLevel**——Android 的"授予仪式"枚举（normal / dangerous / signature，以及 privileged / development / appop / instant / setup 等内部档）在我们这里退化成三条正交判断：`scope` 决定碰不碰宿主资源、`grant` 决定要不要管理员点头、等级决定提示强度；**身份 / 信任类档位（signature = 同签名才可用）整类删除**（ADR-001 v3）；
- **不做 intent-filter 级隐式分发**——插件间通信走**显式声明的事件面**（清单订阅 + 依赖声明 + 管理员批准）与显式调用的端点，不搞隐式意图匹配（那套是 Android 特有的复杂性与安全漏洞来源）。
