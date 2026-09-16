# 构建层实测证据（方法与数据）

- 状态：**证据基线**（P2-2 前置；数据采集于 2026-09，esbuild 0.28.2 / Node 24）
- 关联：build-layer-design（§3/§4/§5 的依据）、module-emulation-design（§3 清单的排期输入）、ADR-005 §6/§7、ROADMAP P2-2
- 定位：回答"**构建层的每条规则、仿真的每个排期，凭什么这么定**"。把**证据**与**结论**分开写：结论会变，证据要能复核。
- 样本：`core` 27 个包 + `utils` 43 个包（见 §2.1）
- 复现：`tools/` 下三个工具（见 §5）

## 0. 方法：决策问题先取证

### 0.1 为什么写在文档最前面

本层有规则与判断最初是**推出来**的，三次都错了。这不是笔误，是方法问题：**在"真实生态长什么样"
这类问题上，推理和记忆都不可靠**——你不知道 `debug` 的依赖面、不知道 esbuild 遇到 try/catch
里的 `require` 会怎么处理、不知道 `fs-extra` 的 `stream` 是从哪来的，靠想就会想错。

### 0.2 三次代价（记录以便复用教训）

| # | 当时的结论 | 怎么错的 | 实测纠正 |
|---|---|---|---|
| 1 | "第一道闸能**看见**依赖包内部的 `require`，但**拦不住**它" | 只测了闸门"旁观"（`onResolve` 返回 `undefined`）的情况，没测返回 `error` 的情况 | 返回 `error` 时构建失败，且报错**精确到依赖包内部的行号** |
| 2 | "产物里有欠条就一律构建失败，作者逐个登记放行" | 没查样本库的真实依赖面就下结论 | 该库在 `package.json` 里**显式声明**了那个依赖为可选，代码里也用 try/catch 兜住并写了注释。这是生态**标准写法**——一律失败是纯误伤 |
| 3 | "`fs-extra` 卡在 `stream`，说明文件类依赖门槛很高"；"`stream` 需求面 9 个包、23 个属性，可能很重" | 只看"**缺哪个模块**"，没看"**缺多少功能**"；也没追那个引用**从哪条依赖链进来** | `fs-extra` 自己根本没引用 `stream`（是它的依赖 `graceful-fs` 带的，后者只用 `Stream` 和 `call`）；而 23 个属性**几乎全来自 `archiver` 一个包**，其余包只要 1–2 个 |

第 2 条尤其值得记：**它会把 npm 生态里最常见的可选依赖写法全部拒掉**，而设计者当时以为自己在"从严"。
第 3 条则说明：**"某包卡在某模块"这句话，不追到属性级就不算数**。

### 0.3 做法

1. **先问"这条规则误伤了谁"**——把规则的边界在真实代码上撞一遍，而不是只验证"违规的会被拦"；
2. **工具只出数据，判断写文档**——避免"工具为了通过而改"；
3. **样本要覆盖形态，不是覆盖数量**——但**样本集要贴真实需求**：`core`（27 个，形态覆盖）
   解决了"规则对不对"，`utils`（43 个，插件作者真会用的）才回答"能用什么"。两个集缺一不可；
4. **数据带版本**——esbuild 与生态都会变，结论有保质期（见 §6）；
5. **区分"缺哪个模块"和"缺多少功能"**——需求面（多少个包引用）与实现量（实际访问几个属性）
   是两个数，还可能来自不同包。混起来会把小门槛说成大工程（§0.2 第 3 条）；
6. **结论要追引用链**——"A 卡在 X"未必是 A 引用了 X，可能是它的依赖引用的。

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

## 2. 依赖面实测（`core` 27 个 + `utils` 43 个）

工具：`tools/dep-survey.mjs`。同一个 `platform: node` + `format: esm` 配置。

**欠条的可靠判据**：产物里是否出现标记字符串 `"Dynamic require of "`（esbuild 运行期兜底的错误文案）。
不用 `__require(` 正则——它会命中辅助函数**定义行**（详见 §3.3）。

### 2.1 两个样本集

| 集 | 包数 | 选它的理由 |
|---|---|---|
| **`core`** | 27 | **形态覆盖**：纯计算 / IO / 服务端 / 带可选原生加速器。用来验证规则与闸门本身 |
| **`utils`** | 43 | **真实需求面**：插件作者真会用的那类小工具——配置解析、文件操作、模板、校验、格式化、CLI |

