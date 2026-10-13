// 守护进程的**进程管理器入口**：`pm2 start server.js` / systemd / 计划任务 / 双击 `run.*` 都走它。
//
// 为什么需要它：真正的入口是 `core/server.ts`（TypeScript），只有 `spc` / `pnpm daemon` 那条链会替它加载 tsx；
// 而进程管理器只会 `node server.js` —— 它们不认识 `.ts`，也不会给我们加 `--import`。
//
// 两条设计选择（都有理由，别随手改）：
//   1. **在同一个进程里加载**（`tsImport`），**不 spawn 子进程**：pm2 / systemd 要记录、要发信号的必须是
//      **守护进程本身**。中间夹一层的话，那个"父进程先死会把子进程一起带走"的坑立刻回来
//      （本仓库 `bin/_launch.mjs` 上刚踩过，见那里的注释）。
//   2. **不打印自己的横幅**：守护进程自己会打（本地化文案在 `core/i18n/locales/`）。这里再打一份就是两份真值。
//
// 环境变量（与直接跑守护进程完全一致）：`SPC_PORT`（默认 18777）· `SPC_STATE_DIR` · `SPC_AUDIT_DIR` ·
// `SPC_SHUTDOWN_TIMEOUT_MS`。停机：`spc daemon stop`，或给本进程发 SIGINT / SIGTERM（两个都接）。
import { tsImport } from 'tsx/esm/api';

await tsImport('./core/server.ts', import.meta.url);
