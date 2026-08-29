# Spike 记录：QuickJS 沙箱可行性验证

- 日期：2026-08
- 状态：验证完成，结论已纳入架构

## 1. 目标

在写任何正式代码之前，用最小切片验证核心链路：

> **核心加载插件 → QuickJS 沙箱 → 注入 `@host/api` → 插件调用宿主函数 → 宿主落盘**

验证点：
1. QuickJS（WASM 版）的 ESM 模块加载是否可用；
2. 宿主 API 注入闭环（沙箱 ↔ 宿主函数 ↔ Node fs）；
3. "零环境权力"（白名单外模块一律拒绝）；
4. 资源释放（dispose 无泄漏/无断言）。

## 2. 结果

链路全部打通：

```
$ pnpm spike
[plugin] write result: {"ok":true,"path":"C:\\Users\\Administrator\\test.txt","bytes":10}
[core] plugin "official:sample" executed.
---file---
HelloWorld
```

- 插件（ESM）在 QuickJS 沙箱内执行，`import { write } from '@host/api'` 经 `runtime.setModuleLoader` 解析；
- 宿主函数写入 `~/test.txt`，内容 `HelloWorld`；
- 最终形态采用 **asyncify 变体**（宿主 API 可返回 Promise，exec/网络必须异步）。

## 3. 踩坑记录（P1 参考）

| # | 坑 | 解决 |
|---|---|---|
| 1 | quickjs-emscripten **v0.32 API 大改**：旧教程的 `newModule`/`setModuleResolveHandler` 已不存在 | 模块系统移到 **Runtime 层**：`runtime.setModuleLoader(loader)`（loader 返回**模块源码字符串**），执行用 `context.evalCode` |
| 2 | asyncify 变体 dispose 断言（`list_empty(&rt->gc_obj_list)`） | **上游 bug**，见下节 |
| 3 | handle 生命周期：宿主创建的 handle 需 `Scope` 管理；`evalCodeAsync` 返回 `SuccessOrFail`，需 `isSuccess` 后释放 `value` | 见 `core/sandbox.ts` |

## 4. 上游 Bug：quickjs-emscripten#261（重要）

### 现象

asyncify 变体在 `runtime.dispose()` 时崩溃：

```
QuickJSRuntime(rt = ...) not found when trying to free HostRef(id = -2147483648)
// 或：Aborted(Assertion failed: list_empty(&rt->gc_obj_list), quickjs.c JS_FreeRuntime)
```

只要沙箱里创建过宿主函数（`newFunction`），释放必崩。

### 根因（源码对比定位）

`newRuntime` 的释放回调顺序，两个变体不一致：

| 变体 | 顺序 | 结果 |
|---|---|---|
| sync（module.ts） | `QTS_FreeRuntime()` **先** → `deleteRuntime()` **后** | 正常（注释明说："Free runtime first - this runs GC finalizers that may call back into JS"） |
| asyncify（module-asyncify.ts） | `deleteRuntime()` **先** → `QTS_FreeRuntime()` **后** | **写反了** |

机制：`QTS_FreeRuntime` 内部 GC 会 finalize 残留对象（含宿主函数），触发 `freeHostRef` 回调查 `runtimeCallbacks` 表——asyncify 变体先把表删了，回调必然扑空。

### 上游状态

- [Issue #261](https://github.com/justjake/quickjs-emscripten/issues/261)：OPEN（2026-04 创建），多人受影响，**无修复 PR、无维护者回复**；
- 同断言另有 [Issue #269](https://github.com/justjake/quickjs-emscripten/issues/269) / [#235](https://github.com/justjake/quickjs-emscripten/issues/235)（promise job + 大量对象的另一触发路径，未来 async 场景需关注）；
- 上游维护不活跃（0.32.0 为 latest）→ **本地补丁是唯一可靠方案**。

### 本地修复（pnpm patch）

```
patches/quickjs-emscripten-core.patch   # 两行顺序交换，与 sync 变体对齐
pnpm-workspace.yaml → patchedDependencies   # 声明补丁
pnpm-lock.yaml → patch_hash                 # 锁定补丁版本
```

**克隆可移植性已实测**：全新目录 + `pnpm install --frozen-lockfile` → `pnpm verify:sandbox` 8/8 PASS——其他开发者克隆后补丁自动应用。

### 回归测试

```
pnpm verify:sandbox   # scripts/verify-quickjs-patch.mjs
```

8 个用例（基线/loader/纯表达式/import/宿主函数/返回值路径/手动释放/仅创建），**补丁失效时 FAIL 并以非零码退出**。升级 quickjs-emscripten 前必须跑。

## 5. 对 P1 的启示

1. **asyncify 变体为默认**（sync 仅是演示）——宿主 API 统一 async 设计；
2. **pnpm 为唯一包管理器**（patchedDependencies 依赖 pnpm）；
3. **依赖升级策略**：版本锁定 + `verify:sandbox` 回归前置；
4. 安全语义已验证：`setModuleLoader` 白名单外模块抛错（零环境权力的执行点），正式版在此之上叠加权限注册表与审计（见 ADR-005、interface-audit-exec-fs.md）。

## 6. 文件清单

```
core/main.ts                          # 入口：加载插件 → 建沙箱 → 执行
core/sandbox.ts                       # QuickJS 沙箱封装（asyncify + @host/api 注入）
core/hostApi.ts                       # 宿主 API（spike：无鉴权 fs.write）
plugin/sample/{manifest.json, main.ts}# 样板插件（ESM）
scripts/verify-quickjs-patch.mjs      # 补丁回归测试
patches/quickjs-emscripten-core.patch # 上游 bug 补丁（随仓库提交）
```
