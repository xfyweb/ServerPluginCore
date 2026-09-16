# 构建层实测证据（方法与数据）

- 状态：**证据基线**（P2-2 前置；数据采集于 2026-09，esbuild 0.28.2 / Node 24）
- 关联：build-layer-design（§3/§4/§5 的依据）、module-emulation-design §5/§10、ADR-005 §6/§7、ROADMAP P2-2
- 定位：回答"**构建层的每条规则，凭什么这么定**"。把**证据**与**结论**分开写：结论会变，证据要能复核。
- 复现：`tools/` 下三个工具（见 §5）

## 0. 方法：决策问题先取证

### 0.1 为什么写在文档最前面

本层有两条规则最初是**推出来**的，两条都错了。这不是笔误，是方法问题：**在"真实生态长什么样"
这类问题上，推理和记忆都不可靠**——你不知道 `debug` 的依赖面、不知道 esbuild 遇到 try/catch
里的 `require` 会怎么处理，靠想就会想错。

### 0.2 两次代价（记录以便复用教训）

| # | 当时的结论 | 怎么错的 | 实测纠正 |
|---|---|---|---|
| 1 | "第一道闸能**看见**依赖包内部的 `require`，但**拦不住**它" | 只测了闸门"旁观"（`onResolve` 返回 `undefined`）的情况，没测返回 `error` 的情况 | 返回 `error` 时构建失败，且报错**精确到依赖包内部的行号** |
| 2 | "产物里有欠条就一律构建失败，作者逐个登记放行" | 没查样本库的真实依赖面就下结论 | 该库在 `package.json` 里**显式声明**了那个依赖为可选，代码里也用 try/catch 兜住并写了注释。这是生态**标准写法**——一律失败是纯误伤 |

第 2 条尤其值得记：**它会把 npm 生态里最常见的可选依赖写法全部拒掉**，而设计者当时以为自己在"从严"。

### 0.3 做法

1. **先问"这条规则误伤了谁"**——把规则的边界在真实代码上撞一遍，而不是只验证"违规的会被拦"；
2. **工具只出数据，判断写文档**——避免"工具为了通过而改"；
3. **样本要覆盖形态，不是覆盖数量**——27 个包的价值在于覆盖了"纯计算 / IO / 服务端 / 带可选原生加速器"四类形态；
4. **数据带版本**——esbuild 与生态都会变，结论有保质期（见 §6）。

## 1. esbuild 行为矩阵

工具：`tools/esbuild-probe.mjs`（自包含）。参数固定 `format=esm, bundle=true, target=es2022`。

| 样本（代码形态） | `browser` | `neutral` | `node` |
|---|---|---|---|
| 纯 ESM，不碰内建 | ok 64B | ok 64B | ok 64B |
| `import … from 'node:fs'` | FAIL 解析不到 | FAIL 解析不到 | **ok 100B，`node:fs` 留在产物里** |
| `import … from 'path'`（裸名） | FAIL 解析不到 | FAIL 解析不到 | **ok 92B，`path` 留在产物里** |
| CJS 包（内部 `require`） | ok，**走 browser 分支** | FAIL 解析不到 | ok，**留下运行期兜底调用** |
| 原生模块（`.node`） | FAIL 无 loader | FAIL 无 loader | FAIL 无 loader |

**四条结论**

1. **`platform: node` 会把内建 externalize，构建静默通过**——若只靠它，"构建期即失败"是空话；
2. **`browser` 的"能通过"是假象**：带 `browser` 字段的包被静默换了实现，构建通过 ≠ 语义一致，
   而且**违背 fail-closed**（出问题时看不出发生过替换）；
3. **`neutral` 不可用**：解析不了 CJS 包与裸名内建；
4. **原生模块的"必失败"是配置产物，不是自动保证**：失败原因是"No loader is configured"——
   一旦有人配上 `.node` loader，它会被内联成二进制数据、构建通过。
   ⇒ **"esbuild 配置里永远不出现 `.node` loader"必须是硬约束，并有测试守住。**

## 2. 依赖面实测（27 个包）

工具：`tools/dep-survey.mjs`。同一个 `platform: node` + `format: esm` 配置。

**欠条的可靠判据**：产物里是否出现标记字符串 `"Dynamic require of "`（esbuild 运行期兜底的错误文案）。
不用 `__require(` 正则——它会命中辅助函数**定义行**（详见 §3.3）。

### 2.1 汇总

```
共 27 个包：构建成功 27，有欠条 13
欠条调用点 417 处 = 字面量 413 处 + 动态 4 处
非内建的欠条 specifier 共 5 个
```