> 为什么要第二个集：`core` 里那批服务端包（`express`/`ws`/`axios`/`mysql2`/`pg`/`ssh2`/`dockerode`）
> **结构上就不该在沙箱里跑**（见 §4.3），它们拉低了覆盖率却掩饰不了真实结论。
> `utils` 才是"沙箱插件能用什么"的答案。

```bash
node tools/dep-survey.mjs --set core  --coverage
node tools/dep-survey.mjs --set utils --coverage
```

### 2.2 覆盖度进展（按仿真档位）

**过闸** = 构建成功 + 无动态欠条 + 用到的内建**全部**有仿真。
（解析不到的非内建 specifier 会被自动 stub，与 Node 行为一致，不算卡点。）

| 仿真档 | `core` | `utils` |
|---|---|---|
| **none**（完全不仿真） | 9/27 | **17/43** |
| p2a（`path` `util` `events` `assert` `url`） | 9/27 — **+0** | 18/43 — +`joi` |
| p2a+（+ `tty` `constants`） | 9/27 — **+0** | 18/43 — +0 |
| p2b（+ `fs` `fs/promises` `process` `os`） | 11/27 — +`chalk` `mkdirp` | **26/43** — +`debug` `properties` `handlebars` `eta` `ejs` `ora` `cli-table3` `which` |
| p2c（+ `buffer` `crypto`） | 14/27 — +`uuid` `yaml` `dotenv` | 27/43 — +`tmp` |

**三条读数**

1. **`utils` 的覆盖率高一倍**（27/43 vs 14/27）——沙箱插件的依赖面是"纯计算 + 文件操作 + 小工具"，
   不是服务端框架；
2. **P2-A 在 `core` 集里解锁 0 个包**。文档 §3 称它"最容易、**收益最高**"——实测**最容易是对的，收益是 0**：
   需要这些模块的包**同时还缺别的**（`chalk` 要 path+util 也要 process+os）。
   **`tty`/`constants` 同理**（补了 0）——它们不是白补，是**前置条件，不是解锁项**；
3. **真正的杠杆是 P2-B**（`utils` 集一次解锁 8 个），不是 P2-A。

### 2.3 属性级功能需求（**缺哪个模块 ≠ 缺多少功能**）

> 这一节的方法论价值大于数据本身，见 §0.2 第 3 条。

**模块引用只是"面"，实际访问的属性才是"要写多少代码"。** 工具对每个未仿真模块统计
产物里对它的属性访问：

```
utils 集，基线 p2c：
  stream               23 个属性  PassThrough Readable call prototype Writable Duplex Transform …
  zlib                  4 个属性  deflateRawSync createDeflateRaw inflateRawSync createInflateRaw
  child_process         3 个属性  emit spawn spawnSync
  worker_threads        1 个属性  threadId
  net                   1 个属性  createConnection
```

**但那个 23 会误导**——它是**跨 9 个包取并集**。按包拆开：

| 包 | 卡在 | 实际属性数 |
|---|---|---|
| `proper-lockfile` | `stream` | **1** |
| `graceful-fs` | `stream` | **1** |
| `fast-glob` | `stream` | **2** |
| `chokidar` / `csv-parse` | `stream` | 检测不到属性访问（引用在未被静态解析的分支里） |
| **`archiver`** | `stream` | **23** ← 全部来自它一个 |

⇒ **补一个极小的 `stream` shim（`Stream` + `call` + 一两个类）就可能解锁 5 个包**；
要完整 `stream` 的只有 `archiver`（打包压缩，本来就边缘）。

**推论（写进 module-emulation 的输入）**：

- **"设计上不仿真"要按属性判断，不是按模块**——`worker_threads` 被访问的只有 `threadId`
  （`write-file-atomic` 拿它判断"在不在 worker 里"），**那不是能力**，返回 `null` 即可；
- 而 `child_process`（`spawn`/`spawnSync`）与 `net`（`createConnection`）确实是能力，维持禁区。

### 2.4 案例：`fs-extra` 卡在 `stream` —— 追引用链

覆盖度报告说 `fs-extra` 差一个 `stream`。追下去发现**它自己根本没引用 `stream`**：

