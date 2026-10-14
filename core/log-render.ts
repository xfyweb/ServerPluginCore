// 日志/审计的**渲染层**：把机器可读的条目变成终端上读得懂的一行。
//
// 为什么单独一个模块（而不是塞在 `core/cli.ts` 里）：
//   · `api-contract.md` §8 把"本地化"这件事**指定给了渲染层**（"核心只记机器可读的码与参数摘要……
//     本地化在 `spc audit tail` / 面板渲染层完成"）—— 那就得有一个能被单独测的渲染层；
//   · `core/cli.ts` 是**入口**：import 它会执行 `main()`，测试没法干净地引它。
//
// 两条规矩：
//   · **码永远照打**（`kv.set` / `denied` / 权限点名是契约），中文标签只是附加可读性；
//   · 认不出的组 / 结果 / 身份**原样回退**——绝不为了好看编一个不存在的名字。
import { t } from './i18n';
import type { AuditActor, AuditEntry, AuditSubject } from './audit';
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
 * **谁做的**那一列。
 *
 * 这是 2026-10-14 改结构要解决的问题：以前只有"关于谁"，于是"插件自己写 KV"与"管理员授权"
 * 在流里长得一模一样（维护者原话："插件主动行为鉴权和用户主动行为混在一起，难以辨认"）。
 */
function actorLabel(actor: AuditActor | undefined): string {
  const kind = actor?.kind;
  if (kind === 'plugin') return t('cli.audit.actor.plugin', { ref: actor?.ref ?? '?' });
  if (kind === 'core') return t('cli.audit.actor.core');
  if (kind === 'operator') {
    const via = actor?.via ?? 'internal';
    const key = `cli.audit.actor.operator.${via}`;
    const text = t(key);
    // 认不出的通道原样回退（不编"某个通道"）
    return text === key ? t('cli.audit.actor.operator.internal') : text;
  }
  return t('cli.audit.actor.unknown');
}

/** **关于谁/什么**那一列（`self` 是"插件自己的事"，不打出来——否则每行都是废话） */
function subjectLabel(subject: AuditSubject | undefined): string | null {
  if (!subject) return null;
  if (subject.kind === 'self' || subject.kind === 'none') return null;
  const key = `cli.audit.subjectKind.${subject.kind}`;
  const label = t(key);
  return t('cli.audit.subject', {
    label: label === key ? subject.kind : label,
    ref: subject.ref ?? '',
  });
}

/** 管理动作的**闭集明文**（码值：来源/权限点/别名/指纹…）：渲染成 `k=v`，最多三对，免得一行刷屏 */
function detailLabel(detail: AuditEntry['detail']): string | null {
  if (!detail) return null;
  const keys = Object.keys(detail).slice(0, 3);
  if (keys.length === 0) return null;
  return keys.map((k) => `${k}=${Array.isArray(detail[k]) ? (detail[k] as string[]).join(',') : String(detail[k])}`).join(' ');
}

/**
 * 审计一行：`时刻  谁  结果  组（方法）  → 关于谁  细节  错误码  耗时`。
 * 后几段按需出现（没有就不占位）；`durationMs` 对排障最有用，所以只要有就打。
 */
export function auditLine(e: AuditEntry): string {
  const dot = e.method.indexOf('.');
  const group = dot === -1 ? e.method : e.method.slice(0, dot);
  const labelKey = `cli.audit.group.${group}`;
  const label = t(labelKey);
  const resultKey = `cli.audit.result.${e.result}`;
  const resultText = t(resultKey);
  const parts = [
    clockOf(e.ts),
    actorLabel(e.actor),
    resultText === resultKey ? e.result : resultText,
    t('cli.audit.what', { group: label === labelKey ? group : label, method: e.method }),
  ];
  const subject = subjectLabel(e.subject);
  if (subject !== null) parts.push(subject);
  const detail = detailLabel(e.detail);
  if (detail !== null) parts.push(detail);
  if (e.error?.code !== undefined) parts.push(t('cli.audit.error', { code: e.error.code }));
  if (e.timing && typeof e.timing.ms === 'number') {
    parts.push(t('cli.audit.ms', { ms: String(Math.round(e.timing.ms)) }));
  }
  return parts.join('  ');
}
