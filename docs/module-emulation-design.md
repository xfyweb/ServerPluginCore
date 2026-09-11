# 官方模块仿真设计（module emulation）

- 状态：**设计草案（2026-09）**；实现：P2-A（纯计算模块 + 桥契约）→ P2-B（fs / process / os）→ P2-C（buffer / crypto）
- 关联：ADR-005 §5（模块表面契约：**注入面 = 安全边界**）、api-contract §2/§5、exec-sandbox-design.md（同为"一个真实文件 + 注册表"模式）、manifest-design.md（权限请求）、ROADMAP P2
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

**非目标**（明确不做，避免误解）：
- 不是"在沙箱里跑真实 Node"：没有真 `process`、没有原生 addon、没有 `child_process`/`worker_threads`；
- 不改变权限模型：仿真是**接口形状的兼容**，能力仍由 `@host/api` + 权限注册表强制（零环境权力不变）；
- 不追求 100% API 覆盖：按真实插件需求逐块扩展（清单见 §3），未登记的模块**在构建期就报错**。

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
| **P2-C** | `node:buffer` | 无 | 最小 `Buffer`：`from` / `alloc` / `concat` / `toString(enc)` / `write`；编码 `utf8`/`base64`/`hex`（**注：不少纯 JS 依赖在加载期即使用 `Buffer`，若真实需求提前出现，可把 Buffer 提前到 P2-A/P2-B**） |
| P2-C | `node:crypto` | `crypto.hash`（待注册） | 只做摘要（sha256/md5）与 `randomUUID`；加密原语走宿主，不在沙箱内自实现 |
| 后置 | `node:stream` / `node:zlib` / `node:string_decoder` … | 视需求 | 按真实插件需求逐块评估，一律"先登记后可用" |

未列入本表的模块（`node:net`、`node:http`、`node:dns`、`node:tls`、`node:cluster`、`node:child_process`、`node:worker_threads`、`node:vm`、`node:v8`、`node:module`、`node:repl` …）**一律拒绝**。

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

## 9. 不可仿真项与替代

| 做不到 | 替代 |
|---|---|
| 原生模块（`.node`） | L3 禁区（ADR-005 §7）：由驱动插件在核心侧提供 `@host/api` 端点 |
| `child_process` | exec 模板（interface-audit-exec-fs.md / exec-sandbox-design.md） |
| `worker_threads` | 不做；重计算拆成多次宿主调用或由驱动插件承担 |
| 真 `Buffer`（C++） | 最小纯 JS 实现（§3 P2-C）：只保证常见编码与操作 |
| `fs.watch` / inotify | 不做；轮询或宿主专用事件 |
| 网络（`net`/`http`/`dns`/`tls`） | 驱动插件提供的端点 |
| `process.exit` / 信号 | 不做；插件生命周期由核心管理（init/start/stop） |

## 10. 与构建层的联动（构建期即失败）

1. **静态扫描 builtin 依赖**：构建层解析依赖图，收集所有 `node:*` / 裸内建模块引用，与本文件的登记表比对；
   - 未登记 → **构建失败**（而不是"构建通过、运行时报 module not allowed"）；
2. **CJS 依赖的 `require('fs')`**：依赖若是 CJS，esbuild 打成 ESM 时可能保留 `require` 调用或注入 `__require` 兜底。构建层需验证并按需提供映射到 loader 的 shim（**实现细节待 P2-A 验证后落定**，不在此处假设 esbuild 行为）；
3. **ESM-only 与依赖三层**（ADR-005 §4/§7）不变：L1 平台托管、L2 用户放行、L3 禁区；
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
| **P2-C** | 最小 `node:buffer`、`node:crypto` 摘要 | 二进制读写（base64/hex）与摘要用例通过；依赖探测 `Buffer` 的分支不崩 |
| 后续 | `stream` / `zlib` / `string_decoder` … 按真实插件需求逐块评估 | 每个新模块：本文件登记 + 权限映射 + 对齐测试 |

## 13. 待定项（评审时逐条定）

1. **`process.env` 暴露策略**：默认空对象已定；是否需要"白名单 + 权限点"（如 `env.read`）由 P2-B 定；
2. **`tmpdir` / `cwd` 语义**：`tmpdir` 用宿主值；`cwd` 建议=插件数据目录（与 fs 作用域一致），需确认；
3. **同步长操作**：`readFileSync` 走宿主同步 IO 会阻塞核心事件循环——是否需要大小阈值/超时/警告；
4. **仿真 Node 版本**：`process.versions.node` 汇报一个**固定的仿真版本**（建议 22.x LTS），并写进本文件，避免依赖走不同分支；
5. **未登记模块的用户体验**：构建期报错文案要指出"是沙箱未支持，而非代码写错"（清单可从本文件自动生成）；
6. **`node:module` / `createRequire`**：CJS 依赖可能需要 `createRequire`——是否在沙箱内提供受限版本，随 §10-2 一起定。
