# 仿真与测试的已知缺口（待办）

- 状态：**待办**。来源：三轮独立深度审计（2026-09）。
- 定位：**临时清单，不是长期文档**。修完一条删一行；全部清空后删掉本文件。
- 证据图例：**✓ = 已亲自复核（实测或读码）**；○ = 审计报的，未复核。
- 复核方法可复现：load shim 后与宿主 Node 同输入对跑；沙箱实验用 `createSandbox(hostApi, …)`（见 `core/__tests__/sandbox-modules.test.ts` 的用法）。

## 当前进展（修一条更新一次）

**已修**（每条都有回归测试，且**同时跑 shim 与宿主 Node 比字段**，不只比"抛没抛"）：

| 条目 | 修法要点 |
|---|---|
| **A1** | `doesNotThrow/doesNotReject` 错误不匹配时**重抛原错误**（原先静默吞掉真实故障） |
| **A2** | 二元断言补 `ERR_MISSING_ARGS`（原先 `notXxx(x)` **静默通过**） |
| **A3** | `path.format` 补 `formatExt`（原先拼出 `btxt` 这种错误路径） |
| **A5** | `equal/notEqual` 的 NaN 特例（原先两个判定都反了） |
| **A8** | `removeAllListeners(undefined)` 改用 `arguments.length`（原先**静默清空全部**） |
| **A9** | `listenerCount(type,null)` 与不传等价 |
| **A10** | `failWith` 里"message 是 Error 就原样抛出"——一处改动覆盖全部断言 |
| **A11** | `throws/rejects` 的字符串第二参当 message；校验函数须**严格返回 true**；类不当函数调 |
| **A12** | `ok` 的 `actual` 用原值 |
| **A13** | `emit('error')` 补 `ERR_UNHANDLED_ERROR` + `context` |
| **A19** | `binaryResult` 返回非字节 → **抛错**（原先静默变零字节） |
| **B3** | 文本参数类型校验放在**沙箱侧包装器**（`__marshal` 之后宿主已看不到原值），码用 Node 形状 |
| **C1** | 测试隔离 `SPC_AUDIT_DIR`（原先跑测试就往仓库 `.spc/audit/audit.jsonl` 追加，已涨到 106MB） |

**未修**：A4、A6、A7、A14–A18、B1、B2、B4、C2–C9（清单其余全部）。

## A · 仿真与 Node 的行为偏差（静默错值优先）

> 判定基准始终是 **Node 是契约宗主**：语义以 Node 源码为准，改法也是"向 Node 靠"。

