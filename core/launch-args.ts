// **守护进程启动器的参数面**（唯一真相）：`server.js` 与 `run.*` 的旗标 / 环境变量都在这张表里。
//
// 口径（2026-10-14 定）：
//   · 表**只覆盖守护进程启动器** —— 只有管启动的人需要了解这些；用 `spc` 的人可能根本改不了启动方式；
//   · **未知参数一律拒**（与 CLI「不认识的旗标一律拒」同一条 fail-closed 口径）——不做"静默忽略"，
//     否则 `--prot 18778` 这种手滑会按默认端口起来，而人以为改过了；
//   · **常用项由启动器翻译成环境变量**再交给核心：核心侧不新增旗标解析，仍只认环境变量与 `--maintenance`；
//   · `--maintenance` **不进环境变量**：它留在 argv 里（核心读 `process.argv`），启动器只做校验。
//
// ⚠️ 分类（`kind`）是给守门用例用的：`core/**` 里每个 `process.env.SPC_*` 读取点**都必须出现在本表里**，
// 否则用例红 —— 免得变量越加越多、却没有人知道它们存在（`ops` 进帮助，`internal`/`test` 只做清册）。
import { t } from './i18n';

export type LaunchArgKind = 'ops' | 'internal' | 'test';

export interface LaunchArg {
  /** 旗标（不含 `--`）；没有就是"只能用环境变量" */
  flag?: string;
  /** 环境变量名 */
  env: string;
  /** 默认值（帮助里显示；`internal`/`test` 可省） */
  fallback?: string;
  kind: LaunchArgKind;
  /** 一行说明的 locale 键 */
  descKey: string;
  /** 值是否为"开关"（不带值） */
  boolean?: boolean;
}

export const LAUNCH_ARGS: readonly LaunchArg[] = [
  // ---- ops：帮助里显示 ----
  { flag: 'port', env: 'SPC_PORT', fallback: '18777', kind: 'ops', descKey: 'launcher.arg.port' },
  { flag: 'state-dir', env: 'SPC_STATE_DIR', fallback: '<仓库>/.spc', kind: 'ops', descKey: 'launcher.arg.state_dir' },
  { flag: 'audit-dir', env: 'SPC_AUDIT_DIR', fallback: '<状态目录>/audit', kind: 'ops', descKey: 'launcher.arg.audit_dir' },
  { flag: 'lang', env: 'SPC_LANG', fallback: '按 LANGUAGE / LC_ALL / LANG / 平台探测', kind: 'ops', descKey: 'launcher.arg.lang' },
  {
    flag: 'shutdown-timeout-ms',
    env: 'SPC_SHUTDOWN_TIMEOUT_MS',
    fallback: '10000',
    kind: 'ops',
    descKey: 'launcher.arg.shutdown_timeout',
  },
  {
    flag: 'plugin-call-timeout-ms',
    env: 'SPC_PLUGIN_CALL_TIMEOUT_MS',
    fallback: '见 config 的限额默认',
    kind: 'ops',
    descKey: 'launcher.arg.plugin_call_timeout',
  },
  {
    flag: 'plugin-max-call-depth',
    env: 'SPC_PLUGIN_MAX_CALL_DEPTH',
    fallback: '见 config 的限额默认',
    kind: 'ops',
    descKey: 'launcher.arg.plugin_max_depth',
  },
  {
    flag: 'plugin-failed-restart',
    env: 'SPC_PLUGIN_FAILED_RESTART',
    fallback: 'manual',
    kind: 'ops',
    descKey: 'launcher.arg.plugin_failed_restart',
  },
  { flag: 'maintenance', env: '', kind: 'ops', descKey: 'launcher.arg.maintenance', boolean: true },
  // ---- internal / test：只做清册（帮助不显示）----
  { env: 'SPC_KEYRING_DIR', kind: 'internal', descKey: 'launcher.arg.internal' },
  { env: 'SPC_DATA_DIR', kind: 'internal', descKey: 'launcher.arg.internal' },
  { env: 'SPC_AUTHORS_FILE', kind: 'internal', descKey: 'launcher.arg.internal' },
  { env: 'SPC_REPO_ROOTS', kind: 'internal', descKey: 'launcher.arg.internal' },
  { env: 'SPC_LAUNCHER', kind: 'internal', descKey: 'launcher.arg.internal' },
  { env: 'SPC_BUILD_ID', kind: 'internal', descKey: 'launcher.arg.internal' },
  { env: 'SPC_RELEASED_AT', kind: 'internal', descKey: 'launcher.arg.internal' },
  { env: 'SPC_EMULATED_PLATFORM', kind: 'internal', descKey: 'launcher.arg.internal' },
  { env: 'SPC_VERIFY_ENGINE', kind: 'test', descKey: 'launcher.arg.test' },
  { env: 'SPC_TEST_SECRET', kind: 'test', descKey: 'launcher.arg.test' },
];

/** 帮助文本（`--help` / 未知参数时打印）。只渲染 ops 那半。 */
export function renderLaunchHelp(): string {
  const lines = [t('launcher.help.usage'), '', t('launcher.help.flags')];
  for (const a of LAUNCH_ARGS.filter((x) => x.kind === 'ops')) {
    const left = a.boolean === true ? `--${a.flag}` : `--${a.flag} <值>`;
    const fallback = a.fallback === undefined ? '' : `（默认 ${a.fallback}）`;
    const env = a.env === '' ? '' : `  [${a.env}]`;
    lines.push(`  ${left.padEnd(32)}${t(a.descKey)}${fallback}${env}`);
  }
  lines.push('', t('launcher.help.hint'));
  return lines.join('\n');
}

export type LaunchParse =
  | { ok: true; env: Record<string, string>; help?: false }
  | { ok: true; help: true }
  | { ok: false; bad: string[] };

/**
 * 解析启动器参数：认识的旗标 ⇒ 写进 `process.env` 的那一份（**旗标优先于已有环境变量**：
 * 旗标是更具体的意图）；`--maintenance` 原样留在 argv 里（核心读它）。
 * 不认识的参数一律拒 —— 调用方负责打印帮助并以退出码 1 结束。
 */
export function parseLaunchArgs(argv: readonly string[]): LaunchParse {
  const env: Record<string, string> = {};
  const bad: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (raw === '--help' || raw === '-h') return { ok: true, help: true };
    if (raw === '--maintenance') continue; // 留在 argv：核心自己读
    const eq = raw.indexOf('=');
    const name = (raw.startsWith('--') ? raw.slice(2, eq === -1 ? undefined : eq) : '').trim();
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);
    const spec = LAUNCH_ARGS.find((a) => a.flag === name);
    if (spec === undefined || spec.env === '--maintenance') {
      bad.push(raw);
      continue;
    }
    const value = inlineValue ?? argv[i + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
      bad.push(raw);
      continue;
    }
    env[spec.env] = value;
    if (inlineValue === undefined) i += 1;
  }
  return bad.length > 0 ? { ok: false, bad } : { ok: true, env };
}
