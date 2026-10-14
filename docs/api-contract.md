# 宿主 API 契约（v0.2）

> 依据：ADR-001（零环境权力）、ADR-005（QuickJS 沙箱 + 驱动插件机制）、manifest-design.md（schema 2）。
> v0.2 变更：传输模型从"JSON-RPC over stdio"改为**进程内 `@host/api` 注入为主**（QuickJS 沙箱），stdio JSON-RPC 降级为子进程档次通道（⚠️ **该次通道已于 2026-09-25 砍掉**，见 §1/§10）；新增权限注册表、事件推送、API 扩展注册点。

## 1. 传输模型（双通道，同一套方法签名）

| 通道 | 适用 | 形态 | 说明 |
|---|---|---|---|
| **主通道** | QuickJS 沙箱插件（能力插件）· **随核心同一发布单元的内置功能** | 进程内 `@host/api` 模块注入（函数调用） | 插件 `import { fs, exec } from '@host/api'`；µs 级调用；注入即能力 |
| **次通道**（**2026-10-07 请回来**） | **所有装进来的驱动插件**（判据见 ADR-005 §3：**进程位置只看技术属性、不看来源**——带不可控二进制的必须独立，其余"装进来的"一律独立，理由是可**用性**） | stdio JSON-RPC 2.0 | 沿革：2026-09-25 曾随"子进程档"整体砍掉（当时"两个用户都没了"：驱动改核心进程内）；2026-10-07 因"**驱动插件要允许第三方**"重新引入。**同一套方法签名，两种宿主；位置是配置** |

- **版本协商**：`lifecycle.version`（核心返回契约版本，插件 SDK 校验兼容）；契约按 semver 演进，破坏性变更走废弃期；
- 沙箱插件**只能**通过注入拿到 `@host/api`；**跑独立进程的驱动插件通过 RPC 信封拿同一组方法**（同一套签名，见上表）。

## 2. 调用约定

- 每个方法有 JSON Schema 参数校验（宿主侧执行，跨通道共用一份 schema）；
- **错误模型（两层码，全英文，无本地化文本）**：
  - **顶层码**（传输/契约层）：`PERMISSION_DENIED` / `INVALID_ARGS` / `NOT_FOUND` / `TIMEOUT` / `INTERNAL` / `CONTRACT_MISMATCH`；
  - **领域码**（`detail.code` + `detail.params`）：如 `PATH_OUT_OF_SCOPE` / `SYMLINK_DANGLING` / `NOT_DECLARED` / `TIER_DENIED`；
  - 响应形状：`{ "error": "<顶层码>", "detail": { "code": "<领域码>", "params": { … } } }`；
  - **HTTP 不承载本地化文本**：CLI 用 `tError()` 渲染，面板自行请求 locale 文件在**前端渲染层**翻译；
  - **插件面（沙箱）**：`@host/api` 抛出的 `Error` 携带 `code` / `params`（`message` = 码），插件按码分支而非匹配文案；
  - **码是契约**：只增不改；新增码必须同步补 `locales/zh-CN.json` 的 `err.<code>`；
  - **全量清单的单一事实源是代码**：`core/errors.ts`（`SpcError`）+ 各模块的 code 类型联合（`PathErrorCode` / `CheckCode` / …）+ locales 的 `err.*`；本节与 module-emulation-design §7 只列举常用码与映射，**不重复维护全量列表**；
- 超时与并发上限宿主侧强制（防失控，不防恶意）。

### 2.1 面向用户的文案（`core/i18n/locales/*.json`）

**受众按"谁会在终端看到它"分，不按键前缀分**：`spc`（运维/管理员）与 `spcdev`（插件作者）是两个入口，
同一批 `err.*` 里既有运维看得到的（`err.SOURCE_*`、`err.PLUGIN_*`），也有作者看得到的（`err.BUILD_*`、`err.AUTHOR_*`）。
两者都不是内部设计文档的延伸。
**规矩**（2026-09-23 定；检查工具 `tools/check-locales.mjs`）：

1. **不引内部坐标**：ADR 编号、`§x`、文档文件名、阶段号（`P2`/`P5`）、内部字段名（`scope=` / `state=`）；
2. **说清"发生了什么 + 该怎么办"**，**不解释设计理由**（理由归文档：例如"一次点击不该等于全授"属于设计论证，不该出现在管理员的报错里）；
3. **不用口语**：陈述 + 建议，不用"别只开不关""绝不为一个插件卡住核心"这类；
4. **占位符必须真被传**：模板里写了 `{x}` 就必须有人传（历史坑：`cli.plugin.line` 里的 `reserved={reserved}` 字段 v2 已删、参数从没传过，于是**界面上原样打出 `reserved={reserved}`**）；
5. **每份 locale 必须同键同占位符**：`zh-CN.json`（正本）与其余各份（现为 `en-US.json`）的键集与 `{x}` 集合逐条一致。**逐份核**由 `core/__tests__/i18n-locale.test.ts` 做（它按目录列举，加一门语言就自动纳入）；`tools/check-locales.mjs` 目前只覆盖 zh-CN / en-US 两份 —— 加第三门语言时那道工具要一起泛化。

**2026-10-07 补三条**（用户手改一轮文案后定；是上面 2、3 两条的具体化，外加第 1 条受众的落地判据）：

6. **谁的界面就说谁的事**：`spc` 的文案里**不出现作者工具与构建概念** —— 服务器运维不写插件、也没有这份仓库，
   `spcdev` / `keygen` / 产物 / 依赖闭包 / 清单校验都不该出现在管理面文案里；`spcdev` 的文案可以引用仓库内的工具与步骤。
   **反向引用允许**（作者工具的用法行提"管理面命令在 `spc`"）：作者也装机，运维不构建。
   判据是**可复核的**：按 locale 键的**调用点**分档 —— 只被 `build/` 或 `core/cli-dev.ts` 调用的键 = 作者工具，
   其余 = 管理面（审计脚本在仓库外的开发工作区，跑一次即可复核）。
7. **术语与书写统一**：**这里的文案**里，同一个概念用一个词（`origin` = "源"，不叫"桶"；换源的动作不叫"搬"）；
   中文文案里不夹英文键值（`enabled=` → `已启用=`，`uptime` → `运行时间`），写完整句而不是关键词堆。
8. **不写辩护性尾巴**：不是"这不是你的错""闸门宁可拦错也不放过""非法清单不该出得了货"，
   也不写反问（"升级后的残留？"）—— 失败文案只留"发生了什么 + 该怎么办"。用户原话：**不要自我过度辩解**。

> ⚠️ **6–8 只管本节的文案**（`core/i18n/locales/*.json`）：代码注释与 `docs/` 下的设计文档是**给核心开发者看的**，
> 不按这三条要求（2026-10-07 定）—— **不要**为了"术语一致"去改注释与设计文档里的措辞。

> 这五条是**机械可查**的：`node tools/check-locales.mjs`（键集/占位符/内部坐标/陈旧字段），进 CI 也不会有噪声。
>
> **语言从哪来**：`SPC_LANG` → `LANGUAGE` → `LC_ALL` → `LC_MESSAGES` → `LANG` → 平台探测（仅 Windows/macOS）→ 默认 `zh-CN`；
> **可用的集合 = `locales/` 里真实存在的文件**（加语言 = 放个 JSON 文件，不用改代码）；匹配只做拼写归一
> （大小写 / `_`→`-` / 去掉 `.codeset` 与 `@modifier`）、**不猜前缀**；`C`/`POSIX` = 平台没有语言偏好 ⇒ 落默认；
> 匹配不上就回退默认**并在 stderr 出声**（按来源分 `err.LOCALE_UNAVAILABLE` / `err.LOCALE_PLATFORM_UNAVAILABLE`）。
> 契约见 `docs/cli-contract.md` §5。

## 3. 事件与钩子（宿主 ↔ 插件，反向通道）

> **完整设计见 `docs/events-and-hooks-design.md`**：**§1 事件面（P2 落地）** / **§2 钩子链（结论保留、P2 不做）**。
> 本节只留契约面：清单声明、方法、等级门槛。

**一句话**：沙箱里**没有"总线"**——插件自己发布事实，**声明过关系**（清单订阅 + `dependencies.plugins` 依赖声明 + 管理员批准）的插件收到；**核心只搬运**，不广播、不解释、不裁决。

### 3.1 清单声明（manifest `exports.events`）

