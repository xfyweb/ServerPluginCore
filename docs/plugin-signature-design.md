# 插件签名与源（市场签名 + 密钥轮换）

- 状态：**设计基线（v3：市场签名）**——本轮为文档定稿；代码改动清单见 §11
- 关联：ADR-001（信任模型 v3）、ADR-003（市场开源与密钥管理）、ADR-005（沙箱与插件类型）、manifest-design.md（manifest 字段）、market-license-design.md（下载控制面与授权）、api-contract.md §2/§6/§9
- 定位：本文件只回答"**这个包由哪个源签名、有没有被改过、还能不能更新**"，不回答"它能干什么"——后者由沙箱（ADR-005）、权限注册表与管理员授予决定。

## 1. 安全模型分层

| 层 | 管什么 | 机制 | 失效后果 |
|---|---|---|---|
| **运行时** | 插件**能做什么** | 零环境权力沙箱 + 权限注册表 + 逐方法参数解析与校验 | 越权调用被拒 + 审计告警 |
| **交付/更新** | 包由哪个源签名、有没有被改过、还能不能更新 | 市场签名 + 源（keyring）+ 密钥轮换 + 清单校验 | 拒绝安装/更新；**已装插件不受影响** |
| **人工** | 代码**写得对不对** | 市场审核 + 代码分析 + 管理员复审 | 降低概率，不能保证 |

三条推论：

1. **签名不参与权限判定**。来源只决定"有没有更新渠道"和"提示强度"；任何权限点（含最高等级）都与来源无关，只看"manifest 声明 + 管理员授予"。
2. **签名买的是"可归因的更新通道"**：任何人替换包内字节都会被验签拦下；但它对**已落地代码的运行**没有任何约束力——那是运行时层的事。
3. **不做开发者签名**。分发是中心化的（发布必经市场），开发者签名只在"去中心化分发"场景下有立足点。这与 apt 的仓库级签名一致：开发者上传签名只是审计痕迹，**客户端只验市场签名**。

> 术语：**市场**是远端服务（域名 + 密钥 + registry + 审核）；**源**是 keyring 里代表"我信任这个市场"的本地条目；`origin`（域名）是源的主键。

## 2. 分发单元

```
foo-1.2.0.spc/                  （zip 容器；校验不依赖容器字节）
  plugin.meta.json              被签对象（规范化 JSON）
  plugin.meta.sig               **市场** Ed25519 裸签名（64 字节）
  manifest.json                 ─┐
  main.js                        │ 载荷：每个文件必须逐项出现在 files[]
  web/**                         │
  i18n/**                       ─┘
```

- 除两个信封文件外，**容器内任何文件都必须出现在 `files[]` 中**，否则拒装（`PACKAGE_EXTRA_FILE`）。两个文件名是约定，不在元数据里声明路径。
- **不做自定义二进制容器**：签名对象是"安装意图"（结构化清单），不是容器字节流——包会经重新打包，压缩方式、条目顺序、mtime 都会变，确定性由规范化 JSON 保证。
- 包内**不含证书、不含密钥**：签名者不由包自述，而由"这次操作使用的源"确定（§7）。

## 3. `plugin.meta.json`

