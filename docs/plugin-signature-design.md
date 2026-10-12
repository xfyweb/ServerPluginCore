# 插件签名与源（市场签名 + 作者签名 + 密钥轮换）

- 状态：**设计基线（v4：市场签名 + 作者签名）**——v4 加入**作者签名**：它只为**依赖身份匹配**，不是信任层（§1 推论 3、§3bis）；代码改动清单见 §11
- 关联：ADR-001（信任模型 v3）、ADR-003（市场开源与密钥管理）、ADR-005（沙箱与插件类型）、manifest-design.md（manifest 字段）、market-license-design.md（下载控制面与授权）、api-contract.md §2/§6/§9、**events-and-hooks-design.md §3（调用面 / 带源身份 / 依赖身份 / reanchor）**
- 定位：本文件回答"**这个包由哪个源签名、有没有被改过、还能不能更新**"，以及（v4）"**它是不是我依赖的那个插件**"；**不回答"它能干什么"**——后者由沙箱（ADR-005）、权限注册表与管理员授予决定。

## 1. 安全模型分层

| 层 | 管什么 | 机制 | 失效后果 |
|---|---|---|---|
| **运行时** | 插件**能做什么** | 零环境权力沙箱 + 权限注册表 + 逐方法参数解析与校验 | 越权调用被拒 + 审计告警 |
| **交付/更新** | 包由哪个源签名、有没有被改过、还能不能更新 | 市场签名 + 源（keyring）+ 密钥轮换 + 清单校验 | 拒绝安装/更新；**已装插件不受影响** |
| **依赖身份**（v4） | **这是不是我依赖的那个插件** | **作者签名** + 作者名册（`authors.json`）+ 依赖声明里的 `(origin, id, author.pub, 版本区间)` | 依赖不满足（拒装/拒载）；**不影响该插件自身可用** |
| **人工** | 代码**写得对不对** | 市场审核 + 代码分析 + 管理员复审 | 降低概率，不能保证 |

三条推论：

1. **签名不参与权限判定**。来源只决定"有没有更新渠道"和"提示强度"；任何权限点（含最高等级）都与来源无关，只看"manifest 声明 + 管理员授予"。**v4 补一句**：作者签名同样不参与权限判定——它只回答"你调的是不是那个东西"；`origin` 会出现在**引用**与**权限点名**里（因为同名不同源是两个插件），但**判定逻辑不问来源**。
2. **市场签名买的是"可归因的更新通道"**：任何人替换包内字节都会被验签拦下；但它对**已落地代码的运行**没有任何约束力——那是运行时层的事。
3. **做作者签名，但它不是信任层**（v4 修订；原先写的是"不做开发者签名"）。要的东西变了：它**不解决"包可不可信"**（那仍是市场审核 + 市场签名 + 运行时沙箱的事），只解决"**这是不是我依赖的那个插件**"——由**插件间定向调用**与**具名本地来源**带来的新需求（`events-and-hooks-design.md` §3）。因此它：**不参与权限判定**、**不改变安装提示强度**、**不提供更新渠道**；**仍然不做**身份文档 / 命名空间委任 / 去中心化分发（§10）。"客户端只验市场签名"改口径为：**渠道信任只认市场签名；作者签名只用于依赖身份**。

> 术语：**市场**是远端服务（域名 + 密钥 + registry + 审核）；**源**是 keyring 里代表"我信任这个市场"的本地条目；`origin`（域名）是源的主键。

## 2. 分发单元

```
foo-1.2.0.spc/                  （zip 容器；校验不依赖容器字节）
  plugin.meta.json              被签对象（规范化 JSON；含 authorPub）
  plugin.meta.sig               **市场** Ed25519 裸签名（64 字节）—— 市场审核通过后追加
  plugin.author.sig             **作者** Ed25519 裸签名 —— 构建工具产出，签的也是上面那份 meta（§3bis）
  manifest.json                 ─┐
  main.js                        │ 载荷：每个文件必须逐项出现在 files[]
  web/**                         │
  i18n/**                       ─┘
```

- 除**三个信封文件**外，**容器内任何文件都必须出现在 `files[]` 中**，否则拒装（`PACKAGE_EXTRA_FILE`）。三个文件名是约定，不在元数据里声明路径；**它们也都不进 `files[]`** —— 作者签名要签 meta，若 meta 又列出"包含该签名的文件"，就形成「签名 → meta → 文件哈希 → 签名」的**循环**。
- **不做自定义二进制容器**：签名对象是"安装意图"（结构化清单），不是容器字节流——包会经重新打包，压缩方式、条目顺序、mtime 都会变，确定性由规范化 JSON 保证。
- 包内**不含私钥、不含证书链**。**公钥是身份、不是凭据**：作者公钥写在 meta 的 `authorPub` 里；而**市场签名的签名者仍由"这次操作使用的源"确定**（§7），不靠包自述。
- **元数据由构建工具产出，市场审核完只追加一个签名文件**：`plugin.meta.json` 与 `plugin.author.sig` 都是构建期产物，市场对**同一份字节**签 `plugin.meta.sig`（**不改字节**，两把签名因此**平级**）。市场的义务：核对 `files[]` 与实际载荷一致、核对它要背书的事实（如 `releasedAt`）；**不认可就拒签，不改写**（改写会破坏作者签名）。

## 3. `plugin.meta.json`

