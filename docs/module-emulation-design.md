# 官方模块仿真设计（module emulation）

- 状态：**设计草案（2026-09）**；实现：P2-A（纯计算模块 + 桥契约）→ P2-B（fs / process / os）→ P2-C（buffer / crypto）
- 关联：ADR-005 §5（模块表面契约：**注入面 = 安全边界**）、**build-layer-evidence.md §2/§4.4（§3 清单的排期依据）**、api-contract §2/§5、exec-sandbox-design.md（同为"一个真实文件 + 注册表"模式）、manifest-design.md（权限请求）、ROADMAP P2
- 用途：本文件是**兼容性契约 + 实现清单**——每个仿真模块"仿到什么程度、映射哪个权限点、不支持时怎么报错"都以本文件为准。

## 1. 目标与非目标

**目标**：插件作者按 **Node 官方模块的原生写法**写插件，并且可以引入**只使用官方模块的第三方依赖**；写法与依赖都不需要为沙箱做特殊适配。

```js
// 插件作者预期能这样写（这是本设计的验收形态）
import fs from 'node:fs';
import path from 'node:path';
const file = path.join('.', 'data', 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
```

**首要原则：语法与行为对齐 Node——Node 是契约宗主**

仿真的语义**以 Node 为准**，不以"我们实现起来方便"为准：依赖是按 Node 写的，我们偏一点它们就错一点。

- 语义有歧义时**查 Node 源码定义**（工作区备有 Node 源码），不靠推理或记忆；
- 用**对齐测试**守住：同一输入喂真 Node 与 shim，比输出（`core/__tests__/sandbox-modules.test.ts`）；
- 确实无法对齐的（沙箱真的没有那个东西），**明确报错**并在实现头注释写明"故意不同"及其理由，**绝不静默给一个近似值**。

**非目标**（明确不做，避免误解）：
- 不是"在沙箱里跑真实 Node"：没有真 `process`、没有原生 addon、没有 `child_process`/`worker_threads`；
- 不改变权限模型：仿真是**接口形状的兼容**，能力仍由 `@host/api` + 权限注册表强制（零环境权力不变）；
- 不追求 100% API 覆盖：按真实插件需求逐块扩展（清单见 §3），未登记的模块**在构建期就报错**。

**宿主 API 一律公开**：仿真模块内部用到什么宿主方法，插件作者就应该能直接用同一个方法——仿真存在的意义是**照顾依赖与开发者的早期适应**，不是造一套藏起来的私有通道。

## 2. 兼容性天花板（先认账）

运行环境是 QuickJS（纯 ES2020 语义），因此存在硬边界：

| 维度 | 真实 Node | 本沙箱 | 处理方式 |
|---|---|---|---|
| `Buffer` | 原生 C++ 实现 | 无 | 纯 JS 最小实现（§7），只覆盖常见编码/操作 |
| 同步 IO | 真系统调用 | 只能经宿主桥 | 宿主同步执行（注意阻塞核心事件循环，见 §13-3） |
| 进程能力 | `child_process` / `worker_threads` / 原生模块 | 无 | 明确不做；进程能力只走 exec 模板 / 驱动插件 |
| `process` | 完整对象 | 只读子集 | 冻结实现（§3），`env` 默认空 |
| 版本探测 | 真实版本号 | 仿真值 | **声明一个固定仿真版本**（§13-6），避免依赖按真机版本走不同分支 |
| 网络 | `net`/`http`/`dns` | 无 | 不做；网络由驱动插件以 `@host/api` 端点提供 |

> 一句话：**我们能保证"写法兼容 + 常用行为兼容"，不保证"字节级等价"**。任何依赖若探测真机细节（原生模块、`process.binding`、`v8` 模块），会明确失败而不是静默走偏。

## 3. 模块清单与优先级

