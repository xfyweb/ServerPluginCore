# 插件签名与身份设计（更新可信 + 归因）

- 状态：**设计基线**（P4 落地；落地前核心侧为桩）
- 关联：ADR-001（信任模型，本文件是其 v2 修订的依据）、ADR-003（市场开源 / 密钥管理）、ADR-005（沙箱与插件类型）、manifest-design.md（manifest 字段）、market-license-design.md（下载控制面与授权）、api-contract.md §2/§6/§9
- 定位：**本文件只回答"这个包是谁给的、有没有被改过"**，不回答"它能干什么"——后者由沙箱（ADR-005）、权限注册表与管理员授予决定。

## 1. 安全模型分层

| 层 | 管什么 | 机制 | 失效后果 |
|---|---|---|---|
| **运行时** | 插件**能做什么** | 零环境权力沙箱（ADR-001/005）+ 权限注册表 + 逐方法参数解析与校验（api-contract §5/§6） | 越权调用被拒 + 审计告警 |
| **交付/更新** | 这个包**是谁给的、有没有被改过** | 本文件：规范化签名 + 身份锚定 + 清单校验 | 拒绝安装/加载；**已装版本不受影响** |
| **人工** | 代码**写得对不对** | 市场审核 + 代码分析 + 管理员复审（源码可读） | 只能降低概率，不能保证 |

三条推论：

1. **签名不是安全分级**。它证明"谁打的包"，不证明"包里是什么"。把"是否安全"编码成运行时判定，等于拿不可验证、不可证伪的人为判断做强制决策。
2. **没有签名就没有可归因的更新通道**：任何人都能替换包而不被发现。签名买到的是"可归因 + 可安全更新"，仅此而已。
3. **分层不可互相替代**：签名的包不会因为签名而获得任何权限；未签名的包也不会因为未签名而绕过参数校验。这是本设计的全部要点。

## 2. 分发单元

```
foo-1.2.0.spc/                  （zip 容器；校验不依赖容器字节，容器可被任意重打包）
  plugin.meta.json              被签对象（规范化 JSON）
  plugin.meta.sig               Ed25519 裸签名（64 字节）
  manifest.json                 ─┐
  main.js                        │ 载荷：每个文件必须逐项出现在 files[]
  web/**                         │
  i18n/**                       ─┘
```

- 除 `plugin.meta.json` / `plugin.meta.sig` 两个信封文件外，**容器内任何文件都必须出现在 `files[]` 中**，否则拒装（`PACKAGE_EXTRA_FILE`）。两个文件名是约定，不在元数据里声明路径。
- **包内不含证书**：身份文档属于"身份"而非"某个插件的交付物"，见 §4.3。
- **不做自定义二进制容器**。签名对象是"安装意图"（结构化清单）而不是"容器字节流"：包会经 CDN / 镜像 / 重新打包，压缩方式、条目顺序、mtime 都会变；确定性由规范化 JSON 保证（§5），不需要自定 TLV 及其解析器、长度炸弹防护与格式版本管理。

## 3. `plugin.meta.json`

