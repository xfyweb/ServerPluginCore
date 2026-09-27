// i18n：本地化文本的渲染层（**只在边界渲染**）
//
// 分层原则（2026-09 定稿）：
//   1) 内部层（fs / permissions / audit / hostApi / sandbox）：只产出/流通**英文码 + 结构化参数**
//      （SpcError{code, params}、CheckResult{decision, code, params}），不持有本地化文本；
//   2) HTTP 层：只传英文码（`error` 顶层码 + `detail.code/params`），**不承载本地化文本**；
//      审计 JSONL 同理（只记 code + paramsDigest）；
//   3) CLI：本模块的渲染点（t / tError）；
//   4) 面板（P3）：自行请求 locale 文件在**前端渲染层**翻译（核心不再下发本地化消息）。
//
// 码是契约：`<code>` 一经发布不得改名，只增不改；新增码必须同时补 locales 的 `err.<code>`。
// 缺 key 时回退到英文码（+ 参数），保证任何 locale 缺翻译都不会输出空话。
//
// ── 语言从哪来（2026-09-26 定；"切不动语言"修复 + 平台探测） ──────────────────────────
//
// 探测链，优先级从高到低：
//
//   1. `SPC_LANG`                  ← 我们的显式覆盖，永远最高（**非空即请求，不再被重新解释**）
//   2. `LANGUAGE`                  ← GNU：冒号分隔的优先级表，取第一段（这个变量的用途就是"消息语言"）
//   3. `LC_ALL`  4. `LC_MESSAGES` 5. `LANG`   ← POSIX 通用优先级（LC_ALL > 类别 > LANG）
//   6. 平台探测（**只在 Windows / macOS**）   ← Intl 的默认 locale
//   7. 默认 `zh-CN`
//
// 四条规矩：
//   1) **可用的 locale = 磁盘上真实存在的文件**（`locales/*.json`，启动时列一次目录）——
//      加一门语言就是放一个 JSON 文件，**不用改代码**（原先只有 zh-CN 写死在表里，
//      于是 `SPC_LANG=en-US` 匹配不上、悄悄回退中文，用户看到中文却不知道自己设错了哪儿）。
//   2) 只做**拼写归一**（大小写 / `_`→`-` / 去掉 POSIX 的 `.codeset` 与 `@modifier`），**不做前缀猜测** ——
//      `en` **不会**被当成 `en-US`：宁可回退并报出来，也不要"猜对了、但没人知道按什么规则猜的"。
//   3) **`C` / `POSIX`（含 `C.UTF-8`）= 平台没有表达语言偏好**，不是"我要英文" ⇒ 跳过那一档继续往下，
//      最终落默认 `zh-CN`。为什么不当英文：我们的默认/正本就是 zh-CN，"不翻译"对我们自然落回中文
//      （gettext 那边落回英文，是因为它的源语言是英文）；否则 Docker / Alpine / CI 里一大片
//      `LANG=C.UTF-8` 会**静默变英文**，而那些环境从没提过任何语言要求。
//   4) **POSIX 上不探 Intl**：那里的平台机制就是上面那几个环境变量，而实测（2026-09-26，WSL/node v22.22.1）
//      Intl 只是把它们重读一遍 —— **唯一分歧点是 `LANG=C.UTF-8`，那时 ICU 会擅自给出 `en-US`**。
//      让一个随 ICU 版本/构建而变的兜底值决定我们显示什么，是这个项目最不想要的隐藏不确定性。
//      Windows 则相反：实测**设了 `LANG` 也不影响 Intl**（它反映的是 OS 设置）⇒ 只能靠探测。
//      ⚠️ 诚实备注：Windows 上它给的是**区域格式**而非 UI 语言（用美国区域设置的中文用户会拿到 `en-US`）；
//      Node 没有 `os.locale()`，这是最近的东西。
//   5) 请求/探测到的语言**不可用** ⇒ **回退默认 + stderr 一行警告**。两种来源两个码：
//      `SPC_LANG` 来的 ⇒ `err.LOCALE_UNAVAILABLE`；系统环境来的 ⇒ `err.LOCALE_PLATFORM_UNAVAILABLE`
//      （后者文案里给出 `SPC_LANG` 这个静音/固定开关）。空串 / 全空白一律视为"没设"。
//      为什么不 fail-closed 直接拒绝启动：这不是安全判定（不涉及权限/来源），且"缺翻译也要有话可说"
//      是本模块既有的原则（t / tError 都回退）。**但静默不行** —— 静默回退正是被修掉的那个 bug。
//   6) ⚠️ 这些值**只用于匹配**，绝不拼进文件路径 —— 能打开的文件名只来自目录列举
//      （否则 `LANG=../../package` 就能让核心去读任意 JSON 文件，见 `createI18n` 的用例）。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toErrorShape } from '../errors';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Locale = Record<string, string>;

const LOCALES_DIR = join(__dirname, 'locales');
const DEFAULT_LANG = 'zh-CN';

