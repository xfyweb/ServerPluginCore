// `spcdev permission list`：列**本机已注册的权限点**（写清单时照着抄；`docs/build-layer-design.md` §10.5）。
//
// 数据源是**冻结表**（`core/permissions/registry.ts`）—— 核心静态点 + 驱动插件启动期注册的点。
// ⚠️ **临时表**（`plugins.call.<引用>.<path>` / `events.subscribe.<引用>.<topic>`）是从**活着的插件**派生的，
// 构建层/CLI 本地拿不到（那要连 daemon）⇒ 这里只列冻结表，动态族的形状另附说明。
import { resolveGrant, type Grant, type PermissionPoint } from '../core/permissions/registry';
import { registry } from '../core/permissions/registry';

export interface PermissionRow {
  name: string;
  group: string;
  /** `self` 够不着别人 / `host` 碰宿主资源 */
  scope: 'self' | 'host';
  /** 实际生效的档位（`grant` 缺省按 scope 推导） */
  grant: Grant;
  confidentiality: string;
  executionLevel: string;
  description: string;
}

export function listPermissions(): PermissionRow[] {
  return registry
    .all()
    .map((p: PermissionPoint) => ({
      name: p.name,
      group: p.group,
      scope: p.scope,
      grant: resolveGrant(p.scope, p.grant),
      confidentiality: p.confidentiality,
      executionLevel: p.executionLevel,
      description: p.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 动态点族的形状说明（`spcdev permission list` 末尾提示用；作者要写的是**完整引用 + 尾段**） */
export const DYNAMIC_POINT_HINT = [
  'plugins.call.<完整引用>.<端点 path>',
  'events.subscribe.<完整引用>.<topic>',
] as const;