```json
"exports": {
  "events": {
    "publish": [
      { "topic": "@a/sqlite.refresh-started", "classification": "public", "ask": true }
    ],
    "subscribe": [
      { "topic": "@a/sqlite.refresh-started", "mode": "notify" },     // 只听
      { "topic": "@a/sqlite.refresh-started", "mode": "arbitrate" }   // 我愿意出意见
    ]
  }
}
```

- **`publish[].ask`**（新增字段）：这个 topic **支不支持被征询**，缺省 `false`；对没声明 `ask` 的 topic 调 `request` ⇒ `EVENT_ASK_NOT_SUPPORTED`；
- **`subscribe[].mode`**：`notify` = 只听；`arbitrate` = **我愿意出意见**（**不是**"我裁决"——采纳与否由发布方自己的代码决定）；
- **命名空间**：topic 是**点式自由名**（`hello.heartbeat`）—— 点式名字属于**核心/驱动/协作**那条线（见 §4.0），能力插件对它只能声明、不能占用。今天的硬规则只有"**同一 topic 只能有一个发布者**"与"未声明不能发布"。~~`core.` 保留 + 插件用自己的 id 开头~~ ⚠️ **暂缓（2026-09-25）**：且它今天**表达不了** —— `topic` 的 schema pattern 是 `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`（不含 `@` 与 `/`），等那条线落地时一并定；
- **授权**：topic **枚举声明、无通配**；订阅他人事件还必须在 `dependencies.plugins` 里声明依赖发布方（`manifest-design.md` §6）；事件负载可能含敏感信息，跨插件订阅的门槛见 `intent-capture.md` §8.5。

### 3.2 方法（两个方向）

| 方法 | 方向 | 语义 |
|---|---|---|
| `events.publish(topic, payload, bytes?)` | 插件 → 宿主 | **通知**：说完就走，不等任何人 |
| `events.request(topic, payload, bytes?)` | 插件 → 宿主 | **征询**：等意见回来，拿到 `{ eventId, opinions[] }`；**采纳与否由发布方自己的代码决定** |
| `events.on(topic, handler)` / `events.off` | 宿主 → 插件 | 运行时**绑定处理函数**；只能绑清单里**申报过**的 topic（清单是授权面，运行时只绑函数） |

处理函数的返回值是**意见**（SDK 约定，**核心不解释**）：`{ decision?: 'allow' | 'deny' | 'defer' | string, reason?: string, data?: unknown }`。

> 早先草拟的 `EventContext` 与 `EventResult.status` 四态**归 §2 的钩子链**（P2 不做）；事件面用的是上面的意见列表形状。

### 3.3 等级门槛（事件面只剩"听"这一把）

两个正交维度：**保密等级**（读门槛，管谁能订阅）与**执行等级**（写门槛，管谁能裁决——**随 §2 的钩子链，P2 不做**）。

> 与 §6 **同一套等级、两处门槛**：本节的 confidentiality / executionLevel 管"事件订阅与裁决"的门槛（插件调用时通过 `meta` 声明、用户目录覆盖兜底）；§6 的同名字段是**权限点的默认等级**。两处不是两个维度——判定时按 `effective = max(...)` 合成，只取最高。

| 等级 | 通知订阅（读） | 裁决修改（写，P2 不做） |
|---|---|---|
| `public` / `low` | 无需额外授权 | 无需额外授权 |
| `sensitive` / `medium` | 显式授权（安装时确认） | 显式授权 |
| `secret` / `high` | 显式授予 + 二次确认 | 显式授予 + 二次确认 |

- **调用时声明**：事件等级由**发布方逐次声明**（"这一次有多敏感"），清单里的 `classification` 是**兜底**；
- **管理员覆盖（只升不降）**：`effective = max(发布方声明, 管理员覆盖, 清单兜底)`（目录 → 等级映射 `pathLevels` 进配置中心）；
- 审计记录 effective 等级。⚠️ 落地现状与缺口见 §7.1（桥还没把 `meta` / `userOverride` 传进判定）。

## 4. 方法组（核心第一版）

> 「落地」列 = 当前代码状态。P1.5 起 fs/kv/timers/events/lifecycle 全部可用（`core/hostApi.ts`）。

### 4.0 命名形态：路径式（能力插件）与点式（核心 · 驱动 · 协作）

两套形态**不是风格差异，是分层**（2026-09-25 明确；此前只散落在几处例子里，容易被读成"插件也能点式命名"）：

| 形态 | 谁拥有 | 出现在哪 |
|---|---|---|
| **路径式** `/…` | **能力插件**（沙箱内的 ability） | `exports.endpoints[].path`（`/api/…`，对外端点）、`exports.routes[].path`（面板页面）。访址一律是 `(完整引用, path)`：跨插件调用走 `plugins.call` 那条带源的点名，面板网关按 `(插件, path)` 寻址 |
| **点式** `a.b[.c]` | **核心 · 驱动插件 · 协作插件** | ① `@host/api` 的方法名与权限点名（`db.query`、`docker.read`、`exec.template.nginx.reload`）；② 核心流程的**决策点**（`auth.login.before`、`exec.*`…）—— 协作插件（hook）挂载的地方；③ exec 模板的 `action.op` |

- **能力插件对点式名字只能"申请"与"调用"，不能"占用"**：`permissions[].name` 是申请、`@host/api` 是调用；
  点式名字由核心或驱动插件注册（注册协议见 §10）。
- **`core.` / `core:` 保留前缀属于上面那一行的世界**：exec 模板那半已经落地（模板 ID 的命名空间 `core:` / `<pluginId>:`，
  `core:` 保留，见 `exec-sandbox-design.md` §2.2）；事件/主题那半的保留前缀规则**暂缓**，
  等驱动插件与协作插件那条线把命名空间定下来（见 `events-and-hooks-design.md` §1.2 / §2.1）。
- ⚠️ 由此推出的一条：**能力插件的清单里不该出现"点式前缀保留"这条规则** —— 它的对外面是路径式。
  历史上真有过这么一条（"`path` 必须带自己完整引用命名空间"），2026-09-25 已取消。

