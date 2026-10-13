// 安装记录（docs/plugin-lifecycle-design.md §6）：<STATE_DIR>/plugins.json
//
// 字段与 plugin-signature-design.md §9 对齐。
// **身份 = `(origin, id)`**（v4）：记录按**完整引用** `<origin>/<id>` 唯一；`origin` **不再可空** ——
// 本地安装也有具名来源（`local:<名字>`，默认 `local:default`）。`unanchored` 指"没有市场签名 / 更新渠道"，
// 不是 `origin` 为空。理由与完整引用规则见 docs/events-and-hooks-design.md §3.2/§3.3。
//
// 为什么记录与"扫描插件目录"不同（这是 P1.5 的关键变化）：
//   扫描只能回答"这个目录里有没有合法 manifest"，回答不了 enabled / grants / state / lastError，
//   而这三个才是管理面（CLI、面板、权限判定）真正要读的东西。目录扫描降级为 install 的输入。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Manifest } from '../../sdk/types';
import { PLUGIN_ID_RE } from '../../sdk/ids';
import { DEFAULT_LOCAL_SOURCE, ensureDir, isValidSource, pluginConfigPath, pluginsFile, sanitizeOrigin, sanitizePluginId } from '../config';
import { SpcError } from '../errors';

/** 状态机取值（唯一状态机在 manager；记录里存的是"最后一次已知状态"） */
export type PluginState =
  | 'installed'
  | 'loading'
  | 'loaded'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'disabled'
  | 'failed';

export const PLUGIN_STATES: readonly PluginState[] = [
  'installed',
  'loading',
  'loaded',
  'starting',
  'running',
  'stopping',
  'stopped',
  'disabled',
  'failed',
];

/** 记录里的失败信息（只记码与结构化参数，不落本地化文本） */
export interface PluginErrorRecord {
  code: string;
  params?: Record<string, string>;
  at: number;
}

export interface PluginRecord {
  id: string;
  /** 插件目录（写入时归一化为绝对路径） */
  dir: string;
  version: { code: number; name: string };
  enabled: boolean;
  /** 管理员授予的权限点（精确，不接受通配）。`install` 档的点由**首次安装时按清单播种**进来 */
  grants: string[];
  /** 该插件登记了哪些能力（撤销依据 + 展示 + 审计）：route:/x · endpoint:/api/x · event:t · theme:id */
  capabilities: string[];
  configPath: string;
  state: PluginState;
  installedAt: string;
  lastError: PluginErrorRecord | null;
  /** failedRestart=auto 时的连续失败计数（一次成功 running 后清零） */
  restartAttempts: number;
  // ↓ 与 plugin-signature-design.md §9 对齐
  /** 来源（身份的一半）：`local:<名字>` 或市场域名。**不可为空**（见文件头） */
  origin: string;
  /** 市场签名公钥指纹（本地安装为 null ⇒ unanchored：没有更新渠道） */
  signedBy: string | null;
  /**
   * **作者公钥指纹**（`sha256:…`）—— 依赖身份的判据（`plugin-signature-design.md` §3bis）。
   * - `null` = 这个包**没有作者身份**（本地包没带信封）；它满足不了任何带 `author.pub` 的依赖声明；
   * - 有值时与作者名册（`core/sources/authors.ts`）里 `(origin, id)` 的条目一致；
   *   同 `(origin, id)` 换了钥 ⇒ 拒装（`PLUGIN_AUTHOR_MISMATCH`），除非管理员显式接受换钥。
   */
  authorFingerprint: string | null;
  verifiedMeta: unknown | null;
  /**
   * **载荷是"我们的托管副本"还是"作者的目录"**（`build-layer-design.md` §10.6 的两条入口）。
   *
   * - `true` = 从 `.spc` 装进来的：`dir` 在 `<STATE_DIR>/packages/<来源>/<id>/`，**是我们的目录**
   *   ⇒ 卸载时要连副本一起删（记录都没了，副本就是孤儿）；
   * - 缺省（`undefined`）= 目录**就地**安装：`dir` 是作者的目录（可能是他 clone 的仓库）
   *   ⇒ **永远不碰**。
   *
   * ⚠️ 只在 `true` 时写进记录（不是为了省字节，而是让既有记录保持逐字节不变）。
   */
  hosted?: boolean;
}

