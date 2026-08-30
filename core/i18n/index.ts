// i18n 骨架：核心/CLI 消息本地化
// 原则：错误码永远英文（机器可读），只有消息文本走 i18n。
// locale 选择：SPC_LANG 环境变量（默认 zh-CN）；后续可接系统 locale 探测。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
