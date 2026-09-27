# tools/ —— 取证工具

## 为什么有这个目录

**决策问题先用真实代码取证，不靠推理和记忆。**

这个目录里的工具不产出任何功能，它们只回答"**凭什么这么定**"。存在的原因是本项目已经
为此付过两次代价：构建层的两道闸、依赖管控的处置规则，最初都是靠"想象真实代码长什么样"
推出来的，两次都推错了——是实测把它们纠正过来的（记录见 `docs/build-layer-evidence.md` §0）。

## 与 `scripts/` 的分工

| | `scripts/` | `tools/` |
|---|---|---|
| 用途 | **门禁**：回归验证、CI 必须过的 | **取证**：把行为打成矩阵，供设计判断 |
| 判据 | 有明确的通过/失败 | 只呈现事实，不下判断 |
| 是否进 `pnpm test` | 是（或由 CI 单独调） | **否**——它们不是回归门禁 |
| 失败意味着 | 代码坏了 | 行为变了，**设计可能要重估** |

工具失败不是"测试挂了"，是"**结论的保质期到了**"：esbuild 升级、生态变化都可能让旧结论失效，
这时应当重跑工具、重读数据，而不是改工具让它通过。

## 五个工具

### `esbuild-probe.mjs` —— esbuild 行为矩阵

回答：`platform` 取 `browser` / `neutral` / `node` 时，内建引用、CJS 依赖、原生模块分别会怎样。
**自包含**（样本现造，不装任何包），可直接跑：

```bash
node tools/esbuild-probe.mjs
```

关键发现：`platform: node` 会把内建 externalize 且**构建静默通过**；`browser` 的"通过"是靠
静默换实现换来的。→ 见 `docs/build-layer-design.md` §3/§7。

### `gate-probe.mjs` —— 两道闸的可行性

回答：第一道闸（resolve 重定向）返回 error 时能拦住哪些形态；已登记的仿真模块该"内联"还是
"标 external"；第二道闸扫什么才不误报。**自包含**，可直接跑：

```bash
node tools/gate-probe.mjs
```

关键发现：CJS 依赖**必须内联仿真**（标 external 会退化成运行期欠条）；朴素正则
`__require\s*\(` 会误报辅助函数定义行，可靠判据是标记字符串 `"Dynamic require of "`。

### `dep-survey.mjs` —— 依赖面实测 + 构建闸覆盖度

回答两件事：真实 npm 生态里哪些包会留下"运行期才解析模块"的欠条；**按当前仿真清单，能过几个、
下一个该补谁**。

**不自包含**——它需要一个装了样本包的取样目录（工具**不替你装包**，避免把几十个包拉进仓库）：

```bash
# 1) 在仓库外准备取样目录
mkdir ../_deps-survey && cd ../_deps-survey && npm init -y
npm i --registry=https://registry.npmmirror.com esbuild zod lodash ws express ...

# 2) 回到仓库跑（默认读 ../_deps-survey）
node tools/dep-survey.mjs --set utils --coverage       # 只看覆盖度
node tools/dep-survey.mjs --set core|utils|all         # 样本集（见下）
node tools/dep-survey.mjs --emulated p2a|p2a+|p2b|p2c  # 换仿真档位做增量对比
node tools/dep-survey.mjs --packages zod,ws,pg         # 自定义清单
node tools/dep-survey.mjs --json                       # 机器可读
SPC_SURVEY_DIR=/path/to/dir node tools/dep-survey.mjs
```

**两个样本集**：`core`（27 个，形态覆盖：纯计算 / IO / 服务端 / 原生加速器）用来验证规则本身；
`utils`（43 个，插件作者真会用的：配置解析 / 文件操作 / 模板 / 校验 / 格式化 / CLI）才回答"能用什么"。
**两个都要跑**——只看 `core` 会低估覆盖率，只看 `utils` 会漏掉服务端包的结构性问题。

报告分四段：**覆盖度进展**（本档新增解锁了谁）、**下一个该补谁**（需求面 vs 单独补了能过几个）、
**离过闸最近的包**（带每包属性数）、**未仿真模块的真实功能需求**。

⚠️ 两个必须记住的口径（否则会得出反向结论）：

- **"缺哪个模块" ≠ "缺多少功能"**。需求面是"多少个包引用"，实现量是"实际访问几个属性"，
  后者还可能全来自某一个包。实测：`stream` 需求面 9 个包、并集 23 个属性，
  但按包拆开多为 1–2 个，**23 个几乎全来自 `archiver` 一个**；
- **覆盖度 ≠ 运行期可用**。过闸只说明"用到的模块都有仿真"，
  **不代表仿真实现了依赖真正调用的函数**。真正的验收标准是跑通。

