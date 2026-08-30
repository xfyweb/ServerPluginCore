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
 * 校验插件清单。
 * 未知字段、缺失必填、枚举外取值、非 ESM 等一律拒绝（无默认放行）。
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  if (validate(raw)) {
    return { ok: true, errors: [] };
  }
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
