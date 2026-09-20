// 在**真 Windows node v22.22.1** 上跑：把 path.win32 的逐条结果 dump 成 JSON（判卷人一侧）
//
// 用法：
//   & $env:SPC_JUDGE_NODE  tools/truth/path-win32-cases-win.mjs
//
// 输入是 `_audit/tools/truth/path-win32-cases.mjs` 里的**同一组**用例；两边各跑一遍，再逐条比。
// cwd 依赖：为了让结果与机器无关，脚本把 cwd 固定成三个**真实存在**的目录再采样
// （`path.win32.resolve` 无参/单相对参数时读 cwd，这一部分与 cwd 强相关，必须真跑）。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { TRUTH_DATA, fileUrl } from '../paths.mjs';

process.chdir('C:\\Windows');
const cases = (await import(fileUrl(import.meta.dirname + '/path-win32-cases.mjs'))).default;
/**
 * 每个用例在固定 cwd 下的结果。
 *
 * ⚠️ 两个关键点：
 *   1. `path.win32.resolve` 的输出**只依赖传入的 cwd 字符串**（`resolve()` 无参时直接回 `process.cwd()`；
 *      有相对参数时拼在它后面），所以每个 cwd 情形都要 `chdir` 后**重采样**；
 *   2. **采样用的 cwd 字符串必须是沙箱形态**（`C:/Windows`，正斜杠）——因为沙箱给 `path` 的 cwd
 *      来自 `__spcEnv.dataDir`（由 `buildEnvFacts` 归一化成正斜杠）。用 `C:\Windows` 采集、
 *      拿 `C:/Windows` 比对会得到一堆假的"分歧"（第一版就这么错了 27 条）。
 *      `resolve` 两种分隔符都认，所以**用哪种形态采集，输出就按哪种形态**——两边必须一致。
 */
const CWD_STRINGS = ['C:/Windows', 'C:/Windows/System32', 'D:/'];
const results = [];
for (const c of cases) {
  const row = { id: c.id };
  for (const cwd of CWD_STRINGS) {
    process.chdir(cwd.split('/').join('\\'));
    row[cwd] = path.win32[c.fn](...c.args);
  }
  results.push(row);
}
// 采 Windows 的"每盘 cwd"（`process.env['=C:']`）——沙箱侧靠它复现"盘符相对路径"的解析
const driveCwds = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.length === 2 && k[0] === '=' && typeof v === 'string' && v.length > 0) {
    driveCwds[k.slice(1).toUpperCase() + ':'] = v.split('\\').join('/');
  }
}
process.chdir('C:\\Windows');
writeFileSync(
  TRUTH_DATA + '/path-win32-truth.json',
  JSON.stringify(
    { meta: { node: process.version, platform: process.platform, cwds: CWD_STRINGS, driveCwds }, results },
    null,
    1,
  ),
);
console.log('ok', process.version, results.length, 'cases x', CWD_STRINGS.length, 'cwds', '| driveCwds', JSON.stringify(driveCwds));