样本：`zod nanoid chalk picocolors ms semver dayjs lodash uuid yaml ini dotenv fs-extra glob
rimraf mkdirp ajv express ws axios pino winston ioredis mysql2 pg ssh2 dockerode`

### 2.2 数据怎么读

**关键在拆分**：13 个"有欠条"的包里，**绝大多数欠条的 specifier 是内建**。
内建欠条不是"依赖问题"，是**仿真覆盖度问题**——它是 module-emulation 的排期表，不是依赖管控的对象。

按 specifier 归属拆开：

| 归属 | 数量 | 谁管 |
|---|---|---|
| **内建** | 绝大多数（`fs`/`path`/`util`/`stream`/`crypto`/`buffer`/`tty`/`zlib`/`url`/`events`/`assert`/`os`/`string_decoder`/`constants`/`process`/`timers`/`util/types` …） | **仿真**（第一道闸 + 登记表） |
| **可选依赖**（5 个名字） | `bufferutil`、`utf-8-validate`、`pg-native`（可选 peer）；`cpu-features`（optionalDependencies）；`supports-color`（历史遗留的可选 peer） | **自动 stub**（§4.1） |
| **原生模块相对路径** | `./crypto/build/Release/sshcrypto.node` | 同一 stub 机制（该库本就有纯 JS 降级路径） |
| **动态**（无名字） | 4 处调用点 | **构建失败**，要求作者改写法 |

### 2.3 "引用了但没装"是什么情况

这不是意外，是 npm 生态**设计好的状态**。`install` 只拉 `dependencies`，另外四类天生可能不在：

| 来源 | 含义 | 实测样本 |
|---|---|---|
| 可选 peer | 包显式声明"这个可以不装" | `ws`、`pg` |
| `optionalDependencies` | 会尝试装，失败不报错继续 | `ssh2` 的 `cpu-features`、`nan` |
| 原生加速器 | 需编译 C++，跨平台常失败 → 故意做成可选 | `bufferutil`、`cpu-features` |
| 历史遗留 | 曾是硬依赖，后为瘦身移除，代码留着 try/catch | `supports-color` |

**两点澄清**

1. **Node 上也没有**：这些东西在 Node 里同样解析不到、同样抛错、同样被 `catch` 接住。
   沙箱只要也抛错，**行为就一致**——这是"不该判失败"的根本理由；
2. **装了就会消失**：实测——开发者**自己把那个包装上**，欠条即被正常内联（体积从 468B 变 5510B，
   欠条归零；`express`/`axios`/`ioredis` 的同类欠条一并消失）。
   所以欠条 = "构建时真的解析不到"，不是死结，作者有两条路：装上（内联）或不装（stub）。

## 3. 两道闸的可行性

工具：`tools/gate-probe.mjs`（自包含）。

### 3.1 第一道闸能拦住什么

| 形态 | 结果 |
|---|---|
| ESM `import … from 'node:fs'`（未登记） | ✅ 构建失败，报错带入口行号 |
| CJS 依赖**顶层**裸 `require`（未登记） | ✅ 构建失败 |
| CJS 依赖 **try/catch 里**的 `require`（未登记） | ✅ **同样被拦住**——try/catch 不是盲区 |

**最后一行是纠正 §0.2 那条错误结论的直接证据**：`onResolve` 对 try/catch 里的 `require` 也会触发，
因此"未登记内建"在**任何形态**下都逃不过第一道闸。

### 3.2 内联 vs external（决定仿真模块怎么接）

| 处理方式 | 欠条 | 残留调用 | 结论 |
|---|---|---|---|
| 已登记内建 → **内联 shim** | 无 | 0 | ✅ |
| 已登记内建 → 标 `external` | 有 | 3 | ❌ |

**为什么 external 不行**：CJS 依赖里的 `require('util')` 在 "CJS-in-ESM" 输出下**无法提升成
`import`**（要保留 CJS 的惰性语义），于是退化成运行期兜底调用。沙箱里没有 `require` ⇒ 必炸。
而 `import` 形态（ESM 依赖）标 external 是可行的——它走沙箱 loader。

⇒ **统一内联**：对两种形态都成立，且更简单。

### 3.3 第二道闸的判据

| 场景 | 朴素正则 `__require(` | 真调用点 | 标记字符串 |
|---|---|---|---|
| 全部处理干净 | 1（**误报**） | 0 | 无 |
| 只处理内建，留可选依赖 | 1 | 1 | **有** |
| 只 external 不内联 | 4 | 4 | **有** |
| 完全不处理 | 4 | 4 | **有** |
| 动态 require（变量） | 1 | 1 | **有** |