### `dep-trace.mjs` —— 追引用链

回答：某包"卡在某个模块"时，**那个引用究竟从哪条依赖链进来**。

```bash
node tools/dep-trace.mjs fs-extra stream
node tools/dep-trace.mjs chokidar stream --dir ../_deps-survey
node tools/dep-trace.mjs tar zlib --depth 5
```

为什么必须有它：**"A 卡在 X"不代表 A 引用了 X**。实测 `fs-extra` 被判为"卡在 `stream`"，
追下去发现它自己根本没引用——是依赖 `graceful-fs` 带的，而后者只用了 `Stream` 和 `call`。
不追链就会把一个极小的 shim 估成"实现整个 stream"。

### `bridge-bench.mjs` —— 桥的传输成本

回答：沙箱 ↔ 宿主搬字节到底多贵；**二进制通道比字符串通道值多少**。

**需要 tsx**（要 import 仓库里的 `.ts`）：

```bash
node node_modules/tsx/dist/cli.mjs tools/bridge-bench.mjs
node node_modules/tsx/dist/cli.mjs tools/bridge-bench.mjs --json
```

为什么要有它：二进制通道的每个原语都是**拷贝**（实测，不是零拷贝），
我们选它的理由是"一次 memcpy 远比 base64 便宜"——**这个理由必须能被量出来**，
否则既无法反驳"干脆走 base64"，也无法发现有人把它改成逐字节/二次编码。

留档数字（本机，7 轮取中位）：

| 载荷 | 调用开销 | 宿主→沙箱 | 沙箱→宿主 | 字符串通道 |
|---|---|---|---|---|
| 0 B | 0.21 ms | 0.23 ms | 0.22 ms | 0.21 ms |
| 64 KB | 0.21 ms | 0.28 ms（221 MB/s） | 0.30 ms（208 MB/s） | 1.34 ms（47 MB/s） |
| 1 MB | 0.19 ms | 0.84 ms（1185 MB/s） | 1.06 ms（941 MB/s） | 19.2 ms（52 MB/s） |
| 4 MB | 0.25 ms | 2.13 ms（1882 MB/s） | 2.25 ms（1778 MB/s） | 71.8 ms（56 MB/s） |

**两条必须记住的读数**：

- **二进制比字符串快 20–34 倍**，比"沙箱内自己逐字节"（≈2.6 MB/s）快约 700 倍；
- **跨界底价 ≈0.2 ms/次，且它盖住了一切小载荷**——≤1 KB 时两条通道测不出差别。
  所以守门**只能用相对比较**（已在 `sandbox-modules.test.ts` 落地：断言二进制至少快 5 倍）。

> **改动二进制通道后必须重跑本工具**。数字变了要能解释：换机器、改实现、还是误伤？

## 仿真层的真值链与验收工具（2026-09-20 从开发工作区迁入）

> 这一批原先住在仓库外的开发工作区（`_audit/`）里，于是仓库文档只能引用一个**读者看不到的路径**——
> 等于"结论可复核"这句话打了折。它们本来就是**结论的来源**，迁进来引用才成立。
>
> 路径统一由 **`tools/paths.mjs`** 提供：仓库内的位置自己推（任何人克隆都能跑）；
> **仓库外的两样**——判卷人 node、依赖取样目录——默认按工作区布局猜，可用环境变量覆盖：
> `SPC_JUDGE_NODE` / `SPC_SURVEY_DIR`。

### `tools/batteries/` —— 仿真层差分验收

| 工具 | 干什么 | 判据 |
|---|---|---|
| `deep-cmp-battery.mjs` | 深比较/断言语义：**68 组 × 3 操作**，与宿主 Node 对跑 | **0 分歧** |
| `events-battery.mjs` | `events` 语义：**34 组剧本**（error/close/drain 序列、监听器时序…） | **0 分歧** |

```bash
node tools/batteries/deep-cmp-battery.mjs
node tools/batteries/events-battery.mjs
```

这两个是**改动仿真层后必跑的**（见 `AGENTS.md` §4 的验收三件套）。

### `tools/truth/` —— 真值采集 / 生成 / 校验链

**为什么有它**：`core/sandbox-modules/*.js` 里那些"勿手改"的表（常量、errno、crypto、zlib、fs 错误文案）
**不是手抄的**，是"在基线 node（现为 v24.20.0）上跑出来、再生成进去"的。这条链就是它们的出处：