| 阶段 | 模块 | 依赖能力 | 说明 |
|---|---|---|---|
| **P2-A** | `node:path` | 无（纯计算） | 直接对齐 Node 行为；最容易、收益最高 |
| P2-A | `node:util` | 无 | `format` / `inspect` / `types` 子集（`promisify` 视需要） |
| P2-A | `node:events` | 无 | `EventEmitter`（含 `once`/`on`/`emit`/`removeListener`） |
| P2-A | `node:assert` | 无 | 常用断言子集（依赖常用它做参数校验） |
| P2-A | `node:url` | 无 | `URL` / `URLSearchParams` 用 QuickJS 内置实现包装 |
| **P2-B** | `node:fs` + `node:fs/promises` | `fs.read.data` / `fs.write.data` | 作用域 = 插件数据目录（+ 显式授予的额外目录）；errno 映射见 §7 |
| P2-B | `node:process` | 只读 | 冻结子集：`platform` / `arch` / `version` / `versions`（仿真值）/ `nextTick` / `env`（默认空，§13-1） |
| P2-B | `node:os` | 只读 | `platform` / `arch` / `EOL` / `tmpdir`（宿主值） |
| **P2-B** | `node:buffer` | 无（编解码走宿主，不碰资源） | **最小集（已定）**：`from` / `alloc` / `allocUnsafe` / `concat` / `isBuffer` / `byteLength` + 实例 `toString` / `slice` / `subarray` / `equals` / `compare` / 数值读写。**字节存沙箱（`Uint8Array` 子类），编解码宿主代工**——见 §3.2。已从 P2-C 提前到 P2-B（构建期口径低估了它；它是二进制的通用货币，`fs` 一支持二进制就必然需要） |
| **P2-B** | `node:string_decoder` | 无（宿主代工） | `StringDecoder`——流式 utf8 解码的**状态机放宿主**（跨 chunk 的不完整多字节序列由 Node 处理）。实测需求面 7 个包，与 buffer 共用同一条代工通道 |
| P2-C | `node:crypto` | `crypto.hash`（待注册） | 只做摘要（sha256/md5）与 `randomUUID`；加密原语走宿主，不在沙箱内自实现 |
| 后置 | `node:stream` / `node:zlib` / `node:string_decoder` … | 视需求 | 按真实插件需求逐块评估，一律"先登记后可用" |

未列入本表的模块（`node:net`、`node:http`、`node:dns`、`node:tls`、`node:cluster`、`node:child_process`、`node:worker_threads`、`node:vm`、`node:v8`、`node:module`、`node:repl` …）**一律拒绝**。

### 3.1 排期依据（实测输入，2026-09）

**排序依据是"哪些包被卡住 + 实际访问几个属性"，不是"Node 文档里有多少 API"。**
理由：依赖改不了，只能迁就它；而 Node 文档描述的是全集，真实依赖只用子集。
数据、方法与工具见 **build-layer-evidence.md §2/§4.4** 与 `tools/`（`dep-survey.mjs` 出清单，`dep-trace.mjs` 追引用链）。

**实测对 §3 的四条修正**

| # | 修正 | 依据 |
|---|---|---|
| 1 | **`node:tty` 补入 P2-A、`node:constants` 补入 P2-B** | 两者都被实测撞到（`chalk` 用 `tty`；`fs-extra`/`dockerode` 用 `constants`），成本极低。**但它们当前解锁 0 个包**（用到它们的包还缺别的）——是**前置条件，不是解锁项** |
| 2 | **子路径内建要独立登记**：`stream/promises`、`path/win32`、`util/types`、`timers/promises` | 实测均撞到。§4 的规则本来就要求独立登记名，但**清单里一个都没列** |
| 3 | **`stream` 从"后置"提升**（建议 P2-D） | 在 43 个小工具包样本里，**单独补 `stream` 解锁 5 个包**（`chokidar` `fast-glob` `proper-lockfile` `graceful-fs` `csv-parse`），是单个模块里最高的。而且按包拆开多为 **1–2 个属性**（`Stream` + `call`）——**小 shim 可能就够**；只有 `archiver` 真的需要完整 stream |
| 4 | **`zlib` 按"能力型"设计，不是纯计算** | `adm-zip` 只要 4 个属性（`deflateRawSync`/`createDeflateRaw`/`inflateRawSync`/`createInflateRaw`）。压缩算法要么走宿主、要么纯 JS 实现（工作量大）⇒ 与 `fs`/`crypto` 同类：**源码静态可内联，能力运行时接上** |

**两条要写进纪律的**：

- **"一律拒绝"要按属性判断，不是按模块**——`node:worker_threads` 在实测里只被访问了 `threadId`
  （`write-file-atomic` 拿它判断"在不在 worker 里"），**那不是能力**，返回 `null` 即可；
  而 `child_process` 的 `spawn`/`spawnSync`、`net` 的 `createConnection` 确实是能力，维持禁区。
  ⇒ 上面那句"一律拒绝"应理解为"**这些模块的能力面**一律拒绝"；
