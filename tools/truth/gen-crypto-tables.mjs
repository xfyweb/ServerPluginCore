// 从 crypto 的两份真值生成 node-crypto.js 要嵌入的静态表（getHashes/getCiphers/getCurves/constants）
//   用法：node _audit/tools/truth/gen-crypto-tables.mjs > _audit/data/crypto-tables.txt
// 取值取向：**固定 22.22.1 基线**（与 path=posix、constants=Linux、os 三分法一致）——
// 这几个清单是宿主 OpenSSL 的真相，开发机与生产机可能不同，所以按仿真版本钉死。
import { readFileSync } from 'node:fs';
import { TRUTH_DATA } from '../paths.mjs';

const t1 = JSON.parse(readFileSync(TRUTH_DATA + '/crypto-truth.json', 'utf8'));
const t2 = JSON.parse(readFileSync(TRUTH_DATA + '/crypto-truth2.json', 'utf8'));

const arr = (name, list) => {
  const lines = [`const ${name} = Object.freeze([`];
  for (let i = 0; i < list.length; i += 4) {
    lines.push('  ' + list.slice(i, i + 4).map((s) => JSON.stringify(s)).join(', ') + ',');
  }
  lines.push(']);');
  return lines.join('\n');
};

const consts = Object.entries(t2.constantsRaw);
const kWidth = Math.max(...consts.map(([k]) => k.length));
const constLines = ['const CONSTANTS = Object.freeze({'];
for (const [k, v] of consts) {
  constLines.push(`  ${k.padEnd(kWidth)}: ${typeof v === 'string' ? JSON.stringify(v) : v},`);
}
constLines.push('});');

process.stdout.write(
  [
    arr('HASHES', t1.getHashes),
    '',
    arr('CIPHERS', t1.getCiphers),
    '',
    arr('CURVES', t2.getCurves),
    '',
    constLines.join('\n'),
    '',
    `// getHashes ${t1.getHashes.length} 项 / getCiphers ${t1.getCiphers.length} 项 / getCurves ${t2.getCurves.length} 项 / constants ${consts.length} 键`,
  ].join('\n') + '\n',
);