```jsonc
{
  "metaSchema": 1,

  // 身份冗余：与 manifest 一致，用于"不解析载荷就快速拒绝"
  "id": "@xfy2412/docker",
  "version": { "code": 12, "name": "1.2.0" },
  "type": "ability",
  "compat": { "minCore": "0.1.0" },

  // 签名者自述：验签用；无身份文档时这也是唯一身份
  "signer": {
    "alg": "ed25519",
    "pub": "<base64 32B>",
    "fingerprint": "sha256:<hex>"        // keyring / 身份表用同一算法索引
  },

  // 交付事实
  "releasedAt": "2026-09-01T00:00:00Z",
  "build": { "sdk": "0.4.0", "bundler": "esbuild@0.24" },   // 可选：排障用，不参与判定

  // 载荷清单：签名覆盖的全部内容
  "files": [
    { "path": "manifest.json", "sha256": "<hex>", "size": 1234 },
    { "path": "main.js",       "sha256": "<hex>", "size": 8123 },
    { "path": "web/index.js",  "sha256": "<hex>", "size": 4321 }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `metaSchema` | ✔ | 元数据 schema 版本（与 `manifest.schema` 各自演进） |
| `id` / `version` / `type` / `compat.minCore` | ✔ | **冗余缓存**，必须与 `manifest.json` 一致，否则 `META_MANIFEST_MISMATCH` |
| `signer` | ✔ | `alg` 暂只允许 `ed25519`；`fingerprint` = `sha256(pub)` |
| `releasedAt` | ✔ | 发布时刻（授权判定锚点，见 market-license-design §3） |
| `build` | ✘ | 构建描述，排障用 |
| `files[]` | ✔ | `path` 必须为相对路径且规范化后不含 `..`（复用 `core/fs/safe-path.ts` 规则）；重复 `path` → `DUPLICATE_ENTRY`；建议按 `path` 升序输出 |

- **签名对象 = 规范化后的整个 meta 字节**（§5）。`releasedAt` 与 `build` 也在被签范围内。
- 不设 `source` / `registry` / `origin` 字段：来源由宿主的 keyring 别名推导（§4.1），自报来源不可信且冗余。
- 不设 `cert` / `certSha256` 字段：包内没有证书（§4.3）。

## 4. 身份：keyring、身份文档、身份表

### 4.1 信任根 = 管理员 keyring（宿主侧，唯一）

```jsonc
// keyring 条目（管理员维护）
{
  "fingerprint": "sha256:<hex>",
  "pub": "<base64>",
  "alias": "官方市场",              // 管理员命名 —— "来源"这个显示标签就是它
  "kind": "market" | "developer",
  "namespaces": ["@xfy2412"],       // kind=developer 必填：管理员直接指定其命名空间
  "enabled": true,
  "addedAt": "2026-08-01T00:00:00Z",
  "note": "自建市场 / 我自己的开发者密钥"
}
```

- **内置官方公钥只是 keyring 里的初始条目，不享有特殊档位**；市场可自建、可镜像、可并存 —— 谁是市场由管理员决定（ADR-003）。
- `kind: "market"` 可签发身份文档；`kind: "developer"` 是管理员**直接锚定某个开发者公钥**（等价于管理员自签委任状，不经过任何市场）。

### 4.2 身份文档（市场签发，宿主侧缓存）

```jsonc
// 一份/开发者，跨插件、跨版本复用
{
  "identitySchema": 1,
  "subject":   { "alg": "ed25519", "pub": "<base64>", "fingerprint": "sha256:<hex>" },
  "namespace": "@xfy2412",
  "issuer":    { "fingerprint": "sha256:<市场公钥指纹>" },
  "serial": 7,
  "issuedAt": "2026-08-01T00:00:00Z",
  "notAfter": "2027-08-01T00:00:00Z",     // 可选；只拦"比已装版本更新"的包
  "sig": "<base64，覆盖去掉本字段后的规范化 JSON>"
}
```

- 宿主按 `subject.fingerprint` 缓存为身份表 `identities/<fingerprint>.json`，**同一开发者的 N 个插件共用一条记录，冗余在结构上不存在**。
- 获取渠道三条，**验证规则完全相同**：注册表按指纹按需取（安装时未命中则顺带拉取）/ 管理员手动导入（或整市场身份清单批量导入）/ keyring 直锚（§4.1 的 `kind: "developer"`）。
- 身份文档只回答"这把公钥属于哪个命名空间"，**不含任何能力约束**：`constraints`、`maxPermissionLevel`、`pluginTypes` 之类字段**明确不做**（理由见 §9）。
- 宿主侧文档用**内嵌 base64 签名**（单文件、便于一次 HTTP 获取与管理）；包内用**外挂裸签名字节**（签名对象就是该文件本身）。两处约定不同是有意的。

### 4.3 为什么证书不随包走

1. **无重复**：证书不再随每个插件、每个版本复制一份。
2. **消除"证书被替换"攻击面**：身份绑定是宿主状态，包内签名只证明"谁签的"，攻击者换不了。
3. **身份与能力彻底分离**：包内只剩"我自称是谁 + 我签了这些字节"，一点策略都没有。

## 5. 规范化与签名对象

签名对象 = **规范化后的 JSON 字节**（UTF-8，无 BOM）：

1. 对象键按 UTF-8 字节序**升序**；
2. 无任何多余空白（`,` `:` 后不加空格），无缩进/换行美化；
3. 字符串只允许 `\" \\ \b \f \n \r \t` 与 `\u00XX`（小写 hex）转义；禁止 `\/` 等多余转义；
4. 数字**只允许整数**：禁浮点、禁指数、禁前导零、禁 `-0`；
5. 禁重复键、禁尾随逗号、禁注释；
6. 数组是语义顺序，**不排序**（`files[]` 建议按 `path` 升序输出，但校验方不依赖顺序）；
7. 验签方先做规范化合法性校验（失败 → `PACKAGE_META_MALFORMED`），再对**原始字节**验签；**不做"重新序列化后比对"**。

