// 构建层的 CLI 面（`spcdev keygen` / `new` / `check` / `permission list` / `build`）
//
// 分层照本项目一贯的做法：**这里只产出/渲染**，判定在 `keys.ts` / `scaffold.ts` / `check.ts` / `bundle.ts` /
// `facts.ts` / `sign.ts` 里，文案走 `t()` / `tError()`（核心与工具只给码 + 参数）。这些子命令**都是本地的**：
// 不握手、不连 daemon（`build` 也不联网：它只读源码与 node_modules）。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { SpcError } from '../core/errors';
import { renderThrown, t, tError } from '../core/i18n';
import { validateManifest } from '../sdk/validate';
import type { Manifest } from '../sdk/types';
import { bundlePlugin } from './bundle';
import { checkPlugin, type CheckResult, type Finding } from './check';
import { closureOf, reconcile, type BuildFacts, type DeclaredDep } from './facts';
import { generateAuthorKey, loadAuthorKey, saveAuthorKey } from './keys';
import { DYNAMIC_POINT_HINT, listPermissions } from './permissions';
import { checkAuthor, metaOf, payloadFiles, writeEnvelope } from './sign';
import { scaffoldPlugin } from './scaffold';
import {
  checkAuthorId,
  ensureWorkspaceConfig,
  loadWorkspace,
  patchWorkspaceConfig,
  suggestedAuthor,
  workspaceConfigFile,
  type Workspace,
} from './workspace';

/** 产物里的 bundle 文件名（`dist/manifest.json` 的 `entry` 指向它 —— 见 `build-layer-design.md` §6） */
const BUNDLE_FILE = 'bundle.js';

/** 问一句（交互）；抽成可注入的 IO，好让用例覆盖"回车用默认值 / 非法值被拒"而不必真开一个终端 */
export type AskFn = (question: string) => Promise<string>;

export interface CliIo {
  /** 能不能问（默认看 stdin 是不是 TTY）—— 非交互时**不问**，直接拒（见 `resolveAuthorId`） */
  interactive?: boolean;
  ask?: AskFn;
  /** 作者 ID 的建议默认值（默认从 `git config user.name` 推） */
  suggest?: () => string;
}

/**
 * 极简参数解析（位置参数与 `--flag [值]` 分开）。
 * 为什么这里自己写一份而不是复用 `core/cli.ts` 的那份：反过来的依赖会形成**循环导入**
 * （`core/cli.ts` 要 import 本文件来分发子命令），而这段逻辑只有十几行。
 */
export function parseArgs(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(a, next);
        i++;
      } else {
        flags.set(a, '');
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/**
 * 问一句（只问一次；答案非法就报错退出，**不做"追问到合法为止"的循环** —— 规矩一次说清，
 * 不合法就是不合法的输入，改完再跑一遍没有任何代价，此时磁盘上还什么都没写）。
 */
async function askOne(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolveAnswer) => {
      let done = false;
      const finish = (v: string): void => {
        if (!done) {
          done = true;
          resolveAnswer(v);
        }
      };
      rl.question(question, (answer) => finish(answer));
      // ⚠️ stdin 先关掉（Ctrl+Z、终端窗口被关）时 question 的回调**永远不会来** —— 少了这条就是挂死
      rl.once('close', () => finish(''));
    });
  } finally {
    rl.close();
  }
}

/**
 * 作者 ID 的来源顺序：`--author` > `.spcdev/config.json` 里已有的 > 交互询问（仅 TTY）。
 *
 * ⚠️ 非 TTY 又不给 `--author` ⇒ **拒**（照 ⑥b"非交互要给 `--yes`"的先例）。身份是一次性决定、
 * 且会印进插件 id，不该因为"跑在脚本里"就悄悄取一个默认值 —— `git config user.name` 只用作
 * **交互提问时的默认答案**，绝不顶替用户的回答。
 *
 * @returns 合法作者 ID；`null` = 已经报过错（调用方直接返回 1）
 */
