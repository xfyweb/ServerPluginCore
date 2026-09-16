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

## 写新工具的约定

1. **先说清它回答什么问题**——文件头注释里写，否则半年后没人知道它为什么存在；
2. **呈现事实，不下判断**——判断写在 `docs/` 里，工具只出数据；
3. **尽量自包含**——能不装包就不装；必须装的，把命令打印出来让使用者自己跑；
4. **数据要可追溯**——报告里带上版本号，否则数据没有意义。
