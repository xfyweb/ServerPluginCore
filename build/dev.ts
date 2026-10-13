// `spcdev watch`（别名 `dev`）：盯源码 → 改动即重建 → 自动 `spc plugin reload`。
//
// 口径（`docs/build-layer-design.md` §10 的工具表，别自己发明）：
//   · **不做 HMR**：`reload` 是"整插件停 → 重新 load"（`plugin-lifecycle-design.md` §380），
//     这里只是**省掉手敲两条命令**；
//   · 重载**走已有管理通道**：调 `spc plugin reload <id>`，而不是让作者工具自己去跟 daemon 握手
//     —— 那就多出第二条管理通道，鉴权 / 审计 / 错误文案都得再写一遍；
//   · ⚠️ 只对**目录就地安装**的那个插件有意义：托管副本（`.spc` 装的）是一份不动的载荷，
//     改了源码得重新 `build` + `pack` + `install` 才生效。
//
// 分工：这里只做**去抖与编排**（纯逻辑，可注入 io ⇒ 用例不必真起 watcher / 真跑构建）；
// 真 watcher（`chokidar`）与真命令在 `cli.ts` 里接线。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_LOCAL_SOURCE } from '../core/config';

/**
 * 这些目录里的改动**不算源码改动**：
 *   `dist/` 构建产物本身（否则重建会触发自己）· `.spcdev/` 工具态（含私钥）·
 *   `node_modules/` 依赖 · `.git/` 版本库 · `release/` 发布物（`pack` 的输出）。
 */
const IGNORED_DIRS = new Set(['dist', '.spcdev', 'node_modules', '.git', 'release']);

/**
 * 这次改动要不要触发重建？
 *
 * 判据（按顺序）：必须**在根目录之内**（`..` 开头 ⇒ 不是我们的）→ 路径里任何一段命中忽略名单 ⇒ 不算 →
 * `.spc` 文件本身不算（那是发布物；默认在 `release/` 下，但作者可能用 `--file` 丢在别处）。
 */
export function isSourceChange(root: string, absPath: string): boolean {
  const rel = relative(root, absPath).split(sep).join('/');
  if (rel === '' || rel.startsWith('..')) return false;
  if (rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) return false;
  if (rel.endsWith('.spc')) return false;
  return true;
}

/**
 * **watcher 用的判据**：`ignored` 回调返回 true 就等于"这个路径不监视"。
 *
 * ⚠️ **根目录本身必须放行**（2026-10-13 踩过）：`ignored` 回调对根目录也会问一次，
 * 而 `relative(root, root)` 是空串 ⇒ 若直接复用 `isSourceChange`，根目录会被判成"忽略"，
 * chokidar 于是**连下降都不下降** ⇒ 一个事件都收不到（表现是"只有启动那次构建，之后改文件毫无反应"）。
 */
export function isWatchedPath(root: string, absPath: string): boolean {
  if (relative(root, absPath) === '') return true; // 根目录：放行，让它能往下走
  return isSourceChange(root, absPath);
}

/**
 * **开发沙箱**：`watch` 到底该拿哪个已装实例来 reload？装的话装到哪个源？
 *
 * 判据（2026-10-13 维护者提的"缺失自动安装" + "要不要能指定源"）：
 *   · **给了 `source`**（`--source`）⇒ 钉死在那个源：那里没装 ⇒ `auto-install` 进这个源；
 *     装了且 `dir` 就是这个目录 ⇒ `reuse`；装了但指向别处 ⇒ `foreign`。**别的源同名的一律不管**
 *     （身份是 `(origin, id)`，同 id 不同源本来就是两个插件）；
 *   · **没给** ⇒ 先看同名插件**装在哪**：一个都没装 ⇒ 装进缺省源；只装在一个源 ⇒ **沿用那个源**
 *     （作者已有的就地安装直接生效，**不会凭空多出一份记录**）；装在不同源 ⇒ `ambiguous`，
 *     由调用方提示他用 `--source <其中之一>` 选一个（本工具不猜）。
 */
export type SandboxDecision =
  | { kind: 'auto-install'; origin: string }
  | { kind: 'reuse'; ref: string }
  | { kind: 'foreign'; ref: string; dir: string }
  | { kind: 'ambiguous'; refs: string[] };

/** `完整引用` → 来源：`local:default/@std/demo` + `@std/demo` ⇒ `local:default`（id 里含 `/`，不能按 `/` 切） */
function originOfRef(ref: string, id: string): string {
  const tail = `/${id}`;
  return ref.endsWith(tail) ? ref.slice(0, ref.length - tail.length) : ref;
}

export function decideSandbox(
  installed: readonly { ref: string; id: string; dir: string }[],
  id: string,
  pluginDir: string,
  source?: string,
): SandboxDecision {
  const sameId = installed.filter((p) => p.id === id);
  const candidates = source === undefined ? sameId : sameId.filter((p) => originOfRef(p.ref, p.id) === source);

  if (candidates.length === 0) return { kind: 'auto-install', origin: source ?? DEFAULT_LOCAL_SOURCE };
  if (candidates.length > 1) return { kind: 'ambiguous', refs: candidates.map((p) => p.ref).sort() };
  const one = candidates[0]!;
  const same = resolve(one.dir) === resolve(pluginDir);
  return same ? { kind: 'reuse', ref: one.ref } : { kind: 'foreign', ref: one.ref, dir: one.dir };
}