async function resolveAuthorId(
  ws: Workspace,
  flags: Map<string, string>,
  opts: { prompt: boolean; io: CliIo },
): Promise<string | null> {
  const raw = flags.get('--author');
  if (raw !== undefined) {
    const author = checkAuthorId(raw);
    if (author === null) {
      console.error(tError({ code: 'AUTHOR_ID_INVALID', params: { id: raw } }));
      return null;
    }
    return author;
  }
  if (ws.config.author !== '') return ws.config.author;

  const file = workspaceConfigFile(ws);
  if (!opts.prompt || (opts.io.interactive ?? process.stdin.isTTY === true) !== true) {
    console.error(tError({ code: 'AUTHOR_ID_REQUIRED', params: { file } }));
    return null;
  }

  const suggested = (opts.io.suggest ?? suggestedAuthor)();
  const ask = opts.io.ask ?? askOne;
  const answer = (await ask(
    suggested === ''
      ? t('cli.keygen.askAuthor')
      : t('cli.keygen.askAuthorDefault', { suggested }),
  )).trim();
  const author = checkAuthorId(answer === '' ? suggested : answer);
  if (author === null) {
    console.error(tError({ code: 'AUTHOR_ID_INVALID', params: { id: answer } }));
    return null;
  }
  return author;
}

/**
 * `spcdev keygen [--author <作者 ID>] [--force] [--dir <目录>]`
 *
 * 生成作者密钥（只出作者签名；市场签名属 P4），**并问一次作者 ID 写进 `.spcdev/config.json`**
 * —— 这是整个工作区里唯一问身份的地方，`spcdev new` 之后都从配置取。
 */
export async function runKeygen(args: string[], io: CliIo = {}): Promise<number> {
  const { flags } = parseArgs(args);
  const start = resolve(flags.get('--dir') ?? process.cwd());
  const ws = loadWorkspace(start, { create: true });
  ensureWorkspaceConfig(ws);

  if (existsSync(ws.keyPath) && !flags.has('--force')) {
    // 窄例外：钥在、作者 ID 还没登记（典型：从另一台机器拷了 keys/ 过来）⇒ **只登记，绝不碰密钥**。
    // 没有这条，那个场景只剩"手改配置"或"--force 换掉身份"两条路，后者是破坏性的。
    if (ws.config.author === '') {
      const existing = loadAuthorKey(ws.keyPath); // 先确认这把钥是自洽的，再拿它登记身份
      const author = await resolveAuthorId(ws, flags, { prompt: true, io });
      if (author === null) return 1;
      const file = patchWorkspaceConfig(ws, { author });
      console.log(
        t('cli.keygen.authorRecorded', { author, file, fingerprint: existing.fingerprint }),
      );
      return 0;
    }
    // 已有密钥：**覆盖 = 换身份**，必须显式 --force
    const existing = loadAuthorKey(ws.keyPath);
    console.error(
      tError({ code: 'AUTHOR_KEY_EXISTS', params: { file: ws.keyPath, fingerprint: existing.fingerprint } }),
    );
    return 1;
  }

  const author = await resolveAuthorId(ws, flags, { prompt: true, io });
  if (author === null) return 1;

  // 顺序有讲究：**先把身份写进配置，再产钥**。反过来的话，配置写失败就留下"有钥但没身份"的死角
  // （下次 keygen 会被 AUTHOR_KEY_EXISTS 挡住，只能手改配置或 --force 换钥）；这个顺序最坏也只是
  // "声明了身份还没有钥"，重跑一次 keygen 就接上了。
  const file = patchWorkspaceConfig(ws, { author });
  const overwritten = existsSync(ws.keyPath);
  const saved = saveAuthorKey(ws, generateAuthorKey(), { force: flags.has('--force') });

  if (overwritten) console.log(t('cli.keygen.overwritten', { file: saved.keyPath }));
  console.log(t('cli.keygen.done', { fingerprint: saved.fingerprint }));
  console.log(t('cli.keygen.authorSet', { author, file }));
  console.log(t('cli.keygen.keyPath', { file: saved.keyPath }));
  console.log(t('cli.keygen.pubPath', { file: saved.pubPath }));
  console.log(t('cli.keygen.note'));
  return 0;
}