签名：`plugin.meta.sig` = `Ed25519(canonical bytes)`，无格式、无头部。算法信息只在 `signer.alg` / 身份文档中，签名文件本身是纯字节。

## 6. 校验流程

```
1  读取信封       缺文件 / 非法 JSON / 重复键 / 规范化失败
                    → PACKAGE_META_MISSING | PACKAGE_META_MALFORMED
2  验 meta 签名    用 meta.signer.pub 验 plugin.meta.sig
                    → META_SIGNATURE_INVALID
                    （只证明"完整性 + 有人持有该私钥"，尚不证明身份）
3  查身份          keyring / 身份表 按 meta.signer.fingerprint 查：
      未命中         → 不报错，落到 unanchored（显著警告）
      命中但停用     → ANCHOR_DISABLED
      命名空间不覆盖 → NAMESPACE_NOT_GRANTED
      已过 notAfter 且是更新 → IDENTITY_EXPIRED
      命名空间已被别的锚占用 → NAMESPACE_TAKEN
      否则           → anchored（anchorKey = 锚指纹）
4  核载荷          逐项校验 files[] 与包内实际内容
                    → PACKAGE_FILE_MISSING | PACKAGE_FILE_MISMATCH
                      PACKAGE_EXTRA_FILE | DUPLICATE_ENTRY | PATH_OUT_OF_SCOPE
5  交叉校验        解析 manifest.json，比对 id/version/type/compat
                    → META_MANIFEST_MISMATCH
6  与已装版本比对  signerKey 或 anchorKey 变化 → 需人工确认（§8）
7  写安装记录      { id, version, anchor, anchorKey, signerKey, packageSha256,
                     installedAt, grants }
```

**"不认识" ≠ "签名错"** 是整个流程的骨架：

- 签名字节验不过 → 硬拒（伪造/损坏）；
- 签名正确但查不到身份 → `unanchored`：可安装、可运行，但**每次升级都要人工确认**、`secret` 级不可用、不占用命名空间（§7）。

顶层错误码结构沿用 api-contract §2（顶层 `error` + `detail.code`/`detail.params`）；本节各码是 `detail.code`。核心与 HTTP/审计只走码，本地化只发生在渲染边界（CLI / 面板按 `err.<CODE>` 取词条）。

## 7. 锚定两档与差异

| | `anchored` | `unanchored` |
|---|---|---|
| 判定 | 签名链能走到管理员 keyring 里的某个公钥（内置官方 / 自建市场 / 直锚开发者，**三者等价**） | 走不到（无身份文档 / 市场不在 keyring / 身份已停用） |
| 命名空间归属 | 可占用锚定的命名空间 | 只在**无人认领**的命名空间下可安装，且不构成归属 |
| 静默升级 | 签名者与锚不变时允许 | **每个版本都必须人工确认** |
| 换签名者 | 必须人工确认（供应链攻击主入口） | 不适用 |
| `secret` 级权限 | 可经管理员**显式授予** | 不受理 |

