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
import { spawnSync } from 'node:child_process';

// ── S8：内存增长后收尾（上游 #269）+ asyncify newContext 的包装语义 ──────────────
// 为什么单独开子进程：命中的后果是 **WASM abort（不可 catch）**，会把本脚本一起打死，
// 于是后面的用例与汇总全都看不到 —— 那不是"测试失败"，是"报告消失"，最难查。
// 子进程做两件事：
//   ① B：`newContext({ contextPointer })` 必须**包装**传入的指针，而不是新建一个 context。
//      没修时 exit 3 立刻返回（不必等收尾 abort），诊断清楚。
//   ② A：promise job 里分配 200k 个对象，让 WASM 内存在这**一次**调用里增长
//      （≈16 MiB → 23 MiB），然后收尾。没修时 out 参数的视图已 detach，
//      `ctxPtr` 读成 undefined ⇒ 凭空 newContext 一个没人释放的 context ⇒ 收尾断言 abort。
const S8_CHILD = `
const { newQuickJSAsyncWASMModule } = await import(process.env.SPC_VERIFY_ENGINE);
const QuickJS = await newQuickJSAsyncWASMModule();
const rt = QuickJS.newRuntime();
const vm = rt.newContext();

// ① B：包装语义（注意**不要** dispose wrapped：它不拥有那个 context）
const wrapped = rt.newContext({ contextPointer: vm.ctx.value });
if (wrapped.ctx.value !== vm.ctx.value) {
  console.error('B 未生效：newContext({contextPointer}) 新建了 context '
    + wrapped.ctx.value + ' ≠ ' + vm.ctx.value);
  process.exit(3);
}

// ② A：同一个 promise job 里大量分配 + 收尾
rt.setMemoryLimit(32 * 1024 * 1024);
rt.setMaxStackSize(512 * 1024);
// ⚠️ 必须 dispose 返回值：漏掉它 = 留一个未释放的 handle ⇒ 那个 promise 一直活着 ⇒
//    收尾断言照样 abort（**另一种原因**，与本用例要测的 A 无关）。
//    本文件第一版就漏了这行，于是把"脚本自己的泄漏"误报成了"补丁不完整"。
const r = vm.evalCode('Promise.resolve().then(() => { const a = []; for (let i = 0; i < 200000; i++) a.push({ i }); })');
if (r.error) { r.error.dispose(); } else { r.value.dispose(); }
rt.executePendingJobs();
vm.dispose();
rt.dispose();
console.log('S8_CLEAN_TEARDOWN');
`;

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

// S8. 内存增长后收尾 + newContext 包装（子进程；见文件头的 S8_CHILD 说明）
{
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', S8_CHILD], {
    env: { ...process.env, SPC_VERIFY_ENGINE: import.meta.resolve('quickjs-emscripten') },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const out = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  if (child.status === 0 && out.includes('S8_CLEAN_TEARDOWN')) {
    results.push('PASS: S8 gc-teardown (+ newContext 包装)');
  } else {
    failed++;
    const why =
      child.status === 3
        ? 'B 未生效：asyncify 的 newContext 没包装 contextPointer'
        : out.includes('Assertion failed')
          ? 'WASM abort：内存增长后读 out 参数读到 undefined（上游 #269）'
          : `子进程异常退出 status=${child.status} signal=${child.signal ?? '-'}`;
    results.push(`FAIL: S8 gc-teardown -> ${why}`);
    console.error(
      '[S8 诊断] 子进程尾部输出：\n' +
        out
          .split('\n')
          .filter((l) => l.trim() !== '')
          .slice(-6)
          .join('\n'),
    );
  }
}

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);

if (failed > 0) {
  console.error(
    '\n[回归失败] 用例 FAIL——quickjs-emscripten-core 补丁可能未生效。\n' +
      '检查：pnpm-workspace.yaml 的 patchedDependencies 与 patches/quickjs-emscripten-core.patch\n' +
      '修复：pnpm install 重新应用补丁\n' +
      '（补丁现含三条：#256 释放顺序 / A=executePendingJobs 的 out 参数从当前堆重读 / ' +
      'B=asyncify newContext 尊重 contextPointer；见 patches/ 与该文件头注释）',
  );
  process.exit(1);
} else {
  console.log('[OK] quickjs-emscripten-core 补丁生效：释放顺序（#256）、内存增长后收尾（#269/A）、'
    + 'newContext 包装（B）与宿主函数无泄漏均通过。');
}