```jsonc
{
  "metaSchema": 2,                                          // v4 加了 authorPub ⇒ 1 → 2（未发布，不做兼容）

  // 身份冗余：与 manifest 一致，用于"不解析载荷就快速拒绝"
  "id": "@xfy2412/docker",
  "version": { "code": 12, "name": "1.2.0" },
  "type": "ability",
  "compat": { "minCore": "0.1.0" },

  // v4：作者公钥（身份，不是凭据）。验证时用"期望的公钥"，不用这个自述值
  "authorPub": "<base64 裸 32 字节公钥>",

  // 交付事实
  "releasedAt": "2026-09-01T00:00:00Z",
  "build": { "sdk": "0.4.0", "bundler": "esbuild@0.24" },   // 可选：排障用，不参与判定

  // 载荷清单：签名覆盖的全部内容
  "files": [
    { "path": "manifest.json", "sha256": "<hex>", "size": 1234 },
    { "path": "main.js",       "sha256": "<hex>", "size": 8123 }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `metaSchema` | ✔ | 元数据 schema 版本（与 `manifest.schema` 各自演进）；**v4 = 2** |
| `id` / `version` / `type` / `compat.minCore` | ✔ | 冗余缓存，必须与 `manifest.json` 一致，否则 `META_MANIFEST_MISMATCH` |
| **`authorPub`** | ✔ | **作者公钥**（base64 裸 32 字节）—— 身份。**验证时必须用"期望的公钥"**（依赖声明里的 `author.pub`，或 `authors` 名册里的首见值），**不能信这个字段本身**（§3bis） |
| `releasedAt` | ✔ | 发布时刻（授权判定锚点，见 market-license-design §3）。⚠️ **v4 起由构建期填**，市场**核对后拒签或背书**、不改写字节（✅ 已定，见 §12-4） |
| `build` | ✘ | 构建描述 |
| `files[]` | ✔ | `path` 必须为相对路径且规范化后不含 `..`（复用 `core/fs/safe-path.ts` 规则）；重复 `path` → `DUPLICATE_ENTRY`；建议按 `path` 升序输出 |

- **两把签名签的是同一个对象**：**规范化后的整个 meta 字节**（§4）—— 市场签名（`plugin.meta.sig`）与作者签名（`plugin.author.sig`）都签它，因此二者**平级**，谁后签都不能改字节。
- **meta 由构建工具产出**（含 `authorPub` 与 `files[]`），市场只追加自己的签名（§2 末条）。
- **不设 `signer` / `cert` / `source` / `registry` 字段**：市场签名的签名者由验签时使用的源确定；来源由宿主的 keyring 条目推导（§5），包内自报的来源不可信且冗余。**唯一新增的"自述"字段是 `authorPub`**，而它**只作为身份记录**——判定时用期望公钥覆盖它。

## 3bis. 作者签名（v4，只为依赖身份）

> **✅ 已落地（2026-09-25，④）**：`MetaDoc.authorPub` + `META_SCHEMA 2`（`core/sources/verify.ts`）；
> `plugin.author.sig` 验签（**用期望公钥**，`verifyPackage` 支持 `expectAuthorPub`）；本地包的信封读取
> （`loadLocalEnvelope`：要么两个都没有，要么两个都在且自洽）；名册 `core/sources/authors.ts`；
> 记录字段 `authorFingerprint`；安装期的身份闸（TOFU / 拒 / `--accept-key-change` + `plugin.key-change` 审计）；
> 依赖解析的身份比对与"本地范围唯一匹配"（`core/plugin/deps.ts`）。
> ⏳ **仍未做**：有源安装流的**接线**（市场验签 → 安装记录：`signedBy`/`verifiedMeta` 的写入）属 P4；
> 目前只有 `verifyPackage` 这一层（市场路径的用例已就位）。

**它是什么**：作者用**自己的密钥**对**同一份 `plugin.meta.json`** 签一次（`plugin.author.sig`），于是"这份代码"与"这把公钥"被绑在一起。

- ⚠️ **为什么不是"只签三元组"**：只签 `(id, author.id, version)` 的签名**可以整段复制**到另一个包里（那几个值照样成立）⇒ 它不绑定任何东西，连"连续性"都保不住；
- **它买到**：**完整性**（换一个字节就验不过）+ **连续性**（同一作者的后续版本仍由同一把密钥签）；
- **它买不到**："这个作者到底是谁"。有源包由**市场命名空间间接背书**（`author.id = user@origin`，见 §8 的 `AUTHOR_MISMATCH`）；本地包只有 TOFU（首见即记，见下面的名册）；
- ⚠️ **验证永远用"期望的公钥"**（依赖声明里的 `author.pub` / 名册首见值），**绝不用包里的 `authorPub`**——否则就是自签自证；
- **产出分工**：`plugin.meta.json` + `plugin.author.sig` 由**构建工具**产出（`spcdev keygen` / `spcdev build --key`，**只产作者签名**）；`plugin.meta.sig` 由**市场**在审核通过后追加。市场的义务：核对 `files[]` 与实际载荷一致、核对它要背书的事实；**不认可就拒签**；
- **端到端链路**：市场签名 → meta → 每个文件哈希 → 载荷（客户端安装时仍**逐文件核哈希**）。

**作者名册（宿主侧，`authors.json`）**：`(origin, id) → { pub, fingerprint, firstSeenAt }`

- 与 `keyring`（源）**共用机制、分开存储**：源是"我信任的更新渠道"（只有管理员能加，**永不自动新增**）；作者名册是"我见过的签名主体"（**首见即记**，因为它是**识别**、不是信任）。验签与指纹复用 `core/sources/keys.ts`；
- **同一 `(origin, id)` 内、公钥不同 ⇒ 拒装**（`PLUGIN_AUTHOR_MISMATCH`）：机器分不清"作者换了钥"还是"另一个人"，必须管理员裁决（显式**接受换钥** / 换个源 / 先卸载）；
- **换源（reanchor）**：公钥**相同**、来源不同 ⇒ 允许，数据 / 配置 / 授权一起搬（`events-and-hooks-design.md` §3.6）；
- `keyring` 另加一类条目 **`kind: 'local'`**：具名本地来源 `local:<名字>`（默认 `local:default`），**无公钥、不可轮换、不参与市场验签、不提供更新渠道** —— 它只做**命名空间归属**（否则所有本地安装都会坍缩到同一个键上）。

#### 期望值解析（"这个包该由谁签"）— 只有一处，顺序写死

```
装一个包时：  ① 源级作者锚（`authorAnchor`，若该源绑了）   ← 事先钉的
              ② 名册首见值 (origin,id) → pub               ← 事后记的（TOFU）
              ③ 首见即记（此时包内 authorPub 才是"被记的对象"）
包内 authorPub 永远只是**被验的对象**，不是期望值（否则自签自证）
解析依赖时：  期望值 = 被依赖方**记录里的 authorFingerprint**（宿主侧记忆，插件改不到）；
              依赖声明里的 author.pub 是**要求**，两者必须相等