- **`fs` 的门槛在方法面的宽度**，不在依赖了谁——`fs-extra` 一个包就用到 **41 个 `fs` 方法名**。
  实现 5 个它照样跑不起来。

**一条必须搭配的约束**：仿真模块**必须可内联**（静态、无构建期占位符、能力运行时从全局取）——
见 §5 规则 2 的修订要求与 build-layer-evidence §4.2。

**两条原待定项已定（2026-09）**

| 问题 | 决定 | 落点 |
|---|---|---|
| **`Buffer` 要不要提前** | **提前到 P2-B**，随 `fs` 的二进制读写一起（构建期口径低估了它） | §3 清单已改 |
| **`fs` 回调风格要不要支持** | **支持**（薄包装，非第二套实现）；必须照做"回调不同步触发" | §8 |

### 3.2 宿主代工：哪些数据处理放宿主（以 `Buffer` 为例）

**结论：字节存沙箱，编解码宿主代工。**

三条理由，**第一条最重要**：

1. **保真**——编解码交给宿主 = 宿主就是 Node，**天然逐字节一致**。这类实现的难点从来不是主流程，而是**畸形输入**：孤立代理项怎么替换、`Buffer.from(str,'base64')` 的宽松性、`toString('utf8')` 遇到非法序列怎么办。自己实现必然逐条漂移，而且很难测全；走宿主则**不需要复刻**；
2. **性能**——实测：沙箱内纯 JS 逐字节处理只有 **≈2.6 MB/s**（1 MB 循环 395 ms，Node 原生约 1 ms），而 **QuickJS 没有 `TextEncoder`/`TextDecoder`**，不代工就只能纯 JS 逐字节；
3. **存储必须留沙箱**——索引 `buf[i]`、`subarray`、`DataView` 都是原生操作。字节若放宿主（不透明 id），随机访问就得逐字节跨界，比 395 ms 更糟。

分工：

| `Buffer` 的面 | 放哪 | 依据（实测） |
|---|---|---|
| 字节存储（`class Buffer extends Uint8Array`） | **沙箱** | QuickJS 支持类型化数组子类化，`instanceof` 正常 |
| `length` / `buf[i]` / 迭代 | **沙箱** | 原生 |
| `subarray` / `slice` / `set` / `fill` / `copy` | **沙箱** | 原生，且 `subarray` 共享底层、`slice` 复制——语义已实测正确 |
| `readUInt32LE` 一类数值读写 | **沙箱** | `DataView` 原生，字节序 LE |
| **`toString(enc)` / `Buffer.from(str, enc)` / `byteLength`** | **宿主代工** | 无 `TextEncoder` + 保真 |
| `concat` / `compare` / `equals` / `indexOf` | 沙箱优先，大块可代工 | 小块跨界不划算，阈值待实现期量 |
| **`StringDecoder`（流式）** | **宿主代工** | 状态机（跨 chunk 的不完整序列）放宿主更稳 |

**参考量级**：Node 侧 `lib/buffer.js` 1539 行 + `lib/internal/buffer.js` 1154 行 + `lib/string_decoder.js` 146 行
——这就是"自己实现"要复刻并逐条对齐的量。

**桥的二进制通道已具备**（行为是实测的，不是读注释推断的）：

| 原语 | 实测行为 |
|---|---|
| `vm.newArrayBuffer(bytes)` | 宿主 → 沙箱，**一次拷贝**；沙箱侧读出来 `instanceof ArrayBuffer` 为真 |
| `vm.getArrayBuffer(handle)` | 沙箱 → 宿主，**一次拷贝**——把宿主侧返回的视图改掉，**沙箱内看不到变化**，所以不是共享内存 |
| `vm.typeof(handle)` | 二进制是 `'object'`、字符串是 `'string'` ⇒ **用它判别参数类型** |
| ⚠️ `vm.getString(二进制handle)` | **不报错**，返回字面量 `"[object ArrayBuffer]"` —— 桥若不做类型判别，会把二进制**静默变成这串垃圾**（当前桥是字符串专用，加二进制时必须先判别） |

**实测成本**（`tools/bridge-bench.mjs`，1 MB/4 MB 档，7 轮取中位）：

