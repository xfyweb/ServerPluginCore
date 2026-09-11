# 草案：命名空间与信任档解耦（namespace & trust）

- 状态：**信任部分已定案**——信任档已由 **plugin-signature-design.md（签名与身份设计）** 定案，并在 ADR-001 v2 落地；本文件只保留**仍未决的 id 形态与迁移清单**
- 关联：ADR-001（信任模型 v2：锚定两档）、ADR-003（市场开源：用户可自建/镜像 registry）、plugin-signature-design.md、manifest-design（Android 对照）、api-contract §6/§9
- 触发：市场开源后"官方 vs 第三方"二分法不再成立，且 id 前缀同时承担了"身份 / 来源 / 信任"三件事

## 1. 问题：一个前缀压了三件事

| 维度 | 现状载体 | 问题 |
|---|---|---|
| **身份**（这是谁） | `id` 前缀 `official:` / `thirdparty:` | 身份里塞了信任判断，发布者本身没有命名空间 |
| **来源**（从哪个市场装） | 同上（隐含） | 用户可自建/镜像市场（ADR-003），来源不是二元的 |
| **信任**（谁签的名、审核强度） | 同上（`id.startsWith('official:')` 推导 `Tier`） | 第三方市场也可以有审核与签名；官方也可能有不同档 |

**Android 的正确读法**（我们当初的参照）：包名（`com.example.app`）**只是发布者命名空间，不承载信任**；信任来自两处——
- **签名** → `signature` 级权限（同签名才可用）；
- **安装来源/系统分区** → privileged/system 应用的额外能力与安装体验。
来源（Play / sideload / 其他商店）**从不写进包名**。

**结论**：`official:` 前缀把 Android 里本应分离的两件事合并了，且只有两档。

## 2. 现状引用点（迁移影响清单）

| 位置 | 现状 | 影响 |
|---|---|---|
| `sdk/schema/manifest.schema.json` | `^(official\|thirdparty):[a-z0-9][a-z0-9_-]{0,62}$`（`id` 与 `dependencies.plugins[].id`） | 改 pattern（签名块已删，见 plugin-signature-design §10） |
| `sdk/types.ts` | id 注释 | 改注释 |
| `core/main.ts:36` | `manifest.id.startsWith('official:') ? 'official' : 'thirdparty'` | **改为"安装记录里的签名锚定状态 → `Anchor`"**（P4 前为桩） |
| `core/permissions/registry.ts` | `Tier = 'official' \| 'thirdparty'`、`defaults: {official, thirdparty}` | `Tier` → `Anchor`；**取消按信任档分档的 `defaults`**（权限基线只由 `protectionLevel` 决定） |
| `core/permissions/check.ts` | 等级矩阵（`secret`/`high` 仅官方）+ 文案 | 等级矩阵改为"`secret` 仅 `anchored`"；`LEVEL_OFFICIAL_ONLY` → `LEVEL_ANCHORED_ONLY` |
| `core/i18n/locales/zh-CN.json` | `err.LEVEL_NEEDS_GRANT` 等文案 | 文案 |
| 测试 4 处 | manifest.test / permissions.test / sandbox.test / cli.e2e（`official:sample`） | 用例更新 |
| `plugin/sample/manifest.json` | `official:sample` | 示例更新 |
| 文档 | ADR-001（已 v2 修订）、ADR-003（已改）、manifest-design、api-contract、market-license-design、ROADMAP、README | 术语与语义 |
| 审计条目 | 目前只记 `pluginId` | 建议增 `anchor` / `anchorKey`（可选） |

## 3. 方案对比（信任部分已定案）

| 方案 | id 形态 | 评价 |
|---|---|---|
| A. 最小改动 | 保留 `前缀:`，语义改为"发布者/来源"（如 `spc:docker`、`xfy2412:docker`） | 改动小；但"来源写进身份"的老问题还在 |
| **B. 身份与信任分离（推荐）** | **发布者命名空间**：`@publisher/name`（npm scope 风格） | 与 Android 语义对齐；多市场天然支持；业界辨识度好 |
| C. B 的保守变体 | 保留 `:` 分隔，左半段 = 发布者命名空间 | schema pattern 只改语义不改形状，迁移更小 |

**信任档已定案为"锚定两档"**（完整设计见 plugin-signature-design.md §4/§7）：

| 档位 | 判定 | 差异 |
|---|---|---|
| `anchored` | 签名链走到管理员 keyring 里的某个公钥（内置官方 / 自建市场 / 管理员直锚的开发者公钥，**三者等价**） | 可占用命名空间；签名者与锚不变时可静默升级；`secret` 级可经管理员**显式授予** |
| `unanchored` | 走不到 | 不占用命名空间；每版人工确认；`secret` 级不受理 |

> 取消"三级（official / verified / community）"的原因：**"审核强度"在运行时不可验证、不可证伪**，把它编码成档位只带来虚假安全感与维护负担——审核结论属于市场页面上的展示信息。四类差异之外，能力一律由"声明 + 管理员显式授予"决定。

## 4. 待决问题

1. **id 形态（唯一阻塞项）**：`@publisher/name`（推荐）/ `publisher:name`（改动最小）/ 反向域名？
2. **旧 id 迁移**：`official:` / `thirdparty:` 是否接受一段时间（映射 official→anchored、thirdparty→unanchored）？项目尚未发布 v1，倾向硬切。
3. **审计字段**：审计条目是否加 `anchor` / `anchorKey`（便于统计与排障）？

已定案（不再讨论）：

- **信任根** = 管理员 keyring，条目别名由管理员命名（"来源"显示标签由此推导）；
- **包内不自报来源**：`source: market|community` 一类字段取消；
- **manifest 保持纯净**：不放 registry / publisher / 签名块；来源与签名都在交付层；
- **降级 ≠ 授予**：锚定只影响命名空间归属、更新资格、安装摩擦与 `secret` 准入。

## 5. 建议执行顺序（定稿后）

1. 定 id 形态 → 写入 manifest-design（id 规则）与 ADR-003（防仿冒）；
2. 代码：`sdk/schema` pattern → `core/main.ts` 锚定推导（桩：`anchored` 仅当安装记录带签名身份）→ `registry.ts`（`Anchor` + 取消 `defaults`）→ 文案；
3. 测试与示例：manifest / permissions / sandbox / cli 四处 + `plugin/sample`；
4. 签名链本体按 plugin-signature-design.md §10 的落地清单在 P4 实施。
