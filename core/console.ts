// 守护进程的**前台控制台**：在真终端里管这个核心（`status` / `list` / `stop` + 插件生命周期）。
//
// 口径：
//   · **只在 stdin 是 TTY 时挂**（`shouldAttachConsole`）：`cli-contract.md` §3 的规矩是"非 TTY 不猜"，
//     服务模式（pm2 / systemd / 管道）下 stdin 读到 EOF 是经典悬案，所以那里**根本不碰 stdin**；
//   · **语义与审计复用 manager**：安装 / 卸载 / 重载 / 启用 / 禁用调的就是 `spc` 走 HTTP 时最终落到的那批
//     manager 方法（审计写在 manager 层）⇒ 这里**没有第二份实现**，只是换了个传输（终端而不是 HTTP）；
//   · **语法扁平**：这里是 `install <目录>`，CLI 是 `spc plugin install <目录>`；旗标与 `spc` **同名同义**
//     （`--source` / `--grant` / `--accept-key-change`），**不新增** `spc` 里没有的东西 —— 学一套就够；
//   · **作者工具不进**（`keygen` / `new` / `build` / `pack` 是 `spcdev` 的事，与守护进程无关）；
//   · **客户端专属不进**（`--json`、退出码、`about` 是 CLI 的呈现契约）。
//
// ⚠️ stdin 关闭（终端没了）**不等于停机**：只把控制台摘掉，守护进程继续跑 —— 免得"关掉一个窗口"
// 顺手停掉线上的核心。要停就 `stop` / `spc daemon stop` / SIGINT / SIGTERM。
import { createInterface, type Interface } from 'node:readline';
import { renderThrown, t } from './i18n';

/** 控制台能管的插件生命周期动词（与 `spc plugin <verb>` 一一对应） */
export type PluginVerb = 'install' | 'uninstall' | 'reload' | 'enable' | 'disable';
const PLUGIN_VERBS: readonly PluginVerb[] = ['install', 'uninstall', 'reload', 'enable', 'disable'];

export type ConsoleCommand =
  | { kind: 'empty' }
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'list' }
  /** 单个插件的详情：show <引用>（只读） */
  | { kind: 'show'; ref: string }
  | { kind: 'stop' }
  /** 敲的是 `spc …`（管理面命令）：控制台不执行它，但要说清该怎么办 —— 见 `attachConsole` */
  | { kind: 'cli'; raw: string; isStop: boolean }
  /** 插件生命周期：`verb` + 原始参数（旗标解析交给 handler 那边的同一套语义） */
  | { kind: 'plugin'; verb: PluginVerb; args: string[] }
  | { kind: 'usage'; verb: string; need: 'target' | 'ref' }
  /** 不接受参数的命令却带了参数：明说，**不静默忽略**（`stop now` 不该被当成 `stop`） */
  | { kind: 'extra'; raw: string }
  | { kind: 'unknown'; raw: string };

/**
 * 按 shell 的规矩拆词：`"带 空格 的路径"` 与 `'单引号'` 都支持，反斜杠转义引号。
 * 自己写而不是抓 CLI 的解析器：那是**客户端**的实现（`core/cli.ts`），守护进程不该依赖它。
 */
export function splitConsoleArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === '\\' && line[i + 1] === quote) {
        cur += quote;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (has || cur !== '') out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
  }
  if (has || cur !== '') out.push(cur);
  return out;
}

/**
 * 一行 → 一条命令。**纯函数**（用例不必真开 readline）。
 * 容忍首尾空白与大小写：这是**人**敲的，不是机器发的协议。
 */
export function parseConsoleLine(line: string): ConsoleCommand {
  const raw = line.trim();
  if (raw === '') return { kind: 'empty' };
  // `spc …` 先认出来：人在这儿的肌肉记忆就是敲那一条（`spc plugin list` / `spc daemon stop`），
  // 回一句"未知命令"等于把人晾着 —— 要告诉他这里有什么、以及那条该在哪敲。
  const cli = /^(spc|spcdev)\b\s*(.*)$/i.exec(raw);
  if (cli) return { kind: 'cli', raw, isStop: /^daemon\s+stop$/i.test(cli[2]!.trim()) };

  const tokens = splitConsoleArgs(raw);
  const head = (tokens[0] ?? '').toLowerCase();
  const rest = tokens.slice(1);

  if (PLUGIN_VERBS.includes(head as PluginVerb)) {
    const verb = head as PluginVerb;
    // `install` 要一个目标（目录或 `.spc`）；其余四个要一个插件引用 —— 缺了就报该动词的用法，别猜
    if (rest.length === 0) return { kind: 'usage', verb, need: verb === 'install' ? 'target' : 'ref' };
    return { kind: 'plugin', verb, args: rest };
  }
  switch (head) {
    case 'help':
      return rest.length === 0 ? { kind: 'help' } : { kind: 'extra', raw };
    case 'status':
      return rest.length === 0 ? { kind: 'status' } : { kind: 'extra', raw };
    case 'list':
      return rest.length === 0 ? { kind: 'list' } : { kind: 'extra', raw };
    case 'show':
      // `show <引用>`：单个插件的详情（只读）。多给参数或漏参数都按用法处理，不猜
      return rest.length === 1 ? { kind: 'show', ref: rest[0]! } : { kind: 'usage', verb: 'show', need: 'ref' };
    case 'stop':
    case 'exit':
    case 'quit':
      return rest.length === 0 ? { kind: 'stop' } : { kind: 'extra', raw };
    default:
      return { kind: 'unknown', raw };
  }
}

