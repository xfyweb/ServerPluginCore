# AGENTS.md —— 给 AI 协作者（以及人）的项目约定

> 这份文件是**项目自身**的约定：它跟着代码走，克隆仓库就能看到。
> 只写"不写就会踩坑"的东西，**不重复** `README.md`（这是什么/怎么用）与 `docs/`（设计与实测记录）。
> 如果你是 AI 协作者：先读这份 + `docs/ROADMAP.md`，再动代码。

## 1. 一句话

ServerPluginCore 是一个**宿主最小、能力全插件化**的服务端核心：
本体只做"装载 / 隔离 / 桥 / 审计"，其余一切能力交给插件；插件跑在 QuickJS（WASM）沙箱里，
**摸不到操作系统**——所以不需要容器、不需要多用户矩阵，安全重心落在**宿主 API 的审查与实现**上。

## 2. 契约与设计原则（改代码前必须接受的前提）

- **码是契约，只增不改**：错误码用英文、**只增**（改既有码等于破坏契约）。
- **fail-closed**：判定不出来就拒绝，不要"默认放行"。
- **Node 是契约宗主**：被仿真的模块（`core/sandbox-modules/*.js`）语义以 **Node 源码为准**，
  改法也是"向 Node 靠"，而不是"向方便靠"。有分歧时，Node 的行为就是答案。
- **本体最小**：能在插件或构建层解决的，不要塞进核心。新增核心代码要有非加不可的理由。

## 3. 改代码的规矩

### 3.1 先读权威源码，不要凭记忆

判定基准优先**源码**，而不是记忆或二手描述：

| 你要判断什么 | 去看 |
|---|---|
| Node 语义（被仿真模块要对齐的行为） | **Node 源码 `lib/*.js`** —— 本项目的契约宗主 |
| 解释器语义（中断轮询 / 栈限额 / 收尾断言） | **`vendor/quickjs/quickjs.c`** —— 就是编进 WASM、**实际跑的那份** |
| 沙箱宿主层（句柄 / GC 释放 / 挂起） | 上游 `quickjs-emscripten` 的 `c/interface.c`、`packages/quickjs-emscripten-core/src/` |
| 被仿真的实装行为 | **亲自跑一遍看**，别推理（见 §4） |

#### 引行号的规矩 ⚠️

**先问一句：这个行号有没有一个「冻结的帧」？** 行号是**坐标**，而坐标只相对**某个不再变的修订**才有意义：

| 你要引的东西 | 有冻结的帧吗 | 怎么写 |
|---|---|---|
| 上游引擎 / Node 源码 / **Linux 内核源码** / 第三方包 | ✅ 有（发行版本、提交哈希、lockfile、内核版本） | **符号 + 行号**（基准见下表） |
| **我们自己在改的码**（本仓库源码，fork 里我们要打补丁的 `c/interface.c` 与 `packages/*/src`） | ❌ **没有** | **只写符号**，不写行号 |

**为什么自引不能写行号**：我们自己这份**每次提交都在动**。若给它也记个提交哈希当基准，注释要么永远落后
（"等下个发版再更新注释？"），要么每次提交都得改注释——两头都不对；而读者读的是**工作区**、
不是那个哈希指向的树 ⇒ 哈希对他**零信息**。这不是理论担忧：本仓库原有 **6 处**自引行号，
**5 处已经指错**（第 6 处是**碰巧**——它指的 `id` 恰好还在第 3 行，运气不是设计）。
最典型的是 `core/main.ts` 那处"由 id 前缀推导信任档"：**把那些行删掉的正是引用它的那次迁移**
（`e1c28c8`），于是行号落到了 CLI 横幅上，而没有任何东西会报错。

所以：

1. **引符号名为主、行号为辅**。写成
   「`` `JS_FreeRuntime` 里的 `assert(list_empty(&rt->gc_obj_list))`（`vendor/quickjs/quickjs.c:2036`）``」
   而不是只写行号——版本变了，符号名还能重新定位，裸行号不能。
   **自引时"行号为辅"也省掉**：写成 `` `core/sandbox.ts` 的 `host.*` 桥 ``、`` `sdk/types.ts` 的 `Manifest.id` ``、
   `` `HOST_ERROR_KEY` `` 这样。符号在一个工作区里是可 `grep` 的（重命名还能靠 `tsc` 抓到），行号不是。
