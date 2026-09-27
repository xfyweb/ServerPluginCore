// 生成 core/sandbox-modules/node-constants.js 的**两个平台**版本（P2-E / 模型 B）
//
// 用法（从仓库根）：node tools/truth/gen-constants2.mjs
//
// 输入（两份都是 node 的运行值真值；**生成物里的版本号从数据里读**，见下面 `VER`）：
//   · tools/truth/data/const-linux.json  ← 在 WSL 里跑 tools/truth/dump-const.mjs
//   · tools/truth/data/const-win.json    ← 用判卷人 node 跑 tools/truth/dump-const-win.mjs
//
// ⚠️ **为什么必须按平台整表分**（不是"值不同"那么轻）：
//   · 键集不同：Windows 有 59 个 Linux 没有的键（`WSA*` 54 个 + `SIGBREAK` 等），Linux 有 51 个 Windows 没有的
//     （`SIGUSR1/2`、`O_*` 一族、`RTLD_*`、`S_IRGRP` 一族）；
//   · 值不同：49 个同名键值不同（`EADDRINUSE` win=100/linux=98 ……）；
//   · **形状不同**：Windows **没有** `os.constants.dlopen` 这一组，Linux 有 5 个键。
//
// ⚠️ **另一个坑（本轮顺手修掉）**：`os.constants` 的四组**不能靠前缀猜**。旧实现用
//   `groupOf(/^E[A-Z0-9_]+$/)` 归 errno —— 在 Windows 上 `WSAEACCES` 也匹配这条（W-S-A-E-A-C-C-E-S
//   里以 `E` 开头？不，是 `^E` 匹配不到 `W`……真正的冲突是 **`EWOULDBLOCK`/`WSAEWOULDBLOCK` 同值** 与
//   `ENOTSUP`/`EOPNOTSUPP` 同值这类**同值不同键**，以及 `signals` 组里 `SIG*` 之外还有 `SIGBREAK`）。
//   所以这里改成：**真值里本来就是分组的，就按真值的分组**（`d.os.errno` / `d.os.signals` / …），
//   不再从前缀反推。
import { readFileSync, writeFileSync } from 'node:fs';
import { TRUTH_DATA, SANDBOX_MODULES } from '../paths.mjs';

const LINUX = JSON.parse(readFileSync(TRUTH_DATA + '/const-linux.json', 'utf8'));
const WIN = JSON.parse(readFileSync(TRUTH_DATA + '/const-win.json', 'utf8'));
const OUT = SANDBOX_MODULES + '/node-constants.js';

/** 真值 → `{group: {…}}`（顺序照 Node 的 `lib/constants.js` 合并顺序：dlopen/errno/priority/signals + fs + crypto） */
function groupTable(d) {
  return {
    dlopen: d.os.dlopen ?? {},
    errno: d.os.errno ?? {},
    priority: d.os.priority ?? {},
    signals: d.os.signals ?? {},
    fs: d.fs ?? {},
    crypto: d.crypto ?? {},
  };
}

const GROUP_LABEL = {
  dlopen: 'os.constants.dlopen',
  errno: 'os.constants.errno',
  priority: 'os.constants.priority',
  signals: 'os.constants.signals',
  fs: 'fs.constants',
  crypto: 'crypto.constants',
};

/** 冻结一张表 + 它的四个 os 分组（分组按真值给，不靠前缀猜） */
function emitPlatform(lines, indent, varName, d, human) {
  const t = groupTable(d);
  const flat = new Map();
  for (const g of Object.keys(GROUP_LABEL)) for (const [k, v] of Object.entries(t[g])) flat.set(k, v);
  const keys = [...flat.keys()];
  if (!keys.every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) {
    throw new Error(varName + ': 键名不是合法标识符，不能生成解构导出');
  }

  const p = (s) => indent + s;
  lines.push(p(`// ${human}（node ${d.node} / ${d.platform} / ${d.arch}）：${keys.size} 键`));
  lines.push(p(`const ${varName} = Object.freeze({`));
  for (const [g, label] of Object.entries(GROUP_LABEL)) {
    const entries = Object.entries(t[g]);
    if (entries.length === 0) continue;
    lines.push(p(`  // ── ${label}（${entries.length} 键）──`));
    for (const [k, v] of entries) {
      lines.push(p(`  ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v},`));
    }
  }
  lines.push(p('});'));
  lines.push('');
  // os.constants 的四组：**直接给**（不从前缀反推）
  lines.push(p(`const ${varName}OsGroups = Object.freeze({`));
  for (const g of ['dlopen', 'errno', 'priority', 'signals']) {
    const entries = Object.entries(t[g]);
    lines.push(p(`  ${g}: Object.freeze({`));
    for (const [k, v] of entries) lines.push(p(`    ${k}: ${v},`));
    lines.push(p('  }),'));
  }
  lines.push(p('});'));
  lines.push('');
  return `${varName}OsGroups`;
}