/** `spcdev new <名字> [--author <作者 ID>] [--dir <父目录>] [--force]` */
export async function runPluginNew(args: string[], io: CliIo = {}): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  if (!name) {
    console.log(t('cli.dev.new.usage'));
    return 1;
  }
  if (flags.has('--id')) {
    // 明确拒，而不是静默忽略：插件的 id 决定它挂在谁名下，悄悄按别的规则拼出来是最坏的结果
    console.log(t('cli.dev.new.idRemoved'));
    return 1;
  }
  const ws: Workspace = loadWorkspace(resolve(flags.get('--dir') ?? process.cwd()), { create: true });
  ensureWorkspaceConfig(ws);
  // `new` **不问**作者 ID：问一次是 `spcdev keygen` 的事，这里只管取用（缺了就说清楚去哪儿补）
  const author = await resolveAuthorId(ws, flags, { prompt: false, io });
  if (author === null) return 1;

  const result = scaffoldPlugin(ws, {
    name,
    author,
    ...(flags.has('--force') ? { force: true } : {}),
  });

  console.log(t('cli.dev.new.done', { id: result.id, dir: result.dir }));
  console.log(t('cli.dev.new.files', { files: result.files.join(', ') }));
  console.log(
    t('cli.dev.new.next', {
      dir: result.dir,
      hasKey: existsSync(ws.keyPath) ? t('cli.yes') : t('cli.no'),
    }),
  );
  return 0;
}

