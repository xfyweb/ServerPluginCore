// 两个命令共用的启动器实现：`spc`（管理面）与 `spcdev`（作者工具）。
//
// 为什么要分成两个命令（2026-09-25 用户拍板）：
//   · `spc` = **本机管理员**的管理面（status / daemon / plugin / source）——**跟着装好的核心走**，多数命令要 daemon；
//   · `spcdev` = **插件作者**的工具（keygen / new / check / build / pack / watch）——**跟着这份仓库走**，全程本地。
// 两者受众不同、前提不同、发布节奏也不同：P5 要把核心做成可分发的运行时（`spc` 随它走），
// 而 `spcdev` 必须与**你正在开发的这份仓库**同版本 —— 混在一个入口里迟早出现"工具与本体不一致"。
//
// 实现要点：
//   · **cwd 保持调用者所在目录**（工作区发现、`spcdev check .` 都靠它）；
//   · `tsx` 用**启动器自己所在位置**解析成绝对路径再交给 `--import` —— 按 cwd 解析的话，
//     在仓库外（插件目录被单独 clone 走）会 `ERR_MODULE_NOT_FOUND`（实测踩过）；
//   · 退出码与信号原样透传（脚本 / CI 靠它判断成败）。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @param {'admin' | 'dev'} mode 走哪个入口（`core/cli.ts` / `core/cli-dev.ts`）
 * @param {string} commandName 命令名（只用于报错信息）
 */
export function launch(mode, commandName) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, '..');
  const entry = join(repo, 'core', mode === 'dev' ? 'cli-dev.ts' : 'cli.ts');

  let tsxEntry;
  try {
    tsxEntry = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  } catch {
    console.error(`[${commandName}] 找不到 tsx：请先在仓库根跑 \`pnpm install\`（${commandName} 依赖本体的开发依赖）。`);
    process.exit(1);
  }

  const child = spawn(process.execPath, ['--import', tsxEntry, entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd(),
    // 给 `about` 留个记号：这样"手上这条命令是全局命令还是直接跑仓库入口"一眼可见
    env: { ...process.env, SPC_LAUNCHER: commandName },
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  child.on('error', (err) => {
    console.error(`[${commandName}] 启动失败：${err.message}`);
    process.exit(1);
  });
}