| 方法组 | 方法 | 权限点 | 落地 | 说明 |
|---|---|---|---|---|
| **exec（模板）** | `exec.run`（阻塞）`exec.spawn`（异步→句柄） | `exec.template.<action>.<op>` | `run` ✅ / `spawn` P2 | **无自由命令**，仅模板 + 参数校验（详 §5、§4.1）；返回值是**原始 JSON 文本**（唯一不自动解码的方法） |
| **fs（受限）** | `fs.read` `fs.write` `fs.list` `fs.stat` | `fs.read.data` `fs.write.data` | ✅ | 作用域 = **插件数据目录**；路径收敛 + realpath；`fs.write` 在"最近存在祖先的 realpath 在数据目录内"时补建父目录；读取上限 1MB（写 64MB） |
| **fs 原语（`node:fs` 仿真用）** | `fs.readBytes`（二进制通道）`fs.writeBytes` `fs.statFull` `fs.readdirEntries` `fs.mkdir` `fs.mkdtemp` `fs.rm` `fs.rmdir` `fs.rename` `fs.copyFile` `fs.realpath` `fs.access` | `fs.read.data` `fs.write.data` | ✅（第二批） | 上面那四个是**能力面**（形状已发布，保持不变），这一组是**同一批安全机制上的更低层原语**：同样是路径收敛 F1–F7 + 权限点 + 审计，只是不做 Node 的 API 形状（不解析 options、不造 `Stats`）。`node:fs` / `node:fs/promises` 的仿真层把这一组组装成 Node 的形状（见 module-emulation-design §6）。**写这类原语不补建父目录**（Node 的 `writeFileSync('a/b/c')` 在父目录缺失时就是 `ENOENT`），补建是 `fs.write` 能力面独有的行为；`fs.readdirEntries` 条目上限 10000（超限 `ENTRY_LIMIT_EXCEEDED`） |
| **url（宿主代工）** | `url.resolveHref` `url.setPart` `url.paramsParse` `url.paramsStringify` `url.domainToASCII` `url.domainToUnicode` | `url.parse` `url.encode` | ✅（第二批） | WHATWG `URL`/`URLSearchParams` 的解析与百分号编码：QuickJS **没有** `URL`（实测），而畸形输入多到无法穷举 ⇒ 交给宿主（就是 Node）。**对象身份留在沙箱**（`node:url` 里的 `URL` 类），桥只过"解析一次 → 全量快照"，赋值时回宿主重算（≈0.21ms/次，赋值不是热路径） |
| **kv** | `kv.get` `kv.set` `kv.delete` `kv.keys` | `kv.read` `kv.write` | ✅ | 插件作用域持久化存储（`<dataDir>/kv.json`）；值 JSON 编解码（可存对象/数组）；键 `[A-Za-z0-9_.:-]{1,256}`、值 ≤256KB、键数 ≤1000、**总容量 ≤8MiB**；落盘是**合并写 + 原子替换**，确定性的落盘点在**阶段边界**（钩子/装载结束、卸载前）——`kv.set` 返回后读回立即可见，但同一钩子内多次写只落盘一次 |
| **timers** | `timers.every` `timers.clear` | `timers.schedule` | `every`/`clear` ✅ / `cron` P2 | 宿主侧调度，插件不保活（定时器 unref）；回调在沙箱内执行、与钩子同样限额；卸载时宿主自动清掉；**同时存活上限 64 个**（计活着的，`clear` 即释放；超限 `TIMER_LIMIT_EXCEEDED`） |
| **events** | `events.publish`（订阅走 manifest 声明） | `events.publish` | ✅（总线本体 P2） | topic 必须已在 manifest `exports.events.publish` 声明，否则 `EVENT_TOPIC_NOT_DECLARED`；同一 topic 只能有一个发布者 |
| **lifecycle（宿主 API）** | `lifecycle.health` `lifecycle.version` | `lifecycle.health` `lifecycle.version` | ✅ | 心跳、契约协商；**插件自身钩子（宿主→插件）方向相反，见 §4.2 与 plugin-lifecycle-design.md** |
| **bytes（编解码）** | `bytes.fromString` `bytes.toString` `bytes.byteLength` | `bytes.encode` `bytes.decode` | P2-B | **宿主代工的编解码**（utf8 / latin1 / base64 / hex）：沙箱侧**字节存本地**（`Uint8Array` 子类），只有编解码整块过桥。**为什么代工**：QuickJS 没有 `TextEncoder`，沙箱内纯 JS 逐字节只有 ≈2.6 MB/s；而且交给宿主即**天然与 Node 逐字节一致**（畸形输入不必复刻）。它**不是 `node:buffer` 的私有细节**——仿真模块与插件作者用**同一批**方法。详见 module-emulation-design §3.2 |
| **audit** | （无需插件调用） | — | ✅ | 宿主对每个调用落审计（§8） |
| **plugins（调用面）** | `plugins.call(句柄, path, paramsJson, bytes?)` | 动态点 `plugins.call.<完整引用>.<path>`（`host` / `explicit`） | ✅（2026-09-25） | **插件间的定向调用**：句柄 = 依赖条目的 `as ?? id`（**不是**完整引用），`path` 必须在该依赖的 `call` 里声明过，对端端点还要 `callable` 含 `plugins`，管理员再逐条授予 —— 四条门槛见 `events-and-hooks-design.md` §3.7。返回值是 **JSON 文本**（照 `exec.run` 的约定，插件自己 `JSON.parse`），信封 `{ok, callId, callee:{origin,id,version}, path, result}`；失败按 `err.code` 分支（含**被调方自己的码**原样回传） |

- **作用域**：上表除 `exec.template.*`（`scope: host`，必须管理员逐点授予）外，其余全部 `scope: self`——碰的都是插件自己的数据/自己的调度，安装即生效（见 intent-capture §8.1 的三档模型，`grant` 档位落地位于 P2）；
- **返回值约定**：除 `exec.run` 与 `plugins.call` 外的组由沙箱侧做 JSON 解码，插件拿到真值（对象/数组/布尔），不需要自己 `JSON.parse`；
  （`plugins.call` 与 `exec.run` 一样返回**原始 JSON 文本**：它带字节槽，且信封要与调用方自己的解析习惯对齐。）
- **命名约定**：权限点 = 方法名（同样的字符串让插件作者一眼看懂要哪几个点），差别只出现在"同一方法因目标不同而敏感度不同"的场合（`exec.run` 的动态模板点）。

**核心不向插件暴露网络原语**：不仿真 `node:net`/`http`/`dns`/`tls`、不提供裸 socket、**也不设 `net.*` API**。db 连接代理、SSH、Docker 客户端、pty、媒体处理同样**由驱动插件经扩展注册点提供**（见 §10）。插件出网只有两条路：**`exec` 模板**（核心）与**驱动插件注册的端点**（插件），两条都是显式权限点（intent-capture §6.3）。

> 注意区分：**核心自身有出网**——市场下载与密钥状态文档拉取（plugin-signature-design §6 的 `GET https://{origin}/.well-known/spc-key-status`）。那是核心的运维行为，与插件能力面无关，也不出现在权限注册表里。

## 4.1 命令执行任务模型（参考 MCSManager）

> 设计参考：MCSManager 的 AsyncTask 模型（daemon/src/service/async_task_service）+ 进程适配器 + 状态机。
> 落地：P2（进程管理器），P1 仅 `exec.run` 阻塞形态。

**统一任务模型**：阻塞与异步是同一任务对象的两种消费方式，不是两套 API。

```
exec.run(template, params, {timeoutMs})       // 阻塞：spawn + await handle.wait()
exec.spawn(template, params) → TaskHandle     // 异步：立即返回句柄
```

**TaskHandle（沙箱内句柄对象，方法调用走宿主桥）**——插件三态切换：

```ts
interface TaskHandle {
  id: string;                    // 复杂随机，防枚举（MCSM：taskId 防越权）
  status(): 'running' | 'done' | 'error' | 'killed';
  wait(): Promise<{ exitCode: number }>;      // 阻塞等待（STOP→resolve / ERROR→reject）
  output(opts?): string[];                   // 拉取输出（增量/尾部）
  kill(): Promise<void>;                     // 取消（先软后硬杀树）
  events: EventEmitter;                       // started/exit/data/error —— **句柄自己的事件**，不走事件面的投递
}
```

**关键机制**（MCSM 验证过的坑，必须内置）：

| 机制 | 说明 |
|---|---|
| **世代号（startCount）** | 句柄记录代际；所有超时/取消回调先校验"还是不是原来那个任务"再动手——防竞态 |
| **取消三层链** | abort 流 → 销毁句柄 → **杀进程树**（Linux `/proc` 递归子进程、Windows `taskkill /T /F`）——防子进程逃逸 |
| **优雅停止契约** | 停止策略配置化：`{ stopCommand?, signal, timeoutMs }`——先命令式停止 → ^C/SIGINT → 超时升级 SIGKILL → 杀树兜底 |
| **`detached: false`** | 不分离子进程——父进程异常退出时子进程不继续运行 |
| **输出环形缓冲** | 固定容量（默认 256 块 × 256 字符，50ms flush），**截断时插入 `[截断]` 标记**；内存固定不增长 |
| **任务归属** | 句柄绑定创建者插件——只能控制自己的任务（`jobs.manage` 区分"自己/全局"） |
| **任务级资源限制** | 非容器场景务实方案：磁盘配额 + 降权运行（runAs）+ 超时杀树；硬限制（内存/CPU）留给 docker/未来 |

**长驻进程（MC 服务器等）**——任务模型的特殊形态（无终态，状态机）：

```
process.start(id, template, params) → ProcessHandle   // spawn（低权限用户，数组参数不拼 shell）
process.output(id) / process.signal(id, sig) / process.stop(id, {timeoutMs})
权限点：process.start / process.signal / process.stop（dangerous 级）
状态机：STOPPING → STARTING → RUNNING（+ 崩溃自动重启：autoRestart + 次数上限）
```

**不做事件**（2026-09-22 定）：`job.finished` / `process.exit` / `process.crash` / `process.data` **都不是核心发的事件**——任务是**插件自己的动作**，结果它自己拿得到（`wait()` / `output()` / 句柄自己的 `events`），别的插件没有知情权。核心对插件之间的可见性一律按 `manifest-design.md` §6。理由与边界见 `docs/events-and-hooks-design.md` §1.14。

## 4.2 插件钩子（宿主 → 插件）

与 §4 的方法组**方向相反**：装载器调用插件导出的钩子。完整契约、状态机、配置与验收见 **plugin-lifecycle-design.md**。

```ts
export async function init(ctx: PluginContext): Promise<void>;   // 必需
export async function start(ctx: PluginContext): Promise<void>;  // 可选
export async function stop(ctx: PluginContext): Promise<void>;   // 可选
```

