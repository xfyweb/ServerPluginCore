// exec 模板注册表（docs/exec-sandbox-design.md §2、interface-audit-exec-fs.md §2）
//
// 只有两方来源：核心内置（`core:`）+ 插件声明（`<pluginId>:`，B 阶段接 manifest）。
// 模板是**可审查的静态数据**，不是运行时任意代码——因此注册时做静态校验（E1–E10 中可在声明层完成的那些）。
// 沙箱插件永远只能调用注册表里的模板，没有自由命令。
import { existsSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SpcError } from '../errors';

export type ParamType = 'enum' | 'pattern' | 'whitelist' | 'path';

export interface TemplateParam {
  name: string;
  type: ParamType;
  /** enum / whitelist：允许值集合 */
  allowed?: string[];
  /** pattern：正则（整串匹配） */
  pattern?: string;
  /** path：作用域白名单（复用 core/fs/safe-path 的语义） */
  scope?: string[];
  /** path：是否要求已存在 */
  mustExist?: boolean;
}

export interface TemplateDef {
  /** `<namespace>:<action>.<op>`，如 core:nginx.reload */
  id: string;
  /** 固定命令数组；`{param}` 占位符**必须是整个元素**（禁止部分拼接，E1） */
  command: string[];
  params?: TemplateParam[];
  cwd?: string;
  /** env 白名单（E3/E6） */
  env?: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  /** P5 特权执行器；当前不支持，注册时直接拒绝 */
  privileged?: boolean;
}

const ID_PATTERN = /^(core|@[a-z0-9][a-z0-9_-]{0,62}\/[a-z0-9][a-z0-9_-]{0,62}):[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const PLACEHOLDER = /^\{([a-z][a-z0-9_]*)\}$/;
const PARTIAL_PLACEHOLDER = /[{}]/;

/** 模板 ID → 权限点（action.op 全局唯一，见 exec-sandbox-design §2.2） */
export function permissionPointOf(templateId: string): string {
  const dot = templateId.slice(templateId.indexOf(':') + 1);
  return `exec.template.${dot}`;
}

/** 命令形状归一化（原生写法匹配用）：可执行文件只比 basename，占位符统一成 `{}` */
function normalizeExecutable(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return process.platform === 'win32' ? base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() : base;
}

/**
 * 命令**形状**（与参数名无关）：原生写法匹配的唯一依据。
 * 形状重复意味着"一条原生命令能对上两个模板"，那样权限点归属就有歧义——因此注册时禁止。
 */
export function templateShape(def: TemplateDef): string {
  return def.command
    .map((el, i) => {
      if (PLACEHOLDER.test(el)) return '{}';
      return i === 0 ? normalizeExecutable(el) : el;
    })
    .join('\u0000');
}

/**
 * 可执行文件白名单（E10——防"插件先写脚本再执行"）。
 * 判定依据是**插件写不到那里**，而不是硬编码四个目录：系统目录 + 管理员安装目录。
 */
export function executableAllowlist(): string[] {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    return [
      join(root, 'System32'),
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : undefined,
    ].filter((p): p is string => Boolean(p));
  }
  return ['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/local/bin'];
}

/**
 * 在候选目录 + PATH 里解析可执行文件（跨平台；返回绝对路径，找不到返回 undefined）。
 * 解析结果仍然要过 §E10 白名单——PATH 上任何位置都可能被插件污染，白名单是最终判据。
 */
export function resolveExecutable(name: string, extraDirs: string[] = []): string | undefined {
  const unquote = (p: string) => p.trim().replace(/^"(.*)"$/, '$1');
  const pathDirs = (process.env.PATH ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map(unquote)
    .filter(Boolean);
  const dirs = [...extraDirs, ...pathDirs];
  const names =
    process.platform === 'win32'
      ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
      : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const p = join(dir, n);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        /* 权限/竞态：跳过 */
      }
    }
  }
  return undefined;
}

/** 解析后的命令必须在系统目录白名单内（E10）+ 存在 + 可执行 */
export function assertExecutableInSystemDirs(cmd: string, allowlist = executableAllowlist()): void {
  if (!isAbsolute(cmd)) {
    throw new SpcError('TEMPLATE_COMMAND_NOT_ALLOWED', { command: cmd, reason: 'must-be-absolute' });
  }
  let resolved: string;
  try {
    resolved = realpathSync(cmd);
  } catch {
    throw new SpcError('TEMPLATE_COMMAND_NOT_ALLOWED', { command: cmd, reason: 'not-found' });
  }
  const inside = allowlist.some((dir) => {
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {
      /* 目录不存在则用原值比较 */
    }
    return resolved === real || resolved.startsWith(real.endsWith('/') || real.endsWith('\\') ? real : real + (process.platform === 'win32' ? '\\' : '/'));
  });
  if (!inside) {
    throw new SpcError('TEMPLATE_COMMAND_NOT_ALLOWED', { command: cmd, reason: 'outside-system-dirs' });
  }
  if (process.platform !== 'win32' && !(statSync(resolved).mode & 0o111)) {
    throw new SpcError('TEMPLATE_COMMAND_NOT_ALLOWED', { command: cmd, reason: 'not-executable' });
  }
}

