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
import { clearLine, createInterface, cursorTo, type Interface } from 'node:readline';
import { format } from 'node:util';
import { enterChannel } from './audit';
import { renderThrown, t } from './i18n';

/** 控制台能管的插件生命周期动词（与 `spc plugin <verb>` 一一对应） */
export type PluginVerb =
  | 'install'
  | 'uninstall'
  | 'reload'
  | 'enable'
  | 'disable'
  /** 授权变更（维护模式里 CLI 不参与 ⇒ 控制台必须能做，2026-10-14 定） */
  | 'grant'
  | 'revoke';
const PLUGIN_VERBS: readonly PluginVerb[] = ['install', 'uninstall', 'reload', 'enable', 'disable', 'grant', 'revoke'];

/** 源管理（维护模式里 CLI 不参与 ⇒ 控制台也要能做；`log` / `audit tail` 明确不进控制台） */
export type SourceVerb = 'list' | 'add' | 'remove' | 'enable' | 'disable' | 'alias' | 'anchor';
const SOURCE_VERBS: readonly SourceVerb[] = ['list', 'add', 'remove', 'enable', 'disable', 'alias', 'anchor'];

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
  /** 源管理：`source <verb> …`（与 `spc source` 同名同义） */
  | { kind: 'source'; verb: SourceVerb; args: string[] }
  | { kind: 'usage'; verb: string; need: 'target' | 'ref' | 'ref-points' | 'source' }
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
    // `install` 要一个目标（目录或 `.spc`）；`grant`/`revoke` 要「引用 + 至少一个权限点」；
    // 其余要一个引用 —— 缺了就报该动词的用法，别猜
    if (rest.length === 0) return { kind: 'usage', verb, need: verb === 'install' ? 'target' : 'ref' };
    if ((verb === 'grant' || verb === 'revoke') && rest.length < 2) {
      return { kind: 'usage', verb, need: 'ref-points' };
    }
    return { kind: 'plugin', verb, args: rest };
  }
  if (head === 'source') {
    const verb = (rest[0] ?? '').toLowerCase();
    // 不给子命令 / 不认识 ⇒ 报用法（与 `spc source` 一样，**不猜**）
    if (!SOURCE_VERBS.includes(verb as SourceVerb)) return { kind: 'usage', verb: 'source', need: 'source' };
    if (verb !== 'list' && rest.length < 2) return { kind: 'usage', verb: 'source', need: 'source' };
    return { kind: 'source', verb: verb as SourceVerb, args: rest.slice(1) };
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
  /** 源管理：调用方注入（抛错即失败） */
  source: (verb: SourceVerb, args: string[]) => Promise<string[]>;
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

  /**
   * 提示符是否正**在屏幕上等输入**。
   *
   * 为什么要这个状态：异步输出（插件日志走**同进程**的 `console.*`，见 sandbox/manager）与提示符共用
   * 同一个 stdout，而 readline 不知道别人也在写 —— 它写了 `> `，别人的行从光标处接上去，提示符就被吃掉
   * （2026-10-14 维护者实测："CLI 操作可能导致控制台小箭头被吃"：插件日志刷了几屏，`>` 不见了）。
   * 做法：**只在提示符在场时**先清行、写完再把提示符补回来（`prompt(true)` 保留已敲了一半的输入）；
   * 命令进行中（提示符不在屏幕上）就照常直写 —— 否则一次 reload 的十几行日志会各补一个 `> `。
   */
  let awaiting = false;
  // 只有**明确是终端**才写控制序列：管道/文件时 `isTTY` 是 `undefined`（甚至 `false`），
  // 那种情况下写 `\x1b[2K` 只会污染日志（控制台本来就只挂在 TTY 上，这条是兜底）。
  const tty = (io.output as { isTTY?: boolean }).isTTY === true;

  /** 清掉当前行并回到行首（把提示符或半截输入挪开，给异步输出让位） */
  const yieldLine = (): void => {
    if (!tty) return;
    clearLine(io.output as never, 0);
    cursorTo(io.output as never, 0);
  };
  let closed = false; // readline 关掉之后**不许再 prompt**（会 ERR_USE_AFTER_CLOSE）
  const showPrompt = (preserve = false): void => {
    if (closed) return;
    awaiting = true;
    rl.prompt(preserve);
  };
  /** 打一行：提示符在场就让位 + 补回来；不在场就直写 */
  const say = (line: string): void => {
    const yielded = awaiting && tty;
    if (yielded) yieldLine();
    io.output.write(`${line}\n`);
    if (yielded && !stopping) showPrompt(true);
  };

  // 让**异步输出**也走同一条路：插件日志用的是 `console[hostLogMethod](…)`（沙箱与 manager 都在调），
  // 这里就地接管三个方法；控制台摘掉时原样还回去（`restoreConsole()`）。
  //
  // ⚠️ **不能调用原函数**（那会写回 `process.stdout`/`stderr`，与控制台的 `io.output` 不是一回事 ——
  // 生产里恰好是同一个流，但只要输出被换成别的流就会错位，用例也钉不住）。所以显式路由：
  //   · `console.log`（info 级）⇒ **控制台的输出流**（生产 = stdout）；
  //   · `console.warn` / `error` ⇒ 仍旧走 **stderr**（pm2 之类的分流别被搅乱）。
  // 格式与 console 一致（`util.format`），否则插件日志里的 `%s`、对象展开会变样。
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const route: Record<'log' | 'warn' | 'error', (text: string) => void> = {
    log: (text) => void io.output.write(`${text}\n`),
    warn: (text) => void process.stderr.write(`${text}\n`),
    error: (text) => void process.stderr.write(`${text}\n`),
  };
  for (const method of ['log', 'warn', 'error'] as const) {
    console[method] = (...args: unknown[]): void => {
      const yielded = awaiting && tty;
      if (yielded) yieldLine();
      route[method](format(...args));
      if (yielded && !stopping) showPrompt(true);
    };
  }
  const restoreConsole = (): void => {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  };

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
      case 'source':
        try {
          for (const l of await handlers.source(cmd.verb, cmd.args)) say(l);
        } catch (e) {
          say(renderThrown(e));
        }
        break;
      case 'plugin':
        try {
          for (const l of await handlers.plugin(cmd.verb, cmd.args)) say(l);
        } catch (e) {
          // 与 CLI 同一套渲染（`err.*` 文案 + 参数），控制台不另造一份说法
          say(renderThrown(e));
        }
        break;
      case 'usage': {
        // `grant`/`revoke` 的用法与 `spc plugin grant` **同一句**（学一套就够，控制台不另造说法）
        const key =
          cmd.need === 'target'
            ? 'console.usage.install'
            : cmd.need === 'ref-points'
              ? 'cli.plugin.grant.usage'
              : cmd.need === 'source'
                ? 'console.usage.source'
                : 'console.usage.ref';
        say(t(key, { verb: cmd.verb }));
        break;
      }
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
  showPrompt();

  rl.on('line', (line) => {
    if (stopping) return; // 已经在下线了：多敲的几行不再理会（同一次停机只走一遍）
    // 控制台是**进程内**调用（不走 HTTP）：把这一段标成 `console` 通道，
    // 于是里面管理动作的审计带 `via: console` —— "谁在什么时候改的"才分得清是 CLI 还是控制台。
    enterChannel('console');
    awaiting = false; // 提示符已被这次回车吃掉：命令进行中不必再让位
    const cmd = parseConsoleLine(line);
    if (cmd.kind === 'stop') {
      stopping = true;
      say(t('console.stopping'));
      handlers.stop();
      return; // 停机路径会接管（正常是打日志然后退出），不再打提示符
    }
    chain = chain.then(() => run(cmd)).then(() => showPrompt());
  });

  // stdin 关闭 = 终端没了：**只摘控制台，不停机**（见文件头）
  rl.on('close', () => {
    closed = true; // 先立旗：close 处理自己也会 say(...)，那时已经不能再 prompt 了
    restoreConsole(); // 控制台摘了就别再接管 console.*
    if (!stopping) say(t('console.detached'));
  });
  return rl;
}