```
fs-extra@11.4.0 的依赖 = graceful-fs + jsonfile + universalify
lib/ = 29 个文件 45 KB；它引用的内建只有 path（12 个文件）与 node:fs（1 个）
stream 来自 graceful-fs（fs 的老牌 EMFILE 兼容层），后者只用了 Stream 和 call
```

**它真正"重"的地方在别处**：`fs-extra` 转发/调用了 **41 个 `fs` 方法名**
（`access` `chmod` `copyFile` `exists` `futimes` `link` `lstat` `opendir` `readv` `rename` `rm`
`symlink` `unlink` `writev` …）——它几乎把 `fs` 的方法面抄了一遍。

⇒ **门槛不在 `stream`，在于 `fs` 仿真要够宽。** "某包卡在某模块"这个结论**必须追引用链**才算数。

### 2.5 汇总（`core` 集）

```
共 27 个包：构建成功 27，有欠条 13
欠条调用点 417 处 = 字面量 413 处 + 动态 4 处
非内建的欠条 specifier 共 5 个
```

### 2.6 欠条按归属拆分

**关键在拆分**：13 个"有欠条"的包里，**绝大多数欠条的 specifier 是内建**。
内建欠条不是"依赖问题"，是**仿真覆盖度问题**——它是 module-emulation 的排期表，不是依赖管控的对象。

按 specifier 归属拆开：

| 归属 | 数量 | 谁管 |
|---|---|---|
| **内建** | 绝大多数（`fs`/`path`/`util`/`stream`/`crypto`/`buffer`/`tty`/`zlib`/`url`/`events`/`assert`/`os`/`string_decoder`/`constants`/`process`/`timers`/`util/types` …） | **仿真**（第一道闸 + 登记表） |
| **可选依赖**（5 个名字） | `bufferutil`、`utf-8-validate`、`pg-native`（可选 peer）；`cpu-features`（optionalDependencies）；`supports-color`（历史遗留的可选 peer） | **自动 stub**（§4.1） |
| **原生模块相对路径** | `./crypto/build/Release/sshcrypto.node` | 同一 stub 机制（该库本就有纯 JS 降级路径） |
| **动态**（无名字） | 4 处调用点 | **构建失败**，要求作者改写法 |

### 2.7 "引用了但没装"是什么情况

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

### 4.4 仿真排期的输入（数据给的，不是猜的）

**排序依据是"哪些包被卡住 + 实际访问几个属性"，不是"Node 文档里有多少 API"。**
理由：依赖改不了，只能迁就它；而 Node 文档描述的是全集，真实依赖只用子集
（`debug` 一条链只用到 `tty.isatty` 和 `util` 的一两个函数）。

`utils` 集（基线 p2c）的解锁效率：

| 模块 | 需求面 | 单独补它 → 完全过闸 | 实际属性数 |
|---|---|---|---|
| **`stream`** | 9 个 | **5 个**（`chokidar` `fast-glob` `proper-lockfile` `graceful-fs` `csv-parse`） | 并集 23，但**按包拆开多为 1–2**（§2.3） |
| `child_process` | 6 个 | 3 个 | 3（`spawn`/`spawnSync`）—— 能力，维持禁区 |
| `zlib` | 3 个 | 1 个（`adm-zip`） | 4（只要 raw deflate/inflate） |

**七条具体输入**

1. **`tty` 与 `constants` 补进清单**——两者都被实测撞到（`chalk` 用 `tty`；`fs-extra`/`dockerode`
   用 `constants`），成本都极低。**但注意：它们当前解锁 0 个包**（用到它们的包还缺别的），
   是**前置条件而非解锁项**，别拿覆盖率给它们记功；
2. **子路径内建要独立登记**——实测撞到 `stream/promises`、`path/win32`、`util/types`、`timers/promises`。
   `module-emulation §4` 的规则是对的，但**清单里一个都没列**；
3. **`stream` 是最优先项**，且**很可能一个小 shim 就够**（`Stream` + `call` + 一两个类）；
   完整 `stream` 只有 `archiver` 需要，可作为后置；
4. **`zlib` 要按"能力型"设计，不是纯计算**——压缩算法要么走宿主、要么纯 JS 实现（工作量大）。
   它和 `fs`/`crypto` 同类：**源码静态可内联，能力运行时接上**；