- **两种注入分工**：`@host/api`（模块注入）= **能力**；`ctx`（参数注入）= **环境事实**（`{ pluginId, version, dataDir, manifest(只读), grants(只读), logger }`）；
- **能力登记由 loader 依 manifest 完成**（routes / endpoints / events；`execTemplates` 随 P2-5），插件不能自己注册；
- **四层限额**：CPU 中断（`setInterruptHandler`：死循环与正则灾难性回溯都拦得住）/ 内存（`setMemoryLimit`）/ 栈（`setMaxStackSize`）/ **宿主 API 自带超时**；
- **契约要求（对宿主 API 作者）**：asyncify 挂起期间 VM 不执行代码，中断不触发——所以**任何可能阻塞或依赖外部输入的宿主 API 必须自带超时**（`exec.run` 的 `timeoutMs` 是样板）；
- async 钩子由宿主泵 job 队列（`executePendingJobs`），未泵完即报 `PLUGIN_JOB_PENDING`。

## 5. 危险原语策略

**exec 模板**（核心第一版审计焦点，详细规范见 interface-audit-exec-fs.md，沙箱与注册制见 exec-sandbox-design.md）：
- 模板注册表（**注册制**，两方来源 + 命名空间 `core:` / `<pluginId>:`）：插件在 manifest `execTemplates` 声明 → 核心静态校验（E1–E10）→ 管理员批准 → 进注册表；参数用枚举/正则/白名单校验；**管理员是审批方，不定义模板**（他定义的模板插件开发时看不见）；
- 调用写法：模板 ID 形式（`exec.run('core:git.status', {repo})`）与**原生写法**（`exec.run('git -C /srv/demo status …')`）等价——原生写法只用于**匹配模板**，执行的永远是模板的 argv，匹配不到即 `TEMPLATE_NOT_FOUND`；匹配时**字面量优先**，命令形状全局唯一（详见 interface-audit-exec-fs.md §2）；
- 命令构造禁止字符串拼接用户输入（数组传参）；凭据禁明文 `-p`，走 `MYSQL_PWD`/`--defaults-extra-file`（chmod 600，用完即删）；
- 输出大小限制、超时、工作目录固定、环境变量白名单；
- 第一版内置模板（**无自由命令**；命令固定 + 参数校验，见 interface-audit-exec-fs §2）：
  - **git**：`core:git.version`（诊断，无参数）、`core:git.status`、`core:git.log`（`count` 限 1–3 位数字）、`core:git.rev-parse`、`core:git.branch`（只读）、`core:git.fetch`、`core:git.pull --ff-only`（动仓库 / 走网络）；除 `version` 外都以 `repo`（path，**白名单作用域**）为参数；
  - **nginx**：`core:nginx.test`、`core:nginx.reload`（找得到 nginx 才注册）；
  - psql/mysql（凭据走 env）待补。
  - 仓库白名单根默认按平台取（Windows `%ProgramData%\spc\repos`；Linux `/srv`、`/var/lib/spc/repos`），可用 `SPC_REPO_ROOTS`（平台分隔符）覆盖——"哪些目录里的仓库允许被模板操作"由管理员决定；
  - 可执行文件解析跨平台（Windows 常见 `%ProgramFiles%\Git\cmd\git.exe`），但解析结果仍要过 E10 白名单；单个内置模板注册失败只告警，不影响核心启动。

**fs 路径收敛**：
- 所有路径 `realpath` 规范化后校验前缀；拒绝符号链接逃逸、`..`、特殊文件（/dev、/proc、socket）；
- 写操作默认只落插件数据目录；大小限制、文件类型白名单；
- 详细威胁建模清单见 interface-audit-exec-fs.md。

## 6. 权限注册表（D4，核心侧集中登记）

每个权限点一条记录：

```json
{
  "name": "docker.write",
  "group": "docker",
  "description": "修改容器配置",
  "scope": "host",                  // self | host：资源作用域（碰不碰宿主资源）
  "grant": "explicit",              // auto | install | explicit：授予方式（判定链读取）
  "confidentiality": "sensitive",   // 读门槛
  "executionLevel": "medium"        // 写门槛
}
```

三个维度，各管一件事：

| 字段 | 管什么 | 规则 |
|---|---|---|
| `scope` | **碰不碰宿主资源**（资源作用域，用于路径收敛与文案） | `self` = 只碰插件自身（自己的数据目录 / kv / 定时器）；`host` = 碰宿主管理的资源。注册期两条一致性约束：**`self` 只能是 `auto`**、**`host` 不能是 `auto`**（违反 → `SCOPE_GRANT_INVALID`），与既有的 `executionLevel ≥ confidentiality` 同属注册期校验 |
| `grant` | **要不要管理员逐点授予**（判定链第 3 步读取） | `auto` 安装即生效、**不可撤也不需要撤**（够不着别人，也没有承载授权的载体）；`install` = **首次安装时按清单播种进白名单**，之后与 `explicit` **完全一样**；`explicit` 默认拒绝、**必须逐点授予**（intent-capture §8.1）。两者都在 `grants` 里 —— 判定链只有**一条白名单**，"撤回"就是把点移出它 |
| `confidentiality` / `executionLevel` | **权限点的默认等级（兜底）** + `effective` 合成的输入之一 | `effective = max(调用方/核心声明, 用户目录覆盖, 权限点默认)`，**只升不降**；不变式 `executionLevel ≥ confidentiality`（封死仲裁旁路）。⚠️ **等级不是"每个权限点写死一个值"**：真正决定它的是**这一次调用碰到了什么**（同一次 `fs.read`，读无关文件是 `public/low`、读管理员的机密目录是 `secret/high`），注册表里那两个字段只是"没人声明时兜底"。落地现状与缺口见 §7 末尾。 |

> v3 修订：**删除 `protectionLevel`**（Android 的"授予仪式"枚举：normal / dangerous / signature）。理由：(1) 它在本仓库里从未被判定逻辑读取，是装饰性字段；(2) 其中 `signature`（仅同签名可申请）把身份塞进权限定义，与"来源不参与权限判定"冲突；(3) `normal` 真正表达的是"这个能力够不着别人"，用 `scope: self` 表达更准确。按信任档分档的 `defaults` 同时删除。
>
> v4 修订：**新增 `grant` 三档**（intent-capture §8.1）。它和刚删掉的 `protectionLevel` 的区别是本质的——`grant`
> **被判定链读取**（第 2、3 步都只看它），而 `protectionLevel` 是死字段；`scope` 则从"要不要授予"退为"碰不碰宿主资源"，
> 并在注册期约束 `grant`。**✅ 已落地（2026-09，第四批 B）**：判定链第 2 步放行 `auto` 档、第 3 步只看 `explicit`，
> 注册期约束 `self ⇒ auto`（`SCOPE_GRANT_INVALID`）。
>
> **⚠️ 2026-09-23/24 权限判定体检，改了三处**：
> ① **注册期补 `host` 不能是 `auto`**：`auto` = 免声明 + 免授予，一个碰宿主资源却免声明的点会被**直接放行**
> （fail-open）。此前只有 `permissions-meta.test.ts` 的一条不变式守着 —— 那是测试层面的，注册期并不报错；
> ② **`install` 与 `explicit` 合并走同一条白名单**：`install` = **首次安装时按清单播种一次**（`manager.seedGrants`），
> 之后与 `explicit` 完全一样。在此之前 `install` 档是"声明即生效、`grants` 里根本没有它"，于是
> **`revoke` 删的是一个不存在的条目 —— 判定照旧放行，而 CLI 打印"已撤销"**（假成功）。
> 顺带收口了"升级新增的 `install` 档点静默放行"（现在只播一次 ⇒ 新增点要管理员授予 = 增量同意，§8.4）；
> ③ **`auto` 档的 `grant` / `revoke` 明确报错**（`GRANT_NOT_APPLICABLE`）—— 它够不着别人，
> 没有承载授权的载体，不该再"成功但什么都不发生"。
> （中间一度加过判定链第 2 步 `REVOKED`（记录里的 `revoked` 名单）；②落地后它没有存在必要了 ——
> 撤回与"从未授予"是同一个动作、同一个码，"是谁撤的"由 `plugin.revoke` 审计条目回答。）

- **权限点不设 identity / trust 类字段**：它只描述"这个能力是什么、有多敏感"，不描述"谁有资格申请"。
- 注册表是审计、管理 UI、测试、驱动插件注册方法时枚举的单一事实源。

#### 6.0 两张表：冻结表与临时表

注册表**不是一张表**（2026-09-24 定）：

| | 谁写 | 什么时候写 | 运行期会变吗 |
|---|---|---|---|
| **冻结表**（`core/permissions/registry.ts`） | 核心自己 + **驱动插件** | **只有核心启动阶段**：先核心静态点，再驱动注册点 | **不变**（能力插件加载前就固化） |
| **临时表**（`core/permissions/source.ts`） | 没人写 —— 从**当前活着的插件**派生 | 随插件装载/卸载即时变化 | 是（跟着"谁在跑"） |

