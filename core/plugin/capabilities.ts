// 能力登记与回滚（docs/plugin-lifecycle-design.md §3）
//
// 为什么由 loader 按 manifest 登记、而不是插件 ctx.register()：
//   manifest 是审核对象与唯一事实源；卸载时能精确撤销，插件说了不算。
//
// 三条不变式：
//   1) **全有或全无**：先把本次要登记的东西在临时集合里算完，全部合法才提交；
//      任何冲突/非法 → PLUGIN_EXPORT_INVALID 且**不留半登记状态**（§3）。
//   2) **重载幂等**：reload 先 revoke(pluginId) 再 register()，登记表与 capabilities 完全一致，不叠加。
//   3) **登记结果可枚举**：capabilities: string[] 是撤销依据、CLI/面板展示与审计追溯的输入。
import type { FrontendMode, Manifest } from '../../sdk/types';
import { SpcError } from '../errors';
import { registry } from '../permissions/registry';

export interface RouteCapability {
  pluginId: string;
  path: string;
  title: string;
  icon?: string;
  order?: number;
  /** declarative = 核心渲染组件树；iframe = 插件 bundle 在隔离 iframe 内（P3） */
  frontendMode: FrontendMode;
}

export interface ApiCapability {
  pluginId: string;
  path: string;
  permission?: string;
}

export interface EventCapability {
  pluginId: string;
  topic: string;
  classification: 'public' | 'sensitive' | 'secret';
}

export interface SubscriptionCapability {
  pluginId: string;
  topic: string;
  mode: 'notify' | 'arbitrate';
}

export interface ThemeCapability {
  pluginId: string;
  /** 主题 id（约定与插件 id 同形，便于市场上唯一） */
  themeId: string;
  /** theme.json 相对插件目录的入口 */
  entry: string;
}

export interface CapabilitySnapshot {
  routes: RouteCapability[];
  webApis: ApiCapability[];
  publishedEvents: EventCapability[];
  subscriptions: SubscriptionCapability[];
  themes: ThemeCapability[];
}

export class CapabilityRegistry {
  private readonly routes = new Map<string, RouteCapability>();
  private readonly webApis = new Map<string, ApiCapability>();
  /** topic → 唯一发布者（同 topic 两方发布 → 冲突） */
  private readonly published = new Map<string, EventCapability>();
  /** topic → 订阅者列表（订阅可多方，不冲突） */
  private readonly subscriptions = new Map<string, SubscriptionCapability[]>();
  private readonly themes = new Map<string, ThemeCapability>();

  /**
   * 依 manifest 登记插件能力，返回 capabilities 清单。
   * @param themeEntry 主题包入口（manifest.theme 的解析结果；仅 type=theme 需要）
   */
  register(pluginId: string, manifest: Manifest, themeEntry?: string): string[] {
    const type = manifest.type ?? 'ability';
    const frontendMode: FrontendMode = manifest.frontend?.mode ?? 'declarative';

    // ① 先在临时集合里算完（全有或全无）
    const addRoutes: RouteCapability[] = [];
    const addApis: ApiCapability[] = [];
    const addEvents: EventCapability[] = [];
    const addSubs: SubscriptionCapability[] = [];
    const caps: string[] = [];

    for (const r of manifest.exports?.routes ?? []) {
      const owner = this.routes.get(r.path);
      if (owner && owner.pluginId !== pluginId) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId,
          kind: 'route',
          path: r.path,
          owner: owner.pluginId,
        });
      }
      addRoutes.push({
        pluginId,
        path: r.path,
        title: r.title,
        icon: r.icon,
        order: r.order,
        frontendMode,
      });
      caps.push(`route:${r.path}`);
    }

    for (const a of manifest.exports?.webApis ?? []) {
      const owner = this.webApis.get(a.path);
      if (owner && owner.pluginId !== pluginId) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId,
          kind: 'webApi',
          path: a.path,
          owner: owner.pluginId,
        });
      }
      // 声明的权限点必须已在注册表登记（未知即拒绝：不允许"先声明后实现"的悬挂权限）
      if (a.permission !== undefined && !registry.get(a.permission)) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId,
          kind: 'webApi-permission',
          path: a.path,
          permission: a.permission,
        });
      }
      addApis.push({ pluginId, path: a.path, permission: a.permission });
      caps.push(`api:${a.path}`);
    }

    for (const e of manifest.exports?.events?.publish ?? []) {
      const owner = this.published.get(e.topic);
      if (owner && owner.pluginId !== pluginId) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId,
          kind: 'event',
          topic: e.topic,
          owner: owner.pluginId,
        });
      }
      addEvents.push({ pluginId, topic: e.topic, classification: e.classification });
      caps.push(`event:${e.topic}`);
    }

    for (const s of manifest.exports?.events?.subscribe ?? []) {
      addSubs.push({ pluginId, topic: s.topic, mode: s.mode });
      caps.push(`subscribe:${s.topic}`);
    }

    if (type === 'theme') {
      if (!themeEntry) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', { pluginId, kind: 'theme', reason: 'entry-missing' });
      }
      const owner = this.themes.get(themeEntry);
      if (owner && owner.pluginId !== pluginId) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId,
          kind: 'theme',
          themeId: themeEntry,
          owner: owner.pluginId,
        });
      }
      this.themes.set(themeEntry, { pluginId, themeId: manifest.id, entry: themeEntry });
      caps.push(`theme:${themeEntry}`);
    }

    // ② 全部合法 → 提交（此时才动共享状态）
    for (const r of addRoutes) this.routes.set(r.path, r);
    for (const a of addApis) this.webApis.set(a.path, a);
    for (const e of addEvents) this.published.set(e.topic, e);
    for (const s of addSubs) {
      const list = this.subscriptions.get(s.topic) ?? [];
      list.push(s);
      this.subscriptions.set(s.topic, list);
    }

    return caps;
  }

  /** 撤销该插件的全部登记（重载与卸载都走这里；幂等） */
  revoke(pluginId: string): void {
    for (const [k, v] of [...this.routes]) if (v.pluginId === pluginId) this.routes.delete(k);
    for (const [k, v] of [...this.webApis]) if (v.pluginId === pluginId) this.webApis.delete(k);
    for (const [k, v] of [...this.published]) if (v.pluginId === pluginId) this.published.delete(k);
    for (const [k, list] of [...this.subscriptions]) {
      const kept = list.filter((s) => s.pluginId !== pluginId);
      if (kept.length === 0) this.subscriptions.delete(k);
      else this.subscriptions.set(k, kept);
    }
    for (const [k, v] of [...this.themes]) if (v.pluginId === pluginId) this.themes.delete(k);
  }

  /** 某插件订阅的 topic 清单（意图捕获 §8.5：授出网能力时要把这一屏显示给管理员） */
  topicsOf(pluginId: string): string[] {
    const topics: string[] = [];
    for (const [topic, list] of this.subscriptions) {
      if (list.some((s) => s.pluginId === pluginId)) topics.push(topic);
    }
    return topics.sort();
  }

  snapshot(): CapabilitySnapshot {
    return {
      routes: [...this.routes.values()],
      webApis: [...this.webApis.values()],
      publishedEvents: [...this.published.values()],
      subscriptions: [...this.subscriptions.values()].flat(),
      themes: [...this.themes.values()],
    };
  }

  /** 测试用：清空全部登记 */
  reset(): void {
    this.routes.clear();
    this.webApis.clear();
    this.published.clear();
    this.subscriptions.clear();
    this.themes.clear();
  }
}

export const capabilities = new CapabilityRegistry();