```jsonc
{
  "metaSchema": 1,

  // 身份冗余：与 manifest 一致，用于"不解析载荷就快速拒绝"
  "id": "@xfy2412/docker",
  "version": { "code": 12, "name": "1.2.0" },
  "type": "ability",
  "compat": { "minCore": "0.1.0" },

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
| `metaSchema` | ✔ | 元数据 schema 版本（与 `manifest.schema` 各自演进） |
| `id` / `version` / `type` / `compat.minCore` | ✔ | 冗余缓存，必须与 `manifest.json` 一致，否则 `META_MANIFEST_MISMATCH` |
| `releasedAt` | ✔ | 发布时刻（授权判定锚点，见 market-license-design §3） |
| `build` | ✘ | 构建描述 |
| `files[]` | ✔ | `path` 必须为相对路径且规范化后不含 `..`（复用 `core/fs/safe-path.ts` 规则）；重复 `path` → `DUPLICATE_ENTRY`；建议按 `path` 升序输出 |

- **签名对象 = 规范化后的整个 meta 字节**（§4）。
- **不设 `signer` / `cert` / `source` / `registry` 字段**：签名者由验签时使用的源确定；来源由宿主的 keyring 条目推导（§5），包内自报的来源不可信且冗余。

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

- **不验签**，不联网；记录 `origin: null` ⇒ `unanchored`；
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
| `KEY_CHAIN_INVALID` | 链上任一跳签名不通过，或 `pub`/`fingerprint` 不自洽 | 暂停源 + 告警 |
| `KEY_ROTATION_UNVERIFIABLE` | 本地已信任节点不在 `keys[]` 中（含泄露后被移除） | 暂停源 + 告警 |
| `KEY_STATUS_ROLLBACK` | 状态文档早于本地高水位 | 暂停源 + 告警 |
| `KEY_STATUS_MALFORMED` | 状态文档结构非法（区别于网络失败 / 404） | 暂停源 + 告警 |

## 8. 身份与引用

| 标识 | 形态 | 唯一性范围 | 用途 |
|---|---|---|---|
| **插件 ID** | `@xfy2412/docker` | **市场内**（市场注册时保证不冲突） | manifest / meta、市场内索引、依赖 |
| **作者 ID** | `xfy2412@market.spc.xfyweb.cn` | 全局 | 审计与展示（格式像邮箱，但**不是邮箱**，不需要 DNS / 邮箱验证） |
| **完整引用** | `market.spc.xfyweb.cn/@xfy2412/docker` | 全局 | 安装记录、CLI / 面板展示、跨源依赖 |

- **作者 ID 由市场分配**：用户名由市场管理（注册不得冲突），域名是市场域名；作者 ID 的本地部分与插件 ID 的命名空间**强一致**。
- **强一致校验**（有源包）：`id` 的 `@username` == `author.id` 的本地部分，且 `author.id` 的域名 == 源域名；不一致 → `AUTHOR_MISMATCH`（`author.id` 为**可选**字段，缺省时跳过该校验，作者信息由源推断）。
- **跨市场不保证唯一**：同一个 `@a/x` 出现在两个源就是**两个不同的插件**（完整引用不同），各自安装、各自更新、互不影响；不存在"换源升级"这种操作，因此也不需要 `NAMESPACE_TAKEN` 之类的冲突码。
- 程序内部以 **`(origin, id)` 二元组**为准，完整引用字符串只用于展示与记录（避免字符串解析歧义）。
- 保留名（`admin`、`support`、`official` 等）由**市场侧**在注册时禁用，客户端不做判断。

## 9. 安装记录与加载时校验

```jsonc
// 安装记录（宿主侧）
{
  "ref": "market.spc.xfyweb.cn/@xfy2412/docker",
  "origin": "market.spc.xfyweb.cn",       // null = 本地安装（unanchored）
  "id": "@xfy2412/docker",
  "version": { "code": 12, "name": "1.2.0" },
  "signedBy": "sha256:<签名公钥指纹>",
  "verifiedMeta": "<已验签的 plugin.meta.json 原件>",
  "installedAt": "2026-09-12T00:00:00Z",
  "grants": ["docker.read", "docker.write"]
}
```

- **启动时只校验本地文件哈希**（对照 `verifiedMeta.files[]`），**不重验市场签名、不联网**。理由：轮换与泄露处置会移除旧公钥，若启动时重验，换密钥就会让已装插件全部起不来；完整性由"宿主侧保存的已验签 meta + 磁盘文件哈希"保证——期望值存在**插件目录之外**，否则改写包内 meta 即可绕过。
- 签名只在**安装 / 更新**时使用。

## 10. 明确不做

| 不做 | 理由 |
|---|---|
| 开发者签名 / 身份文档 / 命名空间委任 | 中心化分发下没有立足点（§1 推论 3） |
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

1. 分发容器后缀（当前示例用 `.spc`）。
2. 状态文档的 TTL 默认值与是否允许管理员调整。
3. 一次性验签（"仅下载该插件"）是否也写入 `highWater`（当前设计：不写）。