- **驱动插件与能力插件是两个加载阶段**：驱动插件装/卸/禁**必然伴随核心重启**，它注册的点必须在能力插件
  加载前就位并固化 ⇒ **能力插件看到的点表是稳定的**（这也是"按清单播种"能成立的前提：播种那一刻查得到档位）；
- **临时表不存储、只派生**：能存的东西就有"点还在、端点早删了"的不一致可能，而 `capabilities` 快照本来就是
  "当前活着的插件登记了什么"的唯一事实源。判定链查的是 **冻结表 ∪ 临时表**（`pointSource`）；
- ⚠️ **临时表里的点名不进 `registry.all()`**：早先塞进去过，直接后果是 `permissions-meta.test.ts` 那份
  需要签字的显式清单得**跳过**它们才能对齐 —— 那是污染的症状。"注册表是冻结的"由那个测试守着。

### 6.1 临时表里的点：跨插件调用与订阅

| 点 | 谁派生出来的 | 档位 | 点什么时候没了 | 授权存在哪 |
|---|---|---|---|---|
| `plugins.call.<完整引用>.<path>` | **被调方**登记该端点 | `host` / `explicit` | 被调方卸载 / 重载 / 换源 | 调用方记录的 `grants` |
| `events.subscribe.<完整引用>.<topic>` | **发布方**登记该 topic | `host` / `explicit` | 发布方卸载 / 重载 / 换源 | 订阅方记录的 `grants` |

⚠️ **两件事要分开看**（之前混在一起，混出过一个假成功）：
- **点会消失**：被调方卸载/重载/换源 ⇒ 点名查不到 ⇒ 判定第 1 步就 `UNKNOWN_POINT`（fail-closed）；
- **授权是另一回事**：它存在**调用方**的安装记录里（`grants`，按点名），所以被调方 reload 一次
  不会把管理员的批准抹掉 —— 点会用同一个名字回来，那条授权照旧对得上。

**为什么这两族是 `explicit` 而不是 `install`**：`install` 的语义是"清单里写一行就生效"，用在跨插件上
就等于**插件间默认不隔离**（装一个 A，只要它清单里写了、对方又声明了，就通了）。基础模型是插件之间
**默认隔离**（`exports` 默认私有、看不见别的插件），跨过去必须管理员**逐条**点头 ⇒ 只有 `explicit` 对得上。
顺带把"逐点 / 逐 topic 撤回"变成现成的（撤的就是 `grants` 里那一条）。

四条不变式（都有用例钉着，见 `core/__tests__/dynamic-points.test.ts`）：

1. **点名是"前缀 + 完整引用 + 尾段"的字面拼接**，含源的理由与单射证明见 `docs/events-and-hooks-design.md` §3.4
   —— 身份是 `(origin, id)`，点名不带源就等于两个同名插件共用一条授权；
完整引用 `<来源>/<插件 id>`（如 `local:default/@xfy2412/counter`）是记录的**唯一键**，也是最具体的形式；
管理命令的输入允许一路省到"**只要没有歧义**"为止：

| 写法 | 例子 | 何时可用 |
|---|---|---|
| 完整引用 | `local:default/@xfy2412/counter` | 总是 |
| 裸 id | `@xfy2412/counter` | 该 id 只在一个来源下 |
| 裸**名字** | `counter` | 该名字只对应一个插件（跨作者与来源） |

任一级**不唯一就报 `PLUGIN_REF_AMBIGUOUS`（带候选）**，绝不挑一个 —— 挑错就是在动另一个插件的数据。
只认**标识符**，不认 manifest 里的展示名（展示名可以重名、可以带空格与中文）。
⚠️ **跨插件引用不走这条容错**（调用目标 / topic / 依赖声明 / 权限点名一律完整引用）：那些是"写进别人清单里的名字"，
省一点就会在换源/改作者时静默指错地方（理由见上面那段单射证明）。

**引用的缩写阶梯**（管理面输入；`core/plugin/records.ts` 的 `resolveRecord` 是唯一实现）：
2. **装载/卸载不许动冻结表**（`registry.all()` 逐项不变）—— 临时表是派生的，能力没了点自然就没了，
   不需要（也不该有）"撤销某个点"这一步；
3. **点必须"可声明"**：尾段不含空白（`permissions[].name` 的 schema 表达不了 ⇒ 会生成一个谁都申请不了的点）、
   不含 `*`（`matchDeclaration` 会当通配 ⇒ 一次声明把对方**将来新增**的端点/订阅全预授权了）。
   不满足即**装载失败**（`PERMISSION_POINT_INVALID`），全有或全无，不留半登记；
   ⚠️ **跨插件点的"声明"不由作者写源**（2026-09-24）：调用面的请求写在**依赖条目**的 `call: ['/api/x']` 里、
   订阅面的请求写在 `exports.events.subscribe[].topic` 里 —— **包内被签名的字节里不含本地源名**
   （本地桶名是装机人起的标签，作者不可能知道）。宿主在装载时按依赖**锚定解析**成实际 ref、生成带源的点名；
   **授权（管理员批准的那条）仍然带源**，审计与响应信封记**实际 ref**。见 `events-and-hooks-design.md` §3.7；
4. **等级取被引用方的声明**：订阅点取发布方的 `classification`（`secret` 的 topic **不派生点** —— 它本就禁止跨插件，
   派生等于承诺一条走不通的路）；调用点没有分类可依（端点只有面板侧的 `permission`），取 `public/low` 兜底，
   这一次调用的真实等级由**调用时声明**与用户目录覆盖合成（§7.1）。

> ✅ **"插件还在、只收回这一条"已经落地**（2026-09-23/24）：两族点都是 `explicit` 档 ⇒ 收回就是
> **把点移出调用方记录的 `grants`**（判定链第 3 步读它）。所以不需要另造"批准表"，
> `docs/events-and-hooks-design.md` §4.2-2 那个待定项由此关闭；授权变更另有 `plugin.revoke` 审计留痕。

## 7. 权限判定（三态 + 匹配算法）

判定链（宿主侧强制，D3 单一强制点）：

```
1  权限点查不到（冻结表 ∪ 临时表都没有） → UNKNOWN_POINT（未知即拒绝）
2  grant != auto 且 manifest 未声明     → NOT_DECLARED（无默认放行；**auto 档免声明**）
3  grant != auto 且不在 `grants` 里     → NOT_GRANTED（auto 档免逐点授予）
4  通过 → 作用域与参数校验在各方法内层（通过时审计记 grant 档）
```

> **只有一条白名单**（`install` 与 `explicit` 共用）：`install` 档的那条授权由**首次安装时按清单播种**
> （`manager.seedGrants`）写进 `grants`，之后两者在判定上**没有任何差别**。所以"撤回"= 把点移出 `grants`，
> 与"从未授予"同一个动作、同一个码。⚠️ 中间一度加过第 2 步 `REVOKED`（记录里的 `revoked` 名单）——
> 那是为"`install` 档声明即生效、`grants` 里根本没有它"的旧语义打的补丁；合并白名单之后它没有存在必要：
> **"是谁撤的、什么时候撤的"由 `plugin.grant` / `plugin.revoke` 审计条目回答**，不靠状态字段。
> `auto` 档没有承载授权的载体 ⇒ `grant` / `revoke` 对它直接报 `GRANT_NOT_APPLICABLE`，不再假装成功。

> **第 1 步查两张表**：冻结表（核心静态点 + 驱动注册点，见 §6）与临时表（跨插件调用/订阅的点，见 §6.1）。
> 临时表里的点随对端插件生灭 ⇒「被调方卸载了」自然变成 `UNKNOWN_POINT`（fail-closed），不需要另写规则。

