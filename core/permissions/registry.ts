// 权限注册表（D4）：宿主侧集中登记全部权限点
// 注册表是审计、管理 UI、测试、能力插件枚举的单一事实源（api-contract §6）。
//
// v3（docs/plugin-signature-design.md §1）：权限点只描述"这是什么能力、有多敏感"，
// 不描述"谁有资格申请"——来源（签名 / 市场 / 本地安装）不参与权限判定（ADR-001 v3）。
// 因此删除了 protectionLevel（从未被判定逻辑读取）、Tier 与按档分档的 defaults。
//
// v4（docs/api-contract.md §6，P2 落地）：`scope` 退为"碰不碰宿主资源"的资源语义，
// 新增 `grant: auto | install | explicit` 由判定链读取。**当前代码仍是
// `scope = host ⇒ 未授予即拒绝`**——本文件只登记，档位切换随 P2 权限层一起做。
import { SpcError } from '../errors';

/**
 * 作用域：决定"要不要管理员授予"。
 * - self：只碰插件自身（自己的数据目录 / kv / 定时器 / 自己声明的事件）→ 不需要授予
 * - host：碰宿主管理的资源 → 必须逐点授予
 */
export type Scope = 'self' | 'host';
export type Decision = 'allow' | 'deny';
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
  /** 作用域：self 免授予 / host 必须逐点授予 */
  scope: Scope;
  /** 默认保密等级（调用方未声明 meta 时的兜底） */
  confidentiality: Confidentiality;
  /** 默认执行等级 */
  executionLevel: ExecutionLevel;
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
    this.points.set(point.name, point);
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