/**
 * 归一化语言标签：**只做拼写归一**，不猜（`en` ≠ `en-US`）。
 * `zh_CN.UTF-8@euro` → `zh-cn`：POSIX 的 codeset 与 modifier 都不含语言信息，先摘掉。
 */
export function normalizeLangTag(raw: string): string {
  const head = raw.trim().split('@')[0]?.split('.')[0] ?? '';
  return head.replaceAll('_', '-').toLowerCase();
}

/** `C` / `POSIX`（含 `C.UTF-8`）= 平台没有表达语言偏好（**不是**"要英文"，见文件头规矩 3） */
function isNoPreferenceTag(raw: string): boolean {
  const tag = normalizeLangTag(raw);
  return tag === 'c' || tag === 'posix';
}

/** 语言是从哪儿来的（诊断与用例断言用；也是选哪个警告文案的依据） */
export type LangSource =
  | 'SPC_LANG'
  | 'LANGUAGE'
  | 'LC_ALL'
  | 'LC_MESSAGES'
  | 'LANG'
  | 'platform'
  | 'default';

/** 环境链（顺序即优先级）：`LANGUAGE` 在前是 GNU gettext 对"消息语言"的规定 */
const ENV_CHAIN = ['LANGUAGE', 'LC_ALL', 'LC_MESSAGES', 'LANG'] as const;

export interface DetectedLang {
  /** 探测到的语言（原文，未归一化）；null = 平台没表达偏好 ⇒ 用默认 */
  requested: string | null;
  source: LangSource;
}

/**
 * 从环境（+ 平台探测值）里挑出"用户想要什么语言"。纯函数 ⇒ 可单测，**不碰 `process.env`**。
 *
 * @param platform 平台探测到的语言（`null` = 没有 / 不用探测，例如 POSIX）
 */
export function detectLang(
  env: Record<string, string | undefined>,
  platform: string | null = null,
): DetectedLang {
  // 1. 我们自己的变量：非空即请求，**不再被重新解释**（`SPC_LANG=C` 也会照常报"不可用"）
  const own = env.SPC_LANG;
  if (own !== undefined && own.trim() !== '') return { requested: own, source: 'SPC_LANG' };

  // 2~5. POSIX 环境链；`C`/`POSIX` 与空值一样跳过
  for (const name of ENV_CHAIN) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '' || isNoPreferenceTag(raw)) continue;
    // `LANGUAGE` 是冒号分隔的优先级表：取第一个非空段
    const value = name === 'LANGUAGE' ? raw.split(':').find((s) => s.trim() !== '') ?? '' : raw;
    if (value.trim() === '') continue;
    return { requested: value, source: name };
  }

  // 6. 平台探测（调用方决定给不给；POSIX 一律传 null，见文件头规矩 4）
  if (platform !== null && platform.trim() !== '' && !isNoPreferenceTag(platform)) {
    return { requested: platform, source: 'platform' };
  }

  return { requested: null, source: 'default' };
}

/**
 * 平台语言探测（**只在 Windows / macOS 调用**）：Node 没有 `os.locale()`，最近的等价物是 ICU 的默认 locale。
 * 拿不到（没有 ICU 的构建 / 值异常）⇒ null —— "探不到"不是错误。
 */
export function probePlatformLang(): string | null {
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale;
    return typeof loc === 'string' && loc.trim() !== '' ? loc : null;
  } catch {
    return null;
  }
}

/** 本机的默认探测：POSIX 上**不探**（那些环境变量就是平台机制，规矩 4） */
function platformLangForThisHost(): string | null {
  return process.platform === 'win32' || process.platform === 'darwin' ? probePlatformLang() : null;
}

/** 一次语言解析的结果（`lang` 是**实际生效**的那个） */
export interface LangResolution {
  lang: string;
  /** 探测到的语言原文（没探测到 = null） */
  requested: string | null;
  source: LangSource;
  /** 磁盘上真实可用的 locale（已排序） */
  available: string[];
  /** true = 探测到了但匹配不上，已回退到默认语言 */
  fallback: boolean;
}

/** 解析语言：探测结果 → 归一化 → 与可用列表**精确匹配** → 否则回退（纯函数，所以回退规则可单测） */
export function resolveLang(
  detected: DetectedLang,
  available: string[],
  def: string = DEFAULT_LANG,
): LangResolution {
  const pick = available.includes(def) ? def : available[0] ?? def;
  const { requested, source } = detected;
  if (requested === null) return { lang: pick, requested: null, source, available, fallback: false };
  const want = normalizeLangTag(requested);
  const hit = available.find((id) => normalizeLangTag(id) === want);
  return { lang: hit ?? pick, requested, source, available, fallback: hit === undefined };
}

/** 渲染模式的错误形状（SpcError / HTTP detail 都可直接传入） */
export interface RenderableError {
  code: string;
  params?: Record<string, string>;
}