export interface PluginsFile {
  pluginsSchema: 1;
  plugins: PluginRecord[];
}

const EMPTY: PluginsFile = { pluginsSchema: 1, plugins: [] };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * 记录字段校验：返回错误清单（空数组 = 合法）。
 * 判定为"非法"就拒载整份文件，而不是挑字段用——半可信的记录会让权限判定出现未定义行为。
 */
export function validateRecord(raw: unknown): string[] {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) return ['record: not an object'];
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !PLUGIN_ID_RE.test(r.id)) {
    errors.push('id: must match @<publisher>/<name>');
  }
  if (typeof r.dir !== 'string' || !isAbsolute(r.dir)) errors.push('dir: must be absolute');
  const v = r.version as { code?: unknown; name?: unknown } | undefined;
  if (
    typeof v !== 'object' ||
    v === null ||
    !Number.isSafeInteger(v.code) ||
    typeof v.name !== 'string'
  ) {
    errors.push('version: { code: integer, name: string } required');
  }
  if (typeof r.enabled !== 'boolean') errors.push('enabled: boolean required');
  if (!isStringArray(r.grants)) errors.push('grants: string[] required');
  if (!isStringArray(r.capabilities)) errors.push('capabilities: string[] required');
  if (typeof r.configPath !== 'string') errors.push('configPath: string required');
  if (typeof r.state !== 'string' || !PLUGIN_STATES.includes(r.state as PluginState)) {
    errors.push(`state: must be one of ${PLUGIN_STATES.join('|')}`);
  }
  if (typeof r.installedAt !== 'string') errors.push('installedAt: string required');
  if (!(r.lastError === null || (typeof r.lastError === 'object' && r.lastError !== null))) {
    errors.push('lastError: object | null required');
  }
  if (!Number.isSafeInteger(r.restartAttempts)) errors.push('restartAttempts: integer required');
  if (typeof r.origin !== 'string' || !isValidSource(r.origin)) {
    errors.push('origin: 必须是合法来源（`local:<名字>` 或市场域名）');
  }
  if (!(r.signedBy === null || typeof r.signedBy === 'string')) {
    errors.push('signedBy: string | null required');
  }
  // `authorFingerprint` 是**后加字段**：老记录没有它 ⇒ 缺省当 null（不因它拒绝启动）；
  // 但**写了就必须是 string | null**（半可信的记录会让依赖身份判定出现未定义行为）。
  if ('authorFingerprint' in r && !(r.authorFingerprint === null || typeof r.authorFingerprint === 'string')) {
    errors.push('authorFingerprint: string | null required when present');
  }
  if (!('verifiedMeta' in r)) errors.push('verifiedMeta: required (may be null)');
  return errors;
}

