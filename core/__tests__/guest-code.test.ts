// 两块 guest 代码抽成真文件后的「存在 + 有料」守卫（2026-09-25）
//
// 为什么要有这条：`core/guest/*.js` 是**跑在 VM 里的 guest 代码**（由 `core/sandbox.ts` 读成字符串求值），
// **不进 tsc** —— 文件被误删 / 改名 / 清空时，只有真沙箱用例会以"钩子失败 / PLUGIN_*"的样子炸，
// 根因不好定位。这条直接把"文件在、关键符号在、形态没被搬错"钉在测试层。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(`../guest/${rel}`, import.meta.url), 'utf8');

test('core/guest/bootstrap.js：存在、非空、含全部引导函数', () => {
  const s = read('bootstrap.js');
  assert.ok(s.length > 1000, `引导层不该这么短（${s.length} 字节）—— 是不是被清空了？`);
  for (const sym of [
    '__spcMakeCtx',
    '__spcInvoke',
    '__spcInvokeEndpoint',
    '__spcTimerInvoke',
    '__spcTimerCallbacks',
    '__spcDisposeHooks',
    '__spcRunDisposeHooks',
    'queueMicrotask',
  ]) {
    assert.ok(s.includes(sym), `引导层缺符号：${sym}`);
  }
});

test('core/guest/node-globals.js：含 Node 全局；**win32 分隔符是求值后的单反斜杠形态**', () => {
  const s = read('node-globals.js');
  for (const sym of [
    'globalThis.process = process',
    'globalThis.Buffer = Buffer',
    'globalThis.URL = URL',
    'globalThis.TextEncoder = TextEncoder',
    'globalThis.crypto = nodeCrypto.webcrypto',
    'globalThis.global = globalThis',
    'export const __filename',
    'export const __dirname',
  ]) {
    assert.ok(s.includes(sym), `Node 全局缺：${sym}`);
  }
  // ⚠️ 这条是**抽取时踩到的坑**的回归守卫：原来在模板字面量里写的是 `'\\\\'`（求值后是 `'\\'`），
  //    若把**源码原文**照搬进 .js，guest 就会拿到两个反斜杠 ⇒ win32 上 `__filename` 的形态错。
  //    文件里必须是 `? '\\' : '/'`（两个反斜杠字符 = guest 解析成一个）。
  assert.ok(
    s.includes(`? '\\\\' : '/'`),
    'win32 分隔符不是求值后的形态（应当是 ? \'\\\\\' : \'/\'）—— 检查搬文件时是不是照抄了源码原文',
  );
});
