# 构建层设计（打包流水线）

- 状态：**设计基线**（P2-2；§7 的实测结论已验证，其余为实现契约）
- 关联：ADR-005 §6/§7（构建层 hook + 依赖三层）、plugin-signature-design §2–§5（元数据与签名）、module-emulation-design §10（builtin 联动）、plugin-lifecycle-design（产物如何被装载）、ROADMAP P2-2
- 定位：回答"**插件怎么从源码变成一个能装、能跑、可审查的单文件产物**"。

## 0. 一句话

构建层是**依赖管控的执行点**（ADR-005 §6）：能进产物的东西在这里定生死——**编译期不可达的代码，运行期就不可能出问题**。

## 1. 目标与非目标

**目标**

- `pnpm build:plugin <目录>` → `dist/bundle.js` + `plugin.meta.json`；
- 依赖闭包**静态解析 + tier 判定 + 内建登记表校验**，违规**构建失败**（不是运行期拒绝）；
- 产物可被现有 `spc plugin install` 装载（`plugin-lifecycle-design` 不改契约）。

**非目标（本阶段不做）**

- **签名**：市场密钥属 P4；本层只产出**可被签名覆盖**的元数据（逐文件哈希 + 规范化）；
- **市场发布**：上传/下载控制面属 P4；
- **可复现构建验证**：ADR-005 §6 提过"同输入同输出比对哈希"，本层只保证**确定性输出**（同样的输入产出同样的字节），验证机制待定（见 §9）；
- **依赖安装**：本层**不跑** `npm install`——依赖由开发者在插件仓库里自己管好，本层只做校验与打包。

## 2. 产物形态

```
dist/
├── bundle.js         单文件 ESM 产物（沙箱按源码文本加载，见 plugin-lifecycle-design §1.1）
└── plugin.meta.json  元数据（供安装流与签名使用）
```

`plugin.meta.json`（与 plugin-signature-design §2 对齐）：

```jsonc
{
  "metaSchema": 1,
  "id": "@xfy2412/sample",
  "version": { "code": 1, "name": "0.0.1" },
  "entry": "bundle.js",
  "files": [{ "path": "bundle.js", "sha256": "…", "bytes": 12345 }],
  "dependencies": {
    "npm": [{ "name": "zod", "resolved": "4.6.5", "tier": "whitelist" }],
    "builtins": [{ "specifier": "node:path", "module": "path", "registered": true }]
  },
  "build": { "tool": "esbuild", "version": "0.28.2", "target": "es2022", "platform": "node" }
}
```

要点：

- `dependencies.npm[].resolved` 记**实际解析到的版本**（不是 manifest 里写的区间）——"装的是哪个版本"必须可追溯，否则用户放行的"插件+版本"没有落点；
- `dependencies.builtins` 是**审查面**：让管理员一眼看到"这个插件用到了哪些宿主仿真模块"；
- `build` 段记录构建参数，为将来的可复现验证留位。

## 3. esbuild 配置决策（**基于 §7 实测**）

```js
await esbuild.build({
  bundle: true,
  format: 'esm',            // ESM-only 硬约束（ADR-005 §4）
  platform: 'node',         // ★ 见下，不是风格问题
  target: 'es2022',
  write: false,
  logLevel: 'silent',       // 错误自己归类成契约错误码，不透传 esbuild 文案
  absWorkingDir: pluginDir,
  plugins: [builtinRedirect],   // §5 第一道闸
});
```

**`platform` 的选择是安全决策**——实测三种取值的行为差异（矩阵见 §7）：

| platform | 内建引用 | CJS 包 | 结论 |
|---|---|---|---|
| `node` | **externalize，原样留在产物里**（`__require("tty")`） | 正常解析（用 `node` 条件，与作者测试的环境一致） | ✅ **选它**——引用留在产物里才**可扫描** |
| `browser` | 被"浏览器分支"绕开 → **构建通过但静默换了实现** | 正常解析（走 `browser` 条件） | ❌ 不可审计：你无法从产物看出原本要什么、被换成了什么 |
| `neutral` | 报 `Could not resolve` | **解析失败**（不适用 `main`/`exports` 的 node 条件） | ❌ 大量真实 CJS 包直接不可用 |

**为什么不用 browser 的"自动降级"**：它让构建通过，而作者以为自己在 node 语义下运行。某些包会拿到**完全不同的实现**（`crypto` 的多态填充、内存版 `fs`），行为不可预测；而且它**违背 fail-closed**——出问题时你看不出发生过替换。

## 4. 依赖闭包与 tier 判定

