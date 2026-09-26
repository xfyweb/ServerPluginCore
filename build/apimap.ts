// 读 `api-permission-map.json`（生成物；见 `extract-api-map.ts` 的文件头）。
//
// 用途只有一个：`spcdev check` 的**权限点对账** —— 代码里用了 `fs.write`，就应当声明 `fs.write.data`（或 `.host`）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SpcError } from '../core/errors';

export interface ApiPermissionMap {
  mapSchema: 1;
  source: string;
  generator: string;
  methods: Record<string, string>;
}

let cached: ApiPermissionMap | undefined;

export function loadApiMap(file = join(import.meta.dirname, 'api-permission-map.json')): ApiPermissionMap {
  if (cached) return cached;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SpcError('PLUGIN_WORKSPACE_INVALID', {
      file,
      reason: 'api-map',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const map = parsed as Partial<ApiPermissionMap>;
  if (map?.mapSchema !== 1 || typeof map.methods !== 'object' || map.methods === null) {
    throw new SpcError('PLUGIN_WORKSPACE_INVALID', { file, reason: 'api-map-shape' });
  }
  cached = map as ApiPermissionMap;
  return cached;
}

/**
 * 权限点 → **族**：`fs.read.data` / `fs.read.host` 都归 `fs.read`。
 *
 * 为什么要族而不是精确点：**档位取决于运行期路径**（写自己数据目录是 `.data`、写宿主别处是 `.host`），
 * 静态判不出。对账只在族这一层做，精确点仍由运行期判定 —— 这条边界要写进输出，别让作者以为工具能替他选。
 */
export function pointFamily(point: string): string {
  return point.replace(/\.(data|host)$/, '');
}

/** 这个方法名在映射表里对应的权限点（没有 ⇒ `undefined`：`exec.*` / `plugins.call` 这类按声明或模板动态判） */
export function pointForMethod(method: string, map = loadApiMap()): string | undefined {
  return map.methods[method];
}
