// check-locales.mjs —— 用户文案的机械体检（规矩见 docs/api-contract.md §2.1）
//
// 为什么需要它：**文案漂移没有任何东西会报错**。
//   · 少一个键 → 界面上原样打出 `{placeholder}`；
//   · 引一个内部编号（ADR-004 / P5 / `scope=host`）→ 运维看得见字，但查不到那个编号是什么；
//   · 加了一个没人传的占位符 → 同上，只有当有人盯着那段输出才会发现。
// 历史坑（真实发生过）：`cli.plugin.line` 里的 `reserved={reserved}` —— `reserved` 字段 v2 就删了、
// 参数从没被传过，于是 CLI 一直原样打印 `reserved={reserved}`，直到 2026-09-23 才被发现。
//
// 用法：node tools/check-locales.mjs
//   CI 友好：只读、无副作用；有**硬失败**则 exit 1（警告不影响退出码）。
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.mjs';

const LOCALES = path.join(REPO_ROOT, 'core', 'i18n', 'locales');
const FILES = ['zh-CN.json', 'en-US.json'];

/** 模板里的占位符名（去重排序） */
const slotsOf = (s) => [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

/**
 * 不该出现在**用户可见文案**里的内部坐标。
 * 判定理由：读者是运维/管理员/插件作者，他们查不到 ADR 编号、章节号、阶段号，也不该看到内部字段名。
 */
const INTERNAL = [
  { re: /\bADR-\d+/i, why: 'ADR 编号' },
  { re: /§/, why: '章节号（§x）' },
  { re: /(^|[^A-Za-z0-9])P[1-9](?![0-9A-Za-z])/, why: '阶段号（P1–P9）' },
  { re: /[①-⑳]/, why: '阶段号（⑦b 这类带圈编号）' },
  { re: /\b(?:scope|state|tier|grant|pluginId|paramsDigest)\s*=/, why: '内部字段名（x=…）' },
  {
    re: /(module-emulation-design|api-contract|plugin-lifecycle-design|plugin-signature-design|market-license-design|intent-capture|events-and-hooks-design)/,
    why: '设计文档文件名',
  },
  { re: /判卷人|探针|契约宗主|HostRef/, why: '仓库内部术语' },
];

/** 已退役的字段/占位符（加进来是为了"别再回来"） */
const RETIRED = ['{reserved}', 'reserved='];

/**
 * 终端**不渲染** markdown：`**加粗**` 会连着星号一起打出来，反引号同理。
 * 文案是给运维/作者在终端里读的，所以这里当硬失败拦。
 */
const MARKDOWN = [
  { re: /\*\*/, why: 'markdown 加粗（**…**）' },
  { re: /`/, why: 'markdown 反引号' },
];

/**
 * 重复键：`JSON.parse` **看不见**它（后一个静默覆盖前一个），
 * 而"被覆盖掉的那份的参数名"正是 `{placeholder}` 原样打出来的来源 ——
 * 2026-09-25 实测：`err.PLUGIN_ID_INVALID` 两边各写了两遍，生效的那条收 `{id}`，
 * 而构件层（`build/scaffold.ts`）传的是 `{pluginId}`，于是 CLI 打出字面的 `{id}`。
 * 所以这里**按行扫原文**，重复即硬失败。
 */
const KEY_LINE = /^\s*"([^"]+)"\s*:/;

/** 收代码里出现过的标识符（占位符必须能在代码里找到"有人传"的痕迹） */
function codeIdentifiers() {
  const out = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.spc') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mts|js|mjs)$/.test(e.name)) {
        const text = fs.readFileSync(p, 'utf8');
        for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0]);
      }
    }
  };
  walk(path.join(REPO_ROOT, 'core'));
  walk(path.join(REPO_ROOT, 'sdk'));
  // 构建层（`build/`）也是产品代码：它的 `t()` 调用同样是"有人传"的证据
  walk(path.join(REPO_ROOT, 'build'));
  return out;
}

const problems = [];
const warnings = [];
const tables = {};
for (const f of FILES) {
  const file = path.join(LOCALES, f);
  if (!fs.existsSync(file)) {
    problems.push(`缺少 locale 文件：${f}`);
    continue;
  }
  try {
    tables[f] = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`${f} 不是合法 JSON：${err instanceof Error ? err.message : err}`);
  }
}

// 重复键体检（必须在 JSON.parse 之外做，见 KEY_LINE 处的说明）
for (const f of FILES) {
  const file = path.join(LOCALES, f);
  if (!fs.existsSync(file)) continue;
  const seen = new Map();
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const m = KEY_LINE.exec(line);
      if (!m) return;
      if (seen.has(m[1])) {
        problems.push(`${f} 重复键 ${m[1]}（第 ${seen.get(m[1])} 行与第 ${i + 1} 行，生效的是后者）`);
      } else seen.set(m[1], i + 1);
    });
}

if (tables[FILES[0]] && tables[FILES[1]]) {
  const [a, b] = FILES.map((f) => tables[f]);
  for (const [x, y, xn, yn] of [
    [a, b, FILES[0], FILES[1]],
    [b, a, FILES[1], FILES[0]],
  ]) {
    for (const k of Object.keys(x)) {
      if (!(k in y)) problems.push(`${yn} 缺少键 ${k}（${xn} 有）`);
    }
  }
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue;
    const [sa, sb] = [slotsOf(a[k]), slotsOf(b[k])];
    if (sa.join(',') !== sb.join(',')) {
      problems.push(`${k} 的占位符不一致：${FILES[0]}[${sa}] vs ${FILES[1]}[${sb}]`);
    }
  }
}

const ids = codeIdentifiers();
for (const f of FILES) {
  const t = tables[f];
  if (!t) continue;
  for (const [k, v] of Object.entries(t)) {
    const text = String(v);
    for (const { re, why } of INTERNAL) {
      const m = re.exec(text);
      if (m) problems.push(`${f} ${k}：文案里出现${why}（"${m[0]}"）`);
    }
    for (const r of RETIRED) {
      if (text.includes(r)) problems.push(`${f} ${k}：文案里还有已退役的 ${r}`);
    }
    for (const { re, why } of MARKDOWN) {
      if (re.test(text)) problems.push(`${f} ${k}：文案里出现${why}（终端不渲染）`);
    }
    for (const s of slotsOf(text)) {
      if (!ids.has(s)) warnings.push(`${f} ${k}：占位符 {${s}} 在代码里找不到同名标识符（没人传？）`);
    }
  }
}

console.log(`=== 文案体检：${FILES.join(' / ')}（规矩：docs/api-contract.md §2.1）===`);
console.log(`  键数 ${FILES.map((f) => (tables[f] ? Object.keys(tables[f]).length : 0)).join(' / ')}`);
if (problems.length === 0) console.log('  ✅ 无硬失败');
else {
  console.log(`  ✖ 硬失败 ${problems.length} 条：`);
  for (const p of problems) console.log('      ' + p);
}
if (warnings.length > 0) {
  console.log(`  ⚠️ 提醒 ${warnings.length} 条（不影响退出码）：`);
  for (const w of warnings) console.log('      ' + w);
}
process.exit(problems.length > 0 ? 1 : 0);