```

#### 本地来源的模型（2026-09-24 定；**✅ 条目与 `spc source` 已落地 2026-09-25，见 §5 末**）

> **本地源 = 一个作者的桶**（源的身份**就是**那把作者公钥，名字只是标签）；**`local:default` = 杂桶**，装"某个作者 ID 只出现过一次"的插件。
> 现实动因：小 A 与小 B 不约而同取了作者 ID `std` —— 那就建两个桶 `local:std-a`（`alias: "std（小A）"`）与 `local:std-b`（`alias: "std（小B）"`），各自装各自的插件。

- **锚不再是"额外加的一个字段"，而是这个源存在的理由**：本地源条目可选带 `authorAnchor: { pub, fingerprint }`（字段形状见 §5 末）；**只在 `kind: 'local'` 上允许** —— 市场是**多作者**命名空间，给它钉一把作者钥是范畴错误；
- **升级路径（promote）**：新装的插件一般进杂桶；当它与**另一个已装插件作者公钥相同**时，**建议**管理员为该作者单独建源并把这一组搬过去，之后同一把钥签的包默认进该源。
  ✅ **已落地（2026-09-25，⑥c）**：建议由 `manager.promoteSuggestion` 算好（同一把钥第二例才建议，搬完自动消失），CLI 打印**两条现成命令**（`spc source add … --anchor` + `spc plugin reanchor …`）；"之后同一把钥签的包默认进该源"就是 `resolveInstallSource` 的自动落桶。⛔ **不自动建桶、不自动搬**（"永不自动新增源" + 换源是显式动作）。
  ⚠️ **更正（2026-09-25）**：此处原先写「我们的 CLI 是"守护进程 + HTTP"、**没有交互问答**」—— 那是把"当时 CLI 还没有确认提示"写成了原则，**不成立**：CLI 当然可以交互（`npm` / `pnpm` 就是先例），交互唯一的硬要求是**能被关掉**（`--yes`；非 TTY 时**不问**、直接要求 `--yes`），否则脚本化与 CI 就断了。今天 promote 与 `PLUGIN_AUTHOR_MISMATCH` 仍按**打印建议 + 现成命令**呈现（前者：安装成功后建议为该作者建源并搬迁；后者：错误里给出两条出路 `--source local:std-b` / `--accept-key-change`），那是因为这两处**不需要**确认（照做即可），不是因为 CLI 不能问。需要确认的动作就正常问（⑥b 的 `spc plugin reanchor` 就是 `y/N`）。
- **搬运 = 批量 reanchor**（§7.2 与 `events-and-hooks-design.md` §3.6）：公钥相同天然满足前提；必须**原子**（同一作者的那几个一起搬，否则出现"依赖方在新桶、被依赖方在旧桶"的中间态）、过 manager 唯一锁、**列全会被打断的依赖方**、落审计；
- **锚相同 = 同一组**：不需要"组"这个实体，也不需要往 `origin` 里编东西（⚠️ `core/permissions/points.ts` 的单射证明依赖 **origin 不含 `/` 与 `@`**）。"一人多机"天然是两条独立的名册与锚（每台机器一份 state）；
- **改锚不追溯**：管理员把源的锚从 K1 改成 K2 **只影响后续安装**（已装插件的 `authorFingerprint` 不动 —— 与"加载时不重验签名"一致），但要落审计并提示"已装的 N 个仍按旧锚记录；要换请重装或 reanchor"。

## 4. 规范化与公钥指纹

签名对象 = **规范化后的 JSON 字节**（UTF-8，无 BOM），规则写死：

1. 对象键按 UTF-8 字节序**升序**；
2. 无任何多余空白，无缩进/换行美化；
3. 字符串只允许 `\" \\ \b \f \n \r \t` 与 `\u00XX`（小写 hex）转义；禁止 `\/`；
4. 数字**只允许整数**：禁浮点、禁指数、禁前导零、禁 `-0`；
5. 禁重复键、禁尾随逗号、禁注释；
6. 数组是语义顺序，**不排序**；
7. 验签方先做规范化合法性校验（失败 → `PACKAGE_META_MALFORMED`），再对**原始字节**验签；**不做"重新序列化后比对"**。

签名：`plugin.meta.sig` = `Ed25519(canonical bytes)`，无格式、无头部。

**公钥指纹（全系统统一，必须钉死）**：

```
fingerprint = "sha256:" + hex_lower( SHA-256( raw_32_bytes_of_Ed25519_public_key ) )
```

即对**裸 32 字节公钥**求哈希，不是对 base64 文本、也不是对 SPKI DER。凡同时出现 `pub` 与 `fingerprint` 的地方，验方**必须校验 `fingerprint == sha256(decode(pub))`**，否则判非法。

## 5. 源与 keyring（宿主侧）

```jsonc
// keyring 条目：以域名为主键
{
  "origin": "market.spc.xfyweb.cn",     // 主键：不可为空、不可重复、不可修改
  "pub": "<base64 Ed25519 公钥>",        // 可缺省（缺省时由核心远程拉取，见下）
  "fingerprint": "sha256:<hex>",         // 与 pub 同时存在或同时缺省
  "alias": "官方市场",                    // 管理员可改，仅用于显示
  "enabled": true,
  "addedAt": "2026-08-01T00:00:00Z",
  "firstTrust": "tofu" | "manual",       // 首次信任来源：远程 TOFU / 管理员手填
  "suspended": null,                     // 见 §6.4
  "highWater": {                         // 防回滚高水位，见 §6.2
    "rotatedAt": "2026-09-12T00:00:00Z",
    "fingerprint": "sha256:<hex>",
    "revoked": ["sha256:k0"]             // 累计的吊销指纹（仅展示/审计，不参与判定）
  }
}
```

**添加源**：

```
1  管理员在 CLI / 面板提交 origin（可带 pub，也可不带）
2  不带 pub：核心请求 https://{origin}/.well-known/spc-key-status
   （强制 TLS 校验域名；这就是首次信任 TOFU）
   ├─ 成功 → 取文档中的 `current` 公钥写入 pub/fingerprint，firstTrust = "tofu"，立即添加成功
   └─ 失败 → **明确报错，不添加该源**（SOURCE_KEY_FETCH_FAILED）
3  带 pub（离线 / 无外网）：立即添加成功，firstTrust = "manual"；
   下次更新时再自动尝试拉取状态文档
```

规则：

- **域名是唯一主键**：不存在"有公钥没域名"的配置；条目缺 `origin` 视为无效条目（忽略并告警，不使核心启动失败）。
- **内置默认条目**：`origin = market.spc.xfyweb.cn`（官方市场，随发行版内置）；其余源一律由管理员显式添加。
- 一个源一套密钥：`origin` ↔ 公钥是 1:1；市场想并行使用多把密钥，等于想做域名组（§10 暂不做）。
- 本地开发市场用 `localhost` 或 `localhost:port` 作为 origin；本地源**没有 TLS**，因此**不参与自动轮换**（只能管理员手动更新公钥）。
- **永不自动新增源**：任何包、任何依赖、任何轮换文档都不能替管理员往 keyring 里加条目。

**本地源条目（`kind: 'local'`）——✅ 已落地（2026-09-25，⑥a）**：

> 落地形态：`core/sources/keyring.ts`（条目形状 + 两级校验：读文件宽松/写入口严格 + `kind` 缺省归一化成 `market`）·
> `core/sources/manage.ts`（管理动作 + 审计 + 占用检查 + TOFU 拉取）· daemon 启动播种两个内置条目
> （官方市场 + 杂桶 `local:default`）· `spc source list|add|remove|enable|disable|alias|anchor` 与 `/api/sources/*`。
> 顺带对齐了一处状态目录：`keyringDir()` 现在取 **`<STATE_DIR>`**（`SPC_KEYRING_DIR` 只是覆盖项），
> 与 `core/config.ts` 文件头写的"状态目录统一"一致 —— 原先它自己拼了一个 `<repo>/.spc`，
> 于是设了 `SPC_STATE_DIR` 的测试/部署照样会往仓库里写 keyring.json。

```jsonc
{
  "origin": "local:std-a",              // 主键；不是域名，也不是市场
  "kind": "local",                      // 本地源：不可 fetch、无更新渠道
  "pub": null,                          // 源签名公钥：本地源**永远没有**（它不签任何包）
  "fingerprint": null,
  "authorAnchor": {                     // ★ 可选：本桶里的包**必须**由这把作者公钥签（§3bis）
    "pub": "<base64 裸 32 字节>",
    "fingerprint": "sha256:…"           // 与 pub 同时存在或同时缺省；必须自洽（assertFingerprint）
  },
  "alias": "std（小A）",                 // 管理员起的标签：源的身份是那把公钥，别名只是给人看的
  "enabled": true
}
```

