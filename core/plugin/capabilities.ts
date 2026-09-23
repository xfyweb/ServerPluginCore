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
// 登记的**派生品**：权限点。别人的能力就是你授权时的候选集 —— 端点 ⇒ `plugins.call.<引用>.<path>`、
// 发布的 topic ⇒ `events.subscribe.<引用>.<topic>`（点名怎么拼见 core/permissions/points.ts，
// 为什么由**发布方/被调方**带出来见 docs/events-and-hooks-design.md §3.4/§3.7）。
// 它们跟着 `revoke()` 一起消失：能力没了，那条路就没了，授权不该留着。
import type { FrontendMode, Manifest } from '../../sdk/types';
import { SpcError } from '../errors';
import { registry } from '../permissions/registry';
import { callPointOf, subscribePointOf } from '../permissions/points';
import type { Confidentiality, ExecutionLevel, PermissionPoint } from '../permissions/registry';

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

/**
 * 订阅点的等级**取发布方声明的分类**（docs/events-and-hooks-design.md §1.10）：
 * 管理员在安装清单上看到的敏感度与真正会被投递的内容**同源** —— 两处各写一个值，迟早会出现
 * "标着 public、搬的却是敏感数据"。`executionLevel` 必须 ≥ `confidentiality`（注册期不变式，
 * 否则仲裁通道就是保密旁路），所以三档一一对齐。
 */
function subscribeLevel(classification: Confidentiality): {
  confidentiality: Confidentiality;
  executionLevel: ExecutionLevel;
} {
  if (classification === 'secret') return { confidentiality: 'secret', executionLevel: 'high' };
  if (classification === 'sensitive') return { confidentiality: 'sensitive', executionLevel: 'medium' };
  return { confidentiality: 'public', executionLevel: 'low' };
}

/**
 * 调用点的等级：**端点本身不带分类**（它只有面板侧的 `permission`，那是另一条路，见 §3.7 最后一条），
 * 所以这里只能给兜底值。这一次调用到底多敏感，由调用方在调用时声明（`CallMeta`）与用户目录覆盖合成
 * （api-contract §7.1）——注册表里这一栏从来只是"没人声明时的兜底"。
 */
const CALL_POINT_LEVEL = { confidentiality: 'public', executionLevel: 'low' } as const;

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
    const addPoints: PermissionPoint[] = [];
    const caps: string[] = [];

    /**
     * 认领一个动态权限点（能力的派生品）。**只在预演阶段调用** —— 冲突在这里就报错，
     * 于是提交阶段只是把算好的东西放进去，不会半途失败（不变式 1）。
     *
     * 同一个 ref 重复认领是允许的（重载幂等：提交时先撤后登）；被**别的 ref 或核心静态点**占着同名点
     * 才是冲突。点名里含完整引用，理论上撞不上，这条是"万一"的兜底（真撞上说明身份模型破了）。
     */
    const claimPoint = (
      name: string,
      level: { confidentiality: Confidentiality; executionLevel: ExecutionLevel },
      spec: { group: string; description: string; kind: string; subject: string },
    ): void => {
      const existing = registry.get(name);
      if (existing && existing.owner !== ref) {
        throw new SpcError('PLUGIN_EXPORT_INVALID', {
          pluginId: ref,
          kind: spec.kind,
          path: spec.subject,
          owner: existing.owner ?? '<core>',
        });
      }
      addPoints.push({
        name,
        group: spec.group,
        description: spec.description,
        scope: 'host',
        grant: 'install',
        owner: ref,
        ...level,
      });
    };

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
      // 派生点：**谁能调这个端点**。`callPointOf` 会校验 path 能不能进点名，不合法即装载失败 ——
      // 生成一个谁都声明不了的点，等于给管理员看一条不存在的路。
      // ⚠️ 今天**每个**端点都会带出这个点：`callable`（"谁能调"）是 §3.7 的第二条门槛，
      //    与 path 命名空间一起排在调用面本体（`plugins.call`）那一批 —— 在那之前，点是"可授权的候选集"，
      //    而判定链第 1 步只认"点存不存在"。
      claimPoint(callPointOf(ref, a.path), CALL_POINT_LEVEL, {
        group: 'plugins',
        description: `跨插件调用端点：${ref} ${a.path}`,
        kind: 'endpoint',
        subject: a.path,
      });
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
      // 派生点：**谁能听这个 topic**。发布方带出来的点里**不含 `secret`**：
      // `secret` 的 topic 本来就禁止跨插件（§1.12-2），给它设点等于承诺一条永远走不通的路。
      if (e.classification !== 'secret') {
        claimPoint(subscribePointOf(ref, e.topic), subscribeLevel(e.classification), {
          group: 'events',
          description: `订阅事件：${ref} ${e.topic}（分类 ${e.classification}）`,
          kind: 'event',
          subject: e.topic,
        });
      }
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
    // 动态权限点：先撤后登 ⇒ 同一个 ref 重复登记（重载）不会撞上注册表的重复检查
    for (const p of addPoints) {
      registry.unregister(p.name);
      registry.register(p);
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
    // 派生的动态权限点：能力没了，那条路就没了。撤销**认 owner、不认点名**——
    // 没有 owner 的静态点不受影响（否则一个插件的卸载能让全机器的 fs.read.data 消失）。
    registry.unregisterOwnedBy(ref);
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
    // 有 owner 的就是派生点（静态点没有这一栏）⇒ 精确清掉自己带出来的那些
    for (const point of registry.all()) {
      if (point.owner !== undefined) registry.unregister(point.name);
    }
  }
}

export const capabilities = new CapabilityRegistry();