/**
 * **开发标记**：`watch` 自己装的那个插件记在这里（`<插件目录>/.spcdev/dev-install.json`）。
 *
 * 为什么需要它（2026-10-13 维护者真机实测"被吃了"）：信号是**不可靠**的 —— 强杀、关终端、
 * 机器断电都不会给你机会跑清理。有了标记，**下次 `watch` 启动时就能发现上一次没清干净**并把账收掉。
 */
export const DEV_MARKER_FILE = '.spcdev/dev-install.json';

export interface DevMarker {
  /** 我们装的那个插件的完整引用 `<来源>/<id>` */
  ref: string;
  /** 装它的那个进程 pid（用来判断"那个会话还活着吗"） */
  pid: number;
  at: string;
}

/** 标记文件的**严格**解析：形状不对就当没有（宁可不清理，也不拿一个坏标记去卸东西） */
export function parseDevMarker(text: string): DevMarker | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.ref !== 'string' || m.ref.length === 0) return null;
  if (typeof m.pid !== 'number' || !Number.isInteger(m.pid) || m.pid <= 0) return null;
  if (typeof m.at !== 'string') return null;
  return { ref: m.ref, pid: m.pid, at: m.at };
}

/** 那个 pid 还活着吗（`kill(pid, 0)` 的经典用法；权限不足也算活着） */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读开发标记（文件不存在 / 内容不合法 ⇒ null） */
export function readDevMarker(pluginDir: string): DevMarker | null {
  try {
    return parseDevMarker(readFileSync(join(pluginDir, DEV_MARKER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** 写下"这个插件是我们装的"（`.spcdev/` 已存在；不存在就建） */
export function writeDevMarker(pluginDir: string, ref: string): void {
  const file = join(pluginDir, DEV_MARKER_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const marker: DevMarker = { ref, pid: process.pid, at: new Date().toISOString() };
  writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

/** 清掉标记（清理成功之后；不存在也无所谓） */
export function clearDevMarker(pluginDir: string): void {
  try {
    rmSync(join(pluginDir, DEV_MARKER_FILE));
  } catch {
    /* 本来就不在：无所谓 */
  }
}

export interface DevIo {
  /** 跑一次构建，返回退出码（0 = 成功） */
  build: () => Promise<number>;
  /** 走管理通道重载（返回退出码与要展示的输出片段） */
  reload: () => Promise<{ code: number; text: string }>;
  /** 回调而不是"拼日志字符串"：本地化文案是 CLI 那一层的事（i18n 规矩） */
  onBuilt: (ms: number) => void;
  onBuildFailed: (code: number) => void;
  onReloaded: () => void;
  onReloadFailed: (code: number, text: string) => void;
  /** 计时用（用例可注入假时钟） */
  now?: () => number;
}

export interface DevSession {
  /** 进来先立刻建一次（此时可能还没产物；不等去抖） */
  start: () => Promise<void>;
  /** 收到一次文件事件（内部去抖；非源码改动会被忽略） */
  changed: (absPath: string) => void;
  /** 等"在飞的重建 + 排队的那一次"都结束（用例用；正常跑不需要） */
  idle: () => Promise<void>;
  /** 停止接受新改动并把在飞的那次跑完 */
  close: () => Promise<void>;
}

/**
 * 去抖 + 串行：改动进来先等 `debounceMs`（编辑器保存往往连发好几个事件）；
 * 若此时**正好有重建在跑**，只记账"还得再来一次"（不排队 N 次 —— 连按保存不该触发 N 次构建）。
 */
export function createDevSession(opts: {
  root: string;
  debounceMs?: number;
  autoReload: boolean;
  io: DevIo;
}): DevSession {
  const debounceMs = opts.debounceMs ?? 150;
  const now = opts.io.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let running = false;
  let queued = false;
  let chain: Promise<void> = Promise.resolve();

  const runOnce = async (): Promise<void> => {
    running = true;
    try {
      const t0 = now();
      const code = await opts.io.build();
      if (code !== 0) {
        // 构建失败**不停**：作者还在改，改好下一次会自动重建（这也是 dev 的意义）
        opts.io.onBuildFailed(code);
        return;
      }
      opts.io.onBuilt(now() - t0);
      if (!opts.autoReload) return;
      const r = await opts.io.reload();
      if (r.code === 0) opts.io.onReloaded();
      else opts.io.onReloadFailed(r.code, r.text);
    } finally {
      running = false;
      if (queued && !closed) {
        queued = false;
        // 期间又改过 ⇒ 立刻再来一次（不等去抖：刚起步就该追上最新状态）
        chain = chain.then(runOnce);
      }
    }
  };

  const fire = (): void => {
    timer = undefined;
    if (closed) return;
    if (running) {
      queued = true;
      return;
    }
    chain = chain.then(runOnce);
  };

  return {
    async start(): Promise<void> {
      if (closed) return;
      chain = chain.then(runOnce);
      await chain;
    },
    changed(absPath: string): void {
      if (closed) return;
      if (!isSourceChange(opts.root, absPath)) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, debounceMs);
      timer.unref?.();
    },
    async idle(): Promise<void> {
      // 把待触发的去抖先兑现，再等链上排完
      if (timer !== undefined) {
        clearTimeout(timer);
        fire();
      }
      await chain;
    },
    async close(): Promise<void> {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await chain;
    },
  };
}