- 校验三条：`kind: 'local'` 才允许 `authorAnchor`（市场是多作者命名空间，钉一把作者钥是范畴错误）；`pub` 与 `authorAnchor` 是两回事、可同时存在（本地源 `pub` 恒为 null）；`fingerprint` 必须与 `pub` 自洽；
- **`authorAnchor` 是管理员断言，不是事实**——它声明"我认定这个桶只出 K 签的包"，不证明"K 是谁"；
- `local:default` 是**杂桶**：不绑锚，靠名册逐 `(origin,id)` 首见（TOFU）。

## 6. 密钥轮换与吊销

轮换只有一种机制：**旧签新**（链式）。是否属于"泄露处置"**不由文档里的标志决定**，而由**一个**可观测事实决定——本端信任的密钥是否仍在 `keys[]` 中（§6.5）。因此不需要"紧急模式"开关，也就没有它何时启用、何时清除的问题。

### 6.1 链式轮换：旧签新

固定路径：`GET https://{origin}/.well-known/spc-key-status`

```jsonc
{
  "statusSchema": 1,
  "origin": "market.spc.xfyweb.cn",
  "rotatedAt": "2026-09-12T00:00:00Z",
  "current": "sha256:<当前公钥指纹>",
  "keys": [
    // 当前视图，按时间升序；每个节点由"前驱私钥"对**本节点**签名（旧签新）
    { "fingerprint": "sha256:k0", "pub": "<base64>", "signedBy": null,        "retiredAt": "2026-06-01T00:00:00Z" },
    { "fingerprint": "sha256:k2", "pub": "<base64>", "signedBy": "sha256:k0", "sig": "<base64>", "retiredAt": "2026-09-12T00:00:00Z" },
    { "fingerprint": "sha256:k3", "pub": "<base64>", "signedBy": "sha256:k2", "sig": "<base64>", "retiredAt": null }
  ],
  "revoked": [
    // 吊销事实：**纯数据，不验签、不参与任何判定**，仅供展示与审计（§6.1.1）
    { "fingerprint": "sha256:k1", "revokedAt": "2026-07-01T00:00:00Z", "reason": "PRIVATE_KEY_LEAK" }
  ]
}
```

`keys[]` 节点的被签对象（**只有节点验签**）：

```
去掉 sig 字段后的规范化 JSON（必须含 origin 与 fingerprint）
→ 用 signedBy 指向的公钥验签；signedBy = null 的根节点无签名
```

**验证流程**：

```
1  校验结构、origin 与源一致、每个 pub 与 fingerprint 自洽（§4）
2  本端信任节点（highWater.fingerprint）是否仍在 keys[] 中？
   ├─ 不在 → KEY_ROTATION_UNVERIFIABLE → 暂停该源（§6.4）
   └─ 在   → 从该节点起逐跳验签名，直到 current
             ├─ 全通 → 见第 3 步
             └─ 任一跳失败 / current 与链尾不符 → KEY_CHAIN_INVALID → 暂停
3  全部通过 → 更新本地密钥视图与高水位、清 suspended，继续本次安装/更新
```

- **链式而非扇出**：每个 hop 的签名在当次轮换时生成并长期留存，因此**旧私钥在轮换完成后即可销毁**；任意久未联网的设备都能从自己的起点沿链走到当前。（扇出式"每个历史密钥都对 `current` 签一份"要求每次轮换都动用全部历史私钥，与"泄露后尽快销毁"直接冲突。）
- **`keys[]` 是全量历史的当前视图**：保留全部节点（含已退役），否则离线较久的设备找不到自己的起点；验证成功后本地**整体替换**为文档内容。
- **`revoked[]` 只展示，不判定**（§6.1.1）：客户端可把它累计保留（只增不减，见 §6.2）用于源信息卡与审计，但它不进入任何判定。

#### 6.1.1 为什么吊销记录不参与判定

- **级联泄露时，最有信息价值的记录恰恰由已吊销的密钥签发**。设想 `k0 → k1 → k2`、本端在 k2：k2 泄露 → 市场吊销 k2 并由 k1 签出 k3；核心尚未拉取时 k1 也泄露 → 市场吊销 k1 并由 k0 直签 k3。核心此时拉取：k2 不在 `keys[]` → 暂停（**正确**）；而"k1 吊销 k2"这条记录已经不可验证——要求"吊销条目必须由未被吊销的密钥签发"，等于要求**事故记录由没出事的人来写**。
- **那条规则本来也换不到安全性**：吊销与链在同一份 TLS 文档里下发，"伪造吊销条目"的唯一途径是控制 TLS / 服务端；而这样的人本来就能靠"把你的密钥从 `keys[]` 里删掉"达成同样的暂停。它唯一覆盖的窄场景是"服务端被控 + 旧私钥泄露 + 设备已见过那条吊销"，而能控制服务端的人只要不写 `revoked[]` 就绕过了。
- **暂停决策只依赖一个事实**：本端信任节点是否仍在 `keys[]` 中（外加链验证与防回滚失败）。
- **残余风险（明示）**：本设计**不承诺**"已吊销密钥不得续接新链"。兜底是：设备在泄露密钥上会因"不在 `keys[]`"直接暂停；链完好的设备自动前进；`.well-known` 上的伪造文档需要 TLS + 域名控制权（DNS 污染一类被 TLS 挡住）。

### 6.2 拉取时机与防回滚

- **时机**：① 向某源请求更新时顺带拉取；② 验签失败时**再拉取一次**后重试；③ 添加源时（TOFU 拉公钥）。带 TTL 缓存（默认 24h，可配）。
- **网络语义**：短超时（默认 3s）；网络失败或 404 视为"无轮换"，**用本地缓存密钥继续**；文档结构非法或验签失败 → 暂停（不是"无轮换"）。任何情况下都不阻塞已装插件的运行。
- **防回滚**：本地保留高水位 `{ rotatedAt, fingerprint, revoked[] }`，拒绝"`rotatedAt` 更旧"或"链上不含本地当前节点"的文档（否则回放旧文档即可把 `current` 退回已退役密钥）；`revoked` 与文档取**并集**后写回——**仅供展示与审计，不参与判定**（§6.1.1）。
- 轮换成功、暂停、恢复都落审计（码 + origin + 指纹）。

### 6.3 源信息展示（CLI / 面板）

源的展示卡片至少包含：`origin` / 别名 / `enabled` / `suspended` 及原因 / `firstTrust`（tofu / manual）/ 当前公钥指纹 / `rotatedAt` / **已吊销密钥列表（指纹 + 时间 + 原因码）**。列表内容不经验签、不参与判定（§6.1.1）——级联泄露时它照样展示，因为那种时候它的信息价值最高。原因码是英文契约，渲染层翻译：

| 原因码 | 含义 |
|---|---|
| `PRIVATE_KEY_LEAK` | 私钥泄露或被窃 |
| `SUPERSEDED` | 被新密钥取代（含泄露处置中被跳过的密钥） |
| `POLICY` | 市场策略性作废（人员变更、合规等） |
| `RETIRED` | 正常退役（仅登记，无安全问题） |

