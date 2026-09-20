// `path.win32` 差分：把沙箱 shim 的结果与**真 Windows node v22.22.1** 的真值逐条比。
//
// 用法：
//   & "D:\git-repo\_tools\node-v22.22.1-win-x64\node.exe" D:\git-repo\_audit\tools\truth\path-win32-cases-win.mjs   # 采真值
//   node D:\git-repo\_audit\tools\truth\path-win32-diff.mjs                                                        # 差分
//
// ⚠️ **两条 harness 纪律**（都是本轮踩出来的）：
//   1. 模块实例**只在第一次调用时读 cwd**（`cwd()` 缓存在模块作用域）。所以"先建 3 个实例、再统一断言"
//      是错的——断言时 `__spcEnv` 只剩最后一个值，于是三条 cwd 的断言全跑在同一个 cwd 上
//      （症状：27 条假分歧，全是"期望 C:\Windows、实际 D:\"）。
//   2. 反过来，"每个用例重新 import 模块"也**不需要**：`node-path-win32.js` 是**单实例**
//      （`node-path.js?x=1` 与 `?x=2` 共享它），所以它自己从 `__spcEnv` 现读 cwd。
//      正确做法：**import 一次，每个用例前设好 `__spcEnv`**。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TRUTH_DATA, SANDBOX_MODULES, fileUrl } from '../paths.mjs';

const truth = JSON.parse(readFileSync(TRUTH_DATA + '/path-win32-truth.json', 'utf8'));
const cases = (await import(pathToFileURL(import.meta.dirname + '/path-win32-cases.mjs').href)).default;

// 平台由 `__spcEnv.platform` 决定；cwd 由 `__spcEnv.dataDir` 决定（每个用例前重设）；
// `driveCwds` 是"每盘 cwd"（`process.env['=C:']` 那套，见 emulated-env.ts）
const DRIVE_CWDS = truth.meta.driveCwds ?? {};
const envFor = (cwd) => JSON.stringify({ platform: 'win32', dataDir: cwd, driveCwds: DRIVE_CWDS });
globalThis.__spcEnv = envFor(truth.meta.cwds[0]);
const shim = await import(pathToFileURL(SANDBOX_MODULES + '/node-path.js').href);
const win32 = shim.win32;

/**
 * **已知边界**（显式记账，不是"看不见的红灯"）：Windows 的"每盘一个 cwd"沙箱复现不了。
 *
 * `path.resolve` 在**原生层**读 `process.env['=C:']`（每盘上一次 chdir 的结果），
 * 而 Node 把这类 `=X:` 变量从 **JS 可见的** `process.env` 里过滤掉了
 * （实测：`Object.entries(process.env)` 里没有它们，所以环matter事实里也带不出来）。
 * ⇒ 唯一分歧面：**在 A 盘下解析 B 盘的"盘符相对"路径**（如 `cwd=D:\` 时 `resolve('C:a')`）。
 * 沙箱退到该盘根（`C:\a`），Windows 给"该盘上次所在的目录"（`C:\Windows\System32\a`）。
 *
 * 这份清单是**唯一允许的分歧**：出现清单外的分歧就退出码 1（防止"顺手放宽"）。
 */
const KNOWN_DIVERGENCES = new Set([
  'resolve.drive-only|D:/',
  'resolve.drive-rel|D:/',
  'resolve.reserved-drive|D:/',
]);

let pass = 0;
const diffs = [];
const known = [];
for (const row of truth.results) {
  const c = cases.find((x) => x.id === row.id);
  for (const cwd of truth.meta.cwds) {
    // 每个用例前把 cwd 设回去（这就是上面纪律 1 的落点）
    globalThis.__spcEnv = envFor(cwd);
    const expected = row[cwd];
    let actual;
    let threw = null;
    try {
      actual = win32[c.fn](...c.args);
    } catch (e) {
      threw = e.code || e.message;
    }
    if (threw === null && JSON.stringify(actual) === JSON.stringify(expected)) {
      pass++;
    } else if (KNOWN_DIVERGENCES.has(`${row.id}|${cwd}`)) {
      known.push({ id: row.id, cwd, expected, actual });
    } else {
      diffs.push({ id: row.id, cwd, fn: c.fn, args: c.args, expected, actual, threw });
    }
  }
}

const total = truth.results.length * truth.meta.cwds.length;
console.log(
  `path.win32 差分（判卷人：node ${truth.meta.node} / ${truth.meta.platform}）：` +
    `${pass}/${total} 一致，${known.length} 条已知边界，${diffs.length} 条未预期分歧`,
);
if (known.length > 0) {
  console.log('\n已知边界（每盘 cwd，见本文件顶部说明）：');
  for (const k of known) {
    console.log(`  ~ ${k.id} [cwd=${k.cwd}] 期望 ${JSON.stringify(k.expected)} / 实际 ${JSON.stringify(k.actual)}`);
  }
}
if (diffs.length > 0) {
  console.log(`\n分歧 ${diffs.length} 条：`);
  for (const d of diffs.slice(0, 40)) {
    console.log(`  ✗ ${d.id} [cwd=${d.cwd}] ${d.fn}(${d.args.map((a) => JSON.stringify(a)).join(', ')})`);
    console.log(`      期望 ${JSON.stringify(d.expected)}`);
    console.log(`      实际 ${d.threw ? 'THROW ' + d.threw : JSON.stringify(d.actual)}`);
  }
  if (diffs.length > 40) console.log(`  … 还有 ${diffs.length - 40} 条`);
}
process.exit(diffs.length === 0 ? 0 : 1);
