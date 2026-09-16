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

## 三个工具

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

### `dep-survey.mjs` —— 依赖面实测

回答：真实 npm 生态里哪些包会留下"运行期才解析模块"的欠条，以及那些欠条**该归谁管**。

**不自包含**——它需要一个装了样本包的取样目录（工具**不替你装包**，避免把几十个包拉进仓库）：

```bash
# 1) 在仓库外准备取样目录
mkdir ../_deps-survey && cd ../_deps-survey && npm init -y
npm i --registry=https://registry.npmmirror.com esbuild zod lodash ws express ...

# 2) 回到仓库跑（默认读 ../_deps-survey）
node tools/dep-survey.mjs
node tools/dep-survey.mjs --packages zod,ws,pg     # 自定义清单
node tools/dep-survey.mjs --json                   # 机器可读
SPC_SURVEY_DIR=/path/to/dir node tools/dep-survey.mjs
```

关键发现：绝大多数欠条是**内建**（= 仿真覆盖度问题，不是依赖问题）；真正非内建的只有 5 个
名字，且**全部被自己的 `package.json` 声明为可选**。

## 写新工具的约定

1. **先说清它回答什么问题**——文件头注释里写，否则半年后没人知道它为什么存在；
2. **呈现事实，不下判断**——判断写在 `docs/` 里，工具只出数据；
3. **尽量自包含**——能不装包就不装；必须装的，把命令打印出来让使用者自己跑；
4. **数据要可追溯**——报告里带上版本号，否则数据没有意义。
