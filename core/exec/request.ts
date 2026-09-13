// exec 请求解析：兼容"开发者原生写法"——原始命令只用于**匹配模板**，执行的永远是模板的 argv。
//
//   ① 模板 ID 形式（精确）：exec.run('core:git.status', { repo: '/srv/demo' })
//      —— 与 exec.run('core:git.status', '{"repo":"/srv/demo"}') 等价（桥只传字符串）
//   ② 原生写法：exec.run('git -C /srv/demo status --porcelain=v1 --branch')
//              exec.run('git', ['-C', '/srv/demo', 'status', '--porcelain=v1', '--branch'])
//              exec.run(['git', '-C', '/srv/demo', 'status'])
//
// 安全不变式（关键）：
//   - 交给 spawn 的 argv **始终来自模板定义**，原始写法只做结构化匹配；
//   - 分词差异（引号、空格、Windows 路径）只会导致"匹配不到"→ 拒绝（fail-closed），
//     不会导致执行别的命令；
//   - 参数照旧逐个过模板校验（path 收敛等），**权限点也仍是模板的**（原生写法绕不过授权）。
import { SpcError } from '../errors';
import { templates, type TemplateDef } from './templates';
import { validateParam } from './params';

/** 桥契约：非字符串参数由 @host/api 以该前缀序列化（core/sandbox-modules/host-api.js） */
export const BRIDGE_JSON_PREFIX = '__spcJson:';