### 6.4 暂停机制

自动判定失败时（链缺口 / 签名不通过 / 文档非法 / 回滚），**暂停该源**：

- 状态存在 keyring 条目内：`suspended: { at, reason, pendingFingerprint? }`；`reason` 取 §7.3 的码；
- **拦截该源的一切新装与更新**（`SOURCE_SUSPENDED`）；**已装插件照常运行**，不做任何破坏性动作；
- 面板告警："源 `{origin}` 的密钥发生变化，无法自动验证，请管理员确认"（若吊销列表里有内容，一并展示）；
- 管理员三选一：**信任新密钥**（写入新公钥并清除 suspended）／**停用该源**（`enabled: false`）／**离线核实**（公告、独立渠道）；
- **不自动过期**，只能管理员手动解除——核心离线，不主动做破坏性动作，只标记状态等管理员决策。

### 6.5 泄露处置（数据驱动）

私钥泄露时，"旧签新"本身不再提供额外安全性（持有泄露私钥的攻击者可以签出任意新公钥）。客户端的安全来自两件事：

1. **本端信任的密钥已从 `keys[]` 中移除** → 直接暂停，不做任何自动接受（§6.1 第 2 步）。这是最常见的情形：设备已经切到被泄露的那把密钥；
2. **TLS + 域名控制权**：伪造文档必须出现在该源 `.well-known` 路径上才算数——攻击者若只拿到私钥而没有域名 / DNS / CA，就放不上去（DNS 污染一类攻击在此被 TLS 挡住）。

市场侧的动作：由**最后一把未泄露的私钥**签发新公钥（跳过泄露的那把），并把泄露密钥写进 `revoked[]`（`reason: PRIVATE_KEY_LEAK`）——**这是给管理员看的信息，不参与客户端的任何判定**（§6.1.1）。

其余情形：**链仍然完好的设备自动前进**（设备在 K1、泄露的是 K2、市场用 K1 签了 K3 → K1→K3 验通即接受），不需要人工介入；吊销信息会出现在源信息卡（§6.3）与审计里，管理员能看到"这个源刚处理过一次泄露"。已装插件不受影响（§9：加载时不重验市场签名）。

> **轮换 ≠ 吊销**。轮换是密钥正常更换；吊销是市场声明的"这把密钥不再被信任"，由 `revoked[]` 承载，**属于信息而非规则**（§6.1.1）。失效手段只有三个：吊销声明、停用源条目（`enabled: false`）、暂停源更新（`suspended`）。不做 KSL / CRL / OCSP。

## 7. 安装与更新流程

两种状态（定义见 ADR-001 §来源与更新渠道）：

- **`anchored`（有源）**：包由 keyring 中某个**已启用的源**签名验证通过 ⇒ **有更新渠道**（同一 `(origin, id)` 内可静默升级）；
- **`unanchored`（无源）**：本地安装，不验签 ⇒ **无更新渠道**，每次更新都要人工安装并确认。

两者在权限面前**完全平等**（§1 推论 1）。

### 7.1 有源（市场安装 / 更新请求）

```
0  源检查    keyring 有该 origin？enabled？suspended？
             → SOURCE_NOT_CONFIGURED / SOURCE_DISABLED / SOURCE_SUSPENDED
             顺带拉取密钥状态文档（§6.2），需要时完成链验证
1  信封      → PACKAGE_META_MISSING | PACKAGE_META_MALFORMED
2  验签      用**该源的当前有效公钥**验 plugin.meta.sig
             失败 → 再拉一次状态文档后重试；仍失败 → META_SIGNATURE_INVALID
3  载荷      逐项核对 files[] 与实际内容
             → PACKAGE_FILE_MISSING | PACKAGE_FILE_MISMATCH | PACKAGE_EXTRA_FILE
               DUPLICATE_ENTRY | PATH_OUT_OF_SCOPE
4  交叉校验   解析 manifest.json，比对 id/version/type/compat → META_MANIFEST_MISMATCH
5  身份一致   id 的命名空间、author.id、源域名三者一致 → AUTHOR_MISMATCH（§8）
6  版本比对   同一 (origin, id) → 升级；不同 origin 的同名 id → **是另一个插件**，互不影响
7  写安装记录 + 保存已验签的 meta 副本（§9）
```

- **验签永远是源作用域的**：用"本次操作的源"的当前有效公钥验，不需要"拿 keyring 里所有公钥逐个试"。这同时避免了"市场轮换后新包由新密钥签名、而新密钥还没进 keyring → 直接判签名非法、轮换流程根本没机会执行"的顺序问题。
- 跨源依赖：包声明 `dependencies.plugins[] = [{ origin, id }]`（同源依赖可省略 `origin`）。缺少所需源时**不自动添加**，而是提示管理员：
  - **仅下载该插件** → 一次性用该源公钥（TOFU）验签后安装，记录 `origin` 与签名指纹，但该源**未加入 keyring** ⇒ 无更新渠道（按 `unanchored` 处理，后续每次更新都需人工确认）；
  - **一并添加该源** → 走 §5 添加源流程，之后正常。

### 7.2 本地安装（`spc plugin install <dir|file>`）

> **✅ 已落地（2026-09-25，④ + ⑥c）**：作者信封与身份闸（④）；**源锚是第一期望值**、**“没给 `--source` 就按包的公钥自动落进作者的桶”**（恰好一个就用、多个歧义拒 `PLUGIN_SOURCE_AMBIGUOUS`、零个落杂桶）、**显式 `--source` 必须指向 keyring 里真有的桶**（否则 `SOURCE_NOT_CONFIGURED`，提示 `spc source add`），以及**装完的 promote 建议**（同一把钥第二例 ⇒ 打印"建桶 + 一起搬"两条现成命令，`manager.promoteSuggestion`）。

- **不验市场签名**，不联网；来源记为**具名本地源**（`local:<名字>`，默认 `local:default`）⇒ `unanchored`（**没有更新渠道**）；
- **但要处理作者身份**（v4；作者签名必产 —— 构建层强制签名，所以"无签名包"不存在）：
  ```
  1  读可选信封：plugin.meta.json + plugin.author.sig（都在 ⇒ 验；缺 ⇒ authorFingerprint = null，
     该包满足不了任何带 author.pub 的依赖声明）
  2  验"签名与包内 authorPub 自洽"（防呆 —— 首见时没有期望值，锚就是这次的首见值）
  3  取期望值（§3bis 的解析顺序：源锚 → 名册首见 → 首见即记），比对：
     不同 ⇒ PLUGIN_AUTHOR_MISMATCH，错误里给**两条出路**
            「换个桶：--source local:std-b」/「就在原桶改认：--accept-key-change」
  4  记名册 + 写记录 authorFingerprint；**打印**「归入 <来源>；作者公钥 <指纹>（首见/沿用）」
  5  同钥提示（promote，§3bis）：若另一个已装插件作者公钥相同 ⇒ 建议为该作者单独建源并搬迁
  ```
