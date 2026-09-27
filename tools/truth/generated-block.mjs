// 仿真模块里「生成区间」的公共拼接器（2026-09-27 定；约定见 `tools/README.md`）
//
// 形态：用一对标记圈住一段**生成物**，工具只重写这一段 ——
//   `// >>> GENERATED:<名字>（**勿手改**：由 <工具> 生成，重跑即替换本区间）`
//   …生成物正文…
//   `// <<< GENERATED:<名字>`
//
// 为什么是"就地替换"而不是把表抽成单独文件：shim 是**宿主读成源码字符串**再注入 VM 的
// （`core/sandbox.ts` 只服务 `sandbox-modules/node-<名字>.js` 这一批、按 readdir 白名单判基名）⇒
// shim 里**不能 `import` 兄弟数据文件**；而十来份 `emulation-*.test.ts` 又把 `node-*.js`
// **逐字节拷**出去当真 ESM 跑 ⇒ 抽出去那两份 harness 都得跟着改。
// ⇒ 折中：表仍嵌在同一个文件里，但**圈进标记**。好处：可反复重跑、diff 只有一段、手写逻辑永不被碰。
//
// ⛔ 反面教材（别再用）：一次性占位符 `/*__ERRNO_TABLE__*/` —— 替换一次就没了 ⇒ 工具**再也跑不了**。
// 标记则**属于被替换内容的一部分** ⇒ 重跑后仍在文件里。
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * @param {object} spec
 * @param {string} spec.file    目标文件（绝对路径）
 * @param {string} spec.name    标记名（如 `fs-tables`）
 * @param {string} spec.origin  生成它的工具（写进标记里，如 `tools/truth/gen-fs-tables.mjs`）
 * @param {string} spec.block   生成物正文（**不含标记**）
 * @param {object} spec.bootstrap 首次（文件里还没标记）时用来圈定旧区间的锚点：
 *   - `from`：区间起点（保留在区间**外**）
 *   - `to`：区间终点锚（保留在区间**外**）——给了就用它
 *   - 否则 `closeAfter` + `close`：在 `closeAfter` 之后找第一个 `close` 作收尾
 *   - `swallow`（RegExp，可选）：再吞掉紧跟其后、匹配它的连续注释行（生成器的计数行）
 * @returns {'replaced' | 'unchanged'}
 */
export function spliceGenerated({ file, name, origin, block, bootstrap }) {
  const begin = `// >>> GENERATED:${name}（**勿手改**：由 ${origin} 生成，重跑即替换本区间）`;
  const end = `// <<< GENERATED:${name}`;
  // 收尾固定带一个空行 ⇒ 区间后面永远恰好留一行空白（与前面有几行空白无关，幂等靠这个）
  const text = `${begin}\n${block.trimEnd()}\n${end}\n\n`;

  const src = readFileSync(file, 'utf8');
  const b = src.indexOf(begin);
  const e = src.indexOf(end);
  const next =
    b >= 0 && e > b
      ? src.slice(0, b) + text + src.slice(skipNewlines(src, e + end.length))
      : firstRun(src); // ⚠️ 别把这个函数叫 bootstrap：那会遮蔽上面的 spec 参数（踩过）
  if (next === src) return 'unchanged';
  writeFileSync(file, next, 'utf8');
  return 'replaced';

  function skipNewlines(s, i) {
    while (s[i] === '\n') i++;
    return i;
  }

  function firstRun(s) {
    const from = s.indexOf(bootstrap.from);
    if (from < 0) throw new Error(`${file}：既没有标记、也找不到起点 \`${bootstrap.from}\`（先确认没被手改）`);
    let to;
    if (bootstrap.to !== undefined) {
      to = s.indexOf(bootstrap.to, from);
      if (to < 0) throw new Error(`${file}：找不到终点锚 \`${bootstrap.to}\``);
    } else {
      const after = s.indexOf(bootstrap.closeAfter, from);
      if (after < 0) throw new Error(`${file}：找不到定位锚 \`${bootstrap.closeAfter}\``);
      const close = s.indexOf(bootstrap.close, after);
      if (close < 0) throw new Error(`${file}：找不到收尾 \`${bootstrap.close}\``);
      to = close + bootstrap.close.length + 1; // 连收尾后的换行一起吃掉
      if (bootstrap.swallow) {
        const m = s.slice(to).match(/^(?:\/\/[^\n]*\n)+/);
        if (m && bootstrap.swallow.test(m[0])) to += m[0].length;
      }
    }
    return s.slice(0, from) + text + s.slice(skipNewlines(s, to));
  }
}