```
采集（在基线环境里跑，输出到 data/）
  dump-const.mjs        ← 在 WSL 里跑，取 Linux 的 os.constants
  dump-const-win.mjs    ← 用判卷人 node.exe 跑，取 Windows 的
  fs-url-truth.mjs / fs-shape-truth.mjs / crypto-truth{,2}.mjs / zlib-truth.mjs /
  qs-shape-truth.mjs / qs-unescbuf-truth.mjs / os-cpus-truth.mjs      ← 各模块的运行值
  path-win32-cases.mjs → path-win32-cases-win.mjs                     ← path.win32 的用例与 Windows 侧真值
        ↓  产物都在 tools/truth/data/
生成（把真值写进仿真模块，**改表走这条链，别手抄**）
  gen-constants2.mjs → core/sandbox-modules/node-constants.js      ← 整文件生成
  gen-fs-tables.mjs  → node-fs.js                                  ← **就地替换标记之间**（可反复重跑）
  gen-zlib-tables2.mjs → node-zlib.js                              ← 同上（就地替换标记之间）
  gen-crypto-tables.mjs → node-crypto.js                           ← 同上
  wire-zlib.mjs                                                    ← ⛔ 一次性接线，**已执行，别再跑**
  公共拼接器：generated-block.mjs（上面两处"就地替换"都走它）
        ↓
校验
  verify-constants.mjs / cmp-constants.mjs          ← 逐键核对
  path-win32-diff.mjs                               ← 与真 Windows 的差异（判据：363/366 + 3 条记账边界）
```

> **生成物怎么落进仿真模块（2026-09-27 定的两种形态，别再发明第三种）**：
> ① **整文件生成**（`node-constants.js`）——重跑就是覆盖；
> ② **就地替换标记之间**（`node-fs.js`）——表与手写逻辑同处一个文件，因为 shim 是**宿主读成源码字符串**注入 VM 的
> （不能 `import` 兄弟数据文件），而十来份 `emulation-*.test.ts` 又把它**逐字节拷**出去当真 ESM 跑。
> ⇒ 用 `// >>> GENERATED:<名字>` 与 `// <<< GENERATED:<名字>` 圈住，工具只重写这一段（**幂等**，第二次跑报"未变化"）。
> ⛔ **不要用一次性占位符**（旧的 `/*__ERRNO_TABLE__*/` 就是反面教材：替换一次就没了 ⇒ 工具再也跑不了）。

**判卷人**（Windows 侧真值）= **本机装的 node v24.20.0**（与契约基线同版；`tools/paths.mjs` 的 `JUDGE_NODE` 默认就是
`process.execPath`）—— 旧的官方 `node-v22.22.1-win-x64` **已退役**（留档不删）。要复现旧版本真值才设 `SPC_JUDGE_NODE`。

### `tools/smoke/dep-smoke.mts` —— 真实依赖冒烟

用 esbuild 把**真实 npm 包**的 `node:*` 引用**内联成仿真源码**，再放进真沙箱跑，看它是"能跑"还是"卡在缺全局"。

```bash
# 需要取样目录（同 dep-survey.mjs 的 ../_deps-survey）
node node_modules/tsx/dist/cli.mjs tools/smoke/dep-smoke.mts all
```

靶子产物写在 `tools/smoke/bundles/`（**生成物，已 gitignore**）。
当前基线 **11 个靶子里 10 个过**，唯一不过的是 `graceful-fs`（装载期 `no setter for property`，
处置方案在构建层，见 `docs/module-emulation-design.md` §14.8）。

### `tools/probes/` —— 被文档引用的证据探针

这些是"一次性调查"留下的探针，但**被设计文档当作证据引用**（"QuickJS 没有这批全局"就出自
`quickjs-globals-probe.mjs`），所以一并迁进来，让引用可复核：

| 探针 | 证明了什么 |
|---|---|
| `quickjs-globals-probe.mjs` | QuickJS 原生缺哪些标准全局（`TextEncoder`/`queueMicrotask`/`URL`…） |
| `diag-fastglob.mts` | `path` 固定 posix 会把 `C:/a/b` 认成相对路径（→ 现在认盘符） |
| `probe-dump-keys.mts` | 沙箱里错误对象的键面（`params.stack` 那条诊断链） |
| `hostref-probe.mts` | HostRef 身份的 v1 探针（归因已被 `hostref-probe2` 修正，留作对照） |

> ⚠️ 这些**不是回归门禁**，别加进 `pnpm test`；它们的作用是"结论的保质期到了就重跑一遍"。

### `tools/check-line-refs.mjs` —— 注释里引的行号，还是当初那一行吗？

**为什么有它**：注释引"源码路径:行号"是为了标明**结论的出处**，而行号是**提交相对**的 ——
源码一升级就静默烂掉，而且没有任何东西会报错。实测过两次：① `quickjs.c` 的两个副本
（我们发行的 vendored 那份 vs 上游独立克隆）**同一断言行号相差 428 行**；
② **自引**（引本仓库自己的源码）原有的 6 处行号，**5 处已经指错** ——
把那些行删掉的，正是引用它们的那次迁移。