2. **基准是「一处全局默认」，不是每处都写**。下表**就是全局默认**：

   > **凡是没另作说明的行号引用，一律以上表为准。** 确需偏离的，在**原处**写明理由。
   > 不要在多个文件里各抄一份哈希 —— 那样基准一改就要改很多地方（本仓库已经踩过一次：
   > 6 个文件各写了一份，后来全撤了）。

   | 引用的源码 | 行号基准 |
   |---|---|
   | `vendor/quickjs/{quickjs,libregexp}.c` | **我们发行的那份引擎**：fork `quickjs-emscripten-spc` @ **`7b7af98`** 的 `vendor/quickjs`，`VERSION` = **`2025-09-13`**（= npm 上 `quickjs-emscripten@0.32.0` 所用 WASM 的来源） |
   | Node 源码 `lib/*.js` | `main` @ **`edc61b14de8`**（2026-09-16；`src/node_version.h` 声明 27） |
   | **Linux 内核源码**（`include/linux/*.h`、`kernel/*.c`、`security/*.c` …） | **6.12.110**。行号写**内核树根相对路径**（`include/linux/notifier.h:185`）或带树名前缀（`linux-6.12/…`） |
   | 第三方包（`fast-glob` / `csv-parse` / `@nodelib/*` …） | **锁在 `pnpm-lock.yaml`** ⇒ 天然稳定；注释里写**包名 + 版本**即可，不必写哈希 |

   > 这四份基准**记在快照里**（`tools/line-refs.snapshot.json` 的 `baselines`）：
   > 源码树换了修订，体检会先警告"你看到的'变了'可能只是换了修订"，再逐条比。

3. ⚠️ **别引"另一个 QuickJS"**：开发者本机可能还有一个上游 `quickjs/` 克隆（比 vendored 那份**新 9 个月**，
   `quickjs.c` 多 1882 行，**同一断言行号相差 428 行**）。它只用来回答"上游现在走到哪了"，
   **不作行号基准**——照它去核对会找不到东西。
4. **校验**：`node tools/check-line-refs.mjs` —— 扫出仓库里所有 `路径:行号` 引用，逐个核对
   "那一行现在还含引用的符号吗"，漂了就报。**"帧冻不冻"就是它的判据之一**：自引行号**直接判失败**，
   并把那一行**现在的内容**打出来当证据（让人自己看见"我引的东西早就不在那儿了"）；
   源码树不在这台机器上只**跳过不判**（别人克隆仓库时本来就没有，见 `tools/README.md`）。
   它守的是"别再悄悄变"，**不是"对不对"**——正确性靠人核一次。
5. **运行时错误消息里的行号是引文，不要改**：例如
   `Aborted(Assertion failed: ..., quickjs.c:2036, JS_FreeRuntime)` 是 WASM 实际吐出的原文，
   改了就不是证据了。

### 3.2 注释写**为什么**

尤其是"**少了这行会怎样**"。不要写"这是什么"——那是代码本身就该说清的。
引行号、引实测、引上游出处，都写进注释里。

### 3.3 值必须有**本地可核实**的出处

常量、errno、错误文案这类"真值"**不许上网抓文档抄**——不可复现、也不该进仓库。
两种正当来源：
1. **本机可复现的运行值**（在基线环境里跑采集脚本，结果连同工具一起进仓库，见 `tools/truth/`）；
2. **官方发布的运行时当"判卷人"**（例如官方 node 二进制解压出来当参照）——这是"可复现地取真值"，
   与"抓文档抄数值"是两件事。

**推论**：`core/sandbox-modules/` 里那些"**勿手改**"的表（常量 / errno / crypto / zlib / fs 错误文案）
都是生成物。**改表要走 `tools/truth/` 的生成链**，不要手抄。

## 4. 验证（改完必须做的事）

**验证三件套**：

```bash
pnpm test          # 当前基线：1066 用例 / 1062 通过 / 0 失败 / 4 平台跳过
npx tsc --noEmit   # 0 错
```

> ⚠️ `pnpm test` 起不来且报 **"This drive is locked by BitLocker Drive Encryption"** 时，是**环境**问题不是代码问题：
> 本机 pnpm 的 store 在 **`F:`**（`F:\.pnpm-store\v10\v11`，BitLocker 卷）—— 解锁 F: 即恢复；
> 应急可等价地直跑 `node node_modules/tsx/dist/cli.mjs --test sdk/__tests__/*.test.ts core/__tests__/*.test.ts`。

