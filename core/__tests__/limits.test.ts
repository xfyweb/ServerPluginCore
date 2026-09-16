// 限额装配的纯逻辑测试（docs/plugin-lifecycle-design.md §4）
//
// 这里只测**不需要起沙箱**的部分：deadline 的"剩余预算"读数。
// 为什么它值得单测：CPU 中断只能打断解释器，插件一进宿主方法（`spawnSync`）解释器就停了，
// 中断处理器一次都不会被调用 —— 于是"还剩多少预算"成了宿主方法唯一能自救的依据
// （exec 用它给 spawnSync 的 timeout 封顶）。符号写反（超时返回负数）就是 fail-open。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QuickJSRuntime } from 'quickjs-emscripten';
import { installDeadlineHandler } from '../plugin/limits';

/** 只要有 `setInterruptHandler` 就够：本文件测的是 deadline 读数，不测中断真的会不会触发 */
function fakeRuntime(): QuickJSRuntime {
  return { setInterruptHandler: () => {} } as unknown as QuickJSRuntime;
}

test('无阶段在跑（deadline=∞）→ remainingMs 是 Infinity（不参与封顶）', () => {
  const d = installDeadlineHandler(fakeRuntime());
  assert.equal(d.remainingMs(), Number.POSITIVE_INFINITY);
});

test('设了 deadline → remainingMs 落在 (0, 预算] 内；复位后回到 Infinity', () => {
  const d = installDeadlineHandler(fakeRuntime());
  d.setDeadline(Date.now() + 1_000);
  const left = d.remainingMs();
  assert.ok(left > 0 && left <= 1_000, `remainingMs=${left}`);
  d.setDeadline(Number.POSITIVE_INFINITY);
  assert.equal(d.remainingMs(), Number.POSITIVE_INFINITY);
});

test('**已超时不返回负数**（返回负数的调用方会把它当"还有很久"→ fail-open）', () => {
  const d = installDeadlineHandler(fakeRuntime());
  d.setDeadline(Date.now() - 5_000);
  assert.equal(d.remainingMs(), 0);
});
