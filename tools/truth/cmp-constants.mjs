// 对比 Windows 与 Linux 的常量表（逐键）：哪些键只在一边有、哪些值不同
//
// 输入：`tools/truth/data/const-win.json`（Windows 侧真值，2026-09-27 重采于 v24.20.0）+ `tools/truth/data/const-linux.json`（Linux 侧真值，2026-09-27 重采于 v24.20.0）
import { readFileSync } from 'node:fs';
import { TRUTH_DATA } from '../paths.mjs';

const win = JSON.parse(readFileSync(TRUTH_DATA + '/const-win.json', 'utf8'));
const lin = JSON.parse(readFileSync(TRUTH_DATA + '/const-linux.json', 'utf8'));

/** 顶层 `node:constants` = fs.constants + os.constants.{errno,signals,priority,dlopen} + crypto.constants */
function topLevel(d) {
  return Object.fromEntries([
    ...Object.entries(d.fs),
    ...Object.entries(d.os.errno ?? {}),
    ...Object.entries(d.os.signals ?? {}),
    ...Object.entries(d.os.priority ?? {}),
    ...Object.entries(d.os.dlopen ?? {}),
    ...Object.entries(d.crypto),
  ]);
}

const w = topLevel(win);
const l = topLevel(lin);
const wKeys = new Set(Object.keys(w));
const lKeys = new Set(Object.keys(l));

const onlyWin = [...wKeys].filter((k) => !lKeys.has(k)).sort();
const onlyLin = [...lKeys].filter((k) => !wKeys.has(k)).sort();
const differing = [...wKeys].filter((k) => lKeys.has(k) && w[k] !== l[k]).sort();

console.log(`顶层键数： win=${wKeys.size}  linux=${lKeys.size}`);
console.log(`\n只在 Windows 有（${onlyWin.length}）：\n  ${onlyWin.join(' ')}`);
console.log(`\n只在 Linux 有（${onlyLin.length}）：\n  ${onlyLin.join(' ')}`);
console.log(`\n同名不同值（${differing.length}）—— 这些就是"必须按平台选表"的硬证据：`);
for (const k of differing.slice(0, 40)) console.log(`  ${k}: win=${w[k]} linux=${l[k]}`);
if (differing.length > 40) console.log(`  … 还有 ${differing.length - 40} 条`);

console.log('\n分组大小对比：');
for (const g of ['errno', 'signals', 'priority', 'dlopen']) {
  console.log(`  ${g}: win=${Object.keys(win.os[g] ?? {}).length} linux=${Object.keys(lin.os[g] ?? {}).length}`);
}
console.log(`  fs: win=${Object.keys(win.fs).length} linux=${Object.keys(lin.fs).length}`);
console.log(`  crypto: win=${Object.keys(win.crypto).length} linux=${Object.keys(lin.crypto).length}`);

console.log('\n平台事实：');
console.log('  win  ', JSON.stringify(win.facts));