| 载荷 | 调用开销（跨界底价） | 宿主→沙箱（二进制） | 沙箱→宿主（二进制） | **字符串通道** |
|---|---|---|---|---|
| 0 B | **0.21 ms** | 0.23 ms | 0.22 ms | 0.21 ms |
| 1 KB | 0.21 ms | 0.22 ms | 0.23 ms | 0.23 ms |
| 64 KB | 0.21 ms | 0.28 ms（221 MB/s） | 0.30 ms（208 MB/s） | 1.34 ms（47 MB/s） |
| 1 MB | 0.19 ms | **0.84 ms（1185 MB/s）** | 1.06 ms（941 MB/s） | **19.2 ms（52 MB/s）** |
| 4 MB | 0.25 ms | **2.13 ms（1882 MB/s）** | 2.25 ms（1778 MB/s） | **71.8 ms（56 MB/s）** |

**三条读数**

1. **二进制通道比字符串通道快 20–34 倍**（1 MB：0.84 ms vs 19.2 ms；4 MB：2.1 ms vs 71.8 ms）；
   比"沙箱内自己逐字节"（≈2.6 MB/s）快约 **700 倍**。"走二进制而不是 base64/字符串"这个选择因此是**量出来的**，不是偏好；
2. **跨界底价 ≈0.2 ms/次**，且**它盖住了一切小载荷**：≤1 KB 时两条通道完全测不出差别。
   推论有两条——① 字符串通道**不会**因为"只传小数据"就更划算；② 守门测试**必须用相对比较**（见下）；
3. 单次 memcpy 的实际带宽约 **1.2–1.9 GB/s**。**早先文档里写的"1 MB ≈ 0.1 ms"是我估的，实测慢了约 6 倍**
   （1 MB 总耗时 0.84 ms，扣掉 0.2 ms 底价 ⇒ 纯传输 ≈ 0.65 ms）。
   方向没估错（确实是"很快"），但**量级从没量过就写进了文档**——所以现在这些数都标了出处与档位。

**成本回归的守门方式**（`core/__tests__/sandbox-modules.test.ts`）：

**用相对比较，不用绝对阈值**——1 MB 二进制 vs 1 MB 字符串，断言**二进制至少快 5 倍**（实测 ~22x，留足余量）。
理由：绝对毫秒数随机器波动易 flaky，且小载荷下被底价盖住测不出；而"二进制比字符串快多少倍"是**架构性质**，
把二进制改走 base64/字符串会让这个比值**从 ~20x 塌到 1x**，一测就中。
数值留档在 `tools/bridge-bench.mjs`——**改动二进制通道后必须重跑它**。

> 这条通道**不是 `node:buffer` 的私有实现细节**，而是 P2-B 的公共基础设施——`fs` 的二进制读写、
> 将来的 `zlib`（压缩输出）、`crypto` 摘要的输出都要它。宿主编解码方法本身也**公开**（见 §1 末条）。

**实现期踩到的四个坑（都实测过，记下来免得再踩）**

| # | 坑 | 后果 | 正解 |
|---|---|---|---|
| **1** | **`Buffer.prototype.slice` 是共享内存的**（语义同 `subarray`），与 `Uint8Array.prototype.slice`（复制）**同名不同义** | ⚠️ **安全相关**：池化 Buffer（`Buffer.from` 的小对象走 8 KB 池）上 `slice().buffer` 仍是**整块池** → 把**同池里属于别人的字节**一起送进沙箱。实测：本要 5 字节，实际送出 8192 字节，里面混着构建工具的 source map | 用 `new Uint8Array(view)` 复制（走 TypedArray 构造，与 Buffer 的原型无关） |
| **2** | 宿主对 `__host[...]` 的返回值**一律 `JSON.stringify`**，字符串结果回来是**带引号**的 | 少一步 `JSON.parse` 就把引号一起交给插件（实测 `bytes.toString` 返回了 `"hi"`） | 用 `__json` 系列包装器 |
| **3** | `@host/api` 的 `__marshal` 会把**非字符串 JSON 化** | 二进制参数经 `__wrap`/`__json` 进去会变成字符串（`JSON.stringify(new ArrayBuffer(2))` === `"{}"`，外面再套 `__spcJson:`），宿主收到的是字符串参数 | 二进制参数必须走 `__marshalBin`（`__jsonBin` 即"参数二进制、结果 JSON"） |
| **4** | **`vm.getArrayBuffer(handle)` 只认 `ArrayBuffer`，不认 `Uint8Array` 视图**；且失败时报 `"Couldn't allocate memory to get ArrayBuffer"` | 报错**读起来像 OOM**，把"类型传错"误导成"内存不够"（实测踩到：只按 `typeof === 'object'` 判别，把 `Uint8Array` 也当二进制送进去了） | 桥先 `try/catch`，失败返回明确的 `INVALID_ARGS`（`reason: binary-arg-not-arraybuffer`）；契约写死：**二进制参数必须是 `ArrayBuffer`**（`@host/api` 侧由 `__toAB` 保证） |

