// 日志/审计的**渲染层**：把机器可读的条目变成终端上读得懂的一行。
//
// 为什么单独一个模块（而不是塞在 `core/cli.ts` 里）：
//   · `api-contract.md` §8 把"本地化"这件事**指定给了渲染层**（"核心只记机器可读的码与参数摘要……
//     本地化在 `spc audit tail` / 面板渲染层完成"）—— 那就得有一个能被单独测的渲染层；
//   · `core/cli.ts` 是**入口**：import 它会执行 `main()`，测试没法干净地引它。
//
// 两条规矩：
//   · **码永远照打**（`kv.set` / `denied` / 权限点名是契约），中文标签只是附加可读性；
//   · 认不出的组 / 结果**原样回退**——绝不为了好看编一个不存在的名字。
import { t } from './i18n';
import type { AuditEntry } from './audit';
import type { LogEntry } from './logs';

/** 时刻：**本地 `HH:MM:SS`**（精确值走 `--json` 的 `ts`；给终端看的东西不该是 UTC） */
export function clockOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 插件日志一行（插件文本本身就是给人看的，没什么可本地化） */
export function logLine(e: LogEntry): string {
  return t('cli.log.line', {
    time: clockOf(e.ts),
    level: e.level,
    ref: e.ref,
    text: e.truncated ? `${e.text}${t('cli.log.truncated')}` : e.text,
  });
}

/**
 * 审计一行：`时刻  结果  插件  组（方法）  → 目标  错误码  耗时`。
 * 后三段按需出现（没有目标/错误/时长就不占位）—— `durationMs` 对排障最有用，所以只要有就打。
 */
export function auditLine(e: AuditEntry): string {
  const dot = e.method.indexOf('.');
  const group = dot === -1 ? e.method : e.method.slice(0, dot);
  const labelKey = `cli.audit.group.${group}`;
  const label = t(labelKey);
  const resultKey = `cli.audit.result.${e.result}`;
  const resultText = t(resultKey);
  const parts = [
    t('cli.audit.line', {
      time: clockOf(e.ts),
      result: resultText === resultKey ? e.result : resultText,
      ref: e.ref ?? e.pluginId,
      what: t('cli.audit.what', { group: label === labelKey ? group : label, method: e.method }),
    }),
  ];
  if (e.target !== undefined) parts.push(t('cli.audit.target', { value: e.target }));
  if (e.error?.code !== undefined) parts.push(t('cli.audit.error', { code: e.error.code }));
  if (typeof e.durationMs === 'number') parts.push(t('cli.audit.ms', { ms: String(Math.round(e.durationMs)) }));
  return parts.join('  ');
}