| # | 问题 | 位置 | 后果 | 证 |
|---|---|---|---|---|
| A1 | **`assert.doesNotThrow/doesNotReject` 吞掉不匹配的错误**：错误 ≠ expected 时应**重抛原错误** | `node-assert.js`；Node 语义见 `lib/assert.js` 的 `expectsNoError`（不匹配 → `throw actual`） | 真实故障被静默吞掉；`operator` 也报错（`throws` 而非 `doesNotThrow`） | ✓ |
| A2 | **二元断言缺 `ERR_MISSING_ARGS`** | `node-assert.js` 的 `equal/notEqual/strictEqual/notStrictEqual/deepEqual/…` | `notEqual(1)`、`notDeepEqual(1)`、`notDeepStrictEqual(1)` **静默通过**（漏写参数 = 断言失效） | ✓ |
| A3 | **`path.format()` 丢掉 ext 的引导点** | `node-path.js` 的 `format`；Node 见 `lib/path.js` 的 `formatExt()` | `format({name:'b',ext:'txt'})` → 我们 `"btxt"`、Node `"b.txt"` → **拼出错误路径且不报错** | ✓ |
| A4 | **`relative(相对, 绝对)` 也吃虚拟根兜底** | `node-path.js` 的 `relative`（内部调 `resolve`） | 属"有意差异"（虚拟根）漏了一个入口，需写进注释与测试 | ○ |
| A5 | **`assert.equal/notEqual` 的 NaN 语义反了** | `node-assert.js`；Node 见 `lib/assert.js:212/237`（`NumberIsNaN` 特例） | `equal(NaN,NaN)` 我们抛、Node 通过；`notEqual` 相反 | ✓ |
| A6 | **`deepStrictEqual` 把不该等的判等**（WeakMap / WeakSet / Promise / 函数 / Error 自有属性 / cause / TypedArray 附加属性 / 宽松模式跨 tag） | `node-assert.js` 的深比较；Node 见 `lib/internal/util/comparisons.js` | **断言漏判**：依赖拿它做参数校验/缓存判定时会静默误判相等 | ✓（6 例）○（其余） |
| A7 | **`deepStrictEqual` 把该等的判不等**：严格模式应先比 `constructor`，只在 `constructor===undefined` 时才比原型 | 同上 | `Object.create({x:1},{a:{…}})` vs `{a:1}` → 我们抛、Node 通过 | ○ |
| A8 | **`removeAllListeners(undefined)` 清空全部监听器** | `node-events.js`；Node 用 `arguments.length` | 真实形态 `e.removeAllListeners(opts.event)`（可能为 undefined）→ 静默拆掉所有监听器 | ✓ |
| A9 | **`EventEmitter.listenerCount(type, null)` 返回 0** | `node-events.js`；Node 用 `listener != null` | 把可能为 `null` 的引用透传进来 → 误判"没人监听" | ✓ |
| A10 | **`assert.fail(err)` / message 传 Error → 被包成 AssertionError** | `node-assert.js`；Node **原样重抛那个 Error** | 抛出类型与 code 全变，`instanceof MyError` 类分支失效 | ✓ |
| A11 | **`assert.throws(fn, '消息')`**：字符串第二参应是 message | `node-assert.js` 的 `expectedErrorMatcher` | 我们把**能过的断言**判失败（反向漏判） | ○ |
| A12 | **`assert.ok(0)` 的 `actual` 是 `false` 而非 `0`** | `node-assert.js` 的 `ok` | 靠 `err.actual` 分支的代码走错 | ✓ |
| A13 | **`emit('error')` 无监听器时缺 `ERR_UNHANDLED_ERROR` 与 `context`** | `node-events.js` 的 `emit` | `catch (e) { e.code === 'ERR_UNHANDLED_ERROR' }` 分支失效 | ✓ |
| A14 | **`newListener`/`removeListener` 元事件未实现** | `node-events.js` 的 `_add`/`removeListener` | "第一个监听器到来时惰性订阅"的写法**永不触发**，且是静默的。Node 核心自身重度依赖 | ✓ |
| A15 | **`errorMonitor` 只是符号，emit 从不使用** | `node-events.js` | 挂 `on(errorMonitor)` 收不到通知 —— 静默漏掉错误观测 | ✓ |
| A16 | **`captureRejections` 只存不用** | `node-events.js` 的构造 | async 监听器的 rejection 被静默丢弃（Node 会送到 `'error'`）。要么实现，要么**明确抛错** | ○ |
| A17 | **`EventEmitter.on()` 迭代器不完整**：不注册 `'error'`、`return()` 不摘监听、无 `throw`、遇 error 时 `next()` 永久挂起 | `node-events.js` 的静态 `on` | 沙箱里退化成 `PLUGIN_JOB_PENDING`；监听器泄漏 | ○ |
| A18 | **`EventEmitter` 是 `class`** → `EventEmitter.call(this)` 直接抛 | `node-events.js` | ES5 `util.inherits` 模式的老依赖**完全无法使用**（Node 正常）。原型方法也不可枚举 | ✓ |
| A19 | **`binaryResult` 方法返回非字节 → 静默零字节** | `core/sandbox.ts` 的 `toExactBytes` | 宿主实现写错会变成静默垃圾数据，破坏"AB=数据/字符串=错误"契约 | ○ |

## B · 入口与常量缺失

| # | 问题 | 位置 | 后果 | 证 |
|---|---|---|---|---|
| B1 | **登记表缺真实存在的子路径入口**：`node:assert/strict`、`node:path/posix`、`node:path/win32` | `core/sandbox-modules/registry.ts` | 宿主 `import` 都能成功，我们拒绝。`assert/strict` 的 shim **已经写好**，只差入口 | ○ |
| B2 | **`constants` 只覆盖 30/234 键**，且 `O_SYMLINK` 是凭空造的 | `node-constants.js` | 缺失的 errno / 信号 / 权限位取到 `undefined` → 参与位运算**静默算错**；Node 侧是 frozen，我们可写 | ○ |
| B3 | **`bytes.fromString/byteLength` 不做参数类型校验**，一律 `String()` | `core/hostApi.ts`、`core/sandbox-modules/host-api.js` | 传错类型时**静默算错**（而非 fail-closed）；反方向 `bytes.toString('hi')` 却正确抛错 | ✓ |
| B4 | **E10 可执行文件白名单在 Windows 上大小写敏感** | `core/exec/templates.ts` | 合法模板静默注册失败（**fail-closed，不是提权**），但会诱使运维放宽白名单 | ○ |