**一条桥的固有限制（记录在案，不是待修 bug）**：**字符串通道是 UTF-8**（`JS_ToCString`），
因此**不成对的代理项过不去**——会被编成 WTF-8 三字节，宿主解码时逐字节判非法，
变成 **3 个 U+FFFD**（而 Node 直接编码该字符串时只给 1 个）。
影响很小（只有把字符串从代理对中间切开才会产生孤立代理项，那本就是调用方的 bug），
但**它意味着"字符串参数在桥上不是无损的"**——将来若有需求，得换成 UTF-16 传递。
守门测试见 `sandbox-modules.test.ts`：哪天桥改成 UTF-16 传递，它会红，提醒同步改这里。

## 4. specifier 规则

| 插件写法 | 是否接受 | 映射 |
|---|---|---|
| `'node:fs'` | ✅ | 登记名 `node:fs` |
| `'fs'`（裸名） | ✅ | 归一化为 `node:fs`（第三方依赖普遍用裸名） |
| `'node:fs/promises'` | ✅ | 独立登记名（与 `node:fs` 同文件不同导出面，见 §5） |
| `'fs/promises'` | ✅ | 归一化为 `node:fs/promises` |
| `'node:fs/promises/extra'` / 其它子路径 | ❌ | 未登记 → 构建期报错 |
| 相对路径 `'./x.js'`、包名 `'lodash'` | ❌（运行时） | 依赖必须经构建层内联（ADR-005 §6）；沙箱内不做路径解析 |

**归一化在 loader 里做一次**（`node:` 前缀可选、裸名等价），构建层用同一张表做静态校验（§10）。

## 5. 架构：一模块一文件 + 白名单注册表

骨架已就位（错误码与沙箱桥改造时落地）：

```
core/sandbox-modules/
  host-api.js        ← 能力面（@host/api）：真实文件 + // __SPC_EXPORTS__ 占位（导出清单运行时生成）
  node-path.js       ← 下一步：纯计算模块（无占位符，整文件直出）
  node-fs.js         ← 有占位符（作用域/权限点在初始化时注入，见下）
  …
core/sandbox.ts
  moduleSource(specifier, ctx) → 源码 | null（null = 拒绝）
```

规则：
1. **一个模块一个真实文件**：可评审、可高亮、可单测——这是选择"文件 + 占位符"而不是 TS 模板串的原因；
2. **动态部分最小化**：只有"随插件不同而不同"的东西才做占位符替换（如 `@host/api` 的方法清单、`fs` 的作用域根与插件 id）。能用 `globalThis` 注入的一律注入，让模块正文保持静态；
3. **loader 只认注册表**：未登记 → 抛错（零环境权力的执行点，ADR-005 §5）；
4. **打包**：`sandbox-modules/*.js` 必须随核心分发（P5 自包含 bundle 时以 text loader 内联或作为资源随包）。

## 6. 能力映射（Node API → 权限点）

**仿真是形状，权限是实质**：每个会触碰宿主资源的接口都映射到注册表里的权限点；插件 manifest 的声明仍是唯一入口，未声明 = 拒绝。

| 仿真接口 | 权限点 | 作用域 | 备注 |
|---|---|---|---|
| `fs.readFile(Sync)` / `readdir` / `stat` / `exists` | `fs.read.data` | 插件数据目录 | 路径先过 `validatePath`（F1–F7 全套） |
| `fs.writeFile(Sync)` / `mkdir` / `rm` / `rename` / `copyFile` | `fs.write.data` | 同上 | 大小上限、TOCTOU inode 校验沿用 |
| `fs.watch` | — | — | **不做**（无 inotify 面；需要监听走 `events`/`timers` 由插件轮询或宿主提供专用 API） |
| `crypto.hash` | `crypto.hash`（新增） | — | 摘要计算；`normal`/`public` 级 |
| `os.tmpdir` / `os.platform` | — | — | 宿主只读信息，公开级，自动授予 |
| `process.env` | （待定，§13-1） | — | 默认冻结空对象 |
| `path.*` / `util.*` / `events.*` / `assert.*` | — | — | 纯计算，不触碰资源，无需权限点 |

