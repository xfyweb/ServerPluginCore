// 插件配置（docs/plugin-lifecycle-design.md §1.6）
//
// 契约三件套：
//   1) 声明：manifest.configSchema（JSON Schema 子集；支持 default / description / enum / secret）
//   2) 取值：<STATE_DIR>/config/plugins/<来源>/<sanitized-id>.json（**按 (origin, id) 分开**，
//      同 id 不同来源是两个插件）；读取时**按 schema 校验 → 补默认值**
//   3) 注入：ctx.config 是**只读快照**（沙箱侧 deepFreeze），插件只能读
//
// 为什么没有 ctx.config.set()：写配置 = 改持久状态，必须走管理员与审计路径。
// 插件要存运行期数据用 ctx.dataDir（kv）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { ensureDir, pluginConfigPath } from '../config';
import { SpcError } from '../errors';
import { pluginRef } from './records';

/**
 * configSchema 是 JSON Schema 的**子集**，但带一个自有扩展：`secret: true`。
 * 显式登记这个 keyword（而不是关掉 strict）——这样 schema 里出现拼错的 keyword 仍会报错。
 */
const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: true });
ajv.addKeyword({ keyword: 'secret', schemaType: 'boolean', valid: true });

const cache = new Map<string, ValidateFunction>();

function compile(schema: object): ValidateFunction {
  const key = JSON.stringify(schema);
  const hit = cache.get(key);
  if (hit) return hit;
  let fn: ValidateFunction;
  try {
    fn = ajv.compile(schema);
  } catch (err) {
    throw new SpcError('PLUGIN_CONFIG_INVALID', {
      reason: 'schema-compile',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  cache.set(key, fn);
  return fn;
}

export interface PluginConfigResult {
  ok: boolean;
  errors: string[];
  /** 补过默认值的值（校验失败时是尽力填充的结果，调用方不应使用） */
  values: Record<string, unknown>;
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function isSchemaObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 校验并补默认值（纯函数，不落盘；可单测） */
export function validatePluginConfig(schema: unknown, values: unknown): PluginConfigResult {
  if (!isSchemaObject(schema) || Object.keys(schema).length === 0) {
    // 没声明 configSchema：只接受空配置，避免"没声明却能塞任意值"
    const hasValues = values !== undefined && values !== null && Object.keys(values as object).length > 0;
    return hasValues
      ? { ok: false, errors: ['config: plugin declares no configSchema'], values: {} }
      : { ok: true, errors: [], values: {} };
  }
  const input = (values === undefined || values === null ? {} : clone(values)) as Record<string, unknown>;
  const validate = compile(schema);
  const ok = validate(input);
  const errors = ok
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`);
  return { ok, errors, values: input };
}

/**
 * 读该插件的配置值（文件不存在 → 全默认值）。
 * ⚠️ 参数带 **`origin`**：配置是**按 `(origin, id)` 分开**存的（同 id 不同来源是两个插件，设计 §3.3）。
 */
export function loadPluginConfig(origin: string, id: string, schema: unknown): Record<string, unknown> {
  const ref = pluginRef({ origin, id });
  const path = pluginConfigPath(origin, id);
  let stored: unknown = {};
  if (existsSync(path)) {
    try {
      stored = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new SpcError('PLUGIN_CONFIG_INVALID', {
        pluginId: ref,
        reason: 'malformed-json',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const result = validatePluginConfig(schema, stored);
  if (!result.ok) {
    throw new SpcError('PLUGIN_CONFIG_INVALID', {
      pluginId: ref,
      reason: 'stored-values',
      detail: result.errors.join('; '),
    });
  }
  return result.values;
}

/** 保存配置值（非法值拒绝保存 → PLUGIN_CONFIG_INVALID）；`origin` 同上 */
export function savePluginConfig(
  origin: string,
  id: string,
  schema: unknown,
  values: unknown,
): Record<string, unknown> {
  const ref = pluginRef({ origin, id });
  const result = validatePluginConfig(schema, values);
  if (!result.ok) {
    throw new SpcError('PLUGIN_CONFIG_INVALID', {
      pluginId: ref,
      reason: 'invalid-values',
      detail: result.errors.join('; '),
    });
  }
  const path = pluginConfigPath(origin, id);
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(result.values, null, 2) + '\n', 'utf8');
  return result.values;
}