/** 挂不挂控制台：**只认 TTY**（pm2 / systemd / 重定向一律不挂，连 stdin 都不碰） */
export function shouldAttachConsole(stdin: { isTTY?: boolean } | undefined): boolean {
  return stdin?.isTTY === true;
}

/**
 * `install` 的参数：旗标与 `spc plugin install` **同名同义**（`--source` / `--grant` / `--accept-key-change`）。
 *
 * **不认识的旗标一律拒**（fail-closed）：`--sorce` 这种手滑若被忽略，就会按缺省源装错桶 —— 而"装错桶"
 * 在本项目的身份模型里等于装成了**另一个插件**（身份 = `(origin, id)`）。
 */
export function parseInstallArgs(args: string[]): {
  target?: string;
  grants: string[];
  source?: string;
  acceptKeyChange: boolean;
  /** 不认识的 `--…` 或多余的普通参数（要原样报给用户，别替他猜） */
  bad: string[];
} {
  const grants: string[] = [];
  let source: string | undefined;
  let acceptKeyChange = false;
  const positional: string[] = [];
  const bad: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--grant' && args[i + 1] !== undefined) grants.push(args[(i += 1)]!);
    else if (a === '--source' && args[i + 1] !== undefined) source = args[(i += 1)]!;
    else if (a === '--accept-key-change') acceptKeyChange = true;
    else if (a.startsWith('--')) bad.push(a);
    else positional.push(a);
  }
  if (positional.length > 1) bad.push(...positional.slice(1));
  return {
    ...(positional[0] === undefined ? {} : { target: positional[0] }),
    grants,
    ...(source === undefined ? {} : { source }),
    acceptKeyChange,
    bad,
  };
}

export interface ConsoleHandlers {
  /** 核心状态：**调用方**给行（数据在守护进程那边），这里只负责渲染与分发 */
  status: () => string[];
  /** 已安装插件：同上，一行一个 */
  list: () => string[];
  /** 停机：调用方注入（守护进程传的就是它自己那个 `shutdown()`） */
  stop: () => void;
  /**
   * 插件生命周期：调用方注入。**抛错就是失败**（用例与守护进程都走 `renderThrown` 渲染），
   * 返回的行是成功时要打的（一般一行）。
   */
  plugin: (verb: PluginVerb, args: string[]) => Promise<string[]>;
  /** 单个插件的详情（show <引用>）：与 spc plugin status 同一份渲染 */
  show: (ref: string) => string[];
}

/**
 * 挂上控制台并返回 readline 实例（调用方通常不需要它，用例需要）。
 * `output` 同时用于回显与提示符；每一轮结束会把提示符再打一次。
 */
export function attachConsole(
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
  handlers: ConsoleHandlers,
): Interface {
  const rl = createInterface({ input: io.input, output: io.output, prompt: '> ', terminal: true });
  let stopping = false;
  let chain: Promise<void> = Promise.resolve(); // 命令**串行**：安装还没完就又敲卸载，顺序必须确定
  const say = (line: string): void => void io.output.write(`${line}\n`);

  const run = async (cmd: ConsoleCommand): Promise<void> => {
    switch (cmd.kind) {
      case 'empty':
        break;
      case 'help':
        for (const l of t('console.help').split('\n')) say(l);
        break;
      case 'status':
        for (const l of handlers.status()) say(l);
        break;
      case 'list':
        for (const l of handlers.list()) say(l);
        break;
      case 'show':
        for (const l of handlers.show(cmd.ref)) say(l);
        break;
      case 'plugin':
        try {
          for (const l of await handlers.plugin(cmd.verb, cmd.args)) say(l);
        } catch (e) {
          // 与 CLI 同一套渲染（`err.*` 文案 + 参数），控制台不另造一份说法
          say(renderThrown(e));
        }
        break;
      case 'usage':
        say(t(cmd.need === 'target' ? 'console.usage.install' : 'console.usage.ref', { verb: cmd.verb }));
        break;
      case 'extra':
        say(t('console.noargs', { line: cmd.raw }));
        break;
      case 'cli':
        // 敲的是管理面命令：停机那条直接告诉他就地怎么敲，其余的说清去哪儿敲
        say(cmd.isStop ? t('console.cli.stop') : t('console.cli.other', { line: cmd.raw }));
        break;
      case 'unknown':
        say(t('console.unknown', { line: cmd.raw }));
        break;
    }
  };

  say(t('console.attached'));
  rl.prompt();

  rl.on('line', (line) => {
    if (stopping) return; // 已经在下线了：多敲的几行不再理会（同一次停机只走一遍）
    const cmd = parseConsoleLine(line);
    if (cmd.kind === 'stop') {
      stopping = true;
      say(t('console.stopping'));
      handlers.stop();
      return; // 停机路径会接管（正常是打日志然后退出），不再打提示符
    }
    chain = chain.then(() => run(cmd)).then(() => rl.prompt());
  });

  // stdin 关闭 = 终端没了：**只摘控制台，不停机**（见文件头）
  rl.on('close', () => {
    if (!stopping) say(t('console.detached'));
  });
  return rl;
}