**约定**：仿真模块**不得**引入新的权限语义；需要新能力时先在 `core/permissions/registry.ts` 注册权限点，再在映射表里登记（两处同步修改是评审项）。

## 7. 错误语义兼容（关键）

第三方依赖普遍按 **POSIX errno 字符串**分支（`if (err.code === 'ENOENT') …`）。因此仿真层必须做**错误码翻译**：

| 宿主码（SpcError.code） | 仿真层抛出 | 依据 |
|---|---|---|
| `PATH_OUT_OF_SCOPE` / `SYMLINK_ESCAPE` / `PERMISSION_DENIED` | `EACCES` | 越界或未授权 = 拒绝访问 |
| `SYMLINK_DANGLING` | `ELOOP` | 链接无法解析 |
| `PARENT_MISSING`（读取路径） | `ENOENT` | 目标不存在 |
| `FILE_TOO_LARGE` / `TARGET_TOO_LARGE` | `EFBIG` | 超出单文件上限 |
| `TIMEOUT` | `ETIMEDOUT` | 宿主侧超时 |
| `INTERNAL` / 其它 | `EIO` | 未分类内部错误 |

**同时保留原始码**：抛出的错误对象带 `err.spcCode = '<宿主码>'`（诊断与审计用），`err.message` 用英文（Node 生态习惯），本地化仍只在 CLI / 面板渲染层（api-contract §2）。

> 设计取舍：**对外看起来像 POSIX，对内仍然是我们的码**。这样依赖能正常工作，我们的审计与排障也不丢信息。

## 8. 返回值与异步语义（桥契约变更）

现状（P1 spike 约定）：宿主桥把结果 `JSON.stringify` 后回传，插件拿到的是**字符串**——与 `sdk/host-api.d.ts` 声明的对象不符，也不满足 Node 风格 API。

**P2-A 起改为统一信封**：

```jsonc
// 成功
{ "ok": true, "value": <任意 JSON 值> }
// 失败（保持不变）
{ "__spcError": { "code": "PATH_OUT_OF_SCOPE", "params": { … } } }
```

- 沙箱侧 `__wrap` 拆信封：`ok` → 返回 `value`（字符串仍是字符串，对象就是对象）；`__spcError` → 抛错（仿真层再按 §7 翻译成 errno）；
- **异步**：宿主方法可返回 Promise（asyncify 支持挂起/恢复）。桥在序列化前 `await` thenable：

```ts
const ret = method.fn(...args);
const value = ret && typeof (ret as Promise<unknown>).then === 'function' ? await ret : ret;
```
  `fs.promises.*` 与将来的网络类能力都依赖这条；实现时必须验证 asyncify 下 Promise 挂起与错误路径（P2-A 的验收项之一）。

- **回调风格（已定，2026-09）：支持**。Node 的 `fs.readFile(p, cb)` 与 `fs.promises.readFile(p)` 并存
  （callback 风格要支持，否则一批老包直接不可用），而**回调不是第二套实现，是薄包装**：
  宿主侧只实现一份桥，回调形式 = 调桥 + 把结果排进微任务再回调。
  **必须照做"回调不同步触发"**——这是 Node 的保证，某些依赖的时序假设建立在这上面；
  同步触发会让它们在 Node 上能跑、在沙箱里出错（属静默行为差异，见 build-layer-evidence §2.6 的同类问题）。

## 9. 不可仿真项与替代

| 做不到 | 替代 |
|---|---|
| 原生模块（`.node`） | **构建期失败**（ADR-005 §7）：由驱动插件在核心侧提供 `@host/api` 端点 |
| `child_process` | exec 模板（interface-audit-exec-fs.md / exec-sandbox-design.md） |
| `worker_threads` | 不做；重计算拆成多次宿主调用或由驱动插件承担 |
| 真 `Buffer`（C++） | 最小纯 JS 实现（§3 P2-C）：只保证常见编码与操作 |
| `fs.watch` / inotify | 不做；轮询或宿主专用事件 |
| 网络（`net`/`http`/`dns`/`tls`） | 驱动插件提供的端点 |
| `process.exit` / 信号 | 不做；插件生命周期由核心管理（init/start/stop） |

