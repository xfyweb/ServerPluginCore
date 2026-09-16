# 仿真与测试的已知缺口（待办）

- 状态：**待办**。来源：三轮独立深度审计（2026-09）。
- 定位：**临时清单，不是长期文档**。**修完一条删一行**；全部清空后删掉本文件。
- **已修条目的记录在提交历史里**（每条修复都带回归测试与"为什么"的注释），本文件只留**未修**项。
- 证据图例：**✓ = 已亲自复核（实测或读码）**；○ = 审计报的，未复核。
- 复核方法可复现：load shim 后与宿主 Node 同输入对跑；沙箱实验用 `createSandbox(hostApi, …)`（见 `core/__tests__/sandbox-modules.test.ts` 的用法）。

## A · 仿真与 Node 的行为偏差（静默错值优先）

> 判定基准始终是 **Node 是契约宗主**：语义以 Node 源码为准，改法也是"向 Node 靠"。

| # | 问题 | 位置 | 后果 | 证 |
|---|---|---|---|---|
| A6 | **`deepStrictEqual` 把不该等的判等**（WeakMap / WeakSet / Promise / 函数 / Error 自有属性 / cause / TypedArray 附加属性 / 宽松模式跨 tag） | `node-assert.js` 的深比较；Node 见 `lib/internal/util/comparisons.js` | **断言漏判**：依赖拿它做参数校验/缓存判定时会静默误判相等 | ✓（6 例）○（其余） |
| A7 | **`deepStrictEqual` 把该等的判不等**：严格模式应先比 `constructor`，只在 `constructor===undefined` 时才比原型 | 同上 | `Object.create({x:1},{a:{…}})` vs `{a:1}` → 我们抛、Node 通过 | ○ |
| A14 | **`newListener`/`removeListener` 元事件未实现** | `node-events.js` 的 `_add`/`removeListener` | "第一个监听器到来时惰性订阅"的写法**永不触发**，且是静默的。Node 核心自身重度依赖 | ✓ |
| A15 | **`errorMonitor` 只是符号，emit 从不使用** | `node-events.js` | 挂 `on(errorMonitor)` 收不到通知 —— 静默漏掉错误观测 | ✓ |
| A16 | **`captureRejections` 只存不用** | `node-events.js` 的构造 | async 监听器的 rejection 被静默丢弃（Node 会送到 `'error'`）。要么实现，要么**明确抛错** | ○ |
| A17 | **`EventEmitter.on()` 迭代器不完整**：不注册 `'error'`、`return()` 不摘监听、无 `throw`、遇 error 时 `next()` 永久挂起 | `node-events.js` 的静态 `on` | 沙箱里退化成 `PLUGIN_JOB_PENDING`；监听器泄漏 | ○ |
| A18 | **`EventEmitter` 是 `class`** → `EventEmitter.call(this)` 直接抛 | `node-events.js` | ES5 `util.inherits` 模式的老依赖**完全无法使用**（Node 正常）。原型方法也不可枚举 | ✓ |

## B · 入口与常量缺失

（已清空：`constants` 已补全为 Linux 真值 235 键——取值方式是"在 Linux 上 dump 宿主 Node 的运行值"，见 `node-constants.js` 头部注释；子路径入口 `assert/strict`·`path/posix`·`path/win32` 与 E10 白名单的平台语义已修。）

## C · 测试与工程卫生

| # | 问题 | 位置 | 后果 | 证 |
|---|---|---|---|---|
| C2 | **成本守门测试守的不是它声称的东西**：用测试自造的合成 api、且不看返回值 | `sandbox-modules.test.ts` 的"成本回归守门" | 把二进制侧权限点改成未授予（只收到 60 字节错误信封）**断言仍通过** | ✓ |
| C3 | **二进制通道的失败/越权分支零覆盖** | 同上 | `binary-arg-not-arraybuffer`、`expected-bytes`（宿主 `binaryResult` 返回错类型）、`PERMISSION_DENIED` 三条行为正确但无测试锁住 | ○ |
| C4 | **`assert` 是唯一没在真沙箱里跑过的 shim** | 装载链路测试只 import 了 path/events/tty/constants | 缺冒烟测试；也缺"零环境权力"断言（`typeof process/require/Buffer`） | ○ |
| C5 | **`defaultMaxListeners` 用例名与断言不符**：说"改静态值仍生效"，实际没改静态值 | 同上 | 构造时快照的变异体能通过该断言 | ○ |
| C6 | **编码别名用例对"完全忽略 encoding"的实现无判别力**（`'Ab9'` 是纯 ASCII、往返自洽） | 同上（8 个里 6 个） | 加 `assert.equal(bytes.fromString('Ab9', e).length, Buffer.byteLength('Ab9', e))` 即可（ucs2→6、hex→1…） | ○ |
| C7 | **子串匹配式断言**（`assert.match(out, new RegExp('B64 …'))`） | 同上 | 带尾巴的错误输出也能过；某些输入下**正确输出反而不匹配** | ○ |
| C8 | **把宿主 Node 的字节写死** | 同上（UTF-8 代理项守门） | Node 改语义时我们会红，与我们无关。应断言"两者必须不同" | ○ |
| C9 | **零散覆盖缺口**（长清单） | 见各 shim | `__proto__` 事件名、`prependOnceListener`、`win32` 其余 10 个方法、`toNamespacedPath`、`AssertionError` 无参构造、`dispose()` 幂等与 dispose 后调用、定时器重入保护、`hostapi.test.ts` 完全没有 bytes 组 | ○ |

## 验证过、**没问题**的部分（避免重复排查）

- ✓ **`node:path` 对齐质量很高**：30 万组随机输入 + 173 组手工边界**零不一致**（含 `dirname('/foo')==='//'` 这类怪癖）
- ✓ **`node:events` 4000 段随机剧本**除 A8/A9/A14/A15 外无分歧（`emit` 返回值、`prepend*` 顺序、`listeners` vs `rawListeners`、重复注册的 LIFO 删除、符号事件名、`'__proto__'` 作事件名、惰性 maxListeners）
- ✓ **`node:tty`** 对全部非法输入与宿主一致（Node 本身也不校验参数）
- ✓ **`node:constants`**：235 键（fs 56 / errno 79 / signals 33 / crypto 56 / dlopen+priority 11）逐键等于 Linux 宿主 Node v22.22.1 的运行值；`default` 与具名导出一致、已冻结；Linux 上不存在的键（`O_SYMLINK` 等）**不伪造**
- ✓ **`assert` 的深比较主干**（Date / RegExp / Map / Set / TypedArray / ArrayBuffer / DataView / boxed / 循环引用 / getter / 不可枚举 / 稀疏数组 / `-0` / NaN / 严格模式符号键）对齐
- ✓ **`registry.ts`**：归一化、大小写敏感、拒绝策略、文件名约定、与 `node-*.js` 的双向一致性均正确（无路径穿越风险）

## 建议的处理顺序

1. **A6、A7**（深比较按 `comparisons.js` 补齐）——**已有一份未完成的实现**收在仓库外的 stash/补丁里（见 `_audit/HANDOFF.md`），但**没有判别用例**，必须自己验过再用
2. **A14–A18**（events 元事件 / errorMonitor / captureRejections / 迭代器 / class 形态）
3. **C2–C9**（测试判别力；C3 顺手把宿主调用边界那三条负分支锁住 → 同时补上 S-6/S-7 缺的回归）
