// 插件视图 → 终端行：**CLI 与前台控制台共用这一份**（同一件事同一句话；不造第二套说法）。
//
// 为什么单独一个模块：以前这些行写在 `core/cli.ts` 里（客户端），控制台要用就只能抄一遍 ——
// 抄出来的第二份迟早和第一份不一致。渲染归这里，两个入口都只是"取行 + 打出来"。
//
// 这里只做渲染与**一条派生计算**：`missingPoints()`（声明了、但还没授予的 **host 作用域**点）。
// 判 scope 用的是权限注册表（**静态表**，不需要守护进程状态），查不到的点**不判**（见那段注释）。
import { t } from '../i18n';
import { shortFingerprint } from '../sources/keys';
import type { PluginView } from './manager';

/** 一行摘要（`list` 与 `status` 的第一行都是它） */
export function pluginHeadline(p: PluginView): string {
  return t('cli.plugin.line', {
    // 打**完整引用**（身份是 `(origin, id)`）：同 id 不同来源是两个插件，只打裸 id 分不清是谁，
    // 而且管理员要复制这个字符串去做后续命令
    id: p.ref,
    version: p.version.name,
    state: p.state,
    enabled: p.enabled ? t('cli.yes') : t('cli.no'),
    type: p.type,
  });
}

// 「还差哪些权限点」由**守护进程**在视图里算好（`PluginView.missingGrants`）：只有它持有完整的点表
// （`exec.template.*` 在守护进程启动时注册、跨插件点由能力快照派生，客户端进程那本表里没有它们）。

/** 授权面那几行（`status` / 控制台 `show` 用；`list` 不打，免得一屏全是权限） */
export function pluginPermissionLines(p: PluginView): string[] {
  const out: string[] = [];
  if (p.permissions.length > 0) out.push(t('cli.plugin.permissions', { points: p.permissions.join(', ') }));
  if (p.grants.length > 0) out.push(t('cli.plugin.grants', { grants: p.grants.join(', ') }));
  const missing = p.missingGrants;
  if (missing.length > 0) out.push(t('cli.plugin.missing', { points: missing.join(', ') }));
  return out;
}

/** 摘要之外的附加行（`list` 与 `status` 都用：能力 / 指纹 / 错误 / 待重载） */
export function pluginExtraLines(p: PluginView, fingerprint: 'none' | 'short' | 'full' = 'none'): string[] {
  const out: string[] = [];
  if (p.authorFingerprint && fingerprint !== 'none') {
    out.push(
      t(fingerprint === 'full' ? 'cli.plugin.author' : 'cli.plugin.author.short', {
        fingerprint: fingerprint === 'full' ? p.authorFingerprint : shortFingerprint(p.authorFingerprint),
      }),
    );
  }
  if (p.capabilities.length > 0) out.push(t('cli.plugin.caps', { caps: p.capabilities.join(', ') }));
  if (p.lastError) out.push(t('cli.plugin.lastError', { code: p.lastError.code }));
  if (p.reloadRequired) out.push(t('cli.plugin.reloadRequired'));
  return out;
}

/** 一个插件的**详情**（`spc plugin status` 与控制台 `show` 共用）：目录 / 授权面 / 能力 / 指纹 / 错误 */
export function pluginDetailLines(p: PluginView, fingerprint: 'none' | 'short' | 'full' = 'none'): string[] {
  return [
    pluginHeadline(p),
    t('cli.plugin.detail', { dir: p.dir, dataDir: p.dataDir, config: p.configPath }),
    ...pluginPermissionLines(p),
    ...pluginExtraLines(p, fingerprint),
  ];
}
