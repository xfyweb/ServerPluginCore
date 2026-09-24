// 权限注册表（D4）：宿主侧集中登记全部权限点
// 注册表是审计、管理 UI、测试、能力插件枚举的单一事实源（api-contract §6）。
//
// v3（docs/plugin-signature-design.md §1）：权限点只描述"这是什么能力、有多敏感"，
// 不描述"谁有资格申请"——来源（签名 / 市场 / 本地安装）不参与权限判定（ADR-001 v3）。
// 因此删除了 protectionLevel（从未被判定逻辑读取）、Tier 与按档分档的 defaults。
//
// v4（docs/api-contract.md §6，P2 落地）：`scope` 退为"碰不碰宿主资源"的资源语义，
// 新增 `grant: auto | install | explicit` 由判定链读取。判定链**已按 `grant` 分支**
// （`core/permissions/check.ts` 的 `resolveGrant` / `matchDeclaration` / `grants.includes`）——
// 即 `scope: self` + `grant: auto` 的点免声明免授予，`grant: install|explicit` 的点才要声明与授予。
// 本文件只登记；**别再按"scope = host ⇒ 未授予即拒绝"理解它**（那是 v3 的口径，已作废）。
//
// ⚠️ **这是"冻结表"**（2026-09-24 定）：只有核心启动阶段会写它 —— 先核心静态点，再**驱动插件**注册的点；
// **能力插件加载前它就固化，运行途中完全不变**（所以本类没有"运行期撤销某个点"这条路）。
// 跨插件调用/订阅那类**动态点不在本表里**：它们是**临时表**，从当前活着的插件派生
// （`core/permissions/source.ts`），随装载/卸载即时变化。两表合起来才是判定看到的"点表"。
import { SpcError } from '../errors';

/**
 * 作用域：决定"要不要管理员授予"。
 * - self：只碰插件自身（自己的数据目录 / kv / 定时器 / 自己声明的事件）→ 不需要授予
 * - host：碰宿主管理的资源 → 必须逐点授予
 */
export type Scope = 'self' | 'host';
export type Decision = 'allow' | 'deny';
/**
 * 授予方式（v4，`grant` 三档，见 docs/api-contract.md §6/§7）。
 *
 * **分界线是"要不要在清单里声明"**，而且这条线同时决定了**能不能撤**：
 *
 * | 档 | 要声明吗 | 默认 | 能撤吗 | 为什么 |
 * |---|---|---|---|---|
 * | `auto` | 不要（写了也不看） | 安装即用 | **不能，也不需要** | `self` 域：够不着别人（自己的 kv / 自己的定时器），"禁用 crypto.hash"没有意义 |
 * | `install` | **要** | 安装清单即生效 | **能**（记录里的 `revoked`） | 宿主资源，但资源本来就属于该插件 ⇒ 不给管理员添逐点授予的摩擦，只要求它自报家门 |
 * | `explicit` | **要** | **默认拒绝** | **能**（从 `grants` 里移出） | 写宿主资源 / 提权 / 出网 / 跨插件（`exec.template.*`、`plugins.call.*`、`events.subscribe.*`） |
 *
 * ⇒ **规则一句话：需要声明的，都必须撤得动**（用户 2026-09-23 定）。`auto` 档反过来说：
 * 它连"声明"都不要求，所以没有承载授权的载体，`grant` / `revoke` 对它一律**报错**而不是假装成功
 * （`GRANT_NOT_APPLICABLE`）。
 *
 * ⚠️ 与 v3 删掉的 `protectionLevel` 的**本质区别**：这个字段**被判定链读取**
 * （第 2 步"要不要声明"、第 3 步"要不要授予"、第 4 步"有没有被撤回"都只看它），不是装饰。
 */
export type Grant = 'auto' | 'install' | 'explicit';
/** 保密等级（读门槛）：public < sensitive < secret */
export type Confidentiality = 'public' | 'sensitive' | 'secret';
/** 执行等级（写门槛）：low < medium < high */
export type ExecutionLevel = 'low' | 'medium' | 'high';