/** 解码桥标记（不是标记就原样返回） */
export function decodeBridgeArg(v: unknown): unknown {
  if (typeof v === 'string' && v.startsWith(BRIDGE_JSON_PREFIX)) {
    try {
      return JSON.parse(v.slice(BRIDGE_JSON_PREFIX.length));
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * 保守分词（仅用于匹配）：支持单/双引号，其余按空白切分。
 * 它决定"能否匹配到模板"，而执行用的是模板里的固定数组，所以分词不准 = 拒绝，不是放过。
 */
export function tokenizeCommand(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const PLACEHOLDER = /^\{([a-z][a-z0-9_]*)\}$/;

/** 可执行文件比较：模板里存绝对路径，开发者写命令名——只比 basename（去 Windows 扩展名） */
function sameExecutable(developerToken: string, templateToken: string): boolean {
  const norm = (p: string) => {
    const base = p.split(/[\\/]/).pop() ?? p;
    return process.platform === 'win32' ? base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() : base;
  };
  return norm(developerToken) === norm(templateToken);
}

interface Match {
  def: TemplateDef;
  /** 占位符 → 开发者给的原始值（尚未校验） */
  bound: Map<string, string>;
}

/** 匹配优先级：字面量多（占位符少）的更具体，优先命中；同分按注册顺序 */
function specificity(def: TemplateDef): number {
  return def.params?.length ?? 0;
}

/** 结构匹配：把开发者的 argv 与模板命令按"固定元素 / 占位符"逐位对齐 */
function tryMatch(def: TemplateDef, argv: string[]): Match | undefined {
  if (argv.length === 0) return undefined;
  const bound = new Map<string, string>();
  let ai = 0;
  for (const [i, el] of def.command.entries()) {
    const m = PLACEHOLDER.exec(el);
    if (m) {
      if (ai >= argv.length) return undefined;
      bound.set(m[1], argv[ai++]);
      continue;
    }
    if (ai >= argv.length) return undefined;
    const ok = i === 0 ? sameExecutable(argv[ai], el) : argv[ai] === el;
    if (!ok) return undefined;
    ai++;
  }
  return ai === argv.length ? { def, bound } : undefined;
}

/**
 * 选出最具体的结构匹配。
 * 例：`cmd /c echo noargs` 既对得上 `… echo {msg}`（占位符吞掉末位），也对得上 `… echo noargs`（字面量）；
 * **字面量优先**才会选后者——否则原生写法会命中另一个模板、连带权限点也错。
 */
function bestMatch(argv: string[]): Match | undefined {
  let best: Match | undefined;
  for (const def of templates.all()) {
    const m = tryMatch(def, argv);
    if (!m) continue;
    if (!best || specificity(m.def) < specificity(best.def)) best = m;
  }
  return best;
}

/** 第一个结构匹配的模板（**不做参数校验**）——权限解析与执行解析用同一条规则，避免二者不一致 */
export function matchExecTemplate(rawArgs: readonly unknown[]): TemplateDef | undefined {
  const a0 = decodeBridgeArg(rawArgs[0]);
  const a1 = decodeBridgeArg(rawArgs[1]);
  if (typeof a0 === 'string' && templates.has(a0)) return templates.get(a0);
  const argv = toArgv(a0, a1);
  if (!argv) return undefined;
  return bestMatch(argv)?.def;
}

function toArgv(a0: unknown, a1: unknown): string[] | undefined {
  if (Array.isArray(a0)) return a0.map(String);
  if (typeof a0 !== 'string') return undefined;
  if (Array.isArray(a1)) return [a0, ...a1.map(String)];
  return tokenizeCommand(a0);
}

export type ExecRequest =
  | { ok: true; def: TemplateDef; params: Record<string, unknown> }
  | { ok: false; code: string; params?: Record<string, string> };

/** 解析一次 exec.run 调用：模板 + 已校验参数（失败返回英文码） */
export function resolveExecRequest(rawArgs: readonly unknown[]): ExecRequest {
  const a0 = decodeBridgeArg(rawArgs[0]);
  const a1 = decodeBridgeArg(rawArgs[1]);

  // ① 模板 ID 形式：第二个参数是参数对象（或 JSON 文本）
  if (typeof a0 === 'string' && templates.has(a0)) {
    const def = templates.get(a0)!;
    const raw = typeof a1 === 'string' ? parseParamsJson(a1, a0) : a1;
    try {
      return { ok: true, def, params: validateAll(def, (raw ?? {}) as Record<string, unknown>) };
    } catch (err) {
      return toFailure(err, def.id);
    }
  }

  // ② 原生写法：形状匹配（字面量优先）→ 参数逐个校验（不做候选回溯，保证与权限解析一致）
  const argv = toArgv(a0, a1);
  if (!argv || argv.length === 0 || argv[0].length === 0) {
    return { ok: false, code: 'TEMPLATE_NOT_FOUND', params: { reason: 'unrecognized-request' } };
  }
  const best = bestMatch(argv);
  if (best) {
    try {
      const bound: Record<string, unknown> = {};
      for (const p of best.def.params ?? []) bound[p.name] = best.bound.get(p.name);
      return { ok: true, def: best.def, params: validateAll(best.def, bound) };
    } catch (err) {
      return toFailure(err, best.def.id);
    }
  }
  // 匹配不到 → 拒绝执行（绝不退回"自由命令"）
  return { ok: false, code: 'TEMPLATE_NOT_FOUND', params: { reason: 'no-matching-template' } };
}

function parseParamsJson(text: string, templateId: string): unknown {
  const t = text.trim();
  if (t === '' || t === 'undefined' || t === 'null') return {};
  try {
    return JSON.parse(t);
  } catch {
    throw new SpcError('TEMPLATE_PARAM_INVALID', { templateId, reason: 'params-not-json' });
  }
}

/** 逐参数校验并按类型归一化（path → 收敛后的绝对路径） */
function validateAll(def: TemplateDef, raw: Record<string, unknown>): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SpcError('TEMPLATE_PARAM_INVALID', { templateId: def.id, reason: 'params-not-an-object' });
  }
  const spec = new Map((def.params ?? []).map((p) => [p.name, p]));
  for (const key of Object.keys(raw)) {
    if (!spec.has(key)) throw new SpcError('TEMPLATE_PARAM_UNKNOWN', { templateId: def.id, param: key });
  }
  const out: Record<string, unknown> = {};
  for (const p of def.params ?? []) {
    if (!(p.name in raw)) throw new SpcError('TEMPLATE_PARAM_MISSING', { templateId: def.id, param: p.name });
    out[p.name] = validateParam(p, raw[p.name]);
  }
  return out;
}

function toFailure(err: unknown, templateId: string): ExecRequest {
  if (err instanceof SpcError) return { ok: false, code: err.code, params: err.params };
  return { ok: false, code: 'TEMPLATE_PARAM_INVALID', params: { templateId, reason: 'validation-failed' } };
}