> **✅ 已落地（2026-09，第四批 B；2026-09-23/24 权限体检修三处）**。几处与早期草案的差别，都是落地时才定死的：
>
> ① **第 2 步也看 `grant`，不再看 `scope`**。`scope` 回答"够不够得着别人"（资源语义），
> "要不要在 manifest 里自报家门"是**摩擦**问题——两者混在一个字段里正是 v3 "self 也要声明"
> 的由来（纯摩擦，且拦不住恶意方）。现在的口径：**`self` = 免声明免授予**；**`host` = 必须声明**
> （哪怕是"插件自己的数据目录"，那也是宿主文件系统里的一块，管理员该在安装时看见它），
> 再按 `grant` 档决定要不要逐点授予。
>
> ② **`grant` 缺省按 `scope` 推导**（`self → auto`、`host → explicit`），推导结果就是注册期校验的规则
> （`self` 只允许 `auto`、`host` 不许 `auto`，违反 → `SCOPE_GRANT_INVALID`）。老调用点不写 `grant` 也不会松动：
> `host` 兜到 `explicit` 是 fail-closed 的方向。**注册时存解析后的值**，判定链只读这一处。
>
> ③ **驱动器注册的点，档位与等级由驱动自己定**（2026-09-24 定）：注册 API 本来就收 `scope` / `grant` /
> 等级，核心不替它选 —— 就像发布事件时保密等级按**本次内容**给，而不是清单写死。缺省 `host → explicit`
> 的 fail-closed 方向不变，所以"驱动想省事"不会意外放宽。
>
> 当前档位分布（`core/__tests__/permissions-meta.test.ts` 把它钉成显式清单）：
> **17 个 API 点全是 `self`/`auto`（免声明）**；`exec.template.*` 是 `host`/`explicit`
> （机器上装了 git/nginx 才有，数量随机器变，但档位不变）；**`install` 档今天一个点都没有** ——
> 它是留给"宿主资源、但资源本来就属于该插件"那类点的中间档（如驱动注册的 `docker.read`：
> 一次播种即可用，之后与 `explicit` 同一条道）。
>
> ⚠️ **`fs.read.data` / `fs.write.data` 暂留 `self`**：它们碰的是宿主文件系统里的真实文件，
> 按 `scope` 的定义更像 `host`（`grant: install` 那一档）。「内容式权限」（按路径/内容而不是按
> 方法名划权）要单独讨论——在那之前保持现状，不引入新摩擦（缺口表见本节 §7.1；事件侧的门槛接线见 `docs/events-and-hooks-design.md` §1.7）。
> **推论（2026-09-23 明确）**：既然是 `auto` 档，`spc plugin grant/revoke` 对它们会**明确报错**
> （`GRANT_NOT_APPLICABLE`）——"禁止这个插件写自己的数据目录"今天只能靠禁用/卸载整个插件。

### 7.1 等级（`confidentiality` / `executionLevel`）的落地现状与缺口

**规矩本身没变**（§3.3 + §6）：等级由**这一次调用碰到了什么**决定 ——
插件通过 `meta` 声明本次操作、用户用 `pathLevels`（目录 → 等级）覆盖、权限点的值是**兜底默认**，
合成 `effective = max(...)`（只升不降），审计记 `effective`。

**但代码里目前只有一半**（2026-09 核实，第四批 B 时发现）：

| 环节 | 状态 |
|---|---|
| `effectiveLevel()` 合成（含"只升不降"+ `e ≥ c` 校正） | ✅ 有，`core/permissions/check.ts` |
| `checkPermission(..., { meta, userOverride })` 两个入参 | ✅ 有 |
| **桥把 `meta` / `userOverride` 传进判定** | ❌ **没有**——`core/sandbox.ts` 调用时根本没传 ⇒ 每次 API 调用拿到的都是**权限点默认值** |
| **`pathLevels`（用户目录覆盖）** | ❌ 配置里不存在 |
| 审计记 `effective`（真值） | ⚠️ 记的是 `check.params` 里那三个字段，等于默认值 |

**结论**：等级机制目前**只在单测里活着**；生产路径上等于"每个权限点一个固定等级"——
与设计意图不符（这正是"读无关文件低、读机密目录高"做不到的原因）。

**补法（待与「内容式权限」一起定；**本表就是缺口的单一事实源**，事件侧的门槛接线见 `docs/events-and-hooks-design.md` §1.7）**：
① `HostApi` 的方法表加 `metaFor?(args, ctx)` —— **原语自己声明"这次碰的是什么"**
（`fs.readText` 看路径落在哪个目录、`exec.run` 看模板与命令、`events.publish` 看事件等级）；
② 桥把它与 `pathLevels` 覆盖一起交给 `checkPermission`；
③ 审计记合成后的 `effective`。
⚠️ 不要在仿真层（`node-fs.js`）里塞等级判断：那会让"同一个 `fs.readFileSync` 在不同仿真模块下等级不同"，
等级必须由**碰资源的那一层**（宿主原语）声明。

- `grant` 三档（`auto` / `install` / `explicit`）是权限点的属性：`auto` = self 域 + `lifecycle.*`（**免声明免授予、不可撤**）；`install` = host 级只读 + 插件自有能力（**首次安装时播种进白名单**，之后与 `explicit` 同一条道）；`explicit` = 写宿主资源 / `exec.template.*` / `process.*` / **出网类权限点（exec 模板或驱动插件注册的端点）** / **跨插件调用与订阅（`plugins.call.*` / `events.subscribe.*`）** / 提权，默认拒绝、逐点授予。**升级新增的 `install`/`explicit` 点都必须重新展示（增量同意）** —— 合并白名单之后这一条对两档都成立了（`install` 档只播种一次）；
- 判定结果：`ALLOW / DENY / UNSET→DENY`（Tristate：未设置 = 拒绝）；
- **授权变更留痕**：`grant` / `revoke` 各落一条审计（`plugin.grant` / `plugin.revoke`，`target` = 变了的那几个点名）—— 权限变更不写日志比"少一个状态字段"严重得多；
- **声明与授予都不接受通配**：`permissions[].name` 是**固定分段**的形状（schema 的 pattern），`docker.*` / `*` 连 manifest 校验都过不了；管理员的授予同样必须逐个写具体点（`isValidGrantPoint`）。理由是同一条：**声明的用途是让管理员在安装时看见"这个插件要什么"**，`docker.*` 会把这张清单变成一句口号。⚠️ `core/permissions/check.ts` 的 `matchDeclaration` **仍保留**前缀通配与 `*` 的分支，但今天的 manifest 产生不出这种输入 ⇒ 那条路径**从真实插件走不到**（留着是因为它是判定链的通用能力，别把它当成"清单可以写通配"的依据）；
- 插件 manifest 声明的是"请求"（uses-permission）；宿主按"`scope` + `grant` 档 + 管理员逐点授予"做出"批准"（请求/批准分离，Android 模型）；
- **来源（签名 / 市场 / 本地安装）不参与判定**：有源与无源插件在权限面前完全平等（ADR-001 v3）。

## 8. 审计

每条调用落一条 JSONL（文件位置与游标见 §8.4），结构版本 **v2**（2026-10-14 重整）：

```jsonc
{ "v": 2, "seq": 12, "ts": 1791951692498,
  "actor":   { "kind": "plugin", "ref": "local:default/@a/b" },
  "subject": { "kind": "point", "ref": "kv.write" },
  "method": "kv.set",
  "paramsDigest": "…", "result": "ok",
  "permission": { "decision": "allow", "code": "ALLOWED" },
  "timing": { "ms": 1, "suspendedMs": 0 },
  "resultBytes": 128,
  "corr": { "callId": "…", "attempts": 1, "waitedMs": 0 },
  "detail": { "origin": "local:b" } }
```

审计日志只增不改，插件不可达；**只记机器可读的码与参数摘要**（不落明文参数、不落本地化文本；
本地化在 `spc audit tail` / 面板渲染层完成）；权限拒绝单独告警。

### 8.1 谁做的 / 关于谁（v2 的核心）

| 字段 | 语义 |
|---|---|
| `actor.kind` | `plugin`（插件自己调的）/ `operator`（管理员：CLI、TTY 控制台、将来的面板）/ `core`（核心自己：停机收尾、自动重启、强制回收） |
| `actor.ref` | 插件干的 ⇒ 该插件**完整引用**；管理员干的 ⇒ **留空**（P3 填用户）；核心 ⇒ 无 |
| `actor.via` | 只有 `operator` 有：`cli`（HTTP 管理通道）/ `console`（守护进程的 TTY 控制台）/ `internal`（不是人从某条通道发起的） |
| `actor.user` | P3 的用户身份位（现在恒为空）—— 结构不用再动 |
| `subject.kind` / `.ref` | 关于谁/什么：`plugin` / `origin` / `point`（权限点）/ `timer` / `event` / `self`（插件自己的事，渲染时省略）/ `none` |
| `detail` | **只对管理动作**：**闭集码值**明文（来源 / 权限点 / 别名 / 指纹 / 计数）。⚠️ 路径、凭据、业务数据**不许进**（照旧只进 `paramsDigest`） |
| `timing.ms` / `.suspendedMs` | 执行时长 / **等宿主 Promise 的墙钟**（分开记的理由见下） |
| `corr.callId` / `.eventId` / `.attempts` / `.waitedMs` | 串联与重试代价（跨插件调用、事件） |
| `paramsDigest` / `permission` / `error` / `resultBytes` / `result` / `method` | 沿用（名字没改） |