export const CONF_ORDER: Record<Confidentiality, number> = { public: 0, sensitive: 1, secret: 2 };
export const EXEC_ORDER: Record<ExecutionLevel, number> = { low: 0, medium: 1, high: 2 };

export interface PermissionPoint {
  /** 权限点名称，层级命名：<group>.<action>[.<scope>]（D2） */
  name: string;
  group: string;
  description: string;
  /** 作用域：self 够不着别人（免声明免授予）/ host 碰宿主资源 */
  scope: Scope;
  /**
   * 授予方式。**缺省按 scope 推导**（`self → auto`、`host → explicit`），且推导结果就是注册期校验的规则
   * —— 老调用点不写它也不会松动（`host` 兜到 `explicit` 是 fail-closed 的方向）。
   */
  grant?: Grant;
  /** 默认保密等级（调用方未声明 meta 时的兜底） */
  confidentiality: Confidentiality;
  /** 默认执行等级 */
  executionLevel: ExecutionLevel;
}

/** `grant` 的缺省推导：`self → auto`、`host → explicit`（偏保守；要 `install` 必须显式写） */
export function resolveGrant(scope: Scope, grant?: Grant): Grant {
  if (grant !== undefined) return grant;
  return scope === 'self' ? 'auto' : 'explicit';
}

export class PermissionRegistry {
  private readonly points = new Map<string, PermissionPoint>();

  register(point: PermissionPoint): void {
    if (this.points.has(point.name)) {
      throw new SpcError('DUPLICATE_POINT', { permission: point.name });
    }
    // 一致性约束：执行等级必须 >= 保密等级（否则仲裁通道成为保密旁路）
    if (EXEC_ORDER[point.executionLevel] < CONF_ORDER[point.confidentiality]) {
      throw new SpcError('LEVEL_ORDER_INVALID', {
        permission: point.name,
        executionLevel: point.executionLevel,
        confidentiality: point.confidentiality,
      });
    }
    // 一致性约束（v4）：**`self` 只能是 `auto`**——"够不着别人"的能力没有理由再要一次授予仪式。
    // 反过来挡住的是"给 self 点写 explicit"这种把摩擦塞进 self 的写法。
    if (point.scope === 'self' && point.grant !== undefined && point.grant !== 'auto') {
      throw new SpcError('SCOPE_GRANT_INVALID', {
        permission: point.name,
        scope: point.scope,
        grant: point.grant,
      });
    }
    // 一致性约束（v4 补，2026-09-23）：**`host` 不能是 `auto`**。
    // `auto` = 免声明 + 免授予；一个碰宿主资源的点若是 auto，判定链会**直接放行**，
    // 于是"管理员该在安装时看见它"这条就没了 —— 那是 fail-open 的方向。
    // （此前只有 `permissions-meta.test.ts` 的一条不变式在测试层面守着，注册期并不报错。）
    if (point.scope === 'host' && point.grant === 'auto') {
      throw new SpcError('SCOPE_GRANT_INVALID', {
        permission: point.name,
        scope: point.scope,
        grant: point.grant,
      });
    }
    // 存**解析后**的档位：判定链只读这里，不再各自推导（单一事实源）
    this.points.set(point.name, { ...point, grant: resolveGrant(point.scope, point.grant) });
  }

  get(name: string): PermissionPoint | undefined {
    return this.points.get(name);
  }

  all(): PermissionPoint[] {
    return [...this.points.values()];
  }

  /** 测试用：清空（exec 模板注册器等会在注册时往这里写，重置后需重新注册） */
  reset(): void {
    this.points.clear();
  }
}

export const registry = new PermissionRegistry();

// ---- 第一版注册（与 api-contract §4 方法组对齐，其余方法组 P2 补）----
//
// 命名约定：权限点 = 方法名（同样的字符串让插件作者一眼看懂"这个方法要哪几个点"）。
// 差别只出现在"同一方法因目标不同而敏感度不同"的场合（如 exec.run 的动态模板点）。

registry.register({
  name: 'fs.read.data',
  group: 'fs',
  description: '读取 / 列目录 / 取属性：插件自己的数据目录（<STATE_DIR>/data/plugins/<id>/）',
  scope: 'self',
  confidentiality: 'sensitive',
  executionLevel: 'medium',
});