/** 读记录文件；文件不存在 → 空表；结构非法 → 拒载（fail-closed，不猜） */
export function loadRecords(): PluginsFile {
  const file = pluginsFile();
  if (!existsSync(file)) return { pluginsSchema: 1, plugins: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SpcError('RECORDS_INVALID', {
      file,
      reason: 'malformed-json',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const root = parsed as Partial<PluginsFile> | null;
  if (!root || typeof root !== 'object' || root.pluginsSchema !== 1 || !Array.isArray(root.plugins)) {
    throw new SpcError('RECORDS_INVALID', { file, reason: 'shape' });
  }
  const seen = new Set<string>();
  for (const raw of root.plugins) {
    // 用交叉类型读"后加字段"：它在磁盘上可能不存在（老记录），归一化后再交给下游
    const rec = raw as PluginRecord & { authorFingerprint?: string | null };
    const errors = validateRecord(raw);
    if (errors.length > 0) {
      throw new SpcError('RECORDS_INVALID', { file, reason: 'record', detail: errors.join('; ') });
    }
    // 后加字段的归一化：老记录没有 `authorFingerprint` ⇒ 补 null，让读的人不必各自兜 undefined
    if (rec.authorFingerprint === undefined) rec.authorFingerprint = null;
    const ref = `${rec.origin}/${rec.id}`;
    if (seen.has(ref)) {
      throw new SpcError('RECORDS_INVALID', { file, reason: 'duplicate-ref', ref });
    }
    seen.add(ref);
  }
  return { pluginsSchema: 1, plugins: root.plugins };
}

/** 原子写：先写 .tmp 再 rename（避免半截文件让下次启动拒载） */
export function saveRecords(file: PluginsFile): void {
  const path = pluginsFile();
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

/**
 * **完整引用**：`<origin>/<id>`，如 `local:default/@xfy2412/hello`、`market.spc.xfyweb.cn/@a/b`。
 * 它是**记录的唯一键**，也是管理命令与跨插件引用里指向某个插件的写法（设计 §3.2/§3.4）。
 * ⚠️ 拼字符串这件事**只在这里做一次**：别处一律传 ref 比较，不要再各拼一份（拼法一变就会各错各的）。
 */
export function pluginRef(rec: { origin: string; id: string }): string {
  return `${rec.origin}/${rec.id}`;
}

export function findRecord(file: PluginsFile, ref: string): PluginRecord | undefined {
  return file.plugins.find((p) => pluginRef(p) === ref);
}

/**
 * **管理面输入 → 记录**：先按完整引用精确匹配；否则把它当**裸 id**（以 `@` 开头）做唯一匹配。
 *
 * 为什么容错裸 id：管理命令（`spc plugin status @a/b`）手打完整引用太啰嗦，而绝大多数机器上
 * 同一个 id 只有一个来源。但**歧义必须报错，不能随便挑一个**——"挑错了"就是在动另一个插件的数据。
 * 跨插件引用（调用目标 / topic / 依赖声明 / 权限点名）**一律用完整引用**，不走这条容错。
 */
export function resolveRecord(file: PluginsFile, input: string): PluginRecord | undefined {
  const exact = findRecord(file, input);
  if (exact) return exact;
  if (!input.startsWith('@')) return undefined; // 不像裸 id ⇒ 就是没有
  const hits = file.plugins.filter((p) => p.id === input);
  if (hits.length > 1) {
    throw new SpcError('PLUGIN_REF_AMBIGUOUS', { input, refs: hits.map(pluginRef).join('、') });
  }
  return hits[0];
}

/** 按完整引用 upsert（同一 `(origin, id)` 只有一条记录） */
export function upsertRecord(file: PluginsFile, rec: PluginRecord): void {
  const ref = pluginRef(rec);
  const idx = file.plugins.findIndex((p) => pluginRef(p) === ref);
  if (idx === -1) file.plugins.push(rec);
  else file.plugins[idx] = rec;
}

export function dropRecord(file: PluginsFile, ref: string): boolean {
  const idx = file.plugins.findIndex((p) => pluginRef(p) === ref);
  if (idx === -1) return false;
  file.plugins.splice(idx, 1);
  return true;
}

/** 由 manifest 造一条新记录（install 用）。`source` 缺省 = `local:default`（见文件头） */
export function newRecord(
  manifest: Manifest,
  dir: string,
  opts: {
    source?: string;
    grants?: string[];
    signedBy?: string | null;
    authorFingerprint?: string | null;
    /** 载荷是不是"我们的托管副本"（`.spc` 装进来的）⇒ 卸载时连副本一起删，见 `PluginRecord.hosted` */
    hosted?: boolean;
  } = {},
): PluginRecord {
  // ID 与来源都必须先过 sanitize：它们同时是数据目录/配置文件名，非法的不能写进记录
  sanitizePluginId(manifest.id);
  const origin = opts.source ?? DEFAULT_LOCAL_SOURCE;
  sanitizeOrigin(origin);
  return {
    id: manifest.id,
    dir: resolve(dir),
    version: { code: manifest.version.code, name: manifest.version.name },
    enabled: false,
    grants: opts.grants ?? [],
    capabilities: [],
    configPath: pluginConfigPath(origin, manifest.id),
    state: 'installed',
    installedAt: new Date().toISOString(),
    lastError: null,
    restartAttempts: 0,
    origin,
    signedBy: opts.signedBy ?? null,
    authorFingerprint: opts.authorFingerprint ?? null,
    verifiedMeta: null,
    // 只在托管时写这个字段（就地安装的记录保持与历史记录逐字节一致）
    ...(opts.hosted === true ? { hosted: true } : {}),
  };
}

export { EMPTY as EMPTY_RECORDS };
