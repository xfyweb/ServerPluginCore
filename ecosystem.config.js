// pm2 的应用清单：在仓库根**裸敲 `pm2 start`** 就能起（这就是放这个文件的目的 —— 少记一条命令）。
//
// ⚠️ 形状是「ESM + **命名导出 `apps`**」，两个细节都不是随手写的（2026-10-13 读 pm2 7.0.4 源码 + 实测）：
//   · 文件名必须是 `ecosystem.config.js`：pm2 的默认名写死在 `lib/constants.js`（`APP_CONF_DEFAULT_FILE`），
//     裸 `pm2 start` **只**找这一个名字 —— `ecosystem.config.cjs` / `.json` 它都不找；
//   · 内容必须是 **ESM**：本仓库 `package.json` 是 `"type": "module"`，那个 `.js` 只能按 ESM 解析
//     （写 `module.exports` 会 `module is not defined in ES module scope`）；
//   · 必须用 **命名导出 `apps`** 而不是 `export default`：pm2 走的是
//     `Common.parseConfig` → `require(文件)` → 直接读 `config.apps`，**它不解 `.default`**
//     （实测：只写 `export default` 时 pm2 报 `No script path - aborting`）。
//
// 关键两条（不是随手填的）：
//   · `script: 'server.js'` —— 那个入口**与守护进程同进程**，所以 pm2 记录到、发信号到的就是守护进程本身；
//   · `kill_timeout: 15000` —— 守护进程自己的停机超时默认 **10 s**（`SPC_SHUTDOWN_TIMEOUT_MS`），
//     而 pm2 默认 kill_timeout 只有 **1600 ms** ⇒ 不给足余量，pm2 会在优雅停机做完之前就 SIGKILL，
//     插件来不及 stop、审计也少一条尾巴。
//
// 环境变量：**这里不写端口/目录**，免得盖掉你 shell 里那份 —— pm2 会把启动时的环境原样传给应用
// （`SPC_PORT` / `SPC_STATE_DIR` / `SPC_AUDIT_DIR` / `SPC_SHUTDOWN_TIMEOUT_MS`）。
// 要固定下来就取消下面 `env` 里的注释（或 `pm2 set`、或写进系统环境变量）。
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const apps = [
  {
    name: 'spc',
    script: 'server.js',
    cwd: here, // 从哪个目录敲 pm2 都行
    // 守护进程 SIGINT / SIGTERM 都接（pm2 默认发 SIGINT）⇒ 停机走它自己的优雅停机
    kill_timeout: 15000,
    autorestart: true,
    max_restarts: 10,
    // 崩溃循环就别一直重启了：等 4 秒再拉起（起不来通常是端口被占或状态目录不可写）
    restart_delay: 4000,
    merge_logs: true,
    time: true, // 日志行带时间戳（pm2 写 ~/.pm2/logs/）
    env: {
      // SPC_PORT: '18777',                          // 默认就是 18777
      // SPC_STATE_DIR: '<状态目录的绝对路径>',        // 默认是 <仓库>/.spc
      // SPC_AUDIT_DIR: '<审计目录的绝对路径>',
      // SPC_SHUTDOWN_TIMEOUT_MS: '10000',           // 改大就同时把上面的 kill_timeout 一起改大
    },
  },
];

// 顺手也给 `export default` 一份：万一以后 pm2 学会了解 `.default`，两条路都还在（现在它只用上面那个命名导出）
export default { apps };
