// 校验生成的 node-constants.js：逐键等于 Linux 真值 dump，且 default 与具名导出一致、已冻结。
import { readFileSync } from 'node:fs';
import { SANDBOX_MODULES, TRUTH_DATA } from '../paths.mjs';
const shimPath = SANDBOX_MODULES + '/node-constants.js';
const src = readFileSync(shimPath, 'utf8');
const shim = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
const d = JSON.parse(readFileSync(TRUTH_DATA + '/const-linux.json', 'utf8'));

const flat = new Map();
for (const obj of [d.os.dlopen ?? {}, d.os.errno ?? {}, d.os.priority ?? {}, d.os.signals ?? {}, d.fs, d.crypto]) {
  for (const [k, v] of Object.entries(obj)) flat.set(k, v);
}
const problems = [];
for (const [k, v] of flat) {
  if (shim.default[k] !== v) problems.push(`default.${k}=${shim.default[k]} 应为 ${v}`);
  if (shim[k] !== v) problems.push(`具名 ${k}=${shim[k]} 应为 ${v}`);
}
const extra = Object.keys(shim.default).filter((k) => !flat.has(k));
console.log(`dump ${flat.size} 键 / shim ${Object.keys(shim.default).length} 键 / 具名导出 ${Object.keys(shim).filter((k) => k !== 'default').length} 个`);
console.log('逐键不一致:', problems.length ? problems : '无');
console.log('多出来的键:', extra.length ? extra : '无');
console.log('default 冻结:', Object.isFrozen(shim.default));
console.log('DELETE O_SYMLINK 存在?', 'O_SYMLINK' in shim.default);
process.exit(problems.length || extra.length ? 1 : 0);