5. **"设计上不仿真"要按属性判断，不是按模块**——`worker_threads` 只被访问 `threadId`
   （判断"在不在 worker 里"），**那不是能力**；而 `child_process` 的 `spawn`、`net` 的
   `createConnection` 确实是能力，维持禁区；
6. **`fs` 仿真要够宽**——`fs-extra` 一个包就用到 41 个 `fs` 方法名（§2.4）。
   `fs` 的门槛不在依赖了谁，而在**方法面的宽度**；
7. **两个问题本数据回答不了，已另行判定**（2026-09）：
   - **`Buffer`**：构建期口径偏低估（只要求"引用了就得有"）。**决定：提前到 P2-B**，
     随 `fs` 的二进制读写一起上——它是二进制的通用货币，`fs` 一支持二进制就必然需要；
   - **回调风格**（`fs.readFile(p, cb)`）：这是**运行期 API 形状**，构建期指标测不到。
     **决定：支持**，但它是**薄包装**而非第二套实现（调桥 + 把结果排进微任务再回调；
     Node 保证回调不同步触发，这点要照做）。
   - 两者落点见 `module-emulation-design` §3 与 §8。

## 5. 复现

```bash
node tools/esbuild-probe.mjs     # §1（自包含）
node tools/gate-probe.mjs        # §3（自包含）

# §2 需要一个装了样本包的取样目录（工具不替你装包，避免污染仓库）
mkdir ../_deps-survey && cd ../_deps-survey && npm init -y

# core 集（形态覆盖）
npm i --registry=https://registry.npmmirror.com esbuild zod nanoid chalk picocolors ms semver \
  dayjs lodash uuid yaml ini dotenv fs-extra glob rimraf mkdirp ajv express ws axios pino \
  winston ioredis mysql2 pg ssh2 dockerode

# utils 集（真实需求面）
npm i --registry=https://registry.npmmirror.com debug chokidar fast-glob globby write-file-atomic \
  proper-lockfile tmp graceful-fs toml json5 properties csv-parse fast-xml-parser mustache handlebars \
  eta ejs joi valibot superstruct date-fns luxon change-case slugify bytes pretty-bytes \
  humanize-duration deepmerge diff sanitize-filename commander yargs ora cli-table3 execa \
  cross-spawn which pidusage systeminformation tar adm-zip archiver marked
```

回到仓库：

```bash
node tools/dep-survey.mjs --set core  --coverage
node tools/dep-survey.mjs --set utils --coverage
node tools/dep-survey.mjs --set utils --emulated p2b --coverage   # 换基线做增量对比
node tools/dep-survey.mjs --json                                  # 机器可读
```

工具约定见 `tools/README.md`：它们**不参与 `pnpm test`**——不是回归门禁，是取证工具。

## 6. 已知边界

1. **结论有保质期**：§3.3 的标记字符串依赖 esbuild 文案，**esbuild 升级后必须重跑** `gate-probe`；
   依赖面数据随生态变化，建议每个大阶段重采一次；
2. **样本是形态覆盖，不是全量普查**：`core` 27 + `utils` 43 覆盖了形态与真实需求，
   但不代表"生态里只有这 5 个非内建欠条名字"；
3. **动态欠条的比例（4/417）来自 `core` 集**——足以支撑"误伤面小"的判断，但不足以支撑"永远不会有"，
   所以规则仍是**构建失败**（fail-closed），而不是"忽略"；
4. **取样用 `import * as mod`（整包导入），是"上限口径"**：CJS 包摇不动，这就是真实情况；
   ESM 包真实用法可能更小。所以数字**一致可比，但不等于"真实插件一定卡在这些模块上"**；
5. **覆盖度 ≠ 运行期可用**：过闸只说明"用到的模块都有仿真"，**不代表仿真实现了依赖真正调用的函数**
   （`fs-extra` 用到 41 个 `fs` 方法名，实现 5 个它照样跑不起来）。**真正的验收标准是跑通**，
   构建闸只是第一道；
6. **属性级数据也是静态上限**：产物里出现过 ≠ 运行期会执行到。它的用途是**估工作量与排期**，
   不是判定可用性；
7. **本层未验证**：`.node` loader 的守门测试、内联后产物的运行期行为、仿真模块内联后的权限门
   是否仍然完整（这三个属 P2-2 实现期验收）。