/** 注册时静态校验（E1/E7/E8/E10 + 形状） */
export function validateTemplate(def: TemplateDef, allowlist = executableAllowlist()): void {
  if (!ID_PATTERN.test(def.id)) {
    throw new SpcError('TEMPLATE_ID_INVALID', { id: def.id });
  }
  if (def.privileged) {
    // P5 特权执行器尚未实现：明确拒绝，避免"看起来支持"
    throw new SpcError('TEMPLATE_PRIVILEGED_UNSUPPORTED', { id: def.id });
  }
  if (!Array.isArray(def.command) || def.command.length === 0) {
    throw new SpcError('TEMPLATE_COMMAND_INVALID', { id: def.id, reason: 'empty' });
  }
  assertExecutableInSystemDirs(def.command[0], allowlist);
  if (def.cwd !== undefined && !isAbsolute(def.cwd)) {
    throw new SpcError('TEMPLATE_CWD_INVALID', { id: def.id, cwd: def.cwd });
  }
  if (!Number.isSafeInteger(def.timeoutMs) || def.timeoutMs <= 0 || def.timeoutMs > 600_000) {
    throw new SpcError('TEMPLATE_TIMEOUT_INVALID', { id: def.id, timeoutMs: String(def.timeoutMs) });
  }
  if (!Number.isSafeInteger(def.maxOutputBytes) || def.maxOutputBytes <= 0) {
    throw new SpcError('TEMPLATE_OUTPUT_LIMIT_INVALID', { id: def.id, maxOutputBytes: String(def.maxOutputBytes) });
  }

  const names = new Set<string>();
  for (const p of def.params ?? []) {
    if (!/^[a-z][a-z0-9_]*$/.test(p.name)) {
      throw new SpcError('TEMPLATE_PARAM_SPEC_INVALID', { id: def.id, param: p.name });
    }
    if (names.has(p.name)) {
      throw new SpcError('TEMPLATE_PARAM_SPEC_INVALID', { id: def.id, param: p.name, reason: 'duplicate' });
    }
    names.add(p.name);
    if (p.type === 'enum' || p.type === 'whitelist') {
      if (!p.allowed?.length) {
        throw new SpcError('TEMPLATE_PARAM_SPEC_INVALID', { id: def.id, param: p.name, reason: 'allowed-required' });
      }
    } else if (p.type === 'pattern') {
      if (!p.pattern) {
        throw new SpcError('TEMPLATE_PARAM_SPEC_INVALID', { id: def.id, param: p.name, reason: 'pattern-required' });
      }
      try {
        new RegExp(p.pattern);
      } catch {
        throw new SpcError('TEMPLATE_PARAM_SPEC_INVALID', { id: def.id, param: p.name, reason: 'pattern-invalid' });
      }
    } else if (p.type === 'path') {
      if (!p.scope?.length) {
        throw new SpcError('TEMPLATE_PARAM_SPEC_INVALID', { id: def.id, param: p.name, reason: 'scope-required' });
      }
    } else {
      throw new SpcError('TEMPLATE_PARAM_SPEC_INVALID', { id: def.id, param: p.name, reason: 'unknown-type' });
    }
  }

  // 命令数组里的占位符：只能是整个元素，且必须声明过；声明的参数必须被用上（E1 防拼接口子）
  const used = new Set<string>();
  for (const [i, el] of def.command.entries()) {
    const whole = PLACEHOLDER.exec(el);
    if (whole) {
      if (i === 0) {
        throw new SpcError('TEMPLATE_COMMAND_INVALID', { id: def.id, reason: 'executable-cannot-be-param' });
      }
      if (!names.has(whole[1])) {
        throw new SpcError('TEMPLATE_COMMAND_INVALID', { id: def.id, reason: `undeclared-placeholder:${whole[1]}` });
      }
      used.add(whole[1]);
      continue;
    }
    if (PARTIAL_PLACEHOLDER.test(el)) {
      throw new SpcError('TEMPLATE_COMMAND_INVALID', { id: def.id, reason: 'partial-placeholder' });
    }
  }
  for (const name of names) {
    if (!used.has(name)) {
      throw new SpcError('TEMPLATE_COMMAND_INVALID', { id: def.id, reason: `unused-param:${name}` });
    }
  }
}

export class TemplateRegistry {
  private readonly templates = new Map<string, TemplateDef>();
  /** action.op → 首个注册它的模板（权限点不含命名空间，撞名即失败） */
  private readonly points = new Map<string, string>();
  /** 命令形状 → 模板 ID（原生写法要能唯一匹配，形状撞了第二个注册失败） */
  private readonly shapes = new Map<string, string>();

  constructor(private readonly allowlist: string[] = executableAllowlist()) {}

  register(def: TemplateDef): void {
    if (this.templates.has(def.id)) {
      throw new SpcError('TEMPLATE_DUPLICATE', { id: def.id });
    }
    validateTemplate(def, this.allowlist);
    const point = permissionPointOf(def.id);
    const owner = this.points.get(point);
    if (owner) {
      throw new SpcError('TEMPLATE_DUPLICATE', { id: def.id, reason: `action.op 已被 ${owner} 占用` });
    }
    const shape = templateShape(def);
    const shapeOwner = this.shapes.get(shape);
    if (shapeOwner) {
      throw new SpcError('TEMPLATE_DUPLICATE', {
        id: def.id,
        reason: `命令形状与 ${shapeOwner} 相同：原生写法会匹配歧义`,
      });
    }
    this.templates.set(def.id, def);
    this.points.set(point, def.id);
    this.shapes.set(shape, def.id);
  }

  get(id: string): TemplateDef | undefined {
    return this.templates.get(id);
  }

  /** 撤销注册（回滚用：权限点注册失败时不留半注册状态） */
  unregister(id: string): boolean {
    const def = this.templates.get(id);
    if (!def) return false;
    this.templates.delete(id);
    this.points.delete(permissionPointOf(id));
    this.shapes.delete(templateShape(def));
    return true;
  }

  has(id: string): boolean {
    return this.templates.has(id);
  }

  all(): TemplateDef[] {
    return [...this.templates.values()];
  }
}

export const templates = new TemplateRegistry();