const lines = [];
lines.push('// node:constants 仿真——**按平台两张真值表**（不是转录头文件，是宿主 Node 的运行值）');
lines.push('//');
lines.push('// Node 的 `constants` 已被官方标记为 deprecated，实际是 `os.constants.{dlopen,errno,priority,signals}`');
lines.push("// + `fs.constants` + `crypto.constants` 的合并（见 `lib/constants.js`）。生态里仍有不少包在**加载期**");
lines.push("// 就 `require('constants')` 取 `O_RDONLY` / `F_OK` / `COPYFILE_EXCL` 一类。");
lines.push('//');
lines.push('// **取哪张表由 `globalThis.__spcEnv.platform` 决定**（P2-E / 模型 B：仿真平台跟随宿主）。');
// ⚠️ 版本号**从数据里读**，别在下面写死：写死过一次，基线从 v22.22.1 迁到 v24.20.0 时
// 生成物的头注释就跟着过期了（"生成物写着 v22、数据其实是 v24"这种不一致最费人）。
const VER = LINUX.node === WIN.node ? LINUX.node : `${LINUX.node}（Linux）/ ${WIN.node}（Windows）`;
lines.push(`// 两份都是 **node ${VER}** 的运行值真值，逐键可核：`);
lines.push(`//   · Linux：wsl -e node tools/truth/dump-const.mjs            （${LINUX.platform}/${LINUX.arch}）`);
lines.push(`//   · Windows：用**本机 node（判卷人）**跑 tools/truth/dump-const-win.mjs（${WIN.platform}/${WIN.arch}）`);
lines.push('//   → 再跑 tools/truth/gen-constants2.mjs 生成本文件（两份真值在 tools/truth/data/ 下）');
lines.push('//');
lines.push('// 三处**结构性**差异（不是"几个数值不同"，所以必须整表分）：');
lines.push('//   1. 键集：Windows 有 59 个 Linux 没有的键（`WSA*` 54 + `SIGBREAK` 等），Linux 有 51 个 Windows 没有的');
lines.push('//      （`SIGUSR1/2`、`O_DIRECT`/`O_NOFOLLOW` 一族、`RTLD_*`、`S_IRGRP` 一族）；');
lines.push('//   2. 同名不同值 49 个（`EADDRINUSE` win=100 / linux=98、`EAGAIN` win=11 / linux=11 …）；');
lines.push('//   3. **形状**：Windows **没有** `os.constants.dlopen` 这一组。');
lines.push('//');
lines.push('// 缺失键说明：`O_SYMLINK` 在 Linux 上不存在（macOS/BSD 专有）——曾经"补"过一个 `O_SYMLINK = 0`，');
lines.push('// 那是凭空造键，已删除。`defaultCipherList`/`defaultCoreCipherList` 是字符串，照实带出。');
lines.push('//');
lines.push('// 内联约束：静态、无占位符。Node 侧是 frozen，这里同样冻结。');