- 安装确认提示更多：展示清单摘要（文件数 / 大小）、全部权限请求与 `reason`，以及"**该插件没有更新渠道，后续更新需重新手动安装并在每次安装时确认**"；
- 提示之外**一切与所有插件平等**：可申请任何权限点、可担任任何插件类型、可被授予任何等级（§1 推论 1）。

### 7.3 错误码

顶层结构沿用 api-contract §2（顶层 `error` + `detail.code`/`detail.params`）；下表是 `detail.code`。核心与 HTTP/审计只走码，本地化只发生在渲染边界（CLI / 面板按 `err.<CODE>` 取词条）。

| 码 | 触发 | 处置 |
|---|---|---|
| `SOURCE_NOT_CONFIGURED` | 包 / 依赖指向的源不在 keyring | 拒 + 提示可添加源 |
| `SOURCE_DISABLED` | 源条目 `enabled: false` | 拒 |
| `SOURCE_SUSPENDED` | 源被暂停（§6.4） | 拒新装 / 更新 |
| `SOURCE_KEY_FETCH_FAILED` | 添加源时远程拉取公钥失败 | 不添加该源 |
| `PACKAGE_META_MISSING` / `PACKAGE_META_MALFORMED` | 缺信封文件 / 非法 JSON / 规范化失败 | 拒 |
| `META_SIGNATURE_INVALID` | 重拉状态文档后仍验签失败 | 拒 |
| `PACKAGE_FILE_MISSING` / `PACKAGE_FILE_MISMATCH` / `PACKAGE_EXTRA_FILE` / `DUPLICATE_ENTRY` / `PATH_OUT_OF_SCOPE` | 载荷清单不一致 | 拒 |
| `META_MANIFEST_MISMATCH` | meta 冗余字段与 manifest 不一致 | 拒 |
| `AUTHOR_MISMATCH` | 插件 ID 命名空间 / `author.id` / 源域名三者不一致 | 拒 |
| `PLUGIN_AUTHOR_MISMATCH` | 同 `(origin, id)` 内作者公钥与记录/锚不符（v4；**安装期**判定） | 拒 + **两条出路**：`--source <另一个桶>` / `--accept-key-change`（写审计） |
| `KEY_CHAIN_INVALID` | 链上任一跳签名不通过，或 `pub`/`fingerprint` 不自洽 | 暂停源 + 告警 |
| `KEY_ROTATION_UNVERIFIABLE` | 本地已信任节点不在 `keys[]` 中（含泄露后被移除） | 暂停源 + 告警 |
| `KEY_STATUS_ROLLBACK` | 状态文档早于本地高水位 | 暂停源 + 告警 |
| `KEY_STATUS_MALFORMED` | 状态文档结构非法（区别于网络失败 / 404） | 暂停源 + 告警 |
| `AUTHOR_SIGNATURE_INVALID` | `plugin.author.sig` 验不过，或 `meta.authorPub` 与**期望公钥**不符 | 拒（`params.reason` 区分 `signature` / `authorPub-mismatch`） |
| `PACKAGE_AUTHOR_SIG_MISSING` | 有源包缺 `plugin.author.sig`（信封文件） | 拒 |
| `PACKAGE_ENVELOPE_INCOMPLETE` | 本地包**只给了信封的一半**（meta 或 sig 缺一个） | 拒（要么两个都给，要么都不给） |
| `AUTHORS_INVALID` | 作者名册（`<STATE_DIR>/authors.json`）损坏 / 结构非法 / 指纹与公钥不自洽 | **拒**（绝不"当空名册继续跑"：那会把已知作者降级成首见 ⇒ 换一把钥就能静默装进来） |
| `PLUGIN_DEPENDENCY_IDENTITY` | 依赖目标的作者身份不符（`params.reason` = `author-mismatch` / `author-unknown`） | 依赖不满足 ⇒ 拒载 |
| `PLUGIN_DEPENDENCY_SOURCE` | 依赖声明本身不成立（如**市场包依赖本地源**） | 拒绝该声明 |
| `PLUGIN_DEPENDENCY_SOURCE_CHANGED` | 依赖解析不到目标，但**同名同作者**的插件在**别的来源**下（`params.foundAt` = 它在哪） | 拒载 + **把"它搬到哪去了"报出来**（多半是换过源：reanchor / promote；要么把依赖方一起搬，要么把它搬回来） |
| `PLUGIN_ANCHOR_MISMATCH` | 换源时目标桶绑的**作者锚**与被搬插件的 `authorFingerprint` 不符（插件没有作者身份而桶有锚，`params.actual = none`，同样这条） | 拒（那条桶声明不成立）；换一个桶，或先 `spc source anchor` 改锚 |
| `PLUGIN_REANCHOR_CONFLICT` | 换源的目标位置被占用（`params.reason` = `target-occupied` / `same-origin` / `data-dir-exists` / `config-exists`） | 拒（**不做合并**：静默合并两份数据/配置是事故） |
| `PLUGIN_REANCHOR_FAILED` | 搬文件失败（`params.move` = 哪一步、`reason` = 底层错误） | 记录**未改动**（已搬目录尽力回滚）⇒ 检查目标位置后重试 |
| `SOURCE_IN_USE` | 删源时该来源**仍有插件归属**（`params.count` = 已装个数） | 拒；先搬走（reanchor）或卸载 |
| `SOURCE_BUILTIN` | 删的是**内置来源**（官方市场 / 杂桶 `local:default`） | 拒；它由核心在启动时播种，删了下次启动还会回来 |
| `SOURCE_KEY_FETCH_FAILED` | `spc source add <市场域名>` 不带 `--pub` 时远程拉取状态文档失败（`params.reason` = 状态文档的码） | **不添加该来源**（公钥未知的源等于谁都验不了的源） |
| `SOURCE_ANCHOR_NOT_ALLOWED` | 给**市场源**绑作者锚 / 给非本地源改锚 | 拒（市场是多作者命名空间，锚只属于本地桶） |
| `SOURCE_PUB_NOT_APPLICABLE` | 给**本地桶**写源公钥 | 拒（本地源不签任何包；要绑定作者请用 `authorAnchor`） |
| `SOURCE_KIND_IMMUTABLE` | 试图把条目的 `kind` 从 `market` 改成 `local`（或反向） | 拒（`origin` 与 `kind` 都是主键的一部分，不可改） |
| `KEYRING_INVALID` | keyring 文件整体非法（坏 JSON / 形状不对）——**单条非法只忽略该条 + 告警**，不报这个码 | **拒**（不猜内容，也不"当空 keyring 继续跑"） |

## 8. 身份与引用