/** `spcdev check [<目录>] [--json]`：不打包的静态自检 */
export function runCheck(args: string[]): number {
  const { positional, flags } = parseArgs(args);
  const target = resolvePluginTarget(positional[0]);
  const result = checkPlugin(target);

  if (flags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  console.log(t('cli.check.header', { dir: result.dir }));
  for (const f of result.findings) console.log(t('cli.check.finding', { mark: mark(f), text: renderFinding(f) }));
  const errors = result.findings.filter((f) => f.level === 'error').length;
  const warns = result.findings.filter((f) => f.level === 'warn').length;
  console.log(
    t('cli.check.summary', {
      files: result.summary.files,
      declared: result.summary.declared,
      inferred: result.summary.inferred,
      errors,
      warns,
    }),
  );
  if (result.ok) console.log(t('cli.check.ok'));
  return result.ok ? 0 : 1;
}

/**
 * `spcdev build [<目录>] [--out <目录>] [--released-at <ISO>]`
 *
 * **顺序本身是设计的一部分**（前两步在打包之前，`build-layer-design.md` §5 的施工顺序 + 用户 2026-09-27 的追加要求）：
 *   ① 读清单 → **先按 schema 校验**：非法清单不该出得了货（否则要到 install 才被拦，白构建一趟）；
 *   ② 核对**清单作者段 == 工作区作者 ID**（§10.4 末条）—— 这条要在打包前拦，别产出一个装不进自己机器的包；
 *   ③ 打包（两道闸）；
 *   ④ 产物事实写进产物清单 + 与作者声明对账（不一致 ⇒ 构建失败）；
 *   ⑤ 作者信封（`plugin.meta.json` + `plugin.author.sig`）。
 */
export async function runBuild(args: string[], io: CliIo = {}): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const dir = resolvePluginTarget(positional[0]);

  // `--released-at` 与 `SPC_RELEASED_AT` 都给时**环境变量优先**（§2.1 的口子；确定性用例靠它固定时间）
  const releasedRaw = process.env.SPC_RELEASED_AT ?? flags.get('--released-at');
  let releasedAt = new Date().toISOString();
  if (releasedRaw !== undefined && releasedRaw !== '') {
    const t0 = Date.parse(releasedRaw);
    if (Number.isNaN(t0)) {
      console.error(t('cli.dev.build.badTime', { value: releasedRaw }));
      return 2; // 用法错误（cli-contract 的退出码表）
    }
    releasedAt = new Date(t0).toISOString();
  }

  // 清单三步走，与 `spcdev check` 的三种 finding 同一套词汇：**没了** / **读不成 JSON** / **不合 schema**
  const manifestFile = join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) throw new SpcError('BUILD_MANIFEST_MISSING', { file: 'manifest.json' });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch {
    throw new SpcError('BUILD_MANIFEST_MALFORMED', { file: 'manifest.json' });
  }

  // ① 清单校验：用**同一个**校验器（sdk/validate），构建层不另写一套规则
  const validated = validateManifest(raw);
  if (!validated.ok) {
    throw new SpcError('BUILD_MANIFEST_INVALID', { detail: validated.errors.slice(0, 3).join('；') });
  }
  const manifest = raw as Manifest;

  // ② 作者对账（工作区没声明作者 ⇒ 复用已有的 AUTHOR_ID_REQUIRED，身份不猜）
  const ws = loadWorkspace(dir, {});
  const author = checkAuthor(manifest, ws.config.author);
  if (!author.ok) {
    if (author.reason === 'workspace-unset') {
      throw new SpcError('AUTHOR_ID_REQUIRED', { file: workspaceConfigFile(ws) });
    }
    throw new SpcError('BUILD_AUTHOR_MISMATCH', {
      reason: author.reason,
      expected: author.expected,
      actual: author.actual,
    });
  }
  const key = loadAuthorKey(ws.keyPath); // 缺钥 ⇒ AUTHOR_KEY_MISSING（含"先跑 keygen"的提示）

  // ③ 打包
  const entry = manifest.entry ?? 'main.ts';
  const bundled = await bundlePlugin({ dir, entry });

  // ④ 产物事实 + 与声明对账
  const closure = closureOf(bundled.metafile, dir);
  const declared: DeclaredDep[] = (manifest.dependencies?.npm ?? []).map((d) => ({ ...d }));
  const check = reconcile(declared, closure);
  if (check.unused.length > 0) {
    throw new SpcError('BUILD_DEP_UNUSED', { name: check.unused.join(', ') });
  }
  if (check.versionMismatch.length > 0) {
    const m = check.versionMismatch[0];
    throw new SpcError('BUILD_DEP_MISMATCH', { name: m.name, declared: m.declared, resolved: m.resolved });
  }

  const facts: BuildFacts = { closure, builtins: bundled.builtins, bytes: bundled.bytes };
  const outDir = flags.get('--out') ?? ws.config.outDir;
  const distDir = resolve(dir, outDir === '' ? ws.config.outDir : outDir);

  // 产物清单 = 作者清单 + 构建器写入的事实。⚠️ `entry` 改指向 bundle：产物目录里它才是入口
  // （同一个字段两种语义，见 schema 的 entry 说明；不给产物另起字段，因为那是改契约）
  const srcDeps = (raw as { dependencies?: Record<string, unknown> }).dependencies;
  const distManifest = {
    ...(raw as Record<string, unknown>),
    entry: BUNDLE_FILE,
    // 作者没写 dependencies 就不凭空造一个空对象出来（产物清单要能被逐字 diff）
    ...(srcDeps !== undefined || declared.length > 0
      ? {
          dependencies: {
            ...(srcDeps ?? {}),
            ...(declared.length > 0
              ? {
                  npm: declared.map((d) => {
                    const resolved = check.resolved.get(d.name);
                    return resolved === undefined ? d : { ...d, resolved };
                  }),
                }
              : {}),
          },
        }
      : {}),
    build: facts,
  } as unknown as Manifest;

  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, BUNDLE_FILE), bundled.code);
  writeFileSync(join(distDir, 'manifest.json'), `${JSON.stringify(distManifest, null, 2)}\n`);

  // ⑤ 作者信封（载荷 = 刚写的两个文件；信封自己不算载荷）
  const meta = metaOf({ manifest: distManifest, files: payloadFiles(distDir), authorPub: key.pub, releasedAt });
  const written = writeEnvelope(distDir, meta, key);

  // 输出：把"构建器看到的事实"打给作者看（构建成功 ≠ 没问题，所以 stub 与未核项都要出声）
  console.log(t('cli.dev.build.header', { dir, out: distDir }));
  console.log(t('cli.dev.build.entry', { entry, file: BUNDLE_FILE, bytes: bundled.bytes }));
  console.log(
    bundled.builtins.length > 0
      ? t('cli.dev.build.builtins', { list: bundled.builtins.join(', ') })
      : t('cli.dev.build.builtins.none'),
  );
  console.log(
    closure.length > 0
      ? t('cli.dev.build.closure', {
          count: closure.length,
          bytes: closure.reduce((n, c) => n + c.bytes, 0),
        })
      : t('cli.dev.build.closure.none'),
  );
  if (check.transitive.length > 0) {
    console.log(t('cli.dev.build.transitive', { list: check.transitive.join(', ') }));
  }
  if (bundled.stubbed.length > 0) {
    console.log(t('cli.dev.build.stubbed', { list: bundled.stubbed.join(', ') }));
  }
  if (check.uncheckedRange.length > 0) {
    console.log(
      t('cli.dev.build.unchecked', {
        list: check.uncheckedRange.map((u) => `${u.name} ${u.declared} → ${u.resolved}`).join(', '),
      }),
    );
  }
  if (check.unknownVersion.length > 0) {
    console.log(t('cli.dev.build.unknownVersion', { list: check.unknownVersion.join(', ') }));
  }
  console.log(t('cli.dev.build.author', { author: author.namespace, fingerprint: key.fingerprint }));
  console.log(t('cli.dev.build.releasedAt', { at: releasedAt }));
  console.log(t('cli.dev.build.dist', { dir: distDir, meta: written.metaBytes, sig: written.sigBytes }));
  return 0;
}

