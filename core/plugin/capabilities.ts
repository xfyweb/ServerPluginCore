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
 * ⛔ **`path` 里不放来源**（2026-09-25 取消「必须带自己完整引用命名空间」那条）：同一条 path 还要被
 * **调用方**写进自己清单的 `dependencies.plugins[].call`，两处都在**被签名的字节**里 —— path 一带 origin，
 * 对方换一次源（reanchor / promote / 本地桶改名）就让调用方的包当场失效；何况本地桶名是**装机的人**起的
 * 标签，作者签名时根本写不出来。来源只出现在**宿主生成**的地方（点名 `plugins.call.<实际引用>.<path>`、
 * 审计、响应信封）。
 * ✅ 同时明确：path **也不需要全局唯一** —— 端点表的键是 **`(完整引用, path)`**（见 `endpointKey`）。
 * 身份是 `(origin, id)`，两个插件各自声明 `/api/status` 是两个**不同**的端点，不是冲突；
 * 只有"同一个插件把同一条 path 声明两次"才是清单错误。
 */
export interface EndpointCapability {
  ref: string;
  path: string;
  permission?: string;
  /**
   * 谁能调（**缺省 `['panel']`**，fail-closed）。跨插件调用的门槛三就是查这里有没有 `'plugins'`：
   * 端点默认只服务面板，要开放给别的插件必须**作者自己声明**，所以"没声明"必须是一条**阻塞**，
   * 而不是"默认允许"。
   */
  callable: ('panel' | 'plugins')[];
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

/**
 * 端点表的键：**`(完整引用, path)`**。
 *
 * 为什么不是 path 单键（2026-09-25 改）：身份是 `(origin, id)` —— **同名端点分属两个插件不是冲突**，
 * 就像"两个作者各有一个 `/status`"。用 NUL 分隔是因为两者都不含 NUL（`ref` 的形状由 `pluginRef()`
 * 保证、`path` 由 schema 的 `^/api/` 保证），所以拼接是**单射**的，不会出现 `a|b` 与 `a|b` 的歧义。
 */
function endpointKey(ref: string, path: string): string {
  return `${ref}\u0000${path}`;
}

export class CapabilityRegistry {  private readonly routes = new Map<string, RouteCapability>();
  /** 端点表：键是 **`(完整引用, path)`**（`endpointKey`）—— 跨插件同名端点不是冲突，见 `EndpointCapability` 的注释 */
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

    // 本次清单内**跨插件不冲突、同插件内不许重复**：`seenEndpoints` 记的是"这一份清单里出现过的键"，
    // 因为重复项这时还只在 `addEndpoints`（临时集合）里，查已提交的表是查不到的（判别用例抓过这个漏）。
    const seenEndpoints = new Set<string>();
    for (const a of manifest.exports?.endpoints ?? []) {
      // ⚠️ **跨插件同名端点不是冲突**（2026-09-25 改）：端点表的键是 `(完整引用, path)`，因为身份是
      // `(origin, id)` —— 两个插件各自声明 `/api/status` 是两个不同的端点，谁是谁由引用决定，
      // 调用面（点名、审计、响应信封）全程按 `(ref, path)` 寻址。只有**同一个插件**把同一条 path
      // 声明两次才是清单错误：那种清单没意义，而且会让"这个端点是谁的"变含糊。
      const key = endpointKey(ref, a.path);
      if (seenEndpoints.has(key) || this.endpoints.has(key)) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId: ref,
          kind: 'endpoint',
          path: a.path,
          reason: 'duplicate',
        });
      }
      seenEndpoints.add(key);
      // 声明的权限点必须已在注册表登记（未知即拒绝：不允许"先声明后实现"的悬挂权限）
      if (a.permission !== undefined && !registry.get(a.permission)) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId: ref,
          kind: 'endpoint-permission',
          path: a.path,
          permission: a.permission,
        });
      }
      addEndpoints.push({
        ref,
        path: a.path,
        permission: a.permission,
        // 缺省 `['panel']`：端点默认只服务面板，开放给插件必须作者显式声明（fail-closed）
        callable: a.callable ?? ['panel'],
      });
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
    for (const a of addEndpoints) this.endpoints.set(endpointKey(a.ref, a.path), a);
    for (const e of addEvents) this.published.set(e.topic, e);
    for (const s of addSubs) {
      const list = this.subscriptions.get(s.topic) ?? [];
      list.push(s);
      this.subscriptions.set(s.topic, list);
    }

    return caps;
  }

  /**
   * 某插件当前登记的某个端点（没有 = 它没登记这条 path）。
   * 直接按 `(完整引用, path)` 命中 —— 不再"按 path 取出再比 ref"（那是 path 单键时代的写法）。
   */
  endpointOf(ref: string, path: string): EndpointCapability | undefined {
    return this.endpoints.get(endpointKey(ref, path));
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
