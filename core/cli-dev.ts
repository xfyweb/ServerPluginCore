// `spcdev` 入口：**插件作者工具**（keygen / new / check / build / pack / watch / permission）
//
// 与 `core/cli.ts`（`spc` = 管理面）分开的**两个入口、两份受众**：
//   · `spc`    → 本机管理员，多数命令要 daemon，P5 起随核心运行时一起分发；
//   · `spcdev` → 插件作者，全程本地，但**必须与这份仓库同版本**。
// 实现全在 `build/cli.ts`（`runDevCli` 分发），这里只是入口 + about/usage。
import { runDevCli } from '../build/cli';
import { printAbout } from './about';
import { t } from './i18n';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';

if (cmd === 'about') {
  printAbout('dev');
  process.exit(0);
}
if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(t('cli.dev.usage'));
  process.exit(0);
}
process.exit(await runDevCli(cmd, argv.slice(1)));