export interface I18n {
  resolution: LangResolution;
  /** 需要告诉用户的问题（已渲染成一行，带 `[i18n]` 前缀）；没问题 = null。默认实例会打到 stderr */
  warn: string | null;
  /** 取本地化消息：t('cli.status.running', { version: '0.0.0' }) */
  t(key: string, params?: Record<string, string | number>): string;
  /**
   * 渲染宿主错误：{code, params} → 本地化文本（CLI / 面板在此层翻译）。
   * 缺 `err.<code>` key 时回退到「英文码 + JSON 参数」。
   */
  tError(err: RenderableError): string;
  /**
   * CLI 顶层兜底：把"抛出来的任何东西"渲染成一行。
   *
   * 为什么不能只打 `e.message`：`SpcError` 的 message **就是英文码**（见 `core/errors.ts`），
   * 于是 `spcdev new demo --id BadName` 只会打一句 `PLUGIN_ID_INVALID` —— 哪个 id 非法、该改成什么样，全丢了；
   * 而**没接住**时更糟：Node 把整段堆栈打给用户（内部路径 + 行号），那不是"该怎么办"。
   * 非 SpcError（网络、fs 之类）没有码可翻，退回 message。
   */
  renderThrown(e: unknown): string;
}

export interface I18nOptions {
  /** 环境来源；默认 `process.env`。**测试注入伪造环境**，这样用例与跑测机器的 locale 无关 */
  env?: Record<string, string | undefined>;
  /**
   * 平台探测值。省略 = 按本机自动探（仅 win32/darwin）；
   * 显式 `null` = 没有平台信号（POSIX 的真实现状，也用于让用例与机器无关）。
   */
  platform?: string | null;
  /** locale 目录（默认本模块旁边的 `locales/`） */
  dir?: string;
}

/** 列出磁盘上真实存在的 locale（`locales/*.json`）。列不到 ⇒ 空数组（安装不完整，由调用方报） */
function listLocales(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => /^[A-Za-z0-9-]+\.json$/.test(name))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

export function createI18n(opts: I18nOptions = {}): I18n {
  const dir = opts.dir ?? LOCALES_DIR;
  const env = opts.env ?? process.env;
  const platform = opts.platform === undefined ? platformLangForThisHost() : opts.platform;
  const available = listLocales(dir);
  const resolution = resolveLang(detectLang(env, platform), available);

  // ⚠️ 只打开 `resolution.lang` —— 它必定是 `available` 的一员（resolveLang 的返回值就是这么来的），
  // 所以环境变量的值再离谱也走不到文件路径上。
  let dict: Locale = {};
  try {
    dict = JSON.parse(readFileSync(join(dir, `${resolution.lang}.json`), 'utf8')) as Locale;
  } catch {
    dict = {};
  }

  const t = (key: string, params?: Record<string, string | number>): string => {
    let msg = dict[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        msg = msg.replaceAll(`{${k}}`, String(v));
      }
    }
    return msg;
  };

  const tError = (err: RenderableError): string => {
    const key = `err.${err.code}`;
    const hasKey = Object.prototype.hasOwnProperty.call(dict, key);
    if (hasKey) return t(key, err.params);
    const params = err.params && Object.keys(err.params).length > 0 ? ` ${JSON.stringify(err.params)}` : '';
    return `${err.code}${params}`;
  };

  const renderThrown = (e: unknown): string => {
    const shape = toErrorShape(e);
    if (shape) return tError(shape);
    return e instanceof Error ? e.message : String(e);
  };

  // 警告在**回退之后的**语言里渲染（此时 dict 就是它的表）；没有 locale 表时才退回无语言的英文句子。
  let warn: string | null = null;
  if (available.length === 0) {
    warn = `[i18n] no locale files under ${dir} (incomplete install?) — messages will show raw keys`;
  } else if (resolution.fallback) {
    warn = `[i18n] ${tError({
      code: resolution.source === 'SPC_LANG' ? 'LOCALE_UNAVAILABLE' : 'LOCALE_PLATFORM_UNAVAILABLE',
      params: {
        lang: resolution.requested ?? '',
        fallback: resolution.lang,
        available: available.join(', '),
      },
    })}`;
  }

  return { resolution, warn, t, tError, renderThrown };
}

/**
 * 进程默认实例：按"`SPC_LANG` → 平台环境 → 平台探测 → 默认"选语言。**所有既有调用方用的就是这四个导出**
 * （t / tError / renderThrown / RenderableError），行为不变；要在别处造实例（测试）用 `createI18n`。
 */
const defaultI18n = createI18n();

if (defaultI18n.warn !== null) console.error(defaultI18n.warn);

/** 取本地化消息：t('cli.status.running', { version: '0.0.0' }) */
export const t = defaultI18n.t;

/** 渲染宿主错误（缺 key 时回退到「英文码 + JSON 参数」） */
export const tError = defaultI18n.tError;

/** CLI 顶层兜底（见 `I18n.renderThrown` 的注释） */
export const renderThrown = defaultI18n.renderThrown;

/** 当前**实际生效**的 locale（诊断用，例如 `about` 想报一行） */
export function currentLang(): string {
  return defaultI18n.resolution.lang;
}
