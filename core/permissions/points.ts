// 动态权限点：**由引用派生的点名**（docs/events-and-hooks-design.md §3.4）
//
// 两个动态点族（都是"别人登记了某个能力"的派生品，不是核心写死的静态点）：
//   plugins.call.<完整引用>.<path>        跨插件调用某个端点
//   events.subscribe.<完整引用>.<event>   订阅某个发布方的事件
// 形状照 core/exec/templates.ts 的 `permissionPointOf`（那是现成先例：模板 ID → `exec.template.<action>.<op>`）。
//
// **为什么点名里带完整引用**（`<origin>/@user/name`）：身份是 `(origin, id)`，同 id 不同来源是**两个插件**
// （§3.2）⇒ 点名不带源，两个同名插件就共用同一条授权，"管理员批准了 A 调 B"会被 C 白拿。
//
// **为什么是字面拼接**（不转义、不摘要）：
//   ① **唯一性可证**：origin 不含 `/` 与 `@`，id 恰好一个 `/` 与一个 `@` ⇒ 拼出来是单射（见下方 assertRef）；
//   ② 管理员在 CLI / 面板上看到的点名里**直接含插件引用**，可 grep、可与授权记录对照；
//   ③ 摘要/转义会让"这个点是哪个插件的"变成一个必须查表的问题，而查表又要求先把表建起来。
// ⚠️ 代价：`permissions[].name` 的 schema 形状要放宽（静态点仍是 `<group>.<action>[.<scope>]`，
//    动态点走另一条分支）——见 sdk/schema/manifest.schema.json 的 `permissions.items.properties.name`。
//
// ⛔ **不做反向解析**（§3.4）：展示层用"源别名 + 插件短名"，存储与判定用全称。
//    源别名可以改，一旦别名进了点名，改一次别名就会让一条已授出的授权凭空消失。
//    撤销也不靠解析 —— 点自己记着 `owner`（见 core/permissions/registry.ts 的 `unregisterOwnedBy`）。
import { PLUGIN_ID_RE } from '../../sdk/ids';
import { isValidSource } from '../config';
import { SpcError } from '../errors';

/** 跨插件调用的动态点前缀 */
export const CALL_POINT_PREFIX = 'plugins.call';
/** 订阅他人事件的动态点前缀 */
export const SUBSCRIBE_POINT_PREFIX = 'events.subscribe';

/**
 * 尾段（端点 path / 事件 topic）的合法形状：**非空、无空白、不含 `*`**。
 *
 * 为什么下限只有这么两条（而不是一张白名单字符集）：端点 path 的 schema 今天只要求 `^/api/`，
 * **收紧它等于改契约**——会拒掉别人已经能装进去的包。所以这里只挡两种"进了点名必然出事"的字符：
 *   ① **空白**：`permissions[].name` 的 schema 表达不了它 ⇒ 生成的是一个**谁都声明不了**的死点
 *      （点存在、管理员还能给它授权，但没有任何清单能声明它）；
 *   ② **`*`**：`matchDeclaration` 把它当通配 ⇒ 一次 `plugins.call.<引用>.*` 的声明就把该插件**未来新增**
 *      的端点全预授权了，而设计要的恰恰是"新增端点走**增量同意**"（§3.7）。
 * 剩下的（`-` `_` `:` `/` `@` `%` 大小写字母…）照原样进点名：点名是**不透明字符串**，
 * 判定只做精确匹配与 `registry` 查表，不需要它长得像标识符。
 */
const TAIL_RE = /^[^\s*]+$/;

/**
 * 完整引用 → 点名前先校验它**确实是** `<origin>/<id>`。
 *
 * 单射就是在这里成立的：`isValidSource` 只认 `local:<名字>` 与域名（两者都不含 `/` 与 `@`），
 * id 恰好一个 `@` 与一个 `/` ⇒ 整条点名里第一个 `@` 必然是 id 的、其后第一个 `/` 必然是 id 的，
 * 名字段又不含 `.` ⇒ **引用部分到第一个 `.` 为止**，切分唯一。尾段因此可以含任何非空白字符。
 */
function assertRef(ref: string, value: string): void {
  const slash = ref.indexOf('/');
  const origin = slash > 0 ? ref.slice(0, slash) : '';
  const id = slash > 0 ? ref.slice(slash + 1) : '';
  if (!isValidSource(origin) || !PLUGIN_ID_RE.test(id)) {
    throw new SpcError('PERMISSION_POINT_INVALID', { pluginId: ref, value, reason: 'ref-shape' });
  }
}

function dynamicPointOf(prefix: string, ref: string, tail: string): string {
  assertRef(ref, tail);
  if (!TAIL_RE.test(tail)) {
    throw new SpcError('PERMISSION_POINT_INVALID', { pluginId: ref, value: tail, reason: 'tail-shape' });
  }
  return `${prefix}.${ref}.${tail}`;
}

/** 端点 → 调用点：`plugins.call.<引用>.<path>`（被调方的端点决定点是否存在，见 capabilities.register） */
export function callPointOf(ref: string, path: string): string {
  return dynamicPointOf(CALL_POINT_PREFIX, ref, path);
}

/** 发布方 + topic → 订阅点：`events.subscribe.<引用>.<topic>`（**发布方的**引用） */
export function subscribePointOf(ref: string, topic: string): string {
  return dynamicPointOf(SUBSCRIBE_POINT_PREFIX, ref, topic);
}
