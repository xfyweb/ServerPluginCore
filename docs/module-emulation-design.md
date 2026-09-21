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
| **P2-A** | `node:url` | `url.parse` / `url.encode` | WHATWG `URL`/`URLSearchParams` **宿主代工**（解析一次 → 全量快照，赋值时回宿主重算，§13.1-7）；`pathToFileURL`/`fileURLToPath`/legacy `parse`/`format`/`resolve` 沙箱自实现（照 `node/lib/url.js` 移植，路径语义固定 POSIX） |
| **P2-B** | `node:fs` + `node:fs/promises` | `fs.read.data` / `fs.write.data` | 作用域 = 插件数据目录；**真实动作在宿主**（`core/hostApi.ts` 的 `fs.*` 原语：路径收敛 F1–F7 + 大小上限 + inode 预检 + 审计），**形状与 errno 翻译在沙箱**（`node-fs.js`）。三风格（sync/promises/回调）同一实现；fd 类与 `fs.watch`/流一律 `ERR_NOT_SUPPORTED_IN_SANDBOX`（§9） |
| P2-B | `node:process` | 只读 | 冻结子集：`platform` / `arch` / `version` / `versions`（仿真值）/ `nextTick` / `env`（默认空，§13-1） |
| P2-B | `node:os` | 只读 | `platform` / `arch` / `EOL` / `tmpdir`（宿主值） |
| **P2-B** | `node:buffer` | 无（编解码走宿主，不碰资源） | **最小集（已定）**：`from` / `alloc` / `allocUnsafe` / `concat` / `isBuffer` / `byteLength` + 实例 `toString` / `slice` / `subarray` / `equals` / `compare` / 数值读写。**字节存沙箱（`Uint8Array` 子类），编解码宿主代工**——见 §3.2。已从 P2-C 提前到 P2-B（构建期口径低估了它；它是二进制的通用货币，`fs` 一支持二进制就必然需要） |
| **P2-B** | `node:string_decoder` | 无（宿主代工） | `StringDecoder`——流式 utf8 解码的**状态机放宿主**（跨 chunk 的不完整多字节序列由 Node 处理）。实测需求面 7 个包，与 buffer 共用同一条代工通道 |
| **P2-C** | `node:crypto` | `crypto.hash` / `crypto.random` / `crypto.cipher` | **已完成**：摘要/HMAC/`randomBytes`/`randomUUID`/`getRandomValues`/`randomInt`/`timingSafeEqual`/**对称解密**（`createDecipheriv`，一次性）；`constants`/`getHashes`/`getCiphers`/`getCurves` 按固定基线。`sign`/`verify`/`KeyObject`/`diffieHellman`/`pbkdf2` 一族**明确抛错**（密钥对象要求对象身份）。加密原语一律宿主代工 |
| **P3** | `node:zlib` | `zlib.compress` / `zlib.decompress` | **已完成（同步面 + 回调面）**：`deflateRaw(Sync)`/`deflate(Sync)`/`gzip(Sync)`/`inflateRaw(Sync)`/`inflate(Sync)`/`gunzip(Sync)`/`unzip(Sync)` + `crc32` + `constants`/`codes`（固定基线）。**流式入口**（`createGzip` 一族）与 brotli/zstd 明确抛错（前者等 `stream`，后者无实测需求） |
| **P3** | `node:querystring` | 无（唯一宿主代工点是坏转义的 UTF-8 回退） | **已完成**：`parse`/`stringify`（`encode`/`decode` 是**同一个函数对象**，照 Node 的别名）+ `escape`/`unescape`/`unescapeBuffer`，逐行移植 `node/lib/querystring.js`（含自定义 `sep`/`eq`/`maxKeys`/`decodeURIComponent`）。与 `node-url.js` 内部那份 legacy 子集**并存且有意不合并** |
| **P3** | `node:worker_threads` | 无 | **已完成（只报事实）**：`threadId`(0)/`isMainThread`(true)/`workerData`(null)/`parentPort`(null)/`SHARE_ENV`；`Worker`/`MessageChannel`/`MessagePort`/`receiveMessageOnPort`/`markAsUntransferable` 等**一律明确抛错**。存在理由只有一个：`write-file-atomic` 一类包在装载时读 `threadId` 决定临时文件名后缀（§3.1 的"按属性判断"） |
| **P2-D** | `node:stream` | 无 | **已完成（B1：极小形状）**：`Stream`（**legacy 函数基类**，`Stream.call(this)` 可用）+ `Readable`/`Writable`/`Duplex`/`Transform`/`PassThrough` + `pipe`/`push`/`_transform`/`_flush`/objectMode + `finished`/`pipeline`；`stream/promises`/`stream/web`/`stream/consumers` **登记但明确抛错**。范围是**逐包读出来的**，不是照 Node 文档写的——见 §9 的 stream 条目 |
| 后置 | `node:string_decoder` 之外的剩余模块 | 视需求 | 按真实插件需求逐块评估，一律"先登记后可用" |

未列入本表的模块的**能力面**（`node:net`、`node:http`、`node:dns`、`node:tls`、`node:cluster`、`node:child_process`、`node:vm`、`node:v8`、`node:module`、`node:repl`、`node:worker_threads` 的 `Worker` …）**一律拒绝**；
但"只报事实、不碰能力"的子集可以登记（`worker_threads` 的 `threadId`/`isMainThread` 就是范例，见 §3.1）。

> **每个模块"自己实现"还是"让宿主代工"，按下表判据决定**（§3.2.1 通则：调用频率 × 载荷 × 是否需要对象身份），
> 不要按"它是不是纯计算"想当然：`util.inspect` 看着该代工，实际必须沙箱（要遍历沙箱值）；
> `URL` 解析看着该自己写，实际该代工（一次解析、畸形输入保真）。

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

### 3.2 宿主代工：判据与边界（以 `Buffer` 为例）

#### 3.2.1 通则：什么时候该让宿主代工

**判据按「调用频率 × 单次载荷 × 是否需要对象身份」分，不按"这个模块是不是纯计算"分。**

宿主就是 Node，所以"让宿主算"在**语义保真**上永远是最优解——不这么做的理由只有四条，且都是硬的：

| # | 阻断 | 具体后果 |
|---|---|---|
| 1 | **桥没有对象身份** | 只能传字符串/字节。宿主返回**对象**要靠 JSON 往返（丢原型/getter/`Map`/`Set`/循环引用）；返回**类实例或闭包**根本过不去——监听器（`events`）、`Buffer` 实例、`Stream`、`URL` 实例都属于后者 |
| 2 | **跨界底价 ≈0.21 ms/次**（实测，见下表） | 热循环里的纯计算慢几百到上千倍：`path.join` 调 1 万次 ≈ **2.1 s**（跨界）vs 沙箱内毫秒级 ⇒ 直接撞上 5 s 的钩子 CPU 预算 |
| 3 | **属性访问拦不住** | `path.sep`、`os.EOL`、`Buffer.poolSize` 是**属性**不是方法；拦它只能上 `Proxy`，代价大且破坏 `typeof`/`instanceof`/`Object.keys` 语义 ⇒ **模块表面必须是沙箱里的真对象** |
| 4 | **代工调用会落审计** | 桥的不变量是"每次宿主调用一条审计"（§8）：把 `Buffer.toString()` 放进循环 = 每圈一条审计 + 一次磁盘追加 ⇒ 纯计算变成**审计噪音与写放大** |

再加一条工程约束：仿真模块**必须可被构建层内联**（静态、无占位符，§5 规则 2），
所以沙箱侧那段"模块外壳"无论走哪条路都跑不掉。

| 特征 | 策略 | 例子（已落地 / 计划中） |
|---|---|---|
| 高频 × 小载荷 × 纯逻辑 | **沙箱自实现** | `path`、`events`、`assert`、`util.format`/`inspect`/`types` |
| 低频 × 大载荷 × 语义难（畸形输入多） | **宿主代工** | 编解码（`Buffer.from`/`toString`、`StringDecoder`）、`crypto.hash`、`zlib`、WHATWG `URL` 解析 |
| 需要真实资源 | **宿主能力 + 权限点 + 审计** | `fs`（含 errno 翻译）、`exec` |
| 只读事实、不是调用 | **启动时注入快照**（连桥都不用） | `process.platform`/`versions`、`os.platform`/`arch`/`EOL`/`tmpdir` |
| 需要对象身份 / 子类化 / 闭包 | **沙箱外壳 + 重活代工** | `buffer`（存储与索引在沙箱、编解码代工）、`stream` 形状 |

> **关于"桥没有对象身份"这条阻断的最新证据（2026-09，已验证未采用）**：`quickjs-emscripten` **自带**
> `vm.newHostRef(hostObject)` / `vm.toHostRef(handle)` / `vm.unwrapHostRef(handle)`——沙箱里拿到的是个
> **有身份的 guest 对象**（`a === a`、`a !== b`），宿主方法把它收回来就能得到**当初那个宿主对象**
> （`toHostRef(h).value === 原对象`，可继续改它的状态），宿主值的释放由 wrapper 的 host refs 表 + guest GC 驱动。
> 所以"身份"这条**不是引擎级缺口，也不需要魔改 QuickJS**：它只是"桥还没支持第三种参数"。
> 实测证据：`tools/probes/hostref-probe.mts`（两个 `Hash` 对象各自累积状态、互不串味、收尾干净）。
>
> 采用它要付的代价（都不是小事，所以本批没用）：
> ① 桥要加第三种参数类型（宿主对象引用）与对应的 `HostApi` 签名；
> ② **句柄所有权纪律**：宿主函数里 `return ref.handle` 会把所有权交给 VM，之后再 `dispose()` 会抛
> `QuickJSUseAfterFree: Lifetime not alive`（实测踩到）——漏管则收尾时命中 `JS_FreeRuntime` 的
> `list_empty(&rt->gc_obj_list)` 断言（**abort 整个进程**，不是抛错）；
> ③ guest 侧的宿主对象是**不透明**的（没有方法/属性），插件面的类（`Hash`）仍然要在沙箱里组装，
> 方法调用照样一次一跨界。
> ⇒ 结论：等真需要"跨调用保持真状态"的模块（`crypto` 的 `Hash`/`Cipher`、`stream`）时再引入，
> 并且是**先扩桥**、不是先改引擎。

**已落地模块的核对（2026-09，逐条对判据）**

| 模块 | 落点 | 结论 |
|---|---|---|
| `path`（+`posix`/`win32`） | 沙箱 | 高频纯逻辑；30 万组随机输入 + 173 组边界**零分歧** |
| `events` | 沙箱（**不可代工**） | 监听器是沙箱闭包；`emit` 极高频 |
| `assert`（+`strict`） | 沙箱（**不可代工**） | 深比较要遍历沙箱值；`throws(fn)` 收的是沙箱函数 |
| `tty` | 沙箱常量 | 沙箱确实没有终端：`isatty` 恒 `false` 是**如实回答**；`ReadStream`/`WriteStream` 明确抛错（fail-closed） |
| `constants` | 静态 Linux 表 | 只读事实里唯一**没走注入**的一个：有意固定基线（与 `path` = posix 同一取向）；将来若要"跟随宿主平台"，注入路径现成 |
| `bytes` 组 + 桥的二进制通道 | **代工通道本身** | 编解码代工的第一个实例（见下） |
| 宿主 `fs.read`/`write`/`list`/`stat` | 宿主能力 | 判据要求的那一侧；`node:fs` 落地时要**扩方法面**（`fs-extra` 一个包用到 41 个方法名），`fs.stat` 要加字段才撑得起 Node 的 `Stats` |

**给"将来要代工的方法"立的三条规矩**（P2-B 起适用）

1. **必须有大小上限**：每次代工调用都要能被限住（沿用 `fs` 的单文件 64 MB / 读 8 MB 那套），否则它就是一个放大攻击面；
2. **必须预算感知**：宿主阻塞会**绕过 CPU deadline**（S-2 的教训：1 秒预算里阻塞了 40.7 秒、还被记成成功）——
   新方法要像 `exec.run` 那样用 `bridge.remainingMs()` 给自己封顶，并接受墙钟事后校验；
3. **审计量要算进成本**：高频方法走代工会把审计写爆（阻断 4）——选代工前先估"每秒会落多少条"。

#### 3.2.2 以 `Buffer` 为例：分工与实测

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

**文件名约定（唯一一条规则，别记岔）**：`node-` + **规范名，只把 `/` 换成 `-`**，其余字符（含**下划线**）原样保留。
`registry.ts` 的 `shimFileName()` 生成它，`isShimFileName()` 判定它（加载器服务"shim 之间的相对 import"时用后者）。

| 规范名 | 文件名 | 说明 |
|---|---|---|
| `path` | `node-path.js` | 直通 |
| `string_decoder` | `node-string_decoder.js` | **下划线是规范名的一部分，不换**（`node-string-decoder.js` 曾是错的，已改名） |
| `fs/promises` | `node-fs-promises.js` | 那个连字符来自**路径分隔符** `/`，不是名字里的连字符 |
| `path/win32` `assert/strict` `util/types` | `node-path-win32.js` `node-assert-strict.js` `node-util-types.js` | 同一规则 |
| `path/posix` | `node-path.js`（`shimFile` 别名） | 同一份实现服务多个 specifier 时才用别名条目 |

> 两处判据必须同源：`shimFileName()` 与 `isShimFileName()` 一旦漂移，症状是"文件按约定命名了、加载器却不服务它"。
> 曾经加载器只认 `[a-z0-9-]`（漏了下划线），当下没炸只是因为还没有 shim 去 import `node-string_decoder.js`——
> `stream` 那批一定会（`node-stream.js` 要用 StringDecoder）。守门用例：`sandbox-modules.test.ts` 的
> "每个真实的 node-*.js 都必须过加载器的文件名判据"。

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
| `URL` / `URLSearchParams` 解析 | `url.parse` / `url.encode` | — | 宿主代工的计算，输入输出都在调用方手里，`scope=self` 声明即用（同 `bytes.*`） |
| `path.*` / `util.*` / `events.*` / `assert.*` | — | — | 纯计算，不触碰资源，无需权限点 |
| `Buffer` 的**编解码**（`Buffer.from(str)` / `buf.toString(enc)`） | `bytes.encode` / `bytes.decode` | 插件自身 | 字节在沙箱里（`Uint8Array` 子类）不碰资源；只有**跨宿主编解码**要声明这两个点（scope=self，安装即生效）。`node:fs` 的文本读写刻意不经此路（见下面的权限耦合说明） |

**`@host/api` 的 `fs` 组（能力面）与 `node:fs`（仿真面）的关系**：能力面保留既有的
`fs.read` / `fs.write` / `fs.list` / `fs.stat` 四个（契约已发布），仿真面用的是一组**更低层的原语**
（`fs.readBytes` / `fs.writeBytes` / `fs.statFull` / `fs.readdirEntries` / `fs.mkdir` / `fs.mkdtemp` /
`fs.rm` / `fs.rmdir` / `fs.rename` / `fs.copyFile` / `fs.realpath` / `fs.access`），它们同样登记在
`@host/api` 里（透明：沙箱能做到什么，能力面就照实列出），差别只在**形状**——
能力面给插件的 JSON 对象，仿真面把同一批原语组装成 Node 的 API 形状。
两处**不是两套实现**：权限点、路径收敛、大小上限、审计全在宿主那一层。

> **权限耦合的取向（本轮被差分测试逼出来的）**：仿真层**不得**让"用 `node:fs` 读一个文本文件"
> 额外依赖 `bytes.*` 声明——编码这一步跟读取一起放在 `fs.readText`/`fs.writeText` 里做，
> 于是 `node:fs` 只需要 `fs.read.data` / `fs.write.data`（与上表的映射一致）。
> 仅有的例外是几条边角：路径参数传 `Buffer`、或 `readdir`/`realpath`/`mkdtemp` 用 `{encoding:'buffer'}`
> ——那几次确实要过宿主编解码，插件需声明 `bytes.encode`/`bytes.decode`（`node-fs.js` 文件头边界 9）。

**约定**：仿真模块**不得**引入新的权限语义；需要新能力时先在 `core/permissions/registry.ts` 注册权限点，再在映射表里登记（两处同步修改是评审项）。

## 7. 错误语义兼容（关键）

第三方依赖普遍按 **POSIX errno 字符串**分支（`if (err.code === 'ENOENT') …`）。因此仿真层必须做**错误码翻译**：

| 宿主码（SpcError.code） | 仿真层抛出 | 依据 |
|---|---|---|
| `PATH_OUT_OF_SCOPE` / `SYMLINK_ESCAPE` / `PARENT_ESCAPE` / `SPECIAL_PATH_DENIED` / `PERMISSION_DENIED` | `EACCES` | 越界或未授权 = 拒绝访问 |
| `SYMLINK_DANGLING` | `ELOOP` | 链接无法解析 |
| `PARENT_MISSING` | `ENOENT` | 目标（或父目录）不存在——Node 的 `writeFileSync('a/b/c')` 在 `a/b` 缺失时也是 ENOENT |
| `NOT_FOUND` | `ENOENT` | 目标不存在 |
| `ALREADY_EXISTS` | `EEXIST` | 目标已存在（`mkdir` / `wx` / `COPYFILE_EXCL`） |
| `IS_A_DIRECTORY` / `NOT_A_FILE` | `EISDIR` | 该操作不接受目录 |
| `NOT_A_DIRECTORY` | `ENOTDIR` | 该操作要求目录 |
| `FILE_TOO_LARGE` / `TARGET_TOO_LARGE` | `EFBIG` | 超出单文件上限 |
| `ENTRY_LIMIT_EXCEEDED` | `ENOSPC` | 目录条目数超出上限（比"让 32 MiB 的沙箱堆炸掉"更早、更可诊断） |
| `TIMEOUT` | `ETIMEDOUT` | 宿主侧超时 |
| `INODE_PRECHECK_MISSING` / `INODE_MISMATCH` | `EIO` | TOCTOU 检出（原始码留在 `spcCode` 里） |
| `INVALID_ARGS` | `EINVAL` | 宿主侧参数校验失败 |
| **已经是 POSIX 名的码**（宿主原生 fs 错误的直通，如 `ENOENT`/`EEXIST`/`ENOTEMPTY`/`ENOTDIR`） | 原样 | 宿主就是 Node，它给的 errno 比我们猜的准 |
| `INTERNAL` / 其它 | `EIO` | 未分类内部错误 |

**errno 与文案是 Linux 真值**：`err.errno` 用 Linux 的负值（`ENOENT` = -2），`err.message` 用
`CODE: strerror, syscall 'path'` 的 Node 格式，strerror 文案取 **Linux**（`no such file or directory`…）——
出处是 WSL 上的 node v22.22.1 运行值（`tools/truth/fs-url-truth.mjs` → `tools/truth/data/fs-url-truth.json`），
与 `path`(posix)、`constants`(Linux) 同一个取向。开发机是 Windows 时宿主的 errno（-4058）与文案都不同，
**不能拿宿主当判卷人**（测试里按 `process.platform === 'linux'` 才与宿主对照）。

**同时保留原始码**：抛出的错误对象带 `err.spcCode = '<宿主码>'`，宿主错误信封里的 `params` 也一并带过来
（`err.params`，排障用，如越界时收敛后的路径）。`err.message` 用英文（Node 生态习惯），
本地化仍只在 CLI / 面板渲染层（api-contract §2）。

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
| `worker_threads` | **只做事实子集**（`threadId`/`isMainThread`/`workerData`/`parentPort`）；`Worker`/`MessageChannel` 等**不做**——重计算拆成多次宿主调用或由驱动插件承担。判定依据是 §3.1 的"按属性判断"：被访问的只有一个事实字段，不是能力 |
| 真 `Buffer`（C++） | 最小纯 JS 实现（§3 P2-C）：只保证常见编码与操作 |
| `fs.watch` / inotify | 不做；轮询或宿主专用事件 |
| 网络（`net`/`http`/`dns`/`tls`） | 驱动插件提供的端点 |
| `process.exit` / 信号 | 不做；插件生命周期由核心管理（init/start/stop） |
| `fs` 的 **fd 面**（`open`/`read`/`write`/`fstat`/`fsync`/`ftruncate`…） | 不做（持有 fd 等于拿到沙箱外的句柄）；能力插件用路径式 API，宿主侧同一批原语 |
| `fs` 的**流**（`createReadStream`/`createWriteStream`）与 `fs.watch`/`watchFile` | 不做（前者要 `node:stream`，后者要 inotify 面）；轮询走 `timers`。⚠️ **待决策**：`fs.watch` 是"新宿主资源 + 权限点"，与 fd 面一起挂在**HostRef 审定**之后（见 §14.4 末） |
| `fs` 的**软链创建**（`symlink`/`link`）与 `chown`/`utimes` | 不做；属主/时间戳是宿主语义，且实测依赖对这些调用都是 best-effort 包裹（`adm-zip` 的 issue #379 注释）。**例外：`chmod` 做了**——它只改插件自己数据目录里那个文件的权限位，不是宿主资源（实测 `adm-zip` 写完条目要 `chmodSync` 落权限） |
| `fs` 的 **fd 面**（`open`/`read`/`write`/`fstat`/`fsync`/`ftruncate`/`fchmod`…） | 不做（持有 fd 等于拿到沙箱外的句柄）。⚠️ **待决策**：它是**有状态句柄**（生命周期 + 上限 + 审计），与 `fs.watch` 一起挂在 HostRef 审定之后。代价可见：`tmp.fileSync`、`adm-zip` 的写盘路径、`tar`/`archiver` 都要它（`adm-zip` 内存路径不需要，已跑通） |
| `fs.lstat` 认不出软链 | **已知边界**：路径收敛（F2/F5）在 lstat 之前就把软链解析成了目标。补偿能力是 `readdirSync(withFileTypes)` 的 `Dirent`（不经过收敛，能认出 `isSymbolicLink()`）。要精确 lstat 需要在 `safe-path` 里加"不解析最后一段"的校验通道，与安全设计强相关，等真实需求 |
| `fs.readdir(…, { recursive: true })` / `statSync(…, { bigint: true })` | 明确抛 `ERR_NOT_SUPPORTED_IN_SANDBOX`（不静默降级） |
| 插件传 `URL` 作为 `fs` 路径参数 | **只在 POSIX 语义下成立**（`fileURLToPath` 是 POSIX 基线）；Windows 宿主上数据目录是 Windows 路径，`file:///C:/…` 与沙箱路径语义对不上 ⇒ 用字符串路径 |

### 9.1 `stream` 的已知差异（P2-D，全是"有意不同"）

| # | 差异 | 影响与处置 |
|---|---|---|
| 1 | **只有微任务，没有 `process.nextTick` / `setImmediate` 的区分**（沙箱补的是 `queueMicrotask`）。Node 的流内部靠这个区分排续体 | **事件交错顺序可能与宿主不同** ⇒ 差分测试只比"**终态 + 事件集合**"（`emulation-stream.test.ts` 的 `diff()` 就是这么写的）。真实依赖只看"数据对不对、有没有 `end`/`finish`、错误码是什么"，所以这个差异可接受 |
| 2 | **没有完整背压阈值**：`highWaterMark` 只影响 `write()` 的返回值，不影响数据路径（我们缓冲不设上限） | 保证"不丢数据、不卡死"；`'drain'` 在排空且**未 `end()`** 时发。依赖用 `write()` 的返回值做流控时行为正确，但"内存不会因为不读而涨"这条不成立 |
| 3 | `pipeline`/`finished` 只做**基础**串联与错误传播 | 不做 `AbortSignal`（`addAbortSignal` 抛错）、不做 `stream/web`、不做 `compose`。成功时回调参数是 **`undefined`**（不是 `null`——基线 v22.22.1 实测） |
| 4 | legacy `Stream.call(this)` 只初始化**事件面** | 与 Node 一致（Node 的 `Stream` 本来就是空壳）；`graceful-fs` 那条路只用到事件面 |
| 5 | **`Transform` 的结束是"我们补的"**：队列排空 → `_flush` → `push(null)` → `'finish'` | 这是照 `node/lib/internal/streams/transform.js:126-152` 的 `final()` 做的（子类实现 `_final` 时 Node 不补，我们不支持那种写法）。少了它可读侧永远不发 `'end'`，`pipeline`/`for await` 会**挂住且无报错** |

### 9.2 沙箱补的 Node 全局（第三批新增）
| 全局 | 实现 | 为什么 / 代价 |
|---|---|---|
| `__filename` / `__dirname` | `process.cwd() + '/' + argv[1]` 与 `process.cwd()`（引导层 define，writable/configurable） | esbuild 把 CJS 包搬进 ESM 时**自己**会留下对它们的引用（包源码里没有；实测 `write-file-atomic` 的临时名 = `hash(__filename, pid, threadId, n)`）。值是**沙箱形态**的稳定路径，不是可打开的真实入口 —— 单个 bundle 没有源文件路径可指，编造一个宿主路径会随部署漂移 |
| `setImmediate` / `clearImmediate` | **微任务**（`queueMicrotask`）+ 一个带 `ref/unref/hasRef` 的对象；`clearImmediate` **真的会取消** | 语义上属于"下一 tick"那一档，但沙箱只有微任务。真实依赖在**模块顶层**就用它起步（`@nodelib/fs.walk/out/readers/async.js:26`）⇒ 不补 = 整个包装载失败。**不提供 `setTimeout`**：那才是真正的宏任务能力面（要权限/上限/审计）。差异：回调时机比 Node 早（微任务 vs check 阶段） |
| `queueMicrotask`（第二批就有） | `Promise.resolve().then(fn)` | QuickJS 没有它；`process.nextTick` 与 events 的 rejection 路由都靠它 |

### 9.3 Windows 支持：模型 B（仿真平台跟随宿主，P2-E）

**一句话**：沙箱报的平台 = **核心运行所在的平台**，且**六者同时跟随、不许半跟**——
`platform` / `path` 语义 / `EOL` / `devNull` / 常量表 / 沙箱可见路径形态。

**为什么改**（原来的"永远假装 Linux"= 模型 A）：核心在 Windows 上跑时，插件的 fs 动作**真的**落在
`C:\…` 上（大小写、分隔符、errno 全是 Windows 的），而沙箱自称 Linux —— 这种半真半假最难查，
而且已经踩到了（`path.resolve` 不认盘符 ⇒ `fast-glob` 一个条目都匹配不到且不报错）。

| 项 | 取值 |
|---|---|
| `platform` / `os.platform()` / `process.platform` | 跟随宿主（`SPC_EMULATED_PLATFORM=linux\|win32` 可覆盖，**只给测试与排障**——配置项会造出"配了 Linux、实际跑 Windows"的新坑） |
| Node 版本基线 | **仍固定 v22.22.1**（Windows 侧也取 v22.22.1 的真值，不是宿主 v24）⇒ 差异只来自平台、不来自版本 |
| `EOL` / `devNull` | linux `\n`+`/dev/null`；win32 `\r\n`+`\\.\nul` |
| `constants` / `os.constants` | **两张真值表**，按 `__spcEnv.platform` 选。三处**结构性**差异（所以必须整表分，不是"几个值不同"）：① 键集：Windows 多 59 个（`WSA*` 54 + `SIGBREAK` 等）、Linux 多 51 个（`SIGUSR1/2`、`O_*`、`RTLD_*`、`S_IRGRP` 一族）；② 同名不同值 49 个（`EADDRINUSE` win=100/linux=98）；③ **形状**：Windows **没有** `os.constants.dlopen` 那一组 |
| `path` | 跟随平台（`path/posix` 例外——见下）。`path.win32` 是**真实现**（照 `node/lib/path.js` 重写：UNC、`\\?\`、保留设备名、盘符相对、`.\` 反冒名补偿） |
| 沙箱可见路径形态 | **按平台**：linux 归一成 `/`；win32 保持宿主的 `\`（`path.win32.resolve` 的输出一律是 `\`，形态必须与它同形，否则 `resolve(x) === x` 这种幂等假设不成立） |

**三条容易踩的"半跟"陷阱**（都实测踩到过）：

1. **具名导出 vs 默认导出**必须**都**跟随平台。`import { resolve } from 'path'` 与 `import path from 'path'`
   走的是两条路（具名绑定 / 默认对象）。只让默认对象跟随，就会出现
   "`path.resolve()` 是 win32、具名 `resolve()` 是 posix"——`mkdirp` 正好用**具名**导入的 `resolve`/`parse`
   做 win32 非法字符检查，于是 `C:` 里的冒号被判非法 ⇒ `EINVAL Illegal characters in path`（冒烟靶子直接回退）。
2. **子路径的语义是固定的**：`node:path/posix` 在 Node 里**永远**是 posix（与平台无关），
   所以它不能再"与 `path` 共用一份实现"——ESM 模块不知道自己的 specifier，共用就没法区分"谁在问"。
   现在 `path/posix` → `node-path-posix.js`（固定 posix）、`path/win32` → `node-path-win32.js`（固定 win32）、
   `path` → `node-path.js`（跟随平台）。
3. **`os.type()` 也要跟**：P2-E 之前它写死 `'Linux'`，模型 B 下会出现"`platform()` 说 win32、`type()` 说 Linux"。

**判卷人（Windows 侧真值）**：官方 `node-v22.22.1-win-x64`（解在 `_tools/`，不进仓库）——
常量/信号/errno 是 `src/node_constants.cc` 在**编译期**由平台宏定的，**本地 `node/` 源码（v27）只能告诉你有哪些键，
给不出 Windows 的数值**。采真值的脚本：`tools/truth/dump-const-win.mjs` → `const-win.json`；
`path.win32` 的差分：`tools/truth/path-win32-cases-win.mjs`（采）+ `tools/truth/path-win32-diff.mjs`（比）。

**已知边界（差分白名单里明确记账的 3 条）**：Windows 的"每盘一个 cwd"（`process.env['=C:']`）**沙箱复现不了**——
那些 `=X:` 变量被 Node 从 JS 可见的 `process.env` 里过滤掉了，只有 C 层 `uv_os_getenv` 读得到，
而 `path.resolve` 正是在原生层读的。所以唯一分歧面是：**在 A 盘下解析 B 盘的"盘符相对"路径**
（`cwd=D:\` 时 `resolve('C:a')`：Windows 给"该盘上次所在的目录"，我们给该盘根 `C:\a`）。

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

## 13. 待定项

### 13.1 已定（P2-B，2026-09）

| # | 问题 | 决定 | 落点 |
|---|---|---|---|
| 1 | `process.env` 暴露策略 | **冻结的空对象**，不加权限点（宿主 env 可能含凭据，暴露面太大）；将来有真实需求再谈白名单 + `env.read` | `node-process.js` |
| 2 | `tmpdir` / `cwd` 语义 | `tmpdir` = **`<dataDir>/tmp`**（不是宿主 tmp：那个在 fs 作用域外，插件一用就 `EACCES`——返回它等于挖坑）；`cwd` = 数据目录 | `core/emulated-env.ts` |
| 3 | 同步长操作 | 沿用既有大小上限（单文件 64 MB / 读 8 MB），超限给 `EFBIG`；不做阈值警告（警告没人看得见，上限才是硬的） | `core/hostApi.ts`、`node-fs.js` |
| 4 | 仿真 Node 版本 | **固定 `22.22.1`**（`process.version` = `v22.22.1`）；`process.versions` 只报 `node` + `spc`，**不编造** `v8`/`openssl` | `core/emulated-env.ts` |
| 5 | `node:module` / `createRequire` | **本批不做**：按"未登记模块"拒绝。有真实依赖卡住再评估（它不是能力，但会让 CJS→ESM 的路径变复杂） | `registry.ts` |
| 6 | `os` 的取值三分法 | **行为性事实固定**（platform/EOL/devNull/endianness，与 posix 路径同一取向）、**容量类给宿主真值**（cpuCount/totalmem/freemem/uptime/loadavg）、**身份类明确抛错**（cpus/hostname/networkInterfaces/userInfo） | `core/emulated-env.ts`、`node-os.js` |
| 7 | WHATWG `URL` 实现路径 | **宿主快照 + 变更回宿主**（解析一次、畸形输入保真）；沙箱内自实现的只有 `pathToFileURL`/`fileURLToPath`/legacy `parse`/`format`/`resolve` | `node-url.js` |
| 8 | `process` 的信号事件 | **注册即抛错**，不留"永不触发的监听器"（events 那轮的教训）；核心唯一主动触发的是卸载前的 `'exit'` | `node-process.js`、`core/sandbox.ts` 的引导层 |
| 9 | `stream` 是否入批 | 入第二批之后（单独一步）：按实测属性清单做**极小形状** shim，以"跑通那 5 个包"为界 | 见 ROADMAP |
| 10 | `process.getuid` 一族的语义（第三批） | **返回固定仿真事实 `1000`**（四个 getter 一致），不是抛错也不是宿主真值。理由：Linux 基线上 `process.getuid` 是**函数**（`internal/bootstrap/node.js:214` 的 `implementsPosixCredentials` 门），于是 `!process.getuid \|\| process.getuid() !== 0` 这种"探测自己是不是 root"的写法（`write-file-atomic/lib/index.js:70`）会去**调用**它 —— 抛错等于让包在探测环境这一步就死；给宿主真值则泄露身份且随部署漂移。`getgroups` 与 `setuid`/`setgid` 仍抛错（组/权限变更不是事实） | `node-process.js`、`emulation-os-process.test.ts` |
| 11 | `querystring` 与 `node-url.js` 里那份 legacy 子集 | **并存、有意不合并**：`node-url.js` 的那份只服务 `url.parse(..., true)`（默认分隔符、无 `unescapeBuffer`），新 shim 是面向 `node:querystring` 的完整面。合并不省多少行，却要动已验证的模块 ⇒ 等真有需要 | `node-querystring.js` 文件头 |

### 13.2 仍未定

1. **未登记模块的用户体验**：构建期报错文案要指出"是沙箱未支持，而非代码写错"（清单可从本文件自动生成）；
2. **`os` 的身份类信息**是否需要一个 `os.info` 权限点（当前一律抛错——等真实插件卡住再谈）；
3. **`process.hrtime` 的单调时钟**：现在抛错；若真实依赖需要精密计时，走宿主代工（一次跨界 ≈0.21 ms，适合"每测量两次"的用法）。

## 14. 实测坑清单（第二批踩到的，写代码前先看）

> 这一节只写**花了时间才弄明白、且不做就会再踩**的东西。每条都给"复现/守住它的地方"，
> 这样它有判别力：改坏了对应测试会红。真值采集工具在 `tools/truth/`。

### 14.1 沙箱环境本身

| # | 坑 | 结论 / 做法 |
|---|---|---|
| 1 | QuickJS **没有**一批标准全局：`TextEncoder` `TextDecoder` `queueMicrotask` `structuredClone` `URL` `URLSearchParams` `atob` `btoa` `performance` `DOMException`（有 `Proxy`/`Reflect`/`WeakRef`/`Float16Array`/`Object.hasOwn`） | 引导层补齐 `queueMicrotask`；Node 那批全局由 `GLOBALS_PRELUDE` 装**仿真模块本身**（见 14.2）。探针：`tools/probes/quickjs-globals-probe.mjs` |
| 2 | **宿主 realm 的差分测试测不出"沙箱里缺某个全局"**（在 Node 里跑得通、进沙箱就 ReferenceError） | 每个模块**至少一条真沙箱冒烟**（先例：`sandbox.test.ts` 的微任务用例、`emulation-fs.test.ts` 最后一组） |
| 3 | 模块装载期排的微任务（顶层 `await` 续体、`.then()`）**原来被静默丢掉**（`runModule` 不泵 job 队列，还报成功） | `runModule` 在 eval 成功后、deadline 复位**之前**泵一次 job 队列；回归用例在 `sandbox.test.ts` |
| 4 | **顶层 await（TLA）模块**：QuickJS 的 `js_evaluate_module()`（`quickjs.c` 约 31535 行）**总是**建 promise，QTS 只在"没有异步求值"时拆开交出命名空间；真 TLA 时交回来的是未落地的 promise ⇒ 导出全取不到（症状是 `PLUGIN_NO_ENTRY`，看着像导出名写错） | **明确拒绝**：`PLUGIN_LOAD_FAILED` + "把异步初始化放进 init 钩子"。要真支持得 pump 到 promise 落地再取结果值（未排期） |

### 14.2 Node 全局与路径语义（真实依赖最容易撞的两处）

| # | 坑 | 结论 / 做法 |
|---|---|---|
| 5 | **真实依赖用的是裸全局**，不是 `import`：`mkdirp/dist/mjs/path-arg.js` 写 `process.env.… \|\| process.platform`、`use-native.js` 写 `process.version`、`properties/lib/stringify.js` 写 `process.platform === 'win32' ? "\r\n" : "\n"`；**`uuid` v14 的 `rng.js` 写 `crypto.getRandomValues(...)` / `crypto.randomUUID()`**。沙箱里没有这些全局时它们**装载期就 ReferenceError** | `core/sandbox.ts` 的 `GLOBALS_PRELUDE`：装 `process` / `Buffer` / `global` / `crypto`(=`node:crypto` 的 **webcrypto**，与 Node 19+ 的全局语义一致) / `URL` / `URLSearchParams` / `TextEncoder` / `TextDecoder`——装的是**仿真件**（`platform` 固定 linux、`env` 冻结空、`exit`/`kill` 抛错），所以"零环境权力"（能力只能从 `@host/api` 拿）没被破坏；**`require` 仍然不存在**（动态 require 会让构建层静态闸失效）。守住它的用例：`sandbox-modules.test.ts` 的 C4 |
| 6 | **`path.resolve()` 的兜底不能是虚拟根 `/`**：`resolve('out/a')` → `/out/a`，交给 fs 就是作用域外 → `EACCES`。而真实依赖普遍写 `fs.mkdirSync(path.resolve(p))`（`mkdirp/dist/mjs/path-arg.js:11`） | `node-path.js` 的兜底 = **沙箱 cwd（= 数据目录，与 `process.cwd()`、fs 相对路径解析同源）**；拿不到环境事实时回退 `/`。用例：`sandbox-modules.test.ts` 的"相对路径按沙箱 cwd 兜底" |
| 7 | **`validatePath` 的前缀比较必须规范化**：Windows 上 `C:/a/b` 与 `C:\a\b` 是同一个位置，字符串却不同——正斜杠的绝对路径会被判**越界**（EACCES），且第 2 步的逐级软链扫描 `split(sep)` 切不开、整段被跳过（fail-open） | `core/fs/safe-path.ts` 用 `resolve(requested)` 做**所有判定**（错误文案仍报调用方那串）。用例：`safe-path.test.ts`（26 条）+ 真实依赖冒烟 |
| 8 | **沙箱可见的路径必须全是一个形态**：Windows 开发机上数据目录是 `C:\Users\…`，而沙箱路径语义固定 posix。两种形态一混，"把沙箱路径喂回沙箱 path 函数"就错位——实测 `tmp` 包拿 `path.relative(fs.realpathSync(os.tmpdir()), …)` 一对，反斜杠让它算出 `../C:\…`，随后自己抛 "template option must be relative to …" | **一律转成 POSIX 形态**（`\` → `/`），而且**四个出口必须一起转**：`process.cwd()` / `os.tmpdir()` / `os.homedir()`（`core/emulated-env.ts` 里 dataDir/tmpDir 归一化；注意**不能用 `node:path.join`** 拼 tmpDir——Windows 上它会把刚统一的 `/` 又还原成 `\`）、`fs.realpathSync()`（`node-fs.js` 的 `toSandboxForm`）。宿主侧照旧用宿主形态（`validatePath` 会先 resolve 归一化） |
| 8b | **`os.tmpdir()` 指向 `<dataDir>/tmp`，但没人建它** | 宿主**预建**（`core/plugin/loader.ts` 在 `ensureDir(dataDir)` 之后 `ensureDir(<dataDir>/tmp)`）。否则 `tmp` 包（默认 dir 就是 `os.tmpdir()`）、`fs.mkdtempSync(os.tmpdir()+'/x-')` 一律 ENOENT——实测踩到 |
| 8c | **钩子失败的诊断信息**：`init()` 抛错只报 `PLUGIN_INIT_FAILED` + `cause: 'ENOENT'`，**没有 message**（"哪个文件"完全看不到） | `hookError` 把 VM 失败的 `message` 也放进 params（截断 500 字），与装载失败那条路径一致。没有它，排查真实依赖等于盲猜——本轮就是靠它才看清 `'crypto' is not defined` |

### 14.3 Node 形状与错误语义（差分测试抓出来的）

| # | 坑 | 结论 / 做法 |
|---|---|---|
| 9 | 假桥**必须冒充真桥的参数编组**：真桥把 VM 里的 ArrayBuffer 变成 `Uint8Array` 交给宿主；假桥直接传 ArrayBuffer 会让宿主实现以 `ERR_INVALID_ARG_TYPE` 失败，被误读成"shim 的 bug" | 差分测试的假桥照 `core/sandbox.ts` 写：`typeof a === 'string' ? a : Uint8Array.from(...)` |
| 10 | `writeFileSync(p, arrayBuffer)` —— Node **不收裸 ArrayBuffer**（要 TypedArray/DataView） | `node-fs.js` 的 `toByteView` 只认视图；差分用例守着 |
| 11 | 编码名的两种错：`'zzz'` → `ERR_INVALID_ARG_VALUE`（"The argument 'encoding' is invalid encoding."），而 `{encoding:'buffer'}` 是 **`getOptions` 的哨兵**（读侧不校验、到 `toString` 才炸成 `ERR_UNKNOWN_ENCODING`；写侧直接 `ERR_UNKNOWN_ENCODING`） | 照抄；`node-fs.js` 的 `readFileOptions`/`writeFileOptions` |
| 12 | 宿主自己的 `ERR_*` 契约码**不能翻成 EIO**（`ERR_UNKNOWN_ENCODING` 被说成"i/o error"就查不出来了） | `toNodeError` 让 `ERR_*` 直通（`ERR_FS_EISDIR` 例外地带**正** errno 21） |
| 13 | `rm` 与 `rmdir` 是**两套**语义：`rmSync(目录)` 不给 recursive → `ERR_FS_EISDIR`（SystemError，syscall `rm`）；`rmdirSync` 空目录成功 / 非空 `ENOTEMPTY` / 目标是文件 `ENOTDIR` | 宿主侧就是两个方法（`fs.rm` / `fs.rmdir`），仿真层不自己判 |
| 14 | `mkdirSync('b/c/d', {recursive:true})` 返回**第一个被创建的目录**、`mkdtempSync('t-')` 返回 `'t-ABC123'`——都是**调用方写的那种形式**（相对进、相对出） | 宿主必须用收敛后的绝对路径，所以 shim 负责还原（`callerDepthForm` / "前缀 + 宿主给的 suffix"）；`fs.mkdtemp` 因此多回一个 `suffix` |
| 15 | `mkdir -r` 要建**整条链**：`firstMissingAncestor` 只用于返回值，只建它会让中间层缺失、紧随其后的 `validatePath` 在 F6 上炸 | `hostApi.ts` 的 `fs.mkdir` |
| 16 | `lstatSync` **认不出软链**：路径收敛（F2/F5）在它之前就把软链解析成了目标 | 记进 §9 已知边界；补偿能力是 `readdirSync(withFileTypes)` 的 `Dirent`（不经过收敛） |
| 17 | 判卷人有两个陷阱：(a) **Windows 宿主不是 Linux 真值的判卷人**（errno -4058、`unlinkSync(目录)` 给 EPERM、`mkdir` 回 `\\?\` 长路径前缀）；(b) **本机宿主版本 ≠ 仿真版本**（宿主 v24 有 `mkdtempDisposable`/`Utf8Stream`，v22.22.1 没有） | 断言 **Linux 真值**（WSL 取，`tools/truth/data/fs-url-truth.json`），只在 `platform === 'linux'` 时与宿主对照；导出面拿 **v22.22.1 的真值表**比，不拿宿主比 |
| 18 | 权限耦合：`bytes.*` 是**独立能力组**，`Buffer.from(str)`/`buf.toString()` 要走它 | `node:fs` 的文本读写**刻意不经** `bytes`（`fs.readText`/`fs.writeText` 在宿主侧连编解码一起做），所以 `node:fs` 只需要 `fs.read.data`/`fs.write.data`；用 `node:buffer` 的编解码、或 fs 的 Buffer 路径 / `{encoding:'buffer'}` 才要声明 `bytes.encode`/`bytes.decode` |

### 14.4 真实依赖冒烟（本批的验收证据）

`tools/smoke/dep-smoke.mts`（仓库外工作区工具）：用 esbuild 把真实 npm 包的 `node:*` 引用**内联成仿真源码**，
产物丢进**真 QuickJS 沙箱**（真桥 + 权限判定）里跑。四个包全绿：

| 包 | 走到的路径 | 结果 |
|---|---|---|
| `mkdirp@3.0.1` | `path.resolve` → `fs.mkdirSync(recursive)` → **用返回值** | 建出 `made/x/y/z`，返回第一个创建的目录；数据目录外没有落盘 |
| `properties@1.2.1` | CJS 互操作 + `fs.readFileSync` + **回调风格** `fs.readFile` | 解析出 `{name:'spc',port:8080}` |
| `debug@4.4.3` | `util` + `os` + `process` + `tty` 组合，写 stderr | 格式化输出正确 |
| `ejs@6.0.1` | 模板渲染 + 按 filename 读文件 | 渲染正确 |
| `uuid@14.0.2` | **裸全局 `crypto`**（WebCrypto）→ `getRandomValues` / `randomUUID` | v4/v7 生成 + 校验通过 |
| `tmp@0.2.7` | `os.tmpdir()` + `fs.mkdirSync` + **`crypto.randomBytes`** 起名 | 目录形态跑通；**文件形态要 fd，明确抛错**（边界被冒烟钉住） |
| `dotenv@17.4.2` | 它的 `decrypt()`：`createDecipheriv('aes-256-gcm')` + `setAuthTag` + `update`/`final` | 解出明文 ✅（顺带验证了 `RangeError \"Invalid key length\"` 与认证失败文案要**逐字**过桥） |
| `adm-zip@0.5.x` | 内存路径：读 zip 走 `inflateRawSync`、造 zip 走 `deflateRawSync` | 条目列表/内容/往返都对 ✅；**写盘路径要 fd**（`openSync`/`writeSync`/`closeSync`）⇒ 挂起中 |

> 这四条（uuid/tmp/dotenv/adm-zip）都是**第三批**新增的靶子，用来验证 `crypto` 与 `zlib` 两个宿主代工模块——
> 它们的价值在于：**规格表说"只差 crypto"，但真实调用路径里还有裸全局、tmpdir、fd 面这些规格表看不见的东西**。
>
> ⚠️ 一个观察：依赖把我们的"响亮抛错"**吞掉**之后，用户看到的可能是另一个错（`adm-zip` 的 `openSync` 抛
> `ERR_NOT_SUPPORTED_IN_SANDBOX`，它自己 catch 掉，最后报出来的是 `chmod` 的 ENOENT）。
> 排障的可靠入口因此是**审计日志**（那次未支持的调用一定有一条 `ERR_NOT_SUPPORTED_IN_SANDBOX`）。

**两处待决策（挂在 HostRef 审定之后）**：`fs.watch`/`watchFile`（新宿主资源）与 **fd 面**（有状态句柄）。
两者都属于 §3.2.1 那条"跨调用保持状态 = 对象身份"的范畴——是先看 HostRef 要不要正式采用，
再决定"自建 id 表"还是"HostRef + 沙箱外壳"。它们不解锁新的仿真模块，只解锁少数依赖的**特定路径**
（`chokidar` 的 watch、`tmp.fileSync`、`adm-zip` 写盘、`tar`/`archiver`）。

> 正式的这层冒烟属于**构建层**（P2-2 的验收项）；这里先用同一套内联方式把仿真层单独验了。
> 第 5/6/7 条那几个"包在装载期就 ReferenceError"的坑全是它抓出来的。

### 14.5 收口三项（`worker_threads` / `process.getuid` / `querystring`）踩到的

| # | 坑 | 结论 / 做法 |
|---|---|---|
| 19 | **"这个模块存在"本身就是依赖的探测信号**：`write-file-atomic` 用 `require('worker_threads').threadId \|\| 0` 决定临时文件名后缀；Linux 上 `process.getuid` 是**函数**，所以 `!process.getuid \|\| process.getuid() !== 0` 会**调用**它 | 事实类模块照"能诚实回答的就回答"做（`threadId`=0、`isMainThread`=true、`getuid()`=1000），能力类一律抛错。判据是"依赖访问的是事实还是能力"，不是"Node 文档里这个模块属于什么类别"（§3.1） |
| 20 | **`querystring.escape` 的保留字符集容易记反**：`encodeURIComponent` **保留** `!'()*`，而 Node 的 `noEscape` 表里 `!` 不置位 ⇒ `escape("!'()*")` 只转义**空格**那类 | 移植时照抄表（`!-._~'()*` 与字母数字不转义），别用 `encodeURIComponent` 代替。真值：`escape("!'()*~ -._") === "!'()*~%20-._"` |
| 21 | **移植时漏一个 `else` 会静默改变"键是否需要解码"的判定**：`parse` 里那段"先探 `%HH`"的三层 if，少了中间的 `else` 后 `%zz` 的 `z` 会被当成探测位继续累加，导致后面的 `%41` 被误判为"已编码"（`keyEncoded` 变 true）——症状是某些键**多解码一次**（`encodeURIComponent` 类值被二次解码） | 逐行照抄 `node/lib/querystring.js:404-422` 的嵌套结构；差分用例 `parse('a=%zz&b=%41')` 守着 |
| 22 | **别拿宿主 CJS 内建的 ESM 命名空间键集当判卷人**：同一个测试文件在 `tsx` 与原生 ESM 下，`Object.keys(import('node:querystring'))` 的键集都不一样（Node 对 CJS 内建的具名导出是启发式产物） | 契约值取**基线真值**（`require()` 的对象 + 真值 JSON），宿主命名空间只做"方法存在"的弱断言。否则会得到工具相关的红灯（本轮踩了两次） |
| 23 | `registry.ts` 里用 `edit` 改数组时，**删换行会把下一条注释和对象头粘在一起**（`…搬运）──  {` ⇒ esbuild `Expected "]" but found ":"`） | 这类"纯文本拼接"的编辑后立刻跑一次构建/测试（本轮是沙箱冒烟先炸出来的）。错误信息指向的是**下一行**，别顺着行号找 |
| 24 | 加一个 shim 文件后，**它能被 import 的前提是文件名过 `isShimFileName` 且文件真的在 `sandbox-modules/`**（`shimFileExists` 用 readdir 缓存）| `node-querystring.js` / `node-worker_threads.js` 都符合约定；新建时对照 §5 的表，别自己起名 |

### 14.6 `stream`（P2-D）踩到的（这几条都"没有任何报错"）

| # | 坑 | 结论 / 做法 |
|---|---|---|
| 25 | **`this._transform = noop` 会把 ES class 的实现整个屏蔽掉**：class 的 `_transform`/`_flush` 是**非枚举的原型属性**，而实例自有属性优先。症状：`write()` 返回 true、队列也走了，但 `_transform` 一次都不被调用，且错误发生在微任务的 `'error'` 事件上——**没有监听器时完全看不见**。同理 `optionOf(options,'write',noop)` 会屏蔽 `Transform.prototype._write` | 只在**选项真的给了函数**时才挂到实例上（`inheritOr`）；`_write` 里 `typeof` 检查 + `ERR_METHOD_NOT_IMPLEMENTED`。差分用例"Transform 子类化"守着 |
| 26 | **`Transform` 必须在 `_flush` 之后 `push(null)`**：Node 是在 `transform.js:126-152` 的 `final()` 里补的，子类不写它 | 不补的话可读侧永远不发 `'end'`，`pipeline`/`for await` **挂住且无报错**。我们的 `Transform.end` = 队列排空 → `_flush` → `push(null)` → `'finish'` |
| 27 | **`push(null)` 不能同步发 `'end'`**：Node 走 `onEofChunk` → `emitReadable`，是下一 tick | 同步发的话"先 `push(null)`、后 `finished(r, cb)`"会**错过 `'end'`**，`finished` 误报 `ERR_STREAM_PREMATURE_CLOSE`。`finished()` 另外要做**状态感知**（`readableEnded`/`writableFinished` 已为真就直接回调） |
| 28 | **`'error'` 只能发一次**：`destroy(err)` 自己会（异步）发，`errorOrDestroy` 里再排一个就是两次（差分实测：宿主 1 条、我们 2 条） | 已经销毁过的流才自己发，否则交给 `destroy`；`errored` 标记要**同步**打上——只排异步 `'error'` 的话，`end()` 的 `emitFinish` 微任务会先跑，于是"出错了却发了 `'finish'`" |
| 29 | **`'drain'` 在 `end()` 已排队时不发**（Node 认为"都要结束了，没人需要再写"） | `state.ended` 时跳过；否则差分红灯 |
| 30 | **别拿"事件的精确顺序"当差分判据**：我们与宿主在 `'end'`/`'finish'` 的先后上就有意不同（各自内部的排期不同） | `emulation-stream.test.ts` 的 `diff()` 比**终态 + 事件集合（排序后）**；另外**剧本一定要有超时**（本轮被"等一条永不到来的事件"挂死过一次） |
| 31 | **差分脚本自己也会撒谎**：`record()` 挂的 `'data'` 监听会让流进入 flowing，于是"自己随后挂监听"时数据可能已被 flush 掉（看起来像我们的 bug）；同一事件挂两个监听会把一条错误记两遍 | 数据监听挂在自己那行；错误码只用一个监听读；比对前先确认"宿主是绿的"——宿主也挂的剧本是剧本写错了，不是实现错了 |

### 14.7 真实依赖冒烟（第三批全跑，11 个靶子）

`node node_modules/tsx/dist/cli.mjs D:\git-repo\tools/smoke/dep-smoke.mts all`：

**绿（9）**：`mkdirp` `properties` `debug` `uuid` `tmp` `dotenv` `adm-zip` `ejs` `write-file-atomic`（部分）。
**红（2，都不是 stream 的问题，是各自的边界）**：

| 靶子 | 卡在哪 | 性质 |
|---|---|---|
| `graceful-fs` | **装载期** `PLUGIN_LOAD_FAILED no setter for property`。根因已查明（见 §14.8）：它把 `fs` 的每个属性拷成**只读访问器**再改，而 QuickJS 对"写只读访问器"是**抛错**（V8 静默返回 false） | **有解**：构建层把 `graceful-fs` 换名成 `fs` shim（见 §14.8 的方案评估） |
| `fast-glob` | ~~装载期 `os.cpus is not supported`~~ **已修**：`os.cpus()` 改成"条数照容量类、`model`/`speed` 给空值"，并补了 `setImmediate` 壳子 | 已跑通（`FG-SYNC` / `FG-STREAM` 都列出条目） |
| `write-file-atomic` | 同步路径 `fs.openSync`、异步路径也是 `fs.open` ⇒ 两条路都在 **fd 面**上（不受 `__filename` 影响，那个已修） | **边界正确**：报 `ERR_NOT_SUPPORTED_IN_SANDBOX` + 明确消息（不再是误导性的 ReferenceError） |

> `write-file-atomic` 的两条边界也是真的：同步写盘走 fd 面（挂起中），异步路径同样是 `fs.open`
> （挂起中）。`__filename` 那条已经修了（引导层补了 CJS 全局，见 §9.2）。

### 14.8 QuickJS 的"属性赋值失败"三态（把 `graceful-fs` 查到底）

查 `graceful-fs` 装载失败花了大半轮，**卡点不是它，而是诊断链**：`classifyVmFailure` 原本把
QuickJS 错误对象里的 `stack` 丢掉了，只剩一句 `no setter for property` —— 连"哪一行"都看不到。
**已修**：`params.stack`（截断 1200 字）。下面这张表是拿真沙箱逐条试出来的（`tools/probes/probe-dump-keys.mts`）：

| 写法 | QuickJS 的行为 | 消息 |
|---|---|---|
| 给**只读的普通属性**赋值（`writable:false`，或 ES 模块命名空间导出） | 抛 | `'x' is read-only` |
| 给**自有访问器**（有 getter 无 setter）赋值 | **抛** | `no setter for property` |
| 给**原型链上的访问器**赋值 | **抛** | `no setter for property` |
| 给**不存在的属性**赋值（strict / ESM） | 抛（"no setter" 这条就是它，因为 `[[Set]]` 一路找不到） | `no setter for property` |
| 给**不存在的属性**赋值（sloppy 脚本，非模块） | 静默创建 | — |

**对照 V8（实测宿主 Node v24）**：上面第 2/3 条 V8 **静默返回 false**、不抛。这就是
`graceful-fs` 在 Node 上能跑、在我们这儿装载期就死的原因。

**根因（可复现）**：`graceful-fs/graceful-fs.js` 的 `patch(clone(fs))` 干这三件事：
1. `clone.js:18` 把 `fs` 的每个属性**按原描述符**定义到副本上 —— 而内联产物里的 `node:fs` 是
   esbuild 的 `__toESM(fs_exports)` 结果（§14.6 的命名空间问题在互操作之后仍然留下**只读访问器**）；
2. `graceful-fs.js:107` `fs.createReadStream = …`、`:105` `fs.gracefulify = patch` —— 赋值；
3. `:252`/`:262` `Object.defineProperty(fs,'ReadStream',…)` —— 这一条在只读访问器上**直接抛**。

**方案评估（用户提的"构建层换名"）**：✅ **可行且推荐**。理由：
- 它整个存在的意义是**在 EMFILE/ENFILE 上重试**——沙箱里没有 fd 上限（fd 面本身就不做），这个意义归零；
- 它给 `fs` 加的 `createReadStream`/`createWriteStream` 是 fd 式，在我们这儿本来就抛错；
- 它**不改** `node:fs` 模块对象（用局部副本）⇒ 换名成 `fs` 就是"函数一模一样、只少了 fd 流方法"，
  副作用面极小；
- 落点应在**构建层**（P2-2 的依赖别名表），并且**要写进产物清单**（"本插件依赖了 graceful-fs，已按
  仿真语义替换"）——这正是用户说的"清单记录"。

> 顺带记一条纪律：**遇到"某个包在沙箱里怪死"，先看 QuickJS 侧栈**（`params.stack` 现在有了），
> 别急着写探针——本轮为此写了 5 个诊断脚本才发现是诊断信息本身被丢了。

### 14.9 同一个 shim 被求值两次 ⇒ 两份 `Buffer` 类（**值不对但不报错**）

**症状**：沙箱里 `Buffer.isBuffer(crypto.createHash('sha256').update('a').digest())` 给 **false**，
而 Node 给 true；`crypto.randomBytes(n)`、`fs.readFileSync(p)` 这些**跨桥回来的字节**全都一样，
而沙箱里自己 `Buffer.from('ab')` 造的又是 true。（探针：`_audit/scratch/probe-buffer-identity.mts`。）

**机制**：QuickJS 的模块缓存键 = **归一化后的模块名**。
- 插件写 `import 'node:buffer'` ⇒ 键是 `node:buffer`（走 registry 的规范名）；
- shim 之间是**相对引用**：`node-crypto.js` 里 `import { Buffer } from './node-buffer.js'`
  （构建层要用 esbuild 把 shim 内联进插件产物，所以**只能**这么写，不能写 `node:*`）
  ⇒ 键是解析出来的 `node-buffer.js`。

同一个文件两个键 ⇒ **求值两次** ⇒ 两份 `Buffer` 类。`Buffer.isBuffer` 的实现就是 `b instanceof Buffer`，
于是跨桥回来的那份（由 crypto 模块自己那份 Buffer 造出来）在插件那份类面前不是实例 —— 这一类
"值不对但不报错"的差异最难查，属于本清单专收的那种。

**修法**：`runtime.setModuleLoader(loader, normalizer)` 的**第二个参数**（`JSModuleNormalizer`）。
`sandbox.ts` 的 `normalizeModuleName` 把"同一个 shim 的所有叫法"收敛到一个名字：
①能认成规范名 ⇒ 归到它的文件名；②解析后名字的基名是个 shim 文件（`node-assert/node-assert.js`
这种相对解析出来的怪名字）⇒ 同样归到文件名；③其余原样返回，白名单判定仍只在 `loader` 里。
⚠️ 一旦给了归一化器，QuickJS 的**默认相对解析就不再发生**，所以 `resolveRelativeModuleName`
把那条默认规则（父模块名的目录部分 + 请求名 + `..` 折叠）自己实现了一遍。

**判据**：`core/__tests__/sandbox.test.ts` 的「模块名归一化：同一个 shim 只求值一次」（去掉第二个参数必红：
`DIGEST=false/false`、`RANDOM=false`）。

**为什么以前没发现**：差分电池跑在**纯 Node 假桥**上（只有一份 Buffer），而真沙箱用例只比了摘要的十六进制
字符串——跨桥字节的 `instanceof` 一直没人断言。

### 14.10 句柄面（对象身份）：流式摘要的三种收口

`crypto.Hash`/`Hmac` 的状态从沙箱搬到了宿主（一条句柄 = 一个 OpenSSL EVP 上下文，见
`core/plugin/handles.ts`），于是多了三条必须同时成立的收口，缺一条就是宿主内存的无底洞：

| 收口 | 实现 | 判据 |
|---|---|---|
| 正常释放 | `digest()`/失败的 `digest()` 之后仿真层调 `crypto.hashRelease` ⇒ 表里移除 | 真沙箱用例里"开 300 次、每次 digest"必须全过（`CHURN 300`） |
| 上限 fail-closed | 每 kind 256 条（`MAX_DIGEST_HANDLES`）⇒ `HANDLE_LIMIT_EXCEEDED` | 同一用例里"只开不关到 300"必须停在 **256** 并拿到该码 |
| 卸载强回收 | `bridge.releaseHandles`（沙箱 `teardown()` 调）⇒ `HandleTable.releaseAll()` + 审计 | `handles.test.ts` 的 `releaseAll` 断言（各恰好释放一次、leaked 列表正确） |

另外两条来自判卷人实测（v22.22.1）的保真细节，别想当然：
- **`Hmac` 不是 `Hash` 的子类**：`hmac instanceof crypto.Hash === false`、`Hmac.prototype instanceof Hash === false`、
  **`hm.copy` 不存在**（`TypeError: hm.copy is not a function`）。旧实现把它们别名成同一个类，三处都不对。
- **终态语义不对称**：`Hash` 二次 `digest()` 抛 `ERR_CRYPTO_HASH_FINALIZED`；**`Hmac` 二次 `digest()` 返回空值**
  （`'hex'` ⇒ `''`，不带编码 ⇒ 空 Buffer），而它的 `update()` 仍然抛同一个码。
- **算法校验也不对称**：`createHash('nope')` **懒校验**（create 不抛、`digest()` 才抛 `Digest method not supported`，
  而且那个错误**没有 code**）；`createHmac('nope', k)` **急切**抛 `ERR_CRYPTO_INVALID_DIGEST: Invalid digest: nope`。

句柄 id 是**随机 UUID**（不是自增），而且**每个插件一张表** ⇒ 别家插件的 id 在本表里根本查不到，
"借用/伪造句柄"这条攻击面是**结构上不可达**的，不靠校验挡。