```
1  读 manifest.dependencies.npm（直接依赖）
2  解析**整棵闭包**（含传递依赖）——只查直接依赖是供应链最常见的漏洞形态
3  逐个判定：
     · 命中 L1 白名单           → tier: whitelist（平台托管，无需用户放行）
     · 未命中、且是纯 JS 可达    → tier: user-opt-in（**只标记**，放行在安装期）
     · 闭包内出现原生/二进制     → 构建失败（L3）
4  不跑任何 lifecycle 脚本（--ignore-scripts 等价），并把它作为**风险信号**记进元数据
```

三条与 ADR-005 §7 相关的重要澄清：

1. **判据不是"纯 JS"，而是"依赖闭包内的内建引用全部命中仿真登记表"**。"纯 JS"是描述而非判据——它无法静态判定、且绕起来容易（拆包、动态扩展名）。原生模块只是"永远登记不了"的那一类特例，因此 **L3 不需要单独定义**（不需要"重型二进制"的体积阈值）。
2. **构建期只能"标记" L2，不能"放行" L2**：构建发生在**开发者机器**上，开发者的勾选等于自己给自己发许可。真正的放行发生在**安装期**（管理员），按"插件 + 版本"记录。见 §9-2。
3. **`node:*` 内建不是 npm 依赖**：它们走 §5 的仿真登记表，不走依赖三层。两者是正交的——白名单管"值不值得信任"，登记表管"能不能跑"。

## 5. builtin 校验：两道闸

### 第一道 —— 解析期重定向（esbuild 插件）

| specifier | 处理 |
|---|---|
| `@host/api` | **保留**（沙箱内由宿主注入，不由构建层处理） |
| 已登记的 `node:xxx` / 裸名内建 | **重定向到仿真模块**（构建层产出对应 shim，沙箱内走宿主注入） |
| 未登记的内建 | **构建失败**，文案必须指出"**沙箱尚未支持 X**"，而不是让作者以为代码写错（module-emulation-design §13-5） |
| 第三方包 | 正常解析 + 内联 |

> 重定向这一步是**必需的**：只是"允许"不够——`platform: node` 会把内建 externalize 成 `__require("fs")`，而沙箱里**没有 `require`**，即便登记了也跑不起来。

### 第二道 —— 产物断言（不信 esbuild 的报错）

**实测结论：不能只靠 esbuild 报错。** CJS 包的 `require('tty')` 在 `platform: node` 下**不会让构建失败**，它被转成 `__require("tty")` 兜底留在产物里（§7 证据）。

所以产物出来后还要断言：

```
产物里不允许出现 __require / require( 的**调用**
  —— 沙箱里根本没有 require；任何残留都说明有东西没被静态解析
  （辅助函数的定义行可以放过，调用点不行：`__require("tty")` 这类）
```

这条规则的好处是**自洽且不需要维护名单**：它拦的是"esbuild 没能静态解析"这个事实本身，而不管引用的是哪个内建。

## 6. 与签名、装载的关系

- 元数据**逐文件哈希**覆盖 `bundle.js`（`core/sources/canonical.ts` 已落地）→ 签名后篡改产物即可发现；
- **但哈希只能证明"文件没被改"，不能证明"产物与声明的依赖图一致"**——声明 `zod@L1` 却打包别的东西，哈希看不出来。这块的缺口与处置见 §9-1；
- 装载侧**不改契约**：`plugin-lifecycle-design` 的入口解析已支持"记录/清单指定的入口"，本层只让 `entry` 指向 `dist/bundle.js`。

## 7. 实测记录（esbuild 行为，2026-09）

**为什么必须实测**：module-emulation-design §10-2 原本标着"实现细节待 P2-A 验证后落定，**不在此处假设 esbuild 行为**"。这份实测就是那个验证。

**方法**：仓库外临时目录装真实包，跑参数矩阵，扫描产物里的标记。

```bash
npm install zod nanoid debug esbuild --registry=https://registry.npmmirror.com
node bundle-probe.mjs
```

样本与选它的理由：

| 样本 | 覆盖的情形 | 实测版本 |
|---|---|---|
| `zod` | 纯 ESM、不碰内建 | 4.6.5（dual 发布，`type: module` + `main: ./index.cjs`） |
| `node:fs` 直接引用 | ESM + `node:` 前缀内建 | 手写条目 |
| `path` 裸名引用 | 裸名内建（是不是内建取决于 platform） | 手写条目 |
| `debug` | **CJS** 包内部 `require('tty')` / `require('util')` | 4.4.3（无 `type` 字段 ⇒ CJS） |
| 伪造原生包 | `.node` + `binding.gyp` | 最小复现（不装需要编译的包） |

**矩阵**（`format=esm, bundle=true, target=es2022`）：

