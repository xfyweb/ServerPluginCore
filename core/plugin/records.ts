// 安装记录（docs/plugin-lifecycle-design.md §6）：<STATE_DIR>/plugins.json
//
// 记录由 daemon 拥有（写操作必须经过 daemon），CLI 只读时可离线读取。
// 字段与 plugin-signature-design.md §9 对齐：本地安装 origin/signedBy/verifiedMeta 全为 null（unanchored）。
//
// 为什么记录与"扫描插件目录"不同（这是 P1.5 的关键变化）：
//   扫描只能回答"这个目录里有没有合法 manifest"，回答不了 enabled / grants / state / lastError，
//   而这三个才是管理面（CLI、面板、权限判定）真正要读的东西。目录扫描降级为 install 的输入。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Manifest } from '../../sdk/types';
import { ensureDir, pluginConfigPath, pluginsFile, sanitizePluginId } from '../config';
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
  /** 管理员逐点授予的权限点（精确，不接受通配） */
  grants: string[];
  /** 该插件登记了哪些能力（撤销依据 + 展示 + 审计）：route:/x · api:/api/x · event:t · theme:id */
  capabilities: string[];
  configPath: string;
  state: PluginState;
  installedAt: string;
  lastError: PluginErrorRecord | null;
  /** failedRestart=auto 时的连续失败计数（一次成功 running 后清零） */
  restartAttempts: number;
  // ↓ 与 plugin-signature-design.md §9 对齐（P4 安装流写入；本地安装为 null）
  origin: string | null;
  signedBy: string | null;
  verifiedMeta: unknown | null;
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
  if (typeof r.id !== 'string' || !/^@[a-z0-9][a-z0-9_-]{0,62}\/[a-z0-9][a-z0-9_-]{0,62}$/.test(r.id)) {
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
  for (const key of ['origin', 'signedBy'] as const) {
    if (!(r[key] === null || typeof r[key] === 'string')) errors.push(`${key}: string | null required`);
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
  for (const rec of root.plugins) {
    const errors = validateRecord(rec);
    if (errors.length > 0) {
      throw new SpcError('RECORDS_INVALID', { file, reason: 'record', detail: errors.join('; ') });
    }
    if (seen.has(rec.id)) {
      throw new SpcError('RECORDS_INVALID', { file, reason: 'duplicate-id', pluginId: rec.id });
    }
    seen.add(rec.id);
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

export function findRecord(file: PluginsFile, id: string): PluginRecord | undefined {
  return file.plugins.find((p) => p.id === id);
}

/** 按 id upsert（同一 id 只有一条记录） */
export function upsertRecord(file: PluginsFile, rec: PluginRecord): void {
  const idx = file.plugins.findIndex((p) => p.id === rec.id);
  if (idx === -1) file.plugins.push(rec);
  else file.plugins[idx] = rec;
}

export function dropRecord(file: PluginsFile, id: string): boolean {
  const idx = file.plugins.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  file.plugins.splice(idx, 1);
  return true;
}

/** 由 manifest 造一条新记录（install 用） */
export function newRecord(
  manifest: Manifest,
  dir: string,
  opts: { grants?: string[]; origin?: string | null; signedBy?: string | null } = {},
): PluginRecord {
  // ID 必须先过 sanitize：它同时是数据目录/配置文件名，非法 ID 不能写进记录
  sanitizePluginId(manifest.id);
  return {
    id: manifest.id,
    dir: resolve(dir),
    version: { code: manifest.version.code, name: manifest.version.name },
    enabled: false,
    grants: opts.grants ?? [],
    capabilities: [],
    configPath: pluginConfigPath(manifest.id),
    state: 'installed',
    installedAt: new Date().toISOString(),
    lastError: null,
    restartAttempts: 0,
    origin: opts.origin ?? null,
    signedBy: opts.signedBy ?? null,
    verifiedMeta: null,
  };
}

export { EMPTY as EMPTY_RECORDS };