- 朴素正则会命中辅助函数**定义行**（形如 `… function __require() {`）→ 误报；
- **标记字符串**只在"确实留下运行期解析"时出现，不受辅助函数命名影响，**含动态 require**；
- 代价：它依赖 esbuild 的文案 ⇒ **必须锁 esbuild 版本**，并用本工具做回归（§6）。

## 4. 由数据推出的结论

### 4.1 闸门结构

| | 管什么 | 结果 |
|---|---|---|
| **第一道闸**（唯一硬闸） | **未登记内建** → 失败（文案指出"沙箱尚未支持 X"，而非让作者以为代码写错） | fail-closed：沙箱**真的没有这个能力** |
| | **已登记内建** → **内联仿真模块** | ESM / CJS 两种形态都可用 |
| **消除机制**（不是闸） | 解析不到的**非内建** specifier → 换成抛 `MODULE_NOT_FOUND` 的 stub | 与 Node 行为一致（含错误码），**不失败** |
| | **动态**欠条（无字面量名） | **构建失败**，要求作者改写法（实测误伤面 ≈ 0：4/417） |
| **第二道闸**（自检） | ① 产物无标记字符串 ② 残留 specifier ⊆ 白名单 | 验证消除机制**真的生效**，不是政策闸 |

**第二道闸的性质变了**：它不再判断"该不该放行"，而是自问"我刚才的清理生效了吗"。
这与设计文档原有的"自洽、不需要维护名单"一致，但**依据从推理变成了数据**。

### 4.2 对仿真模块的新约束：必须**可内联**

§3.2 推出的直接后果：**仿真模块必须能被构建层内联进产物**。这要求它：

- 静态、**无构建期占位符**（插件 id、数据目录等一律**运行时从宿主取**）；
- 不依赖"被沙箱 loader 单独服务"这一前提。

`module-emulation-design §5` 规则 2 目前允许"随插件不同而不同"的占位符替换——**那条会挡住内联**，
等于所有 CJS 依赖都用不上仿真。**该节需按本条修订。**

### 4.3 网络类库结构性不可用 → 驱动插件

实测中需要网络/进程类内建（沙箱**设计上永不提供**，因为已外包给官方驱动）的包：

```
express       http, net
ws / axios    https, http, net, tls
ioredis       dns, net, tls, diagnostics_channel
mysql2 / pg   net, tls, dns
pino          worker_threads, module, diagnostics_channel
winston       http, https
ssh2          net, child_process, dns, http, https, tls
dockerode     https, http, net, child_process, dns, tls, http2
```

⇒ 这些库在沙箱里**结构性不可用**，且第一道闸会在构建期就把这件事说清楚。
**这不是缺陷，是架构边界在构建期的执行点**：数据库 / SSH / Docker 类插件本来就该调驱动端点。

**已定（待落文档）**：网络能力由**驱动插件**承接，并且**驱动插件同样按模块仿真的形态来做**——
即仿真模块的实现来源可以包括驱动插件，核心只做登记、权限门与审计。
（此条按本轮口头决定记录；**具体接口形态待评审**，不在此文档展开。）

## 5. 复现

```bash
node tools/esbuild-probe.mjs     # §1（自包含）
node tools/gate-probe.mjs        # §3（自包含）

# §2 需要一个装了样本包的取样目录（工具不替你装包）
mkdir ../_deps-survey && cd ../_deps-survey && npm init -y
npm i --registry=https://registry.npmmirror.com esbuild zod nanoid chalk picocolors ms semver \
  dayjs lodash uuid yaml ini dotenv fs-extra glob rimraf mkdirp ajv express ws axios pino \
  winston ioredis mysql2 pg ssh2 dockerode
cd - && node tools/dep-survey.mjs
```

工具约定见 `tools/README.md`：它们**不参与 `pnpm test`**——不是回归门禁，是取证工具。

## 6. 已知边界

1. **结论有保质期**：§3.3 的标记字符串依赖 esbuild 文案，**esbuild 升级后必须重跑** `gate-probe`；
   依赖面数据随生态变化，建议每个大阶段重采一次；
2. **样本是形态覆盖，不是全量普查**：27 个包覆盖四类形态，不代表"生态里只有这 5 个非内建欠条名字"；
3. **动态欠条的比例（4/417）来自本样本**——它足以支撑"误伤面小"的判断，但不足以支撑"永远不会有"，
   所以规则仍是**构建失败**（fail-closed），而不是"忽略"；
4. **本层未验证**：`.node` loader 的守门测试、inlining 后产物的运行期行为、仿真模块内联后的权限门
   是否仍然完整（这三个属 P2-2 实现期验收）。
