// i18n 的**语言选择**：`SPC_LANG` + 平台环境（`LANG` 等）+ 平台探测（2026-09-26 定）
//
// 为什么值得单测：`SPC_LANG=en-US` 曾经**静默无效** —— locales 表里只装了 zh-CN 一份，
// 请求的语言匹配不上就悄悄回退中文；用户看到中文，只会以为自己设错了地方。
//
// 判别力（本文件在修复前**根本 import 不进来**：`createI18n` / `detectLang` / `resolveLang` 都不存在 ⇒ 必红）：
//   · 正向：`SPC_LANG` / `LANG` 真的换掉文案；
//   · 优先级：`SPC_LANG` > `LANGUAGE` > `LC_ALL` > `LC_MESSAGES` > `LANG` > 平台 > 默认；
//   · `C` / `POSIX` = **没有语言偏好**（不是"要英文"）⇒ 落默认；
//   · 反向：不可用的语言**回退 + 出声**（不是静默），且按来源分两种码；
//   · 边界：`en` 不被猜成 `en-US`；空串 = 没设；
//   · 安全：这些值**绝不拼进文件路径**（路径穿越）；
//   · 端到端：走子进程 + 环境变量那条真实的路（`bin/spcdev.mjs`）。
//
// ⚠️ 所有用例都**注入 env 并显式给 platform**（`null` = 无平台信号）——
// 否则结果会随跑测那台机器的 locale 变，用例就不再是判据了。
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n, detectLang, normalizeLangTag, resolveLang } from '../i18n';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const LOCALES_DIR = join(REPO_ROOT, 'core', 'i18n', 'locales');