| 样本 | `platform: browser` | `platform: neutral` | `platform: node` |
|---|---|---|---|
| 纯 ESM（zod） | ok 753392B | ok 753392B | ok 753392B |
| `import { readFileSync } from 'node:fs'` | **FAIL** `Could not resolve "node:fs"` | **FAIL** 同左 | ok 100B，**`node:fs` 留在产物里** |
| `import { join } from 'path'` | **FAIL** `Could not resolve "path"` | **FAIL** 同左 | ok 93B，**`path` 留在产物里** |
| CJS 包（debug） | ok 15142B（**走浏览器分支**） | **FAIL** `Could not resolve "debug"` | ok 20216B（**`__require("tty")`/`("util")`/`("supports-color")`**） |
| 原生（`.node`） | **FAIL** `No loader is configured for ".node"` | **FAIL** 同左 | **FAIL** 同左 |

**四条结论**

1. **`platform: node` 会把内建 externalize，构建静默通过**（`node:fs` 只留 100B 产物）→ 若用它而不加第二道闸，"构建期即失败"就是空话；
2. **CJS 包的内建引用不会让构建失败**：`debug` 在 `node` 下产出 `__require("tty")` —— 这是 esbuild 的 CJS→ESM 兜底，**运行期才会炸**。这就是 §5 第二道闸存在的理由，也是 §10-2 那个 TODO 的答案：**会残留，且不报错，所以必须扫产物**；
3. **`browser` 的"能通过"是假象**：debug 的 `require('tty')` 之所以消失，是因为它按 `browser` 条件走了 `./browser.js`——**包被静默换了实现**。构建通过 ≠ 语义一致；
4. **原生模块的"必失败"是配置的产物，不是自动保证**：失败原因是 `No loader is configured for ".node"`——一旦有人为了让它过而配上 `.node` 的 loader，它就会被内联成二进制数据、构建通过。**必须把"esbuild 配置里永远不出现 `.node` loader"写成硬约束并加测试守住。**

**一个副产品（路线图输入）**：实测把"该先仿真哪些模块"从猜变成了数据——真实生态最常撞到的是 `util` / `tty` / `path` 这类**小内建**（`debug` 一条链就撞了三个）。P2-A 的 `path`/`util` 排得对，`tty` 是几乎零成本的补充。

## 8. 验收

| # | 验收项 | 现在可测？ |
|---|---|---|
| 1 | 样板插件经**构建产物**走通 install → 装载 → init/start（`pnpm spike` 从"源码 transform"改为"读产物"） | ✅ |
| 2 | 一个 `import 'node:fs'` 的插件 → **构建期失败**（登记表里现在没有 fs） | ✅ 规则现在就成立 |
| 3 | 一个引入 CJS 包（内部 require 内建）的插件 → **构建期失败**（靠第二道闸） | ✅ |
| 4 | 一个引入 `.node` 的插件 → 构建期失败 | ✅ |
| 5 | 产物元数据可被 `spc plugin install` 消费（入口指向 `dist/bundle.js`） | ✅ |
| 6 | 同一输入两次构建产出**字节一致** | ✅ |
| 7 | `pnpm test` 全绿 | ✅ |

## 9. 待定项

1. **自构建插件的依赖声明可信度**：文件哈希证明"没被改"，但证明不了"产物与声明的依赖图一致"。候选：(a) 要求可复现构建并比对；(b) **`unanchored` 插件的全部依赖一律按 L2 处理**（不认它的 L1 声明）；(c) 交给市场审核。倾向 (b)——不需要新机制，且与"来源不影响权限但影响信任展示"一致；
2. **L2 放行的记录位置与失效**：建议存安装记录（与 `grants` 并列，键为 `name@resolved`），**插件升级时清空**（"更新需重新确认"的落地方式）；
3. **L1 白名单的载体**：建议 `sdk/deps-whitelist.json`（name + 允许区间 + 用途 + 维护者），核心与构建工具共用，不硬编码；
4. **版本解析是否上 lockfile**：建议要——"静态解析依赖图"没有确定性版本解析就是空话；L1 锁死版本，L2 认解析结果并写进批准记录；
5. **L2 展示给管理员什么**（决定 CLI/前端形态）：依赖树（含传递）+ `os`/`cpu`/平台包标记 + install 脚本标记 + 体积（实测 zod 一个包就 753KB）+ OSV 结果；
6. **裸名内建的报错文案**：`Could not resolve "path"` 对作者是误导（他以为要装个叫 path 的包）。构建层需要一份内建名单（可用 `node:module` 的 `builtinModules`）先识别、再给"沙箱尚未支持"的准确文案；
7. **`neutral` + 自定义 resolve 条件**是否比 `node` 更可控：留待真实包踩坑后再评估，当前不引入额外复杂度。
