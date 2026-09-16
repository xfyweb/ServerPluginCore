// 模板执行（E3–E6）：固定 argv、env 白名单、cwd 固定、超时、输出截断
//
// 第一版是阻塞式（api-contract §4：P1 仅 exec.run 阻塞形态）；
// P2 的 TaskHandle（exec.spawn / 进程组杀树 / 环形缓冲）替换这里的内核，接口面不变。
// 诚实备注：`spawnSync` 只能杀直接子进程，杀不到孙子进程——P2 的任务模型负责进程组 kill（E5 完整形态）。
import { spawnSync } from 'node:child_process';
import { SpcError } from '../errors';
import { buildArgv } from './params';
import type { TemplateDef } from './templates';

/** 总是透传的基础环境变量（非敏感；缺了它们子进程常常跑不起来） */
const BASE_ENV = ['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** 输出达到 maxOutputBytes 上限被截断（E4） */
  truncated: boolean;
  durationMs: number;
}

/** env 白名单（E3/E6）：只有基础集 + 模板声明的变量能进子进程 */
export function buildEnv(def: TemplateDef, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of new Set([...BASE_ENV, ...(def.env ?? [])])) {
    const v = base[name];
    if (v !== undefined) env[name] = v;
  }
  return env;
}

/**
 * 实际生效的超时 = min(模板声明, 调用方剩余预算)。
 *
 * 模板的 `timeoutMs` 回答的是"这条命令最多允许多久"，而调用方（插件钩子）的剩余预算是
 * "现在总共只剩多久"。两者取小：否则"1 秒预算的钩子"能靠一条 120 秒的模板把核心阻塞两分钟
 * —— 解释器在 `spawnSync` 期间根本不跑，CPU 中断无从触发（见 sandbox 的墙钟事后校验）。
 *
 * `Math.max(1, …)` 是**必须的**：`spawnSync` 的 `timeout: 0` 在 Node 里表示"不超时"，
 * 负数直接抛 ERR_OUT_OF_RANGE。余额算到 0 或 -1 时不能顺势变成"无限等"（那是 fail-open）。
 */
export function effectiveTimeoutMs(templateMs: number, capMs?: number): number {
  if (capMs === undefined || !Number.isFinite(capMs)) return templateMs;
  return Math.max(1, Math.min(templateMs, Math.floor(capMs)));
}

export interface RunOptions {
  /** 调用方（钩子/定时器）当前剩余的 CPU 预算；缺省/Infinity 表示不额外封顶 */
  capMs?: number;
}

/** 执行一个已注册模板（插件侧看不到命令构造过程，只能给参数） */
export function runTemplate(def: TemplateDef, raw: Record<string, unknown>, opts: RunOptions = {}): ExecResult {
  const argv = buildArgv(def, raw);
  const budgetMs = effectiveTimeoutMs(def.timeoutMs, opts.capMs);
  const start = Date.now();
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: def.cwd, // 未声明则继承核心的 cwd；声明则必须是绝对路径（注册时已校验）
    env: buildEnv(def),
    timeout: budgetMs,
    killSignal: 'SIGKILL',
    maxBuffer: def.maxOutputBytes,
    encoding: 'utf8',
    shell: false, // E1/E7：永不经 shell
    windowsHide: true,
  });
  const durationMs = Date.now() - start;
  const errCode = (res.error as NodeJS.ErrnoException | undefined)?.code;

  if (errCode === 'ETIMEDOUT') {
    // 报**生效的**预算（可能来自调用方余额），否则排障时会照模板的值去查，方向就错了
    throw new SpcError('EXEC_TIMEOUT', { templateId: def.id, timeoutMs: String(budgetMs) });
  }
  // 输出超限：Linux 是 ERR_CHILD_PROCESS_STDIO_MAXBUFFER，Windows 是 ENOBUFS（Node 平台差异）
  if (errCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || errCode === 'ENOBUFS') {
    return {
      exitCode: res.status,
      signal: res.signal,
      stdout: clampText(res.stdout ?? '', def.maxOutputBytes),
      stderr: clampText(res.stderr ?? '', def.maxOutputBytes),
      truncated: true,
      durationMs,
    };
  }
  if (res.error) {
    throw new SpcError('EXEC_FAILED', { templateId: def.id, reason: errCode ?? 'spawn-failed' });
  }
  return {
    exitCode: res.status,
    signal: res.signal,
    stdout: clampText(res.stdout ?? '', def.maxOutputBytes),
    stderr: clampText(res.stderr ?? '', def.maxOutputBytes),
    truncated: false,
    durationMs,
  };
}

/** E4：交给插件的输出永不超过模板上限（按字节切，宁可少给） */
function clampText(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  return buf.length <= maxBytes ? s : buf.subarray(0, maxBytes).toString('utf8');
}