> **为什么改**（2026-10-14，维护者原话："插件主动行为鉴权和用户主动行为混在一起，难以辨认"）：
> v1 只有一个身份槽（`pluginId` + `ref`），而它在不同 method 家族里**角色不同** —— 插件调用里是**发起者**、
> 管理动作里是**被操作对象**、`source.*` 里干脆是 origin。于是 `kv.set`（插件干的）与 `plugin.grant`（管理员干的）
> 在流里长得一模一样。现在**发起者**与**对象**分列两处，读面也能按 `actor` / `via` 过滤。

**管理动作的方法码**：`plugin.install` / `.uninstall` / `.enable` / `.disable` / `.reload`（v2 补上，
以前**一条都不落** —— 只有它们带出来的 `lifecycle.*`，`uninstall` 之后记录没了就说不清"谁卸的、从哪个源装的"）、
`plugin.grant` / `.revoke` / `.key-change` / `.reanchor`，以及 `source.add` / `.remove` / `.enable` /
`.disable` / `.alias` / `.anchor`。

> 授权与身份这三条（`plugin.grant` / `.revoke` / `.key-change`）是"**谁在什么时候改了授权/身份**"的**唯一**出处 ——
> 撤回不靠记录里的状态字段，靠这里的日志；变更的点在 `detail.points`（v2 起明文可读），换钥的新指纹在 `detail.fingerprint`。

**生命周期条目**（plugin-lifecycle-design §7）：`lifecycle.load`（求值失败）、`lifecycle.init` / `.start` /
`.stop` / `.unload`（每个钩子，`result: ok/error` + `timing.ms`）、`lifecycle.restart`（`failedRestart=auto`
触发，带 `detail.attempts` 与 `corr.attempts`）；`subject` = 那个插件；`actor` = **谁触发的这次装载**
（管理员操作 ⇒ `operator`，自动重启/开机 ⇒ `core`）。**定时器回调**落 `timers.tick`（`subject` = timerId，
`paramsDigest` = callbackId 摘要）—— 它不经过宿主桥，所以由沙箱侧显式记账。

**跨插件调用的补充字段**（2026-09-25，v2 里改名进 `corr`）：

| 字段 | 谁写 | 回答什么 |
|---|---|---|
| `corr.callId` | 一次 `plugins.call` 的**所有相关条目共用**：调用方那条宿主调用、被调方那条"被调"条目、以及被调方**内部**因这次调用产生的每一条（fs/kv/…） | "这一次跨插件交互里，对端都干了什么" —— 条目分属**两个插件**，光看 `actor.ref` 串不起来 |
| `corr.attempts` | 投递链（`core/plugin/call-retry.ts`） | 试了几次（1 = 一次就通）；>1 说明对端当时正忙（定时器/监视回调在飞） |
| `corr.waitedMs` | 同上 | 重试累计等待（有界：3 次尝试含首次 ⇒ 最多等 50+100=150ms；硬顶 350ms） |

**核心自身的条目**（不是某个插件干的）：`actor.kind = 'core'`（v1 的 `pluginId: "<core>"` 已废）；
目前有 `core.shutdown`（停机收尾时落，原因进 `detail.reason`）与 `lifecycle.shutdown-abandoned`（停机预算用完）。

### 8.2 文件与游标（按天分文件）

| 文件 | 何时 | 说明 |
|---|---|---|
| `audit/<YYYY-MM-DD>.jsonl` | 当天 | 当天全部条目都追加到这里；**同一天内多次重启仍写同一个文件** |
| `audit/<YYYY-MM-DD>.jsonl.gz` | 跨日之后 | 跨日时把前一天的 `.jsonl` gzip 打包（启动时补做"午夜时进程不在"留下的明文） |
| `audit/legacy-v1*.jsonl.gz` | 一次性 | 迁移时把旧的单文件 `audit.jsonl` 挪走留档（读面不解析它） |

- 每条带 `v`（结构版本）与 `seq`（**文件内**序号，从 1 起、不回退不跳号）⇒ **读面游标 = `"<日期>#<seq>"`**
  （人也能照着念；**不用字节偏移、也不用时间戳** —— 后者在同一毫秒多条时会重会漏）；
- 读面 `limit` 不够时往前面几天的 `.gz` 里回看，**最多 7 天 / 解压 64 MiB**，到边界如实报 `lookbackExhausted`；
- 失败策略照旧：启动探测不可写 ⇒ 退出（fail-closed）；运行期写失败进内存缓冲，缓冲超 10 MB ⇒ 退出。

## 9. manifest（schema 2）

> `type` 声明插件类型（ability/driver/hook/theme），缺省 `ability`。四类定义见 README「插件类型」与 ADR-005 v3。
> **今天的现状**：`type` 只区分 **`theme`**（无沙箱、豁免 `init`、不跑任何 JS）与**其余**（一律按 ability 装载进沙箱）。
> ⚠️ **`driver` / `hook` 尚未实现** ⇒ 装载期**明确拒绝**（`PLUGIN_MANIFEST_INVALID` + `reason=unsupported-type`），
> 而不是静默按能力插件跑起来（驱动要进程内特权、协作插件是核心回调方向，两者都不该落在沙箱档）。
> 目标态：**来源只决定更新渠道与安装界面，与加载和权限无关**（见 plugin-signature-design.md）。

完整设计见 manifest-design.md，要点（与旧 schema 1 的差异）：

```json
{
  "schema": 2,
  "id": "@xfy2412/docker",
  "name": "Docker Management",
  "author": { "id": "xfy2412@market.spc.xfyweb.cn", "name": "xfy2412" },
  "version": { "code": 12, "name": "1.2.0" },
  "compat": { "minCore": "0.1.0", "targetCore": "0.3.0" },
  "runtime": { "type": "quickjs", "esm": true },
  "permissions": [ { "name": "docker.read", "reason": "列出容器与镜像" } ],
  "exports": {
    "endpoints": [ { "path": "/api/docker/containers", "permission": "docker.read" } ],
    "routes": [ { "path": "/docker", "title": "Docker", "icon": "container" } ],
    "events": {
      "publish":   [ { "topic": "backup.done", "classification": "public" } ],
      "subscribe": [ { "topic": "docker.container.crash", "mode": "notify" } ]
    }
  },
  "dependencies": { "npm": [ { "name": "zod", "version": "3.x" } ], "plugins": [] }
}
```

- `permissions` 必填（无默认放行）；
- `id` 为**市场内唯一**的发布者命名空间 `@<username>/<name>`；跨市场全局唯一性由完整引用 `<origin>/@<username>/<name>` 提供（plugin-signature-design.md §8）；
- `author.id`（可选）= `<username>@<源域名>`；填写时须与 `id` 的命名空间和源域名一致，否则 `AUTHOR_MISMATCH`；
- `dependencies.plugins[]`：`{ id, origin?, version? }`——同源依赖省略 `origin`，跨源依赖必须写明；缺少的源**不会自动添加**，只会提示管理员（plugin-signature-design.md §7.1）；
- `dependencies.npm[]`：npm 依赖**声明**（`{ name, version }`）。**没有 `tier` 字段**——依赖不分信任档（ADR-005 §7 v2）：真实闭包由**构建器**解析，构建期只做"能不能带"的能力检查，不产生任何用户放行动作（旧 `tier` 枚举与 `protectionLevel` 同因删除：判定链不读的字段不留）；
- `runtime.type`：**`quickjs`（唯一）**；ESM-only 全后端统一。⚠️ 曾经备选的 `node-child`（子进程档）**已砍**（2026-09-25 砍掉：零实现、且它不是沙箱）：它零实现，且不是沙箱（有 node API ⇒ 只能靠内核层 Landlock/seccomp 兜底，那套 Windows 上还没有）。字段保留、值域收窄（将来真要第二后端再加回一个枚举值）。

## 10. API 扩展注册点（驱动插件机制）

核心提供注册协议，让**驱动插件**（driver，核心端特权档）扩展 `@host/api`：

```
注册请求：{ capability: "db", methods: [{ name: "query", schema, permission: "db.query", intent: "none", operation: "db.query" }] }
```