| 标识 | 形态 | 唯一性范围 | 用途 |
|---|---|---|---|
| **插件 ID** | `@xfy2412/docker` | **市场内**（市场注册时保证不冲突） | manifest / meta、市场内索引、依赖 |
| **作者 ID** | `xfy2412@market.spc.xfyweb.cn` | 全局 | 审计与展示（格式像邮箱，但**不是邮箱**，不需要 DNS / 邮箱验证） |
| **作者公钥**（v4） | `sha256:<指纹>` | 全局（指纹唯一） | **依赖身份**：`dependencies.plugins[].author`、`authors.json` 名册、reanchor 的同一性证明 |
| **来源** | `market.spc.xfyweb.cn` / `local:dev-a` | 全局 | **唯一性锚**（身份 = `(origin, id)`）+ 更新渠道（本地源只有前者） |
| **完整引用** | `market.spc.xfyweb.cn/@xfy2412/docker` | 全局 | 安装记录、CLI / 面板展示、**所有跨插件引用**（调用目标 / topic / 端点 path / 依赖声明 / 权限点名） |

- **作者 ID 由市场分配**：用户名由市场管理（注册不得冲突），域名是市场域名；作者 ID 的本地部分与插件 ID 的命名空间**强一致**。
- **强一致校验**（有源包）：`id` 的 `@username` == `author.id` 的本地部分，且 `author.id` 的域名 == 源域名；不一致 → `AUTHOR_MISMATCH`（`author.id` 为**可选**字段，缺省时跳过该校验，作者信息由源推断）。
- **跨市场不保证唯一**：同一个 `@a/x` 出现在两个源就是**两个不同的插件**（完整引用不同），各自安装、各自更新、互不影响。
- **同 `(origin, id)` 内、作者公钥不同 ⇒ 拒装**（`PLUGIN_AUTHOR_MISMATCH`，v4）：那是"这个插件换人了"，必须管理员裁决（显式接受换钥 / 换个源 / 先卸载）。判据始终是**公钥**，不是 `author.id`。
- **换源（reanchor）是显式动作**（v4 修订；原先写的是"不存在换源升级"）：**公钥相同、来源不同**时可把记录搬到新来源，数据 / 配置 / 授权一起走，**点名随源重写**（`docs/events-and-hooks-design.md` §3.6）。
- **本地来源必须具名**（v4）：`local:<名字>`（默认 `local:default`）——`null` 会让所有本地安装坍缩到同一个键上，两个不同的人做同名插件必然相撞。
  **2026-09-24 细化**（§3bis）：本地源**就是一个作者的桶**（源的身份 = 那把作者公钥，名字只是标签），`local:default` 是装"作者只出现过一次"的**杂桶**；同作者第二例出现时**建议独立成源**再搬迁。
  ⇒ **对本地包，唯一性实际来自作者公钥**（桶名是装机人起的标签，作者签名时不可能知道它）——这一点直接决定了依赖声明里 `origin` 的四格规则（`events-and-hooks-design.md` §3.5）。
- 程序内部以 **`(origin, id)` 二元组**为准；**完整引用既用于展示与记录，也用于跨插件引用**（"不做反向解析"承担了避免解析歧义这件事）。
- 保留名（`admin`、`support`、`official` 等）由**市场侧**在注册时禁用，客户端不做判断。

## 9. 安装记录与加载时校验

```jsonc
// 安装记录（宿主侧）
{
  "origin": "market.spc.xfyweb.cn",       // 具名来源；本地 = "local:<名字>"（**不可为空**，v4）
  "id": "@xfy2412/docker",
  "version": { "code": 12, "name": "1.2.0" },
  "signedBy": "sha256:<市场签名公钥指纹>",
  "authorFingerprint": "sha256:<作者公钥指纹>",   // v4：依赖身份 + "防同名顶替"的判据
  "verifiedMeta": "<已验签的 plugin.meta.json 原件>",
  "installedAt": "2026-09-12T00:00:00Z",
  "grants": ["docker.read", "docker.write"]
}
```

> **完整引用 `<origin>/<id>` 是派生的**（v4：**不落记录**，避免两处真相）：记录的唯一键是 `(origin, id)`
> 二元组；展示、管理命令与跨插件引用统一走 `pluginRef()`（`core/plugin/records.ts`）。

- **启动时只校验本地文件哈希**（对照 `verifiedMeta.files[]`），**不重验市场签名、不联网**。理由：轮换与泄露处置会移除旧公钥，若启动时重验，换密钥就会让已装插件全部起不来；完整性由"宿主侧保存的已验签 meta + 磁盘文件哈希"保证——期望值存在**插件目录之外**，否则改写包内 meta 即可绕过。
- **作者签名同理**：加载时**不重验作者签名**（`authorFingerprint` 与 `authors.json` 已在安装 / 换源时核对过）；它只在**安装 / 更新 / reanchor / 依赖解析**时使用。
- 签名只在**安装 / 更新**时使用。

## 10. 明确不做

| 不做 | 理由 |
|---|---|
| 去中心化分发 / 身份文档 / 命名空间委任 | 分发仍是中心化的（发布必经市场）；**作者签名（v4）只做依赖身份**，不承担"证明你是谁"（§1 推论 3、§3bis） |
| KSL / CRL / OCSP / 在线吊销 | 用 `revoked[]`（市场声明、客户端展示的吊销信息）替代：它是**文档里的数据**，不是查询服务，离线可见 |
| 吊销记录参与密码学判定 | 级联泄露时最有价值的记录恰恰由已吊销密钥签发（§6.1.1）；暂停只由"本端节点是否仍在 `keys[]`"触发，吊销记录仅供展示与审计 |
| 文档里的"紧急模式"开关（`emergency`） | 安全路径不需要它：设备在已移除的密钥上会自动暂停，链完好的设备则可安全前进；而它的启用与清除时机无从定义 |
| 心跳鉴权、设备绑定 | 与核心离线冲突；源码可读，防不住真盗版 |
| 自定义二进制签名容器 | 签名对象是结构化清单（§2） |
| **镜像**（同一市场多域名互为镜像） | 暂不做：**自建源允许**（自建市场同样是市场），但同一市场不做镜像；慢的方向通常是国内下国外，而非反向 |
| 域名组（多域名互为信任） | 暂不做，留档 |
| 内容分发走 CDN / 子域 | **允许**（内容哈希与传输通道无关），但 `origin` 与 `.well-known` 只认主域名 |
| 把"审核强度"写进运行时判定 | 不可验证、不可证伪；审核结论是市场页面上的展示信息 |
| 权限点携带身份 / 信任字段 | 身份与能力正交（§1 推论 1） |
| 加载时重验市场签名、启动时联网 | §9 |
| 自动新增源、自动下载并执行任何动作 | 信任集只能由管理员显式扩大 |

**失效与撤销**：市场侧吊销密钥 = 写进 `revoked[]`（**声明性信息**，客户端累计展示，不影响判定）；本地手段是删除源条目 → 该源的新装/更新被拒（已装版本不动）；`enabled: false` → 同上但保留条目；`suspended` → 临时拦截等管理员确认；已装插件用 `spc plugin disable`。**密码学上无法远程收回已落地的私钥权限，任何系统都不行。**

## 11. 落地清单

