# 仿真与测试的已知缺口（待办）

- 状态：**待办**。来源：三轮独立深度审计（2026-09）。
- 定位：**临时清单，不是长期文档**。**修完一条删一行**；全部清空后删掉本文件。
- **已修条目的记录在提交历史里**（每条修复都带回归测试与"为什么"的注释），本文件只留**未修**项。
- 证据图例：**✓ = 已亲自复核（实测或读码）**；○ = 审计报的，未复核。
- 复核方法可复现：load shim 后与宿主 Node 同输入对跑；沙箱实验用 `createSandbox(hostApi, …)`（见 `core/__tests__/sandbox-modules.test.ts` 的用法）。

## A · 仿真与 Node 的行为偏差（静默错值优先）

（已清空：assert 深比较（A6/A7）与 events 的元事件 / errorMonitor / captureRejections / 异步迭代器 /
函数式构造形态（A14–A18）均已按 `lib/internal/util/comparisons.js`、`lib/events.js` 复刻，
每一条都有"同剧本跑 shim 与宿主 Node 比签名"的回归用例。）

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
- ✓ **`node:events`**：4000 段随机剧本 + 元事件/errorMonitor/captureRejections/迭代器/ES5 构造形态的差分剧本（`sandbox-modules.test.ts` 的 `SEMANTIC_CASES`）与宿主 Node 逐条一致；已知无法复刻的只有 `MaxListenersExceededWarning`（沙箱没有 `process.emitWarning`），已写进 shim 文件头
- ✓ **`node:tty`** 对全部非法输入与宿主一致（Node 本身也不校验参数）
- ✓ **`node:constants`**：235 键（fs 56 / errno 79 / signals 33 / crypto 56 / dlopen+priority 11）逐键等于 Linux 宿主 Node v22.22.1 的运行值；`default` 与具名导出一致、已冻结；Linux 上不存在的键（`O_SYMLINK` 等）**不伪造**
- ✓ **`assert` 的深比较主干**（Date / RegExp / Map / Set / TypedArray / ArrayBuffer / DataView / boxed / 循环引用 / getter / 不可枚举 / 稀疏数组 / `-0` / NaN / 严格模式符号键）对齐；A6/A7 修完后，**WeakMap/WeakSet/Promise/函数/Error 自有属性与 cause/TypedArray 附加属性/宽松跨 tag/constructor 优先**也都对齐（差分电池 68 组 × 3 断言操作，仅剩 `URL` 一类"沙箱里不存在、判不到"的盲区，已写进 shim 头部的已知边界）
- ✓ **`registry.ts`**：归一化、大小写敏感、拒绝策略、文件名约定、与 `node-*.js` 的双向一致性均正确（无路径穿越风险）

## 建议的处理顺序

1. **C2–C9**（测试判别力；C3 顺手把宿主调用边界那三条负分支锁住 → 同时补上 S-6/S-7 缺的回归）
2. 清空后删掉本文件