- 驱动插件**不限制来源**（自建市场与官方市场等价），安装走**独立界面与最高强度提示**（ADR-005 §3）；必须：特权档（跑在核心侧/独立 Node 进程，拥有 node API，可下载自己的依赖）；
- 驱动插件向面板注册**权限节点 + API 端点**暴露给沙箱：每个注册方法进权限注册表（D4）、过威胁建模评审、随核心一起审计；
- **`operation` 名必须与 `permission` 一同登记**：核心确认窗口据此签发 grantId，`grant.operation` 校验不上就执行不了（intent-capture §8.7②）——`operation` 缺省时取 `name`，但涉及资源操作的方法**必须显式写明**（如 `docker.remove` 而非 `remove`）；
- **每个注册方法必须声明是否需要"意图确认"**（`intent: 'none' | 'confirm' | 'session'`）：
  - `none`：仅权限点（插件**自主发起**的操作）；
  - `confirm`：每次调用都需要用户在核心 UI 确认（离散写类）；
  - `session`：建立会话时确认一次并签发**绑定该会话**的 grantId（pty / SSH / DB 类），会话内敏感命令仍由核心拦截二次确认。
  核心网关据此在调用前要求对应的 grantId（校验见 intent-capture.md §4/§7）；**强制点在核心/驱动端点**——沙箱插件没有 socket，会话数据面必经核心；
- **鉴权双层**：核心网关先强制检查"调用方（沙箱内能力插件）有没有该端点权限"（D3 单一强制点不放松）；驱动插件内部再按面板给的权限列表**自行鉴权**（参数是否越界等）——驱动插件是市场严审对象，第三方安装有严厉提醒；
### 驱动插件的运行形态（2026-09-25 定案）

**进程内运行**（与核心同进程），不再有"独立 Node 进程 / 子进程档"这个选项。理由：

- **冻结表的时序要求**：驱动必须在**核心启动早期**把端点/权限点写进**冻结表**，之后（能力插件加载前）注册表冻结 ——
  跨进程调用要把注册协议搬到 IPC 上去，纯属自找麻烦（§6.0 的两阶段模型）；
- **IPC 是白加的开销**：进程内 `@host/api` 调用是 µs 级（实测纯调用开销 0.19–0.25 ms，见 `docs/module-emulation-design.md` §207 与 `tools/bridge-bench.mjs`），
  而 stdio JSON-RPC 要给每次调用加序列化 + 往返；
- 进程内还让"**驱动装/卸/禁必须重启核心**"从工程选择变成**结构性必然**（注册表在能力插件加载前冻结）—— 这反而好：
  不给"热卸载驱动"留幻想。

⚠️ **代价必须写明：驱动与核心同进程 ⇒ 它一旦作恶或被攻破，等同核心沦陷**（能读核心内存、审计日志、密钥与所有插件数据）。
**我们不提供隔离**（子进程档已砍，见 §1），补偿只有：严审（ADR-005 §3）+ 最高强度安装提示 + 权限点进冻结表 + 核心网关 D3 + 驱动自行鉴权 + 全量审计。

⚠️ **实现约束（别踩）**：驱动注册的方法会以 `HostMethod` 身份被调用 ⇒ **同步阻塞拦不住 deadline**（与 `exec.run` 的 `spawnSync` 同病：
解释器没在跑，中断处理器一次都不触发），而沙箱那三层保护（内存/栈/中断）对驱动**一概不适用**。所以：
① 驱动注册的方法**一律要求 `async`**（或至少用 `bridge.remainingMs()` 给自己的耗时封顶）；
② "驱动调用耗时"要纳入既有的**墙钟事后校验**（今天只覆盖钩子/定时器/端点）。

**生命周期（一句话）**：核心启动早期**一次注册调用**；**没有热卸载** —— 装/卸/禁一律伴随核心重启。

- 沙箱内的**能力插件**（ability）通过 `import { db } from '@host/api/db'` 调用，**与基础 API 无感知差异**。
- **命名形态**：驱动注册的 `capability` / `methods[].name` / `permission` 都是**点式**（`db` / `query` / `db.query`）——
  这正是"点式 = 核心 · 驱动 · 协作的命名空间"那一半（见 §4.0）；能力插件对这些点式名字只能申请与调用。

> 术语沿革：早期文档称驱动插件为"能力插件（特权档）"，v2 定稿后"能力插件"专指沙箱内挂载管理页面的插件（ability），核心端注册端点的插件称**驱动插件**（driver）。

## 11. 前端 API（核心 REST，P3）

**调用者只有核心前端**（浏览器里的可信 Web Shell），带 frontend-token。插件前端**不直连**这些端点（它处在 opaque origin、且 CSP 零出网），只能经 `postMessage` 由核心前端代理。完整模型见 **intent-capture.md**。

| 端点 | 作用 | 认证 |
|---|---|---|
| `POST /api/intent/grant` | 用户确认后签发 grantId（body：`audience` / `operation` / `resource`） | frontend-token |
| `POST /api/intent/revoke` | 撤销 grantId | frontend-token |
| `POST /api/intent/forward` | 插件前端 → 插件后端的意图转发（**按 manifest `intent[]` 声明校验**；违规 → `INTENT_SCHEMA_VIOLATION`） | frontend-token + `MessageChannel` 会话 |
| `POST /api/fs/{read,list,write,delete,move}`、`POST /api/session/{open,exec}` … | 核心原生能力（**核心执行，插件不参与**） | frontend-token；写类/会话类需带刚签发的 grantId |
| `GET /api/theme/active` | 当前主题令牌（核心与插件 iframe 共用同一批 CSS 变量） | frontend-token |

- **frontend-token**：绑定用户会话、只存核心前端内存、短时有效，**绝不下发给插件 iframe**；
- 插件文档的 **CSP 与 `sandbox` 属性由核心下发**（插件无法覆盖）：`default-src 'none'`、`connect-src 'none'`、`sandbox="allow-scripts"`（无 `allow-same-origin`）等，见 intent-capture.md §5/§6.1；
- 意图负载形状由 manifest `intent[]` 声明（`selection | text | enum`），**默认只给资源引用、不给内容**；要内容必须持 grantId 走沙箱 API；
- 核心可 **headless**：关闭 Web 服务后本组端点一并关闭，一切管理回到 CLI（ADR-002 v4）。

## 12. 待定项（v0.3 再议）

1. ~~事件 topic 与插件可见性（`dependencies.plugins` 显式声明）的细化授权模型~~ **已定（2026-09-22）**：订阅他人事件必须先在 `dependencies.plugins` 里声明依赖发布方；topic 枚举声明、无通配（`manifest-design.md` §6、`docs/events-and-hooks-design.md` §1.7）；
2. `@host/api` 类型声明的自动生成（从注册表生成 TS 类型，保证 IDE 体验与运行时一致）；
3. ~~驱动插件与核心的进程边界（同进程 vs 独立进程的取舍与配置）~~ **✅ 已定（2026-09-25）：进程内运行** ——
   冻结表要求驱动在能力插件加载前写完（跨进程注册协议只会自找麻烦），且 IPC 白加一层开销；
   代价（等同核心沦陷，不提供隔离）与实现约束见 **§10**；
4. QuickJS 性能 benchmark 结论对 §5 超时/并发默认值的影响；
5. **升级新增点的"提示"还没有**（2026-09-24 收敛后剩这一半）：合并白名单之后，升级新增的 `install` / `explicit` 点**都会** fail-closed 要求管理员授予（`install` 档只在首次安装播种一次）——**安全的那一半已经有了**；缺的是**主动性**：新增点不会摆到管理员眼前，只会以插件调用时的 `NOT_GRANTED` 形式出现。要补的是"比对上一版声明的点集合 + 把新增项列出来"（落点：`manager.install` / `reload` 的声明集差分 + 审计 + CLI/面板提示）；
6. **授权/撤回对运行中的插件不立即生效**（已知并有提示）：沙箱持有的是**装载时**的 `permissions` / `grants` 快照，改动只置 `needsReload` 并打印"需 reload 后生效"。**要不要让 `revoke` 立刻生效**（例如撤回时自动 reload，或把授权改成每次调用都查活记录）留待 P2 收口时定 —— 今天的选择是"不自动重启插件"；
7. **默认安全边界（已定，见 intent-capture §7/§8）**：确认判据 = ①意图经不可信方转述 或 ②点击时后果不可见；四档 L0–L3；权限点 `grant` 三档 `auto`/`install`/`explicit`；仅 `explicit` 需逐点授予。落地在 P2（`core/permissions/` 加 `grant` 字段 + 判定链第 3 步）与 P3（前端确认 UI）。