## C · 测试与工程卫生

| # | 问题 | 位置 | 后果 | 证 |
|---|---|---|---|---|
| C1 | **`sandbox-modules.test.ts` 没隔离审计目录** | 三处 `createSandbox` | `.spc/audit/audit.jsonl` 已 **106.7 MB**，跑测试持续往仓库状态目录追加 | ✓ |
| C2 | **成本守门测试守的不是它声称的东西**：用测试自造的合成 api、且不看返回值 | `sandbox-modules.test.ts` 的"成本回归守门" | 把二进制侧权限点改成未授予（只收到 60 字节错误信封）**断言仍通过** | ✓ |
| C3 | **二进制通道的失败/越权分支零覆盖** | 同上 | `binary-arg-not-arraybuffer`、`expected-bytes`、`PERMISSION_DENIED` 三条行为正确但无测试锁住 | ○ |
| C4 | **`assert` 是唯一没在真沙箱里跑过的 shim** | 装载链路测试只 import 了 path/events/tty/constants | 缺冒烟测试；也缺"零环境权力"断言（`typeof process/require/Buffer`） | ○ |
| C5 | **`defaultMaxListeners` 用例名与断言不符**：说"改静态值仍生效"，实际没改静态值 | 同上 | 构造时快照的变异体能通过该断言 | ○ |
| C6 | **编码别名用例对"完全忽略 encoding"的实现无判别力**（`'Ab9'` 是纯 ASCII、往返自洽） | 同上（8 个里 6 个） | 加 `assert.equal(bytes.fromString('Ab9', e).length, Buffer.byteLength('Ab9', e))` 即可（ucs2→6、hex→1…） | ○ |
| C7 | **子串匹配式断言**（`assert.match(out, new RegExp('B64 …'))`） | 同上 | 带尾巴的错误输出也能过；某些输入下**正确输出反而不匹配** | ○ |
| C8 | **把宿主 Node 的字节写死** | 同上（UTF-8 代理项守门） | Node 改语义时我们会红，与我们无关。应断言"两者必须不同" | ○ |
| C9 | **零散覆盖缺口**（长清单） | 见各 shim | `__proto__` 事件名、`prependOnceListener`、`win32` 其余 10 个方法、`toNamespacedPath`、`AssertionError` 无参构造、`dispose()` 幂等与 dispose 后调用、定时器重入保护、`hostapi.test.ts` 完全没有 bytes 组 | ○ |

## 验证过、**没问题**的部分（避免重复排查）

- ✓ **`node:path` 对齐质量很高**：30 万组随机输入 + 173 组手工边界**零不一致**（含 `dirname('/foo')==='//'` 这类怪癖）
- ✓ **`node:events` 4000 段随机剧本**除上表 A8/A9 外无分歧（`emit` 返回值、`prepend*` 顺序、`listeners` vs `rawListeners`、重复注册的 LIFO 删除、符号事件名、`'__proto__'` 作事件名、惰性 maxListeners）
- ✓ **`node:tty`** 对全部非法输入与宿主一致（Node 本身也不校验参数）
- ✓ **`node:constants` 已定义的 29 个值**与 Linux 真值逐项相符
- ✓ **`assert` 的深比较主干**（Date / RegExp / Map / Set / TypedArray / ArrayBuffer / DataView / boxed / 循环引用 / getter / 不可枚举 / 稀疏数组 / `-0` / NaN / 严格模式符号键）对齐
- ✓ **`registry.ts`**：归一化、大小写敏感、拒绝策略、文件名约定、与 `node-*.js` 的双向一致性均正确（无路径穿越风险）

## 建议的处理顺序

1. **A1、A2、A3、A5、A8、A9、A10、A12、A13** —— 全是小改动、证据充分，且**两轮独立审计各自发现了同一批 assert 缺陷**，置信度高
2. **A6、A7**（深比较按 `comparisons.js` 补齐）—— 改动较大，建议单独一个提交
3. A14–A18（events 元事件 / errorMonitor / captureRejections / 迭代器 / class 形态）
4. B1–B4（补入口与常量）
5. C1 顺手做（免得审计文件继续涨），其余测试项随对应修复一起补
