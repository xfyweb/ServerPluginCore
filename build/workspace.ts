// 开发期工作区：`.spcdev/`（docs/build-layer-design.md §10.2）
//
// **发现规则**：从待处理的目录**往上**逐级找最近的 `.spcdev/`（`.git` 那种方式）⇒
// "本体根放一份、一个作者一把钥管所有插件"成立，"某个插件目录里单独放一份"也成立，**近者优先**。
//
// ⚠️ 它**不是** `.spc/` —— 那是**运行期状态**目录（`plugins.json` / `keyring.json` / `audit/` / `data/`）。
// 把开发期密钥塞进宿主状态兜里，等于让"清状态"和"删密钥"变成同一个动作。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SpcError } from '../core/errors';
// 作者 ID 与插件名共用一套字符 ⇒ 形状取自**唯一出处** `sdk/ids.ts`（这里不再自己写一份）
import { ID_SEGMENT_RE } from '../sdk/ids';

/** 固定目录名（`docs/build-layer-design.md` §10.2 定死；改它等于换一套工作区约定） */
export const WORKSPACE_DIRNAME = '.spcdev';

export interface WorkspaceConfig {
  /** 产物目录（相对插件目录）；⑦b 的 `spcdev build` 用 */
  outDir: string;
  /** `spcdev dev` 默认装进的来源 */
  source: string;
  /** 构建时是否用作者密钥签名（`true`；"不存在无签名包"） */
  sign: boolean;
  /** 作者私钥路径（**相对 `.spcdev/`**） */
  key: string;
  /**
   * **作者 ID**（插件 id 的 `@` 前缀，也就是清单里 `@<作者 ID>/<名字>` 那一段）。
   * 空串 = **还没声明** —— `spcdev keygen` 会问一次并写进来，`spcdev new` 拿它拼 id；
   * 没声明又没显式给 `--author` 时**一律拒**（身份不做默认值）。
   *
   * 为什么不从密钥推：密钥里没有名字。为什么不记指纹：钥文件本身就是真值，
   * 配置里再抄一份只会多一个会漂的副本。
   */
  author: string;
}

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  outDir: 'dist',
  source: 'local:default',
  sign: true,
  key: join('keys', 'author.key'),
  author: '',
};

export interface Workspace {
  /** 工作区根 = `.spcdev/` 的父目录 —— `plugin/<名字>/` 就在它下面 */
  root: string;
  /** `.spcdev/` 自身 */
  dir: string;
  config: WorkspaceConfig;
  /** 作者私钥（绝对路径） */
  keyPath: string;
  /** 作者公钥（绝对路径；与私钥同目录） */
  pubPath: string;
}

/**
 * 从 `start` 往上找最近的工作区；找不到返回 `undefined`（走到文件系统根为止）。
 *
 * ⚠️ **判据是"这个 `.spcdev/` 里有 `config.json`"，不是"有个 `.spcdev/` 目录"**（2026-10-13 实测踩到）：
 * 只认目录的话，任何往 `.spcdev/` 里放东西的工具都会**把所在目录变成工作区根** —— 于是"作者 ID 在哪"
 * 的答案就从上层工作区悄悄变成"这里没有"。踩的正是我们自己的开发标记：
 * `spcdev watch` 把 `.spcdev/dev-install.json` 写进插件目录后，**同一个插件的下一次构建**
 * 就报"尚未确定作者 ID"（作者明明声明在上层工作区）。
 */