- 除上表四项外，**其余一律平等**：任何等级（high/medium/low）都只看"是否声明 + 是否授予"，与锚定无关。官方插件也不会因为是官方就自动获得权限。
- **命名空间占位规则**：首次以某个锚锚定某命名空间即占位（记录在宿主的命名空间表）。已被占用的命名空间只接受同一锚的包；未认领时允许安装未锚定包（本地开发不必改名），标记为"未验证"。
- `secret` 级要求锚定是**宿主自己的策略**，与市场无关：不可撤销的持续权限必须可归因，否则出事之后连"该撤销谁"都无从谈起。
- "降级"一词在本设计里已不再使用（它暗示"权限表会缩水"）：锚定差异只体现在**命名空间归属、更新资格、摩擦、`secret` 准入**四处。

## 8. 更新与签名者变更

- 静默升级的前提：`signerKey` 与 `anchorKey` 均未变化，且新版本 `version.code` 更大。
- `signerKey` / `anchorKey` 变化 → 必须人工确认（面板二次确认 / CLI 显式参数）；
- `unanchored` 插件每个新版本都需人工确认 —— 这就是"不可归因的包不能自动更新"的具体含义。

## 9. 明确不做

| 不做 | 理由 |
|---|---|
| 自定义二进制签名容器 | 签名对象是结构化清单，不是容器字节流（§2） |
| 证书/身份文档随包分发 | 冗余，并把身份绑定暴露成可替换的包内数据（§4.3） |
| 身份文档里的能力约束（`maxPermissionLevel` 等） | 委任状只回答"谁是谁"；能力 100% 来自管理员授予，市场不该决定权限上限 |
| 把"审核强度"写进运行时判定 | 不可验证、不可证伪；审核结论是市场页面上的展示信息 |
| CRL / OCSP / 在线吊销检查 / 心跳 | 核心离线，没有查询点；在线黑名单等于变相心跳鉴权 |
| 设备绑定 / 机器指纹 | 源码可读，防不住真盗版，反而干扰换机（market-license-design §4） |

**失效与撤销（全部本地手段）**：管理员删除身份表记录 → 该开发者新版本不再被锚定（已装版本不动）；keyring 条目 `enabled: false` → 该市场签发的全部委任状一次性失效；`notAfter` 到期 → 只拦更新；已装插件用 `spc plugin disable`。密码学上无法远程收回已落地的私钥权限，任何系统都不行。

## 10. 落地清单

| 位置 | 改动 |
|---|---|
| `sdk/schema/` | 新增 `meta.schema.json`、`identity.schema.json`；**删除** `manifest.schema.json` 的 `signature` 块（签名属于交付信封，不属于插件自述，否则自指） |
| `core/` | 新增验签模块（canonical JSON + keyring + 身份表 + 清单校验，全部在核心侧，沙箱不可达）；安装流写安装记录；`Tier = official\|thirdparty` → `Anchor = anchored\|unanchored`；`LEVEL_OFFICIAL_ONLY` → `LEVEL_ANCHORED_ONLY`；`registry.ts` **取消按信任档分档的 `defaults`**——权限基线只由 `protectionLevel` 决定 |
| 构建工具 | 打包时生成 meta + `files[]` + 规范化 + 签名；**签名私钥永不进仓库/CI 明文**（ADR-003） |
| market | 签发身份文档、发布 release 记录、下载控制面与授权判定（market-license-design） |
| 文档 | ADR-001 §信任双档 → 锚定两档（v2 修订）；ADR-003 §防仿冒；api-contract §6/§9；manifest-design |

## 11. 待定

1. **id 形态**：`@publisher/name`（推荐，npm scope 风格）vs `publisher:name`（改动最小）。定后同步 `manifest.schema.json` 的 `id` pattern、`dependencies.plugins[].id`、测试与示例。
2. 容器后缀（当前示例用 `.spc`）。
3. 原子签名算法集合：当前只允许 `ed25519`，是否预留 `ecdsa-p256`。
