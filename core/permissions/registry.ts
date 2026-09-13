// 权限注册表（D4）：宿主侧集中登记全部权限点
// 注册表是审计、管理 UI、测试、能力插件枚举的单一事实源（api-contract §6）。
//
// v3（docs/plugin-signature-design.md §1）：权限点只描述"这是什么能力、有多敏感"，
// 不描述"谁有资格申请"——来源（签名 / 市场 / 本地安装）不参与权限判定（ADR-001 v3）。
// 因此删除了 protectionLevel（从未被判定逻辑读取）、Tier 与按档分档的 defaults。
import { SpcError } from '../errors';

/**
 * 作用域：决定"要不要管理员授予"。
 * - self：只碰插件自身（自己的数据目录 / kv / 定时器）→ 不需要授予
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
}

export const registry = new PermissionRegistry();

// ---- 第一版注册（与 api-contract §4 方法组对齐，其余方法组 P2 补）----

registry.register({
  name: 'fs.write.data',
  group: 'fs',
  description: '写入插件数据目录（/var/lib/spc/plugins/<id>/）',
  scope: 'self',
  confidentiality: 'sensitive',
  executionLevel: 'medium',
});

registry.register({
  name: 'fs.write.home',
  group: 'fs',
  description: 'spike 演示：向用户主目录写入文件（正式版由数据目录机制替代）——属于宿主管理的资源，故 scope=host',
  scope: 'host',
  confidentiality: 'sensitive',
  executionLevel: 'medium',
});

registry.register({
  name: 'fs.read.data',
  group: 'fs',
  description: '读取插件数据目录',
  scope: 'self',
  confidentiality: 'sensitive',
  executionLevel: 'medium',
});
