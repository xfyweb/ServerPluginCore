// 回归测试：验证 quickjs-emscripten@0.32.0 asyncify 变体的 pnpm 补丁是否生效
//
// 背景：quickjs-emscripten-core@0.32.0 的 asyncify 变体（module-asyncify.ts）
// 在 newRuntime 的释放回调里把顺序写反了：
//   deleteRuntime(rt_ptr) → QTS_FreeRuntime(rt_ptr)   （错误）
// 而 sync 变体（module.ts）是正确的：
//   QTS_FreeRuntime(rt_ptr) → deleteRuntime(rt_ptr)   （注释：Free runtime first -
//   this runs GC finalizers that may call back into JS）
//
// 后果：QTS_FreeRuntime 内部 GC 会 finalize 宿主函数对象并触发 freeHostRef 回调，
// 但 asyncify 变体此时已把 runtime 回调注册表删除 → 抛
// "QuickJSRuntime not found when trying to free HostRef" / 断言崩溃。
//
// 修复：patches/quickjs-emscripten-core.patch（pnpm patch 持久化）。
// 上游确认：Issue #261（justjake/quickjs-emscripten，OPEN，2026-04-27 创建，多人受影响）：
//   https://github.com/justjake/quickjs-emscripten/issues/261
// 另注意：同一断言（gc_obj_list）在 Issue #269/#235 有不同触发路径（promise job + 大量对象，
// 无宿主函数）——未来 async 宿主函数 + Promise 场景需关注。
// 本脚本：若补丁失效（如 pnpm 重装后未应用），用例 4/5/D/E 将 FAIL 并以非零码退出。
//
// 运行：pnpm verify:sandbox

import { newQuickJSAsyncWASMModule, Scope } from 'quickjs-emscripten';

let failed = 0;
const results = [];

async function run(label, fn) {
  try {
    const QuickJS = await newQuickJSAsyncWASMModule();
    const runtime = QuickJS.newRuntime();
    const vm = runtime.newContext();
    await fn(runtime, vm);
    vm.dispose();
    runtime.dispose();
    results.push(`PASS: ${label}`);
  } catch (e) {
    failed++;
    results.push(`FAIL: ${label} -> ${String((e && e.message) || e).slice(0, 110)}`);
  }
}

// 0. 基线：空 context
await run('0 empty', async (_rt, _vm) => {});

// 1. setModuleLoader 但无 import
await run('1 loader-only', async (rt, _vm) => {
  rt.setModuleLoader((n) => `export default '${n}'`);
});

// 2. evalCode 纯表达式（无 import）
await run('2 evalCode-plain', async (_rt, vm) => {
  const r = await vm.evalCodeAsync('1 + 1');
  r?.dispose?.();
});

// 3. evalCode + import（loader 返回源码）——模块路径
await run('3 evalCode-import', async (rt, vm) => {
  rt.setModuleLoader((n) => `export const write = () => 'ok';`);
  const r = await vm.evalCodeAsync(`import { write } from '@host/api'; write();`);
  r?.dispose?.();
});

// 4. 宿主函数 + setProp + 调用（模拟真实 @host/api 注入）
await run('4 host-fn-call', async (rt, vm) => {
  rt.setModuleLoader((n) => `export const write = globalThis.__host['write'];`);
  const scope = new Scope();
  const hostObj = scope.manage(vm.newObject());
  const wrapped = scope.manage(vm.newFunction('write', () => vm.newString('"ok"')));
  vm.setProp(hostObj, 'write', wrapped);
  vm.setProp(vm.global, '__host', hostObj);
  const r = await vm.evalCodeAsync(`import { write } from '@host/api'; write();`);
  r?.dispose?.();
  scope.dispose();
});

// 5. 宿主函数多次调用（返回值 handle 路径）
await run('5 host-return-leak', async (rt, vm) => {
  rt.setModuleLoader((n) => `export const ping = globalThis.__host['ping'];`);
  const scope = new Scope();
  const hostObj = scope.manage(vm.newObject());
  const wrapped = scope.manage(
    vm.newFunction('ping', () => vm.newString(JSON.stringify({ ok: true }))),
  );
  vm.setProp(hostObj, 'ping', wrapped);
  vm.setProp(vm.global, '__host', hostObj);
  const r = await vm.evalCodeAsync(`import { ping } from '@host/api'; ping(); ping();`);
  r?.dispose?.();
  scope.dispose();
});

// D. 宿主函数创建 + setProp + 立即手动 dispose handle（不调用）
await run('D create-dispose-nocall', async (rt, vm) => {
  rt.setModuleLoader((n) => `export const ping = globalThis.__host['ping'];`);
  const hostObj = vm.newObject();
  const wrapped = vm.newFunction('ping', () => vm.undefined);
  vm.setProp(hostObj, 'ping', wrapped);
  wrapped.dispose();
  vm.setProp(vm.global, '__host', hostObj);
  hostObj.dispose();
});

// F. 仅创建宿主函数并 dispose（不 setProp）——区分"函数本身"与"注入链"
await run('F fn-only', async (_rt, vm) => {
  const wrapped = vm.newFunction('ping', () => vm.undefined);
  wrapped.dispose();
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);

if (failed > 0) {
  console.error(
    '\n[回归失败] 宿主函数相关用例 FAIL——quickjs-emscripten-core 补丁可能未生效。\n' +
      '检查：pnpm-workspace.yaml 的 patchedDependencies 与 patches/quickjs-emscripten-core.patch\n' +
      '修复：pnpm install 重新应用补丁',
  );
  process.exit(1);
} else {
  console.log('[OK] quickjs-emscripten asyncify 释放顺序补丁生效，宿主函数无泄漏。');
}