```bash
node tools/check-line-refs.mjs            # 体检（与快照比）
node tools/check-line-refs.mjs --update   # 核对无误后，把当前状态记成新快照
node tools/check-line-refs.mjs --json
```

**它判"变了没有"，不判"对不对"** —— 这不是偷懒，是试过两种启发式都很糟：
太松的（随便撞上一个标识符就算过）连"把 `:445` 改成 `:1445`（那行只有一个 `}`）"都抓不住；
太紧的会把正确的引用判成漂移（锚常常是散文级的，如"内存超限那个检查"）。
所以：**正确性靠人核一次并 `--update` 记快照，之后由它守住"别再悄悄变"**。

判据是「引用处 + 目标文件」上的**签名列表**（每处引用 = `行号:该行内容哈希`）——
改行号、或目标行内容变了，都会报"变了"，并给出前后对比。缺失的源码树会**跳过并说明**。

**四类目标**（判据是"它有没有一个**冻结的帧**"，详见仓库根 `AGENTS.md` §3.1）：

| 引用的源码 | 帧 | 默认去哪找 | 覆盖用 |
|---|---|---|---|
| `vendor/quickjs/*.c` | fork 提交 + `VERSION` | `<仓库>/../quickjs-emscripten-spc/vendor/quickjs` | `SPC_VENDOR_ROOT` |
| Node 源码 `lib/*.js` | Node 提交 | `<仓库>/../node` | `SPC_NODE_ROOT` |
| Linux 内核源码（`include/linux/*.h`、`kernel/*.c`…） | **内核版本**（从官方包名读，如 `6.12.110`） | `<仓库>/../linux-6.12`（**部分子树**即可） | `SPC_LINUX_ROOT` |
| 第三方包 | `pnpm-lock.yaml` | 仓库自己的 `node_modules` + `../_deps-survey/node_modules` | — |
| ⛔ **我们自己会改的码** | **没有** | 仓库自己 / 工作区 | — |

前几类可查、可比；缺源码树就跳过。**最后一类不进行号体检，而是直接判失败** ——
它**没有冻结的修订可比**（每次提交都在动），所以根本不该写行号：写成
`` `core/sandbox.ts` 的 `host.*` 桥 ``、`` `Manifest.id` `` 这样的符号名即可。
体检会把那一行**现在的内容**打出来当证据（"你引的东西早就不在那儿了"）。

> Linux 那一类**只解被引用的文件**，所以"树在、文件不在"是**正常状态**：报 ❓ 并提示
> "把 `<文件>` 从同版本内核包里解出来就能核对"，**不判失败**（见 `include/linux/notifier.h:185` 这种引用的来历）。

> ⚠️ 它**不是回归门禁**（别加进 `pnpm test`）：报"变了"意味着**结论的保质期到了**，
> 应当去看一眼那一行、决定是"源码升了该重核"还是"引用该更新"，然后 `--update`。
> **但 ⛔ 那一栏是硬错误**：它不需要人判断，改写成符号名就完了。

### `tools/check-locales.mjs` —— 用户文案的机械体检

**为什么有它**：文案漂移**没有任何东西会报错**。少一个键 → 界面上原样打出 `{placeholder}`；
引一个内部编号 → 运维看得见字却查不到那个编号；加一个没人传的占位符 → 只有盯着那段输出才会发现。
**真实踩过**：`cli.plugin.line` 里的 `reserved={reserved}` —— 字段 v2 就删了、参数从没传过，
于是 CLI 一直原样打印 `reserved={reserved}`，直到 2026-09-23 才发现。

```bash
node tools/check-locales.mjs     # 只读；有硬失败 exit 1
```

**四条硬判据**（规矩见 `docs/api-contract.md` §2.1）：两份 locale **键集一致**、同一键的**占位符集合一致**、
文案里**不出现内部坐标**（ADR 编号 / `§x` / 阶段号 `P1–P9` / `scope=` 这类内部字段名 / 设计文档文件名 / 仓库内部术语）、
**不出现已退役的字段**（`{reserved}` 一类）。
另有一条**提醒**（不影响退出码）：占位符名在 `core/`+`sdk/` 代码里找不到同名标识符 —— 大概率是"没人传"。

## 写新工具的约定

1. **先说清它回答什么问题**——文件头注释里写，否则半年后没人知道它为什么存在；
2. **呈现事实，不下判断**——判断写在 `docs/` 里，工具只出数据；
3. **尽量自包含**——能不装包就不装；必须装的，把命令打印出来让使用者自己跑；
4. **数据要可追溯**——报告里带上版本号，否则数据没有意义。