export function findWorkspaceDir(start: string): string | undefined {
  let cur = resolve(start);
  for (;;) {
    const candidate = join(cur, WORKSPACE_DIRNAME);
    if (existsSync(join(candidate, 'config.json'))) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * 校验**作者 ID**：允许写成 `@alice`（提示语里就是这么写的），此外**一个字都不改写**
 * —— 不做小写化 / 不做 slug（`Alice` 就是非法，而不是被悄悄改成 `alice`）。
 * 合法返回值，非法返回 `null`（调用方去报错：fail-closed）。
 */
export function checkAuthorId(raw: string): string | null {
  const value = raw.trim().replace(/^@/, '');
  return ID_SEGMENT_RE.test(value) ? value : null;
}

/**
 * `git config user.name` → 合法的作者 ID **猜测**（拿不到返回空串）。
 * ⚠️ 它**只是交互提问时的默认值**，不是身份来源：非 TTY 时不会拿它顶替用户的回答
 * （身份这种一次性决定，不该因为"跑在脚本里"就悄悄取一个默认值）。
 * 这里的归一化是**对推测值**做的（git 名字允许大写/空格），用户亲手输入的值只校验、不改写。
 */
export function suggestedAuthor(): string {
  let raw = '';
  try {
    raw = execFileSync('git', ['config', 'user.name'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* 不是 git 仓库 / 没配身份 / git 不在 PATH：都不该让 keygen 失败 */
  }
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return ID_SEGMENT_RE.test(clean) ? clean : '';
}

/** 读 `config.json` 原文（缺文件给默认值；形状/JSON 非法即拒）—— 读取与"合并写"共用 */
function readRawConfig(file: string): Record<string, unknown> {
  if (!existsSync(file)) return { ...DEFAULT_WORKSPACE_CONFIG };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SpcError('PLUGIN_WORKSPACE_INVALID', {
      file,
      reason: 'malformed-json',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SpcError('PLUGIN_WORKSPACE_INVALID', { file, reason: 'shape' });
  }
  return parsed as Record<string, unknown>;
}

/** 读 `config.json`（缺省 / 缺字段一律补默认值：它**可选**，除作者 ID 外全部有默认） */
function readConfig(file: string): WorkspaceConfig {
  const raw = readRawConfig(file) as Partial<WorkspaceConfig>;
  return {
    outDir: typeof raw.outDir === 'string' && raw.outDir !== '' ? raw.outDir : DEFAULT_WORKSPACE_CONFIG.outDir,
    source: typeof raw.source === 'string' && raw.source !== '' ? raw.source : DEFAULT_WORKSPACE_CONFIG.source,
    sign: raw.sign === undefined ? DEFAULT_WORKSPACE_CONFIG.sign : raw.sign === true,
    key: typeof raw.key === 'string' && raw.key !== '' ? raw.key : DEFAULT_WORKSPACE_CONFIG.key,
    // ⚠️ 与上面几条不同：作者 ID **没有**默认值，缺就是空串（"还没声明"，由调用方拒）
    author: typeof raw.author === 'string' ? raw.author.trim() : '',
  };
}

/**
 * 定位（必要时创建）工作区。
 * @param create `true` = 找不到就在 `start` 下**建一个**（`spcdev keygen` / `spcdev new` 要；
 *               `spcdev check` 之类只读的命令传 `false`，缺工作区不该是错误）
 */
export function loadWorkspace(start: string, opts: { create?: boolean } = {}): Workspace {
  let dir = findWorkspaceDir(start);
  if (!dir) {
    if (opts.create !== true) {
      throw new SpcError('PLUGIN_WORKSPACE_MISSING', { start: resolve(start), name: WORKSPACE_DIRNAME });
    }
    dir = join(resolve(start), WORKSPACE_DIRNAME);
    mkdirSync(join(dir, 'keys'), { recursive: true });
    // 顺手把默认 `config.json` 写上：**它才是"这里是工作区"的判据**（只认目录的话，任何往 `.spcdev/`
    // 里放东西的工具都会把所在目录变成工作区根 —— 踩过，见 `findWorkspaceDir` 的注释）。
    // 少了这行，"新建的工作区"在下一次 `findWorkspaceDir` 里就认不出来了。
    if (!existsSync(join(dir, 'config.json'))) {
      writeFileSync(join(dir, 'config.json'), `${JSON.stringify(DEFAULT_WORKSPACE_CONFIG, null, 2)}\n`, 'utf8');
    }
  }
  const config = readConfig(join(dir, 'config.json'));
  const keyPath = resolve(dir, config.key);
  return { root: dirname(dir), dir, config, keyPath, pubPath: join(dirname(keyPath), 'author.pub') };
}

/** 写默认 `config.json`（已存在则原样保留 —— 它是管理员的配置，不许被工具覆盖） */
export function ensureWorkspaceConfig(ws: Workspace): string {
  const file = join(ws.dir, 'config.json');
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(DEFAULT_WORKSPACE_CONFIG, null, 2)}\n`, 'utf8');
  }
  return file;
}

/** 工作区配置文件的绝对路径（报错信息里要指出来，别只说"配置里没有"） */
export function workspaceConfigFile(ws: Workspace): string {
  return join(ws.dir, 'config.json');
}

/**
 * **合并式**写配置：只覆盖给定字段，其余（含用户在文件里自己加的字段）原样保留。
 * 与 `ensureWorkspaceConfig` 的分工：那个管"没有就写一份默认的"，这个管"改已经有的那一两个字段"。
 * 顺手把 `ws.config` 一起更新 —— 同一个进程里接着用 `ws` 的调用方不会读到旧值。
 */
export function patchWorkspaceConfig(ws: Workspace, patch: Partial<WorkspaceConfig>): string {
  const file = workspaceConfigFile(ws);
  const merged = { ...readRawConfig(file), ...patch };
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  Object.assign(ws.config, patch);
  return file;
}
