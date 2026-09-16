// 示例插件：演示 P1.5 装载契约（init / start / stop + ctx）与宿主 API 的几条主线
//
// 它不是"最小示例"，而是**可验收的活体**：pnpm spike 会真的把它装起来、跑起来、停下去。
// 权限面刻意覆盖三条不同的授权路径：
//   · fs / kv / timers → scope=self，声明即用（不需要管理员授予）
//   · exec.template.git.version → scope=host，**必须管理员逐点授予**，否则 PERMISSION_DENIED
import { events, exec, fs, kv, lifecycle, timers } from '@host/api';
import type { PluginContext } from '@spc/sdk';

let heartbeat: { timerId: string } | undefined;

export async function init(ctx: PluginContext) {
  ctx.logger.info(`init: dataDir=${ctx.dataDir}`);

  // 0) 契约协商：先问清楚"这个核心提供哪一版 API"
  const v = lifecycle.version();
  ctx.logger.info(`core=${v.core} api=${v.api}`);

  // 1) kv：插件作用域持久化（值可以是任意可 JSON 化的数据）
  const starts = (kv.get<number>('starts') ?? 0) + 1;
  kv.set('starts', starts);

  // 2) fs：只能碰自己的数据目录（相对路径按数据目录解析）
  //    配置是**只读快照**，默认值由宿主按 configSchema 补齐
  const greeting = String(ctx.config.greeting ?? 'hello');
  fs.write('started.log', `${greeting} #${starts}\n`);
  const back = fs.read('started.log');
  ctx.logger.info(`record=${back.content.trim()} bytes=${back.bytes}`);

  // 3) 列目录 + 取属性（作用域同样收敛在数据目录内）
  const listed = fs.list('.');
  const names = listed.entries.map((e) => `${e.name}(${e.type})`).join(',');
  ctx.logger.info(`files=[${names}]${listed.truncated ? ' (truncated)' : ''}`);

  // 4) exec：只能调已注册模板。未授予 → PERMISSION_DENIED（按英文码分支，不匹配文案）
  try {
    const raw = exec.run('core:git.version') as unknown as string;
    const parsed = JSON.parse(raw) as { stdout: string };
    ctx.logger.info(`git: ${parsed.stdout.trim()}`);
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'UNKNOWN';
    ctx.logger.warn(`git.version unavailable: ${code}`);
  }
}

export async function start(ctx: PluginContext) {
  // 5) timers：宿主侧调度，插件不保活；回调里可以继续用宿主 API
  const seconds = Number(ctx.config.heartbeatSeconds ?? 30);
  heartbeat = timers.every(seconds * 1000, () => {
    const at = Date.now();
    events.publish('hello.heartbeat', { at }); // topic 必须已在 manifest 声明
    kv.set('lastHeartbeatAt', at);
  });
  ctx.logger.info(`started (heartbeat every ${seconds}s)`);
}

export async function stop(ctx: PluginContext) {
  // 宿主卸载时会自动清掉定时器；显式 clear 让语义更清楚（stop 必须幂等）
  if (heartbeat) {
    timers.clear(heartbeat.timerId);
    heartbeat = undefined;
  }
  ctx.logger.info('stopped');
}
