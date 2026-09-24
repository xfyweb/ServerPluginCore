// 权限点的**查询视图**：冻结表 ∪ 临时表（docs/api-contract.md §6）
//
// 注册表不是一张表，是两张，生命周期完全不同（2026-09-24 定）：
//
// | | 谁写 | 什么时候写 | 运行期会变吗 |
// |---|---|---|---|
// | **冻结表**（`core/permissions/registry.ts`） | 核心自己 + **驱动插件**（启动早期） | 只有核心启动阶段：核心静态点 → 驱动注册点 | **不变**（能力插件加载前就固化） |
// | **临时表**（本文件） | 没人写 —— 它是**从当前活着的插件派生**出来的 | 随插件装载/卸载即时变化 | 是（跟着"谁在跑"） |
//
// 为什么动态点**不进**冻结表：注册表一旦固化就不该被运行期的插件增删，否则"注册表"这个词就没意义了
// —— 判定链、审计、面板、测试都指望它是一份**稳定的**事实（`permissions-meta.test.ts` 那份显式清单
// 就是这种指望：它必须与 `all()` 逐项相等）。早先把 `plugins.call.*` / `events.subscribe.*` 写进冻结表，
// 直接后果就是那份清单得**跳过**它们才能对齐 —— 那是污染的症状，不是设计。
//
// 为什么临时表**不存储**、而是每次查时派生：能存的东西就有不一致的可能（点还在、端点早删了），
// 而 `capabilities` 快照本来就是"当前活着的插件登记了什么"的唯一事实源。派生 = 没有第二份真相。
//
// ⛔ **不反向解析点名**（设计 §3.4）：这里用"把每个端点的点名**生成**出来再逐字比较"的办法 ——
// 生成是单射的（`points.ts` 证明了），所以既不需要、也不该从点名里切回 `(ref, path)`。
import { capabilities } from '../plugin/capabilities';
import { callPointOf, subscribePointOf } from './points';
import { registry, type Confidentiality, type ExecutionLevel, type PermissionPoint } from './registry';

/**
 * 判定链与授权校验看到的"点表"。冻结表与临时表都满足它。
 * 只留 `get`：这是判定唯一需要的操作（枚举留给各自的使用方，别把它塞进判定路径）。
 */
export interface PointSource {
  get(name: string): PermissionPoint | undefined;
}

/** 跨插件调用的临时点：端点本身不带分类（面板侧那个 `permission` 是另一条路），取 public/low 兜底 */
function callPointOfEndpoint(ref: string, path: string): PermissionPoint {
  return {
    name: callPointOf(ref, path),
    group: 'plugins',
    description: `跨插件调用端点：${ref} ${path}`,
    scope: 'host',
    // 跨插件一律 explicit：插件之间**默认隔离**（exports 默认私有、看不见别的插件），
    // 调用别人的端点是跨过去 ⇒ 管理员逐条点头。
    grant: 'explicit',
    confidentiality: 'public',
    executionLevel: 'low',
  };
}

/**
 * 订阅点的等级**取发布方声明的分类**（设计 §1.10）：管理员看到的敏感度与真正会被投递的内容同源。
 * `executionLevel` 必须 ≥ `confidentiality`（注册期不变式，否则仲裁通道就是保密旁路）⇒ 三档一一对齐。
 */
function subscribePointOfTopic(
  ref: string,
  topic: string,
  classification: Confidentiality,
): PermissionPoint {
  const level: { confidentiality: Confidentiality; executionLevel: ExecutionLevel } =
    classification === 'secret'
      ? { confidentiality: 'secret', executionLevel: 'high' }
      : classification === 'sensitive'
        ? { confidentiality: 'sensitive', executionLevel: 'medium' }
        : { confidentiality: 'public', executionLevel: 'low' };
  return {
    name: subscribePointOf(ref, topic),
    group: 'events',
    description: `订阅事件：${ref} ${topic}（分类 ${classification}）`,
    scope: 'host',
    grant: 'explicit',
    ...level,
  };
}

/**
 * 临时表查询：当前活着的插件里，有没有一个端点 / 一个已发布 topic 正好对应这个名字。
 * 找不到 ⇒ `undefined`（判定链第 1 步按 `UNKNOWN_POINT` 拒，fail-closed）。
 */
export function resolveDynamicPoint(name: string): PermissionPoint | undefined {
  const snap = capabilities.snapshot();
  for (const e of snap.endpoints) {
    const point = callPointOfEndpoint(e.ref, e.path);
    if (point.name === name) return point;
  }
  for (const e of snap.publishedEvents) {
    // `secret` 的 topic **禁止跨插件**（设计 §1.12-2）⇒ 不设点：设了就是承诺一条永远走不通的路
    if (e.classification === 'secret') continue;
    const point = subscribePointOfTopic(e.ref, e.topic, e.classification);
    if (point.name === name) return point;
  }
  return undefined;
}

/**
 * 判定与授权校验用的点表：**冻结表优先，其次临时表**。
 * 冻结表在前是因为它是稳定事实；两张表不会同名（动态点前缀 `plugins.call.` / `events.subscribe.`
 * 与任何静态点名都不同形 —— 静态点是 `<group>.<action>[.<scope>]`，不含 `/` 与 `@`）。
 */
export const pointSource: PointSource = {
  get(name: string): PermissionPoint | undefined {
    return registry.get(name) ?? resolveDynamicPoint(name);
  },
};

/** 供展示层与测试用：临时表当前的全部点名（派生的；调用方自己排序） */
export function dynamicPointNames(): string[] {
  const snap = capabilities.snapshot();
  return [
    ...snap.endpoints.map((e) => callPointOf(e.ref, e.path)),
    ...snap.publishedEvents
      .filter((e) => e.classification !== 'secret')
      .map((e) => subscribePointOf(e.ref, e.topic)),
  ];
}