/** `spcdev permission list [--json]`：列本机已注册的权限点（冻结表；动态族另附形状） */
export function runPermission(args: string[]): number {
  const sub = args[0];
  const { flags } = parseArgs(args.slice(1));
  if (sub !== 'list') {
    console.log(t('cli.permission.usage'));
    return 1;
  }
  const rows = listPermissions();
  if (flags.has('--json')) {
    console.log(JSON.stringify({ permissions: rows, dynamic: DYNAMIC_POINT_HINT }, null, 2));
    return 0;
  }
  console.log(t('cli.permission.header', { count: rows.length }));
  for (const row of rows) {
    console.log(
      t('cli.permission.row', {
        name: row.name,
        scope: row.scope,
        grant: row.grant,
        level: `${row.confidentiality}/${row.executionLevel}`,
        description: row.description,
      }),
    );
  }
  console.log(t('cli.permission.dynamic', { shapes: DYNAMIC_POINT_HINT.join('  ·  ') }));
  return 0;
}

/** 位置参数可以是目录、插件名（相对工作区的 `plugin/<名字>`），缺省 = 当前目录（`check` 与 `build` 共用） */
function resolvePluginTarget(arg: string | undefined): string {
  if (arg === undefined) return process.cwd();
  const direct = resolve(arg);
  if (existsSync(join(direct, 'manifest.json'))) return direct;
  try {
    const ws = loadWorkspace(process.cwd(), {});
    const named = join(ws.root, 'plugin', arg);
    if (existsSync(join(named, 'manifest.json'))) return named;
  } catch {
    /* 没有工作区：那就按"给的就是路径"处理，后面会报 MANIFEST_MISSING */
  }
  return direct;
}

function mark(f: Finding): string {
  return f.level === 'error' ? '✖' : f.level === 'warn' ? '⚠' : 'ℹ';
}

/** 一条发现 → 本地化文本（码 + 参数，边界写在文案里） */
function renderFinding(f: Finding): string {
  return t(`check.${f.code}`, f.params);
}

/**
 * `spcdev` 的分发：作者工具全集（**本地**命令，不握手、不连 daemon）。
 * ⑦c 的 `pack` / `watch` 还没落地，先明确报"还没做"，别让作者空等一个不存在的动词。
 *
 * `async` 是因为 `keygen` 要**问一句**（作者 ID）、`build` 要 await esbuild；`io` 只为用例留缝。
 */
export const DEV_VERBS = ['keygen', 'new', 'check', 'permission', 'build', 'pack', 'watch'] as const;

export async function runDevCli(cmd: string, args: string[], io: CliIo = {}): Promise<number> {
  try {
    switch (cmd) {
      case 'keygen':
        return await runKeygen(args, io);
      case 'new':
        return await runPluginNew(args, io);
      case 'check':
        return runCheck(args);
      case 'permission':
        return runPermission(args);
      case 'build':
        return await runBuild(args, io);
      case 'pack':
      case 'watch':
        // ⑦c 尚未落地：明确说清楚，而不是给一句"未知命令"
        console.log(t('cli.dev.notYet', { verb: cmd }));
        return 1;
      default:
        console.log(t('cli.dev.usage'));
        return 1;
    }
  } catch (e) {
    // 顶层兜底：作者工具抛的错一律渲染成"码 + 参数"的本地化文案。
    // 少了这一层，Node 会把整段堆栈打出来（内部路径、scaffold.ts:199…）—— 对作者毫无用处，
    // 而那本该是一条"哪个值非法、该改成什么样"的提示。
    console.error(`[spcdev] ${renderThrown(e)}`);
    // 退出码：`BUILD_*` 一族是**门禁失败**（作者写错了/环境缺东西），与一般失败分开 —— 好让 CI 能区分
    // （docs/cli-contract.md 的退出码表：0 成功 / 1 一般失败 / 2 用法 / 3 门禁 / 4 需要交互但非 TTY）
    return e instanceof SpcError && e.code.startsWith('BUILD_') ? 3 : 1;
  }
}

/** 目录存在性预检（CLI 早失败：连目录都没有就不必往下走） */
export function assertDir(dir: string): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new SpcError('PLUGIN_DIR_MISSING', { dir });
  }
}

export type { CheckResult };
