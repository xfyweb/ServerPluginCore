// `parseArgs` 的用例：这条解析器被**所有**管理面动词共用，它静默吃掉一个旗标就是全局的坑。
// 2026-10-14 修的那条：以前只认 `--` 前缀 ⇒ `-n 5` 掉进位置参数、被**静默忽略**
// （`spc audit tail -n 5` 打出默认 50 条，看着"能用"其实没生效）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseArgs } = await import('../cli.ts');

test('长旗标：`--flag value` 取值；布尔旗标后面**别跟裸词**（会被当值收走）', () => {
  const a = parseArgs(['--plugin', '@a/b', 'pos1', '--json']);
  assert.deepEqual(a.positional, ['pos1'], '位置参数放前面');
  assert.equal(a.flags.get('--plugin'), '@a/b');
  assert.equal(a.flags.get('--json'), '', '跟的是另一个旗标 ⇒ 算布尔');
  // 既有规则（不是本次改动引入的）：`--flag` 后面第一个**不以 `--` 开头**的 token 会被当它的值，
  // 所以布尔旗标要放在位置参数后面（`spc plugin list --json` 这种用法天然满足）。
  assert.equal(parseArgs(['--json', 'pos1']).flags.get('--json'), 'pos1');
});

test('短旗标：`-n 5` 必须真取到值（静默忽略是这类解析器最坏的失败方式）', () => {
  const a = parseArgs(['-n', '5', '--method', 'kv.get']);
  assert.deepEqual(a.positional, [], '-n 与它的值都不该落到位置参数里');
  assert.equal(a.flags.get('-n'), '5');
  assert.equal(a.flags.get('--method'), 'kv.get');
});

test('单个 `-` 仍是位置参数（"从 stdin 读"的约定写法）', () => {
  const a = parseArgs(['-', 'x']);
  assert.deepEqual(a.positional, ['-', 'x']);
  assert.equal(a.flags.size, 0);
});

test('负数的值与"下一个是旗标"两种情况分开处理', () => {
  const a = parseArgs(['--since', '12', '--limit']);
  assert.equal(a.flags.get('--since'), '12');
  assert.equal(a.flags.get('--limit'), '', '后面没有值时算布尔，而不是把下一个旗标当值');
  const b = parseArgs(['--since', '-1']);
  assert.equal(b.flags.get('--since'), '-1', '以 - 开头的值照收（不是旗标就照原样取）');
});