**本轮（文档）**：本文件 + ADR-001 v3 + ADR-003 + ADR-005 + api-contract §6/§7/§9 + manifest-design + management-channel + market-license-design + ROADMAP + README；删除已被本文件与 ADR-001 取代的 `namespace-and-trust-draft.md`。

**下轮（代码）**：

| 位置 | 改动 |
|---|---|
| `core/permissions/registry.ts` | 删 `ProtectionLevel`、`Tier`、`defaults`；权限点改为 `{name, group, description, scope: 'self'\|'host', confidentiality, executionLevel}` |
| `core/permissions/check.ts` | 删 `tier` 参数与 `TIER_DENIED` / `LEVEL_OFFICIAL_ONLY`；判定链 = 未登记 / 未声明 / `scope=host` 未授予（`NOT_GRANTED`）；授权按点且**不接受通配** |
| `core/main.ts` | 删"由 id 前缀推导信任档" |
| `core/`（新） | keyring（域名主键 + 可选公钥 + `suspended` + 高水位含吊销累计）、状态文档拉取与**链验证**、安装/更新流、安装记录（`verifiedMeta`）、启动时文件哈希校验、源信息展示（§6.3） |
| `sdk/schema/` | `manifest.schema.json`：`id` pattern 改 `^@[a-z0-9][a-z0-9_-]{0,62}/[a-z0-9][a-z0-9_-]{0,62}$`、`author.id` 格式、`dependencies.plugins[].origin`；新增 `meta.schema.json` |
| 测试与示例 | 权限测试去掉 protectionLevel / `defaults` / official 分支；新增链式轮换、暂停、防回滚、清单校验用例 |
| **旧 id 形态的落点**（v3 前是 `official:` / `thirdparty:`，全部改为 `@username/name`） | `core/main.ts`（由 id 前缀推导信任档的那段，整段删除）、`core/permissions/registry.ts`（`Tier` + 三处 `defaults`）、`core/permissions/check.ts`（`tier` 参数与两个码）、`sdk/types.ts` 的 `Manifest.id` 注释、`sdk/schema/manifest.schema.json` 的 `id`（pattern 与 description）、`plugin/hello/manifest.json` 的 `id`（当时目录名是 `plugin/sample`）、`sdk/__tests__/manifest.test.ts`（4 处）、`core/__tests__/permissions.test.ts`（6 处）、`core/__tests__/sandbox.test.ts`（4 处 + `tier`）、`core/__tests__/cli.e2e.test.ts` 的 `plugin list` 断言 |
| i18n | `err.LEVEL_NEEDS_GRANT` → `err.NOT_GRANTED`；新增 §7.3 各码与 §6.3 吊销原因码的词条 |

> 本表记录的是**签名轮当时**落地的形态。后续（P2 权限层）判定链第 3 步改为"**仅 `explicit` 档需逐点授予**"，权限点新增 `grant: auto | install | explicit` 字段——见 intent-capture §8.1/§8.2。
>
> ⚠️ 落点**只写符号，不写行号**：行号是**提交相对**的，落笔当天就开始烂。本表原来写了 5 个行号，
> 而把那些行删掉的正是 `e1c28c8`（插件 ID 迁移）——迁移一落地，5 个行号**全部指错**
> （`core/main.ts` 那一处落到了 CLI 横幅 `console.log('[spc] state=…')` 上，且没有任何东西会报错）。
> `tools/check-line-refs.mjs` 现在会把这类"引我们自己源码行号"的写法直接判失败。

## 12. 待定

1. ~~**分发容器后缀**~~ **✅ 已定（2026-09-11）：`.spc` = 标准 zip 容器，且校验不依赖容器字节** —— 同批定下「**不用自定义二进制**」（签的是**安装意图**，不是容器字节流；包会经 CDN / 镜像 / 用户重打包，压缩方式、mtime、顺序、权限位都会变；确定性靠规范化 JSON 拿，不靠自研格式）。
   ⚠️ **2026-10-12 核对早期记录后修正**：原先这里记成"已定（2026-09-25，用户拍板）：**确定性 zip**（手写 local file header + central directory、`zlib` raw deflate、时间戳固定 ⇒ 同输入字节一致、不引新依赖）"——其中
   ① "**容器字节一致**"2026-09-26 已被砍掉（承诺只管**载荷**，见 `build-layer-design.md` §2.1）；
   ② "**手写 zip / 不引新依赖**"的出处是 2026-09-25 **助手那张提问卡片** —— 选项把"zip / 手写 / 不引依赖 / 字节一致"**四件事捆成一个**，用户点的是"zip"（工具卡片不进会话导出，事后查不到它问过什么）⇒ **留到 ⑦c 定**（判据见 `build-layer-design.md` §10.6）。
   载荷就是构建产物目录（清单与载荷同级）。
2. 状态文档的 TTL 默认值与是否允许管理员调整。
3. 一次性验签（"仅下载该插件"）是否也写入 `highWater`（当前设计：不写）。
4. ~~**`releasedAt` 归谁写**（v4 新增）~~ **✅ 已定（2026-09-25，用户拍板）**：**构建期填 + 市场核对/拒签**（本文原口径）。理由：meta 由构建工具产出、市场只追加签名 ⇒ 让市场自己定就得改成"市场改写字节 + 作者签名缩小覆盖范围"，代价更大。将来市场若要加自己的事实，用独立的签名对象，不要改写 meta。
5. ~~**作者私钥怎么保管**（`spcdev keygen` 的形态）~~ **✅ 已定（2026-09-25，用户拍板）+ 已落地（V 批）**：**单文件 JSON**（`{ schema: 1, alg: 'ed25519', seed, pub, fingerprint, createdAt }`，种子是 base64 裸 32 字节）+ **无 passphrase** + `chmod 600`；私钥**永不进包**。实现：`build/keys.ts` 的 `AuthorKey` / `saveAuthorKey` / `loadAuthorKey`（种子走 PKCS#8 DER 前缀推公钥，见该文件的注释）；工作区与路径约定见 `build-layer-design.md` §10.4（`.spcdev/keys/author.key`）。
6. ~~**`keyring` 里 `kind: 'local'` 的具体形状**~~ **✅ 语义已定（2026-09-24，§3bis + §5 末）**：本地源 = **一个作者的桶**（可选 `authorAnchor`）+ `local:default` 杂桶 + 同钥第二例建议独立成源（promote）。**✅ 条目与 `spc source` CLI 已落地（2026-09-25，⑥a）**（面板源清单仍属 P3）；promote 的搬运复用 **⑥ reanchor**（批量、原子、列全会被打断的依赖方）。
7. ~~**`authors.json` 的换钥接受流程**~~ **✅ 已定（2026-09-24）**：安装时 **`--accept-key-change`**（显式、落审计含旧/新指纹）；不给该开关就 `PLUGIN_AUTHOR_MISMATCH` 拒装，错误里同时给"换个桶"那条出路。面板入口归 P3。
8. **promote 的触发与呈现细节**：建议在"安装成功后"打印（非交互），是否还要一个 `spc source suggest` / 面板上的一键搬迁入口，留到 P4 与源清单一并定。