## 10. 与构建层的联动（构建期即失败）

1. **静态扫描 builtin 依赖**：构建层解析依赖图，收集所有 `node:*` / 裸内建模块引用，与本文件的登记表比对；
   - 未登记 → **构建失败**（而不是"构建通过、运行时报 module not allowed"）；
2. **CJS 依赖的 `require('fs')`**：**已实测**——esbuild 在 `platform: node` 下会把它降级成"运行期兜底"**留在产物里**，且**构建不会失败**。因此构建层必须有两道闸：① resolve 插件对**未登记内建**直接报错、对**已登记内建内联仿真正文**（实测：标 external 对 CJS 形态无效，会退化成兜底调用）；② **产物断言**——判据是标记字符串 `"Dynamic require of "`（朴素正则 `__require(` 会误报辅助函数的定义行）。完整证据与方法见 **docs/build-layer-evidence.md**；
3. **ESM-only 不变**（ADR-005 §4）；**依赖不分级**（ADR-005 §7 v2）——内联是当前唯一路径。
   L1 里混着的"平台托管"是**模块供给机制**（不是政策档位），取消分级时被连带丢掉，**属未排期的社区讨论项**（ADR-005 §7 v3 补记）；
4. **构建产物里不出现未登记的内建引用**可作为 CI 断言（与 `verify-no-bare-dispatcher` 同类的门禁思路）。

## 11. 测试策略

| 层级 | 内容 |
|---|---|
| 行为对齐 | 每个仿真模块一份测试，覆盖 Node 官方文档的典型用法 + 边界（如 `path.join` 的 `..`/绝对路径、`fs.readFileSync` 的编码参数） |
| 权限负面 | 未声明权限 → `EACCES`；越界路径 → `EACCES`；未登记模块 → 构建失败 + 运行时拒绝（双保险） |
| 错误码兼容 | 依赖常见分支：`try { fs.statSync(p) } catch (e) { e.code === 'ENOENT' }` 必须成立 |
| 真实依赖冒烟 | 选 **纯 JS、只用官方模块** 的小库（如目录创建/调试类）跑通安装→构建→沙箱内执行（Linux + Windows 双平台） |
| 审计 | 仿真调用与 `@host/api` 调用**落同一条审计**（方法名、码、参数摘要），不搞第二套 |

## 12. 阶段划分

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P2-A** | `node:path` / `util` / `events` / `assert` / `url` 五个纯计算模块；桥契约（信封 + 对象化 + 异步 await）；loader 归一化（`node:` 前缀/裸名/`fs/promises`）；构建层 builtin 静态校验 | 纯 JS 依赖（只用官方模块）能在沙箱内跑通；未登记模块构建期失败 |
| **P2-B** | `node:fs` + `node:fs/promises`（作用域=数据目录、errno 映射）、`node:process` / `node:os` 只读子集 | `mkdirp`/`glob` 一类只用 fs+path+events 的依赖跑通；越界与未授权均 `EACCES`；审计完整 |
| **P2-C** | 最小 `node:crypto` 摘要（`node:buffer` 已提前到 P2-B，见 §3） | 二进制读写（base64/hex）与摘要用例通过；依赖探测 `Buffer` 的分支不崩 |
| 后续 | `stream` / `zlib` / `string_decoder` … 按真实插件需求逐块评估 | 每个新模块：本文件登记 + 权限映射 + 对齐测试 |

## 13. 待定项（评审时逐条定）

1. **`process.env` 暴露策略**：默认空对象已定；是否需要"白名单 + 权限点"（如 `env.read`）由 P2-B 定；
2. **`tmpdir` / `cwd` 语义**：`tmpdir` 用宿主值；`cwd` 建议=插件数据目录（与 fs 作用域一致），需确认；
3. **同步长操作**：`readFileSync` 走宿主同步 IO 会阻塞核心事件循环——是否需要大小阈值/超时/警告；
4. **仿真 Node 版本**：`process.versions.node` 汇报一个**固定的仿真版本**（建议 22.x LTS），并写进本文件，避免依赖走不同分支；
5. **未登记模块的用户体验**：构建期报错文案要指出"是沙箱未支持，而非代码写错"（清单可从本文件自动生成）；
6. **`node:module` / `createRequire`**：CJS 依赖可能需要 `createRequire`——是否在沙箱内提供受限版本，随 §10-2 一起定。