registry.register({
  name: 'fs.write.data',
  group: 'fs',
  description: '写入插件数据目录（路径收敛：只允许落在自己的数据目录内）',
  scope: 'self',
  confidentiality: 'sensitive',
  executionLevel: 'medium',
});

registry.register({
  name: 'kv.read',
  group: 'kv',
  description: '读取插件作用域键值存储（kv.get / kv.keys）',
  scope: 'self',
  confidentiality: 'sensitive',
  executionLevel: 'medium',
});

registry.register({
  name: 'kv.write',
  group: 'kv',
  description: '写入 / 删除插件作用域键值存储（kv.set / kv.delete）',
  scope: 'self',
  confidentiality: 'sensitive',
  executionLevel: 'medium',
});

// bytes 组：宿主代工的**编解码**（utf8 / latin1 / ascii / base64 / base64url / hex / utf16le）。
// scope=self 的理由：它不碰任何资源——输入是调用方给的字符串/字节，输出还给调用方，
// 「够不着别人」这个 self 的定义成立，因此**声明即用**，不进管理员审批面。
registry.register({
  name: 'bytes.encode',
  group: 'bytes',
  description: '字符串 → 字节（含长度计算）',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

registry.register({
  name: 'bytes.decode',
  group: 'bytes',
  description: '字节 → 字符串',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

// url 组：WHATWG URL 解析与百分号编码的**宿主代工**（QuickJS 没有 URL，见 module-emulation-design §13.1-7）。
// scope=self 的理由同 bytes：输入是调用方给的字符串，输出还给调用方，够不着别人。
registry.register({
  name: 'url.parse',
  group: 'url',
  description: 'WHATWG URL 解析与规范化（new URL / 部件赋值）',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

registry.register({
  name: 'url.encode',
  group: 'url',
  description: 'URLSearchParams 的解析/序列化与 domainToASCII/Unicode',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

// crypto 组：**加密原语一律宿主代工**（摘要 / HMAC / 随机源 / 对称解密）。
// scope=self 的理由同 bytes/url：输入是调用方给的字节或字符串，输出还给调用方，够不着别人；
// 真会碰宿主资源的那部分（密钥对象、证书、非对称运算）**一律不做**——那才该是 host 级的东西。
// zlib 组：压缩/解压也是**宿主代工**（原生压缩库不可复刻），scope=self 同理——输入输出都在调用方手里。
registry.register({
  name: 'zlib.compress',
  group: 'zlib',
  description: '压缩（deflate/gzip 及其 raw 形态）与 crc32',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

registry.register({
  name: 'zlib.decompress',
  group: 'zlib',
  description: '解压（inflate/gunzip/unzip 及其 raw 形态）',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

registry.register({
  name: 'crypto.hash',
  group: 'crypto',
  description: '摘要、HMAC 与 timingSafeEqual',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

registry.register({
  name: 'crypto.random',
  group: 'crypto',
  description: '随机源：randomBytes / randomUUID / getRandomValues',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

registry.register({
  name: 'crypto.cipher',
  group: 'crypto',
  description: '对称解密（decipheriv，含 AEAD 认证标签）；非对称与密钥对象不做',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

registry.register({
  name: 'timers.schedule',
  group: 'timers',
  description: '宿主侧定时调度（timers.every / timers.clear）；插件不保活',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

registry.register({
  name: 'events.publish',
  group: 'events',
  description: '发布事件（topic 必须先在 manifest exports.events.publish 声明）；订阅方向走 manifest 声明',
  scope: 'self',
  confidentiality: 'sensitive',
  executionLevel: 'medium',
});

registry.register({
  name: 'lifecycle.version',
  group: 'lifecycle',
  description: '契约协商：查询核心 API 版本',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});

registry.register({
  name: 'lifecycle.health',
  group: 'lifecycle',
  description: '心跳：让宿主知道自己还活着（P1.5 仅回执，超时判定在宿主侧）',
  scope: 'self',
  confidentiality: 'public',
  executionLevel: 'low',
});
