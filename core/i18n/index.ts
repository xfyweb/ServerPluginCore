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
// locale 选择：SPC_LANG 环境变量（默认 zh-CN）；后续可接系统 locale 探测。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toErrorShape } from '../errors';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Locale = Record<string, string>;
const locales: Record<string, Locale> = {
  'zh-CN': JSON.parse(readFileSync(join(__dirname, 'locales', 'zh-CN.json'), 'utf8')),
};

const lang = process.env.SPC_LANG ?? 'zh-CN';
const dict: Locale = locales[lang] ?? locales['zh-CN'];

/** 取本地化消息：t('cli.status.running', { version: '0.0.0' }) */
export function t(key: string, params?: Record<string, string | number>): string {
  let msg = dict[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replaceAll(`{${k}}`, String(v));
    }
  }
  return msg;
}

/** 渲染模式的错误形状（SpcError / HTTP detail 都可直接传入） */
export interface RenderableError {
  code: string;
  params?: Record<string, string>;
}

/**
 * 渲染宿主错误：{code, params} → 本地化文本（CLI / 面板在此层翻译）。
 * 缺 `err.<code>` key 时回退到「英文码 + JSON 参数」。
 */
export function tError(err: RenderableError): string {
  const key = `err.${err.code}`;
  const hasKey = Object.prototype.hasOwnProperty.call(dict, key);
  if (hasKey) return t(key, err.params);
  const params = err.params && Object.keys(err.params).length > 0 ? ` ${JSON.stringify(err.params)}` : '';
  return `${err.code}${params}`;
}

/**
 * CLI 顶层兜底：把"抛出来的任何东西"渲染成一行。
 *
 * 为什么不能只打 `e.message`：`SpcError` 的 message **就是英文码**（见 `core/errors.ts`），
 * 于是 `spcdev new demo --id BadName` 只会打一句 `PLUGIN_ID_INVALID` —— 哪个 id 非法、该改成什么样，全丢了；
 * 而**没接住**时更糟：Node 把整段堆栈打给用户（内部路径 + 行号），那不是"该怎么办"。
 * 非 SpcError（网络、fs 之类）没有码可翻，退回 message。
 */
export function renderThrown(e: unknown): string {
  const shape = toErrorShape(e);
  if (shape) return tError(shape);
  return e instanceof Error ? e.message : String(e);
}
