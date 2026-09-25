// Manifest 校验器：ajv 加载 sdk/schema/manifest.schema.json
// 核心加载器、SDK、未来市场上传校验共用同一份 schema（单一事实源）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import type { Manifest, ManifestValidationResult } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, 'schema', 'manifest.schema.json');

const schema: object = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile<Manifest>(schema);

/**
 * 语法之外的**语义闸**（JSON Schema 表达不了的规则）。
 *
 * 目前一条：**依赖的调用句柄必须唯一**（句柄 = `as ?? id`）。
 * 为什么必须是硬失败：代码里写的是 `plugins.call('<句柄>', …)`，句柄一重名，宿主就分不清要调谁 ——
 * 而歧义**只能在校验期**发现（运行时看到的只是一个字符串）。要么给每条依赖写 `as`，要么改 id。
 *
 * 为什么放在这里而不是核心加载器里：校验器是**单一事实源**（核心装载、SDK 工具、将来市场上传
 * 共用同一份），放在这一层，作者在本地就能看见这条错误，而不是装到核心上才炸。
 */
function semanticErrors(raw: unknown): string[] {
  const manifest = raw as Manifest | undefined;
  const deps = manifest?.dependencies?.plugins;
  if (!Array.isArray(deps)) return [];
  const seen = new Map<string, number>();
  const errors: string[] = [];
  deps.forEach((dep, i) => {
    const handle = dep?.as ?? dep?.id;
    if (typeof handle !== 'string' || handle === '') return; // 形状问题交给 schema 报
    const first = seen.get(handle);
    if (first === undefined) {
      seen.set(handle, i);
      return;
    }
    errors.push(
      `/dependencies/plugins/${i} 调用句柄 ${JSON.stringify(handle)} 与第 ${first + 1} 条重复` +
        ` (handle must be unique: as ?? id)`,
    );
  });
  return errors;
}

/**
 * 校验插件清单。
 * 未知字段、缺失必填、枚举外取值、非 ESM 等一律拒绝（无默认放行）。
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  if (!validate(raw)) {
    const errors = (validate.errors ?? []).map((e) => {
      const params = e.params as Record<string, unknown> | undefined;
      const detail =
        params && Object.keys(params).length > 0
          ? ` (${Object.entries(params)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(', ')})`
          : '';
      return `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}${detail}`;
    });
    return { ok: false, errors };
  }
  const semantic = semanticErrors(raw);
  return semantic.length > 0 ? { ok: false, errors: semantic } : { ok: true, errors: [] };
}
