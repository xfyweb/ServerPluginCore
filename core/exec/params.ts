// 模板参数校验与 argv 构造（E1 / E2 / E9）
//
// 两条铁律：
//   1) 参数**永远是独立的 argv 元素**，绝不拼进命令字符串（E1）；
//   2) 占位符只能是**整个元素**（`{repo}`），出现部分拼接（`--file={repo}`）直接算模板定义非法（注册时已拦）。
import { existsSync } from 'node:fs';
import { SpcError } from '../errors';
import { validatePath } from '../fs/safe-path';
import type { TemplateDef, TemplateParam } from './templates';

const PLACEHOLDER = /^\{([a-z][a-z0-9_]*)\}$/;
const MAX_PARAM_CHARS = 4096;

/** 校验单个参数并按类型归一化（path 类型返回收敛后的绝对路径） */
export function validateParam(p: TemplateParam, value: unknown): string {
  if (typeof value !== 'string') {
    throw new SpcError('TEMPLATE_PARAM_INVALID', { param: p.name, reason: 'not-a-string' });
  }
  if (value.length === 0 || value.length > MAX_PARAM_CHARS) {
    throw new SpcError('TEMPLATE_PARAM_INVALID', { param: p.name, reason: 'length' });
  }
  switch (p.type) {
    case 'enum':
    case 'whitelist':
      if (!p.allowed!.includes(value)) {
        throw new SpcError('TEMPLATE_PARAM_INVALID', { param: p.name, reason: 'not-allowed' });
      }
      return value;
    case 'pattern': {
      const re = new RegExp(`^(?:${p.pattern})$`);
      if (!re.test(value)) {
        throw new SpcError('TEMPLATE_PARAM_INVALID', { param: p.name, reason: 'pattern-mismatch' });
      }
      return value;
    }
    case 'path': {
      // E9：路径收敛（越界 / 软链逃逸 / 特殊文件都在这里被拒）
      const { path } = validatePath(value, p.scope!);
      if (p.mustExist && !existsSync(path)) {
        throw new SpcError('TEMPLATE_PARAM_INVALID', { param: p.name, reason: 'must-exist' });
      }
      return path;
    }
    default:
      throw new SpcError('TEMPLATE_PARAM_INVALID', { param: p.name, reason: 'unknown-type' });
  }
}

/** 构造最终 argv：固定命令数组 + 占位符替换（逐元素，不拼接） */
export function buildArgv(def: TemplateDef, raw: Record<string, unknown>): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SpcError('TEMPLATE_PARAM_INVALID', { templateId: def.id, reason: 'params-not-an-object' });
  }
  const declared = def.params ?? [];
  const spec = new Map(declared.map((p) => [p.name, p]));
  for (const key of Object.keys(raw)) {
    if (!spec.has(key)) {
      throw new SpcError('TEMPLATE_PARAM_UNKNOWN', { templateId: def.id, param: key });
    }
  }
  const values = new Map<string, string>();
  for (const p of declared) {
    if (!(p.name in raw)) {
      throw new SpcError('TEMPLATE_PARAM_MISSING', { templateId: def.id, param: p.name });
    }
    values.set(p.name, validateParam(p, raw[p.name]));
  }
  return def.command.map((el) => {
    const m = PLACEHOLDER.exec(el);
    return m ? values.get(m[1])! : el;
  });
}
