// `about`：回答"我这条命令**是哪来的**"（`spc` 与 `spcdev` 两个入口共用）
//
// 为什么这事值得单独一个文件：同一个名字可能来自 `npm link`、将来的全局包、或直接 `node core/cli.ts`
// —— 三者对应的**代码可能不是同一份**，而"工具与本体不一致"是最难查的一类错
// （工具说没问题、本体说不行）。所以 about 必须能当场回答：仓库根在哪、怎么启动的、我是哪个命令。
import { resolve } from 'node:path';
import { t } from './i18n';
import { BRAND } from './version';

export type CliMode = 'admin' | 'dev';

/** 命令名与受众：`spc` = 管理面（跟着装好的核心走）/ `spcdev` = 作者工具（跟着这份仓库走） */
export const COMMAND_NAME: Record<CliMode, string> = { admin: 'spc', dev: 'spcdev' };

export function printAbout(mode: CliMode): void {
  console.log(BRAND);
  console.log(t('cli.about.repo', { repo: resolve(import.meta.dirname, '..') }));
  const launcher = process.env.SPC_LAUNCHER;
  console.log(
    launcher === COMMAND_NAME.admin || launcher === COMMAND_NAME.dev
      ? t('cli.about.launcher.link', { command: launcher })
      : t('cli.about.launcher.direct', { entry: process.argv[1] ?? '—' }),
  );
  console.log(t('cli.about.node', { node: process.version, platform: process.platform }));
  console.log(
    t('cli.about.mode', {
      command: COMMAND_NAME[mode]
    }),
  );
}