function readLocale(id: string): Record<string, string> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${id}.json`), 'utf8')) as Record<string, string>;
}

/** 造一个实例：注入环境；`platform` 默认 null（= 本用例不模拟平台探测） */
function i18nFor(env: Record<string, string | undefined>, platform: string | null = null) {
  return createI18n({ env, platform });
}

test('i18n：SPC_LANG=en-US → 文案真的是英文（不再是静默中文）', () => {
  const en = readLocale('en-US');
  const zh = readLocale('zh-CN');
  // 前提：这条文案两语必须不同，否则下面的断言没有判别力
  assert.notEqual(en['cli.about.mode'], zh['cli.about.mode']);

  const i = i18nFor({ SPC_LANG: 'en-US' });
  assert.equal(i.resolution.lang, 'en-US');
  assert.equal(i.resolution.source, 'SPC_LANG');
  assert.equal(i.resolution.fallback, false);
  assert.equal(i.warn, null);
  assert.equal(
    i.t('cli.about.mode', { command: 'spcdev' }),
    (en['cli.about.mode'] ?? '').replaceAll('{command}', 'spcdev'),
  );
});

test('i18n：什么都没有（env 空 + 无平台信号）⇒ 默认 zh-CN，且不报警', () => {
  const i = i18nFor({});
  assert.equal(i.resolution.lang, 'zh-CN');
  assert.equal(i.resolution.source, 'default');
  assert.equal(i.resolution.requested, null);
  assert.equal(i.resolution.fallback, false);
  assert.equal(i.warn, null);
  assert.equal(i.t('err.UNEXPECTED'), readLocale('zh-CN')['err.UNEXPECTED']);
});

test('i18n：拼写归一（大小写 / 下划线 / 首尾空白 / POSIX 的 .codeset 与 @modifier）', () => {
  assert.equal(normalizeLangTag(' en_US '), 'en-us');
  assert.equal(normalizeLangTag('zh_CN.UTF-8'), 'zh-cn');
  assert.equal(normalizeLangTag('de_DE.ISO-8859-1@euro'), 'de-de');
  for (const raw of ['en-US', 'en-us', 'EN-US', ' en_US ', 'en_US']) {
    const r = resolveLang(detectLang({ SPC_LANG: raw }), ['en-US', 'zh-CN']);
    assert.equal(r.lang, 'en-US', `raw=${raw}`);
    assert.equal(r.fallback, false, `raw=${raw}`);
  }
  // POSIX 形态走环境链也一样归一
  assert.equal(i18nFor({ LANG: 'zh_CN.UTF-8' }).resolution.lang, 'zh-CN');
});

test('i18n：不猜前缀 —— `en` 不当成 `en-US`（宁可回退并报出来）', () => {
  const r = resolveLang(detectLang({ SPC_LANG: 'en' }), ['en-US', 'zh-CN']);
  assert.equal(r.lang, 'zh-CN');
  assert.equal(r.fallback, true);
});

test('i18n：平台环境链 —— LANG=zh_CN.UTF-8 ⇒ zh-CN（来源记成 LANG）', () => {
  const i = i18nFor({ LANG: 'zh_CN.UTF-8' });
  assert.equal(i.resolution.lang, 'zh-CN');
  assert.equal(i.resolution.source, 'LANG');
  assert.equal(i.resolution.requested, 'zh_CN.UTF-8');
  assert.equal(i.warn, null);
  assert.equal(i18nFor({ LANG: 'en_US.UTF-8' }).resolution.lang, 'en-US');
});

test('i18n：优先级 LC_ALL > LC_MESSAGES > LANG', () => {
  assert.equal(i18nFor({ LANG: 'zh_CN.UTF-8', LC_MESSAGES: 'en_US.UTF-8' }).resolution.source, 'LC_MESSAGES');
  assert.equal(i18nFor({ LANG: 'zh_CN.UTF-8', LC_MESSAGES: 'en_US.UTF-8' }).resolution.lang, 'en-US');
  assert.equal(
    i18nFor({ LANG: 'zh_CN.UTF-8', LC_MESSAGES: 'zh_CN.UTF-8', LC_ALL: 'en_US.UTF-8' }).resolution.source,
    'LC_ALL',
  );
  assert.equal(
    i18nFor({ LANG: 'zh_CN.UTF-8', LC_MESSAGES: 'zh_CN.UTF-8', LC_ALL: 'en_US.UTF-8' }).resolution.lang,
    'en-US',
  );
});

test('i18n：`LANGUAGE` 优先于 `LC_ALL`，且只取冒号表的第一段（GNU 规矩）', () => {
  const d = detectLang({ LANGUAGE: 'en_US.UTF-8:zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' });
  assert.equal(d.source, 'LANGUAGE');
  assert.equal(d.requested, 'en_US.UTF-8');
  assert.equal(i18nFor({ LANGUAGE: 'en_US.UTF-8:zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' }).resolution.lang, 'en-US');
  // 空段跳过
  assert.equal(detectLang({ LANGUAGE: ' :en_US' }).requested, 'en_US');
});

test('i18n：`SPC_LANG` 永远最高（压过 LANG / LANGUAGE / 平台探测）', () => {
  const i = createI18n({ env: { SPC_LANG: 'zh-CN', LANG: 'en_US.UTF-8' }, platform: 'en-US' });
  assert.equal(i.resolution.lang, 'zh-CN');
  assert.equal(i.resolution.source, 'SPC_LANG');
  assert.equal(i.warn, null);
});

test('i18n：`C` / `POSIX`（含 `C.UTF-8`）= 没有语言偏好 ⇒ 落默认 zh-CN，且**不报警**', () => {
  for (const raw of ['C', 'POSIX', 'C.UTF-8', 'c.utf8']) {
    const i = i18nFor({ LANG: raw });
    assert.equal(i.resolution.lang, 'zh-CN', `LANG=${raw}`);
    assert.equal(i.resolution.source, 'default', `LANG=${raw}`);
    assert.equal(i.warn, null, `LANG=${raw}`);
  }
  // `LC_ALL=C` 也一样：跳过它继续往下，而不是把后面的 LANG 也吃掉
  assert.equal(i18nFor({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }).resolution.lang, 'en-US');
});

test('i18n：⚠️ `SPC_LANG=C` **不**按"无偏好"处理（显式设了就照实报不可用）', () => {
  const i = i18nFor({ SPC_LANG: 'C', LANG: 'zh_CN.UTF-8' });
  assert.equal(i.resolution.source, 'SPC_LANG');
  assert.equal(i.resolution.fallback, true);
  assert.ok(i.warn !== null);
  assert.match(i.warn, /SPC_LANG/);
});

test('i18n：平台探测（Windows/macOS 那条路）—— env 空时用 platform，来源记成 platform', () => {
  const i = i18nFor({}, 'zh-CN');
  assert.equal(i.resolution.lang, 'zh-CN');
  assert.equal(i.resolution.source, 'platform');
  assert.equal(i.warn, null);
  // `LANG=C.UTF-8`（Git Bash 之类）在 Windows 上跳过 ⇒ 仍能靠平台探测拿到语言
  const j = i18nFor({ LANG: 'C.UTF-8' }, 'en-US');
  assert.equal(j.resolution.lang, 'en-US');
  assert.equal(j.resolution.source, 'platform');
  // 平台给出我们**没有**的语言 ⇒ 出声
  const k = i18nFor({}, 'ja-JP');
  assert.equal(k.resolution.lang, 'zh-CN');
  assert.equal(k.resolution.fallback, true);
  assert.match(k.warn ?? '', /ja-JP/);
});

test('i18n：平台环境给的不可用语言 → 回退 + 出声（用**平台**那个码，并给出 SPC_LANG 开关）', () => {
  const i = i18nFor({ LANG: 'ja_JP.UTF-8' });
  assert.equal(i.resolution.lang, 'zh-CN');
  assert.equal(i.resolution.source, 'LANG');
  assert.equal(i.resolution.fallback, true);
  assert.ok(i.warn !== null, '平台语言不可用也必须出声');
  assert.match(i.warn, /ja_JP/);
  assert.match(i.warn, /zh-CN/);
  assert.match(i.warn, /en-US/);
  assert.match(i.warn, /SPC_LANG/);
});

test('i18n：`SPC_LANG` 不可用 → 回退 + 一行警告（带请求值与可用值）', () => {
  const i = i18nFor({ SPC_LANG: 'nb-NO' });
  assert.equal(i.resolution.lang, 'zh-CN');
  assert.equal(i.resolution.fallback, true);
  assert.ok(i.warn !== null, '不可用必须出声（静默就是被修掉的那个 bug）');
  assert.match(i.warn, /nb-NO/);
  assert.match(i.warn, /zh-CN/);
  assert.match(i.warn, /en-US/);
});

test('i18n：空串 / 全空白 = 没设（继续往下走，不报警）', () => {
  assert.equal(detectLang({ SPC_LANG: '' }).source, 'default');
  assert.equal(detectLang({ SPC_LANG: '   ' }).source, 'default');
  assert.equal(detectLang({ SPC_LANG: '', LANG: 'en_US.UTF-8' }).source, 'LANG');
  assert.equal(detectLang({ LANG: '  ' }).source, 'default');
});

test('i18n：⚠️ 这些值绝不能被拼进文件路径（路径穿越）', () => {
  // `locales/../../package` 就是仓库根的 package.json —— 它**是**合法 JSON。
  // 若实现按 `${lang}.json` 拼路径，这里会把 package.json 当 locale 表加载进来。
  for (const env of [{ SPC_LANG: '../../package' }, { LANG: '../../package' }]) {
    const i = i18nFor(env);
    assert.equal(i.resolution.lang, 'zh-CN', JSON.stringify(env));
    assert.equal(i.resolution.fallback, true, JSON.stringify(env));
    // package.json 里有 packageManager；locale 表里没有 ⇒ 取不到就说明那份文件压根没被打开
    assert.equal(i.t('packageManager'), 'packageManager', JSON.stringify(env));
  }
});

test('i18n：安装不完整（locale 目录不存在）也不炸，但要出声', () => {
  const i = createI18n({ env: {}, platform: null, dir: join(REPO_ROOT, 'core', 'i18n', 'no-such-dir') });
  assert.equal(i.resolution.available.length, 0);
  assert.equal(i.resolution.lang, 'zh-CN');
  assert.ok(i.warn !== null);
  assert.match(i.warn, /no locale files/);
  // 没有表时退回 key（本模块既有的"不输出空话"原则）
  assert.equal(i.t('err.UNEXPECTED'), 'err.UNEXPECTED');
});

test('i18n：**每一份** locale 的键集合都必须与 zh-CN 一致（否则切语言会掉回 key）', () => {
  // 逐份核（不是只核那两份）：语言表现在是"磁盘上有什么就是什么"，漏核一份 = 那道语言悄悄缺一半文案。
  const canon = Object.keys(readLocale('zh-CN')).sort();
  const ids = readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length));
  assert.ok(ids.includes('zh-CN'), `zh-CN 必须在（实际：${ids.join(', ')}）`);
  for (const id of ids) {
    assert.deepEqual(Object.keys(readLocale(id)).sort(), canon, `locale ${id} 的键集合与 zh-CN 不一致`);
  }
});

test('i18n 端到端：`SPC_LANG=en-US` 经环境变量真的改变命令输出', () => {
  const en = readLocale('en-US');
  const expect = (en['cli.about.mode'] ?? '').replaceAll('{command}', 'spcdev');
  const res = spawnSync(process.execPath, [join(REPO_ROOT, 'bin', 'spcdev.mjs'), 'about'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, SPC_LANG: 'en-US' },
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  assert.ok(out.includes(expect), `期望输出含英文的当前命令行；实际输出：\n${out}`);
  assert.equal(/不可用/.test(out), false, `可用语言不该有回退警告：\n${res.stderr ?? ''}`);
});

test('i18n 端到端：**只**设 `LANG=en_US.UTF-8`（不设 SPC_LANG）也切到英文', () => {
  const en = readLocale('en-US');
  const expect = (en['cli.about.mode'] ?? '').replaceAll('{command}', 'spcdev');
  const env: Record<string, string | undefined> = { ...process.env, LANG: 'en_US.UTF-8' };
  delete env.SPC_LANG;
  const res = spawnSync(process.execPath, [join(REPO_ROOT, 'bin', 'spcdev.mjs'), 'about'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  assert.ok(out.includes(expect), `期望输出含英文的当前命令行；实际输出：\n${out}`);
});

test('i18n 端到端：`SPC_LANG=nb-NO` 会在 stderr 上出声（不可用）', () => {
  const res = spawnSync(process.execPath, [join(REPO_ROOT, 'bin', 'spcdev.mjs'), 'about'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, SPC_LANG: 'nb-NO' },
  });
  assert.match(res.stderr ?? '', /nb-NO/);
  assert.match(res.stderr ?? '', /en-US/);
});
