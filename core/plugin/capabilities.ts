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
//
// ⛔ **本类不写权限注册表**（2026-09-24 改）。早先这里会把端点/topic 变成注册表里的"动态点"
// （还带个 `owner` 字段用于撤销），但注册表按模型是**冻结**的：核心启动阶段写完（核心静态点 + 驱动插件点）
// 就固化，运行期不再被插件增删。跨插件调用/订阅的点是**临时表**，从本类这份登记**派生**出来
// （`core/permissions/source.ts`）—— 于是这里不需要"登记点/撤销点"，也就不可能让登记表与点表不一致。
import type { FrontendMode, Manifest } from '../../sdk/types';
import { SpcError } from '../errors';
import { registry } from '../permissions/registry';
import { callPointOf } from '../permissions/points';

export interface RouteCapability {
  ref: string;
  path: string;
  title: string;
  icon?: string;
  order?: number;
  /** declarative = 核心渲染组件树；iframe = 插件 bundle 在隔离 iframe 内（P3） */
  frontendMode: FrontendMode;
}

/**
 * 端点能力（原 `ApiCapability`，manifest 里原叫 `exports.webApis`）。
 * **改名理由**：这个面的调用者**有两类**（面板的 HTTP 网关 / 其他插件），`webApis` 既排除了插件、
 * 又暗示了实现路径；文档里"端点"这个词本来就在用（见 `docs/events-and-hooks-design.md` §3.1）。
 * ⚠️ **两件还没做**（别照文档以为已就位）：① `callable`（谁能调）—— 等插件间调用面落地再加，
 * 不提前给插件承诺一个没实现的字段；② "`path` 必须带自己的**完整引用**命名空间"—— 等身份改成
 * `(origin, id)`（§3.2）之后才有 origin 可拼。
 */
export interface EndpointCapability {
  ref: string;
  path: string;
  permission?: string;
}

export interface EventCapability {
  ref: string;
  topic: string;
  classification: 'public' | 'sensitive' | 'secret';
}

export interface SubscriptionCapability {
  ref: string;
  topic: string;
  mode: 'notify' | 'arbitrate';
}

export interface ThemeCapability {
  ref: string;
  /** 主题 id（约定与插件 id 同形，便于市场上唯一） */
  themeId: string;
  /** theme.json 相对插件目录的入口 */
  entry: string;
}

export interface CapabilitySnapshot {
  routes: RouteCapability[];
  endpoints: EndpointCapability[];
  publishedEvents: EventCapability[];
  subscriptions: SubscriptionCapability[];
  themes: ThemeCapability[];
}

export class CapabilityRegistry {
  private readonly routes = new Map<string, RouteCapability>();
  private readonly endpoints = new Map<string, EndpointCapability>();
  /** topic → 唯一发布者（同 topic 两方发布 → 冲突） */
  private readonly published = new Map<string, EventCapability>();
  /** topic → 订阅者列表（订阅可多方，不冲突） */
  private readonly subscriptions = new Map<string, SubscriptionCapability[]>();
  private readonly themes = new Map<string, ThemeCapability>();

