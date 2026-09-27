// ⛔ **一次性接线脚本 —— 已执行完毕，别再跑**（跑它只会打印一行提示并以 1 退出）。
//
// 它当时做了四件事，**现在都已经在文件里**（这段注释就是它留下的记录 ——
// 看代码能看到"结果"，看不到"当时要动的是哪三处"）：
//   ① 把 zlib 两张表填进 `core/sandbox-modules/node-zlib.js` 的占位符 `/*__ZLIB_TABLES__*/`
//      ⇒ 那个占位符**早已不存在**；表现在由 `tools/truth/gen-zlib-tables2.mjs` 写进生成区间（**可反复重跑**）；
//   ② `core/permissions/registry.ts`：注册 `zlib.compress` / `zlib.decompress` 两个权限点；
//   ③ `core/sandbox-modules/registry.ts`：登记 `canonical: 'zlib'` 的模块条目；
//   ④ `core/sandbox.ts`：JSON 结果组的 `Set` 里加 `'zlib'`。
//
// 为什么不能再跑：它按**字符串替换**改那三个文件，第二遍必然找不到锚点、或者重复插入。
// 为什么留档而不删：②③④ 是"zlib 要在哪几处登记"的清单，删了就只剩结果、没有清单。
console.error(
  'wire-zlib.mjs 是一次性接线脚本，已执行完毕（四件事见文件头注释）。' +
    '要更新 zlib 表请跑：node tools/truth/gen-zlib-tables2.mjs',
);
process.exit(1);