仿真层的改动还要跑**差分电池**（与宿主 Node 对跑，**0 分歧才算对齐**）：

```bash
node tools/batteries/deep-cmp-battery.mjs    # 深比较/断言：68 组 × 3 操作
node tools/batteries/events-battery.mjs      # events 语义：34 组剧本
```

**每个修复必须配一条"有判别力"的回归用例**——在修复前的代码上跑**必须红**。
必要时做**变异测试**自证：把修复改回去，用例必须红。

**不要把 `tools/` 加进测试门禁**：那些工具的作用是"把行为打成矩阵供设计判断"，
失败意味着**结论过期了、要重跑工具重读数据**，而不是"测试挂了"（见 `tools/README.md`）。

## 5. ⚠️ 仓库里**不留**的东西

**能被插件（不可信方）主动利用来伤害核心或其它插件的内容——漏洞细节、复现步骤、修法草案——
只写进仓库外的安全清单，仓库内不留。**

理由：**git 历史是永久的**。公开预修复配方等于给攻击者发清单，而且删掉也来不及了。
修完之后仓库内只保留"**类别 + 已修复**"。

> 这也是为什么本仓库**看不到审计清单文件**——它存在过，后来被有意移除了（记录见 ROADMAP 的历史）。

## 6. 环境与已知的雷

- 依赖很少（2 个运行时依赖 + 4 个开发依赖）。`node_modules` 被清空也能
  `pnpm install --prefer-offline` 秒装回来。
- **`quickjs-emscripten` 有本地 pnpm patch**（`patches/`）：`pnpm install` 会自动重打，
  `scripts/verify-quickjs-patch.mjs`（`pnpm verify:sandbox`）会校验它还在。**别手改 `node_modules`**。
- ⚠️ **测试必须把 `SPC_AUDIT_DIR` 指到临时目录**：否则会污染仓库状态、把
  `.spc/audit/audit.jsonl` 涨到 100+ MB（`core/__tests__/sandbox-modules.test.ts` 顶部有现成写法）。
- ⚠️ **临时 git worktree + `node_modules` 是雷**：在 worktree 里跑 `pnpm test` 会触发 pnpm 的
  verify-deps-before-run，把 workspace state 写成 worktree 路径，随后主仓库的 pnpm 会"修"这个状态并
  清空 `node_modules/.pnpm`（实测 `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`）。
  只跑测试用 `node node_modules/tsx/dist/cli.mjs --test …`；worktree 收尾**先摘 junction 再删目录**：
  `cmd /c rmdir <wt>\node_modules` → `git worktree remove --force <wt>`
  （否则 git 的递归删除会**穿过 junction 删掉主仓库的 `node_modules`**）。
- ⚠️ 本地开发工作区（不在本仓库里）与镜像/同步相关的东西**不随仓库分发**；
  仓库文档里只在必要处写明"该工具在仓库外"，**不要写死本机路径**。

## 7. 指路

```
core/               核心：沙箱 / 桥 / 插件生命周期 / 权限 / 审计 / 服务与 CLI
  sandbox-modules/    被仿真的 Node 模块（那些"勿手改"的表就在这里）
  guest/              **跑在 VM 里的 guest 代码**（引导层 / Node 全局）：由 sandbox.ts 读成字符串后求值，
                      不进 tsc、不随插件分发；改它们必须跑真沙箱用例（见 guest/*.js 的文件头）
  __tests__/          测试（含差分用例）
sdk/                插件作者用的类型与校验（契约面）
plugin/             示例插件
scripts/            门禁脚本（进 CI 的那类）
tools/              取证工具：把行为打成矩阵，供设计判断。**先读 tools/README.md**
docs/               权威设计文档（见下）
patches/            上游补丁（pnpm patch）
```

**文档**（在 `docs/`）：
`ROADMAP.md`（阶段与顺序）· `module-emulation-design.md`（仿真模块清单/阶段/限制，**含 §14 实测坑清单**）·
`build-layer-design.md` + `build-layer-evidence.md`（构建层设计与实测）·
`plugin-lifecycle-design.md`（限额与生命周期）· `api-contract.md` · `ADR-00x-*.md`（架构决策）。