  /**
   * 依 manifest 登记插件能力，返回 capabilities 清单。
   * @param ref **完整引用** `<origin>/<id>`（不是裸 id —— 同 id 不同来源是两个插件，能力归属也必须分开）
   * @param themeEntry 主题包入口（manifest.theme 的解析结果；仅 type=theme 需要）
   */
  register(ref: string, manifest: Manifest, themeEntry?: string): string[] {
    const type = manifest.type ?? 'ability';
    const frontendMode: FrontendMode = manifest.frontend?.mode ?? 'declarative';

    // ① 先在临时集合里算完（全有或全无）
    const addRoutes: RouteCapability[] = [];
    const addEndpoints: EndpointCapability[] = [];
    const addEvents: EventCapability[] = [];
    const addSubs: SubscriptionCapability[] = [];
    const caps: string[] = [];

    for (const r of manifest.exports?.routes ?? []) {
      const owner = this.routes.get(r.path);
      if (owner && owner.ref !== ref) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId: ref,
          kind: 'route',
          path: r.path,
          owner: owner.ref,
        });
      }
      addRoutes.push({
        ref,
        path: r.path,
        title: r.title,
        icon: r.icon,
        order: r.order,
        frontendMode,
      });
      caps.push(`route:${r.path}`);
    }

    for (const a of manifest.exports?.endpoints ?? []) {
      const owner = this.endpoints.get(a.path);
      if (owner && owner.ref !== ref) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId: ref,
          kind: 'endpoint',
          path: a.path,
          owner: owner.ref,
        });
      }
      // 声明的权限点必须已在注册表登记（未知即拒绝：不允许"先声明后实现"的悬挂权限）
      if (a.permission !== undefined && !registry.get(a.permission)) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId: ref,
          kind: 'endpoint-permission',
          path: a.path,
          permission: a.permission,
        });
      }
      addEndpoints.push({ ref, path: a.path, permission: a.permission });
      caps.push(`endpoint:${a.path}`);
      // 端点必须能进点名（`plugins.call.<引用>.<path>`）：空白进不了 `permissions[].name` 的 schema
      // （会生成一个谁都声明不了的点），`*` 会被 `matchDeclaration` 当通配（一次声明预授权将来新增的端点）。
      // 这里**只校验、不登记** —— 点由临时表从本类这份登记派生（`core/permissions/source.ts`）。
      // 不合法 ⇒ 装载失败 `PERMISSION_POINT_INVALID`，全有或全无。
      callPointOf(ref, a.path);
    }

    for (const e of manifest.exports?.events?.publish ?? []) {
      const owner = this.published.get(e.topic);
      if (owner && owner.ref !== ref) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId: ref,
          kind: 'event',
          // `path` 是 locale 文案里的占位符（`{kind} {path}`），`topic` 留作结构化字段
          path: e.topic,
          topic: e.topic,
          owner: owner.ref,
        });
      }
      addEvents.push({ ref, topic: e.topic, classification: e.classification });
      caps.push(`event:${e.topic}`);
    }

    for (const s of manifest.exports?.events?.subscribe ?? []) {
      addSubs.push({ ref, topic: s.topic, mode: s.mode });
      caps.push(`subscribe:${s.topic}`);
    }

    if (type === 'theme') {
      if (!themeEntry) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', { pluginId: ref, kind: 'theme', reason: 'entry-missing' });
      }
      const owner = this.themes.get(themeEntry);
      if (owner && owner.ref !== ref) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId: ref,
          kind: 'theme',
          themeId: themeEntry,
          owner: owner.ref,
        });
      }
      this.themes.set(themeEntry, { ref, themeId: manifest.id, entry: themeEntry });
      caps.push(`theme:${themeEntry}`);
    }

    // ② 全部合法 → 提交（此时才动共享状态）
    for (const r of addRoutes) this.routes.set(r.path, r);
    for (const a of addEndpoints) this.endpoints.set(a.path, a);
    for (const e of addEvents) this.published.set(e.topic, e);
    for (const s of addSubs) {
      const list = this.subscriptions.get(s.topic) ?? [];
      list.push(s);
      this.subscriptions.set(s.topic, list);
    }

    return caps;
  }

  /** 撤销该插件的全部登记（重载与卸载都走这里；幂等）。参数是**完整引用** */
  revoke(ref: string): void {
    for (const [k, v] of [...this.routes]) if (v.ref === ref) this.routes.delete(k);
    for (const [k, v] of [...this.endpoints]) if (v.ref === ref) this.endpoints.delete(k);
    for (const [k, v] of [...this.published]) if (v.ref === ref) this.published.delete(k);
    for (const [k, list] of [...this.subscriptions]) {
      const kept = list.filter((s) => s.ref !== ref);
      if (kept.length === 0) this.subscriptions.delete(k);
      else this.subscriptions.set(k, kept);
    }
    for (const [k, v] of [...this.themes]) if (v.ref === ref) this.themes.delete(k);
    // 权限点**不需要在这里撤**：冻结表从来没有被本类写过，临时表是派生的 ——
    // 上面这几行删完，`plugins.call.<ref>.*` / `events.subscribe.<ref>.*` 下一次查询就不存在了。
  }

  /** 某插件订阅的 topic 清单（意图捕获 §8.5：授出网能力时要把这一屏显示给管理员） */
  topicsOf(ref: string): string[] {
    const topics: string[] = [];
    for (const [topic, list] of this.subscriptions) {
      if (list.some((s) => s.ref === ref)) topics.push(topic);
    }
    return topics.sort();
  }

  snapshot(): CapabilitySnapshot {
    return {
      routes: [...this.routes.values()],
      endpoints: [...this.endpoints.values()],
      publishedEvents: [...this.published.values()],
      subscriptions: [...this.subscriptions.values()].flat(),
      themes: [...this.themes.values()],
    };
  }

  /** 测试用：清空全部登记（连带**派生的动态权限点**；核心写死的静态点不动） */
  reset(): void {
    this.routes.clear();
    this.endpoints.clear();
    this.published.clear();
    this.subscriptions.clear();
    this.themes.clear();
    // 冻结表不归本类管 ⇒ 没有要清的（临时表是派生的，上面清完自然就空了）
  }
}

export const capabilities = new CapabilityRegistry();