const facts = JSON.parse(readFileSync(TRUTH_DATA + '/const-win.json', 'utf8')).facts;
lines.push('');
lines.push('/** 平台事实（与常量同源：`__spcEnv.platform` 决定；`devNull`/`EOL`/分隔符由 node-os.js 与 node-path.js 消费） */');
lines.push(`export const PLATFORM_FACTS = Object.freeze({`);
lines.push(`  linux: Object.freeze({ devNull: '/dev/null', eol: '\\n', sep: '/', delimiter: ':' }),`);
lines.push(`  win32: Object.freeze({ devNull: ${JSON.stringify(facts.devNull)}, eol: ${JSON.stringify(JSON.parse(facts.EOL))}, sep: ${JSON.stringify(facts.sep)}, delimiter: ${JSON.stringify(facts.delimiter)} }),`);
lines.push('});');
lines.push('');
lines.push('/** 当前平台（拿不到环境事实时回退 linux：与沙箱默认取向一致，fail-closed 到"受限的那一套"） */');
lines.push('function currentPlatform() {');
lines.push('  try {');
lines.push('    const p = JSON.parse(globalThis.__spcEnv).platform;');
lines.push('    return p === \'win32\' ? \'win32\' : \'linux\';');
lines.push('  } catch (e) {');
lines.push('    return \'linux\';');
lines.push('  }');
lines.push('}');
lines.push('');

const linuxGroupsVar = emitPlatform(lines, '', 'LINUX_TABLE', LINUX, 'Linux/POSIX');
const win32GroupsVar = emitPlatform(lines, '', 'WIN32_TABLE', WIN, 'Windows');

lines.push('const constants = currentPlatform() === \'win32\' ? WIN32_TABLE : LINUX_TABLE;');
lines.push(`const osGroups = currentPlatform() === 'win32' ? ${win32GroupsVar} : ${linuxGroupsVar};`);
lines.push('');
lines.push('export default constants;');
lines.push('');
lines.push('/** `os.constants` 的四组：**按真值的分组给**（不从前缀反推——Windows 上 `WSA*` 与 `E*` 前缀归类会错位） */');
lines.push('export const osConstants = osGroups;');
lines.push('');

// 命名导出：**两个平台键集的并集**都给出绑定，值取当前平台的那张表。
//
// 为什么不用静态解构 `export const { A, B } = …`：那个形状要求键集在**源码里**固定，
// 而键集是平台相关的（Windows 243 / Linux 235）。只导出交集的话，
// `import { O_NOFOLLOW } from 'node:constants'` 在 Linux 上会变成"未导出"，
// 而它在 Node 上是合法导入（只是 Windows 上没有这个键）。
// `export { x as y }` 走的是**模块绑定**，可以让绑定名的集合与值的来源解耦。
lines.push('');
lines.push('/** 两个平台键集的**并集**（保证任一侧的 `import { X }` 都能解析） */');
const linuxKeys = Object.keys(groupTable(LINUX)).flatMap((g) => Object.keys(groupTable(LINUX)[g]));
const winKeys = Object.keys(groupTable(WIN)).flatMap((g) => Object.keys(groupTable(WIN)[g]));
const allKeys = [...new Set([...linuxKeys, ...winKeys])].sort().filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
lines.push('/**');
lines.push(' * 每个键都建一个**模块级 const 绑定**，值取当前平台那张表。');
lines.push(' *');
lines.push(' * 为什么不是 `export const { A, B } = constants`：解构的键集必须在**源码里**写死，');
lines.push(' * 而键集是平台相关的（Windows 243 / Linux 235）。只导出交集的话，');
lines.push(' * `import { O_NOFOLLOW } from \'node:constants\'` 在 Windows 上会变成"未导出"，');
lines.push(' * 而它在 Node 上只是"值为 undefined"——那是**导入期就炸**的差异，比拿不到值严重。');
lines.push(' * 所以按**并集**建绑定（294 个），值由运行期平台决定。');
lines.push(' */');
for (const k of allKeys) lines.push(`const __C_${k} = constants[${JSON.stringify(k)}];`);
lines.push('');
lines.push('export {');
for (const k of allKeys) lines.push(`  __C_${k} as ${k},`);
lines.push('};');
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
const count = (d) => Object.keys(groupTable(d)).reduce((a, g) => a + Object.keys(groupTable(d)[g]).length, 0);
console.log(`wrote ${OUT}: linux ${count(LINUX)} 键 / win32 ${count(WIN)} 键 / 并集 ${new Set([...linuxKeys, ...winKeys]).size} 键`);
