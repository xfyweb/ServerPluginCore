// 三态判定（D1/D2）：ALLOW / DENY / UNSET→DENY + 安全等级矩阵（读/写门槛）
// 匹配链：精确 > 前缀通配（fs.*）> 全通配（*）；未设置一律拒绝。
// 等级矩阵（决策记录）：public/low 无需额外授权；sensitive/medium 需显式授权；
// secret/high 仅官方。用户目录覆盖：effective = max(调用方声明, 用户配置)（只升不降）。
// 判定结果只携带机器可读的 { decision, code, params }；本地化文本由边界层渲染。
import {
  CONF_ORDER,
  EXEC_ORDER,
  type Confidentiality,
  type Decision,
  type ExecutionLevel,
  type PermissionRegistry,
  type Tier,
} from './registry';

/** 判定码（契约：只增不改） */
export type CheckCode =
  | 'ALLOWED'
  | 'UNKNOWN_POINT'
  | 'NOT_DECLARED'
  | 'TIER_DENIED'
  | 'LEVEL_OFFICIAL_ONLY'
  | 'LEVEL_NEEDS_GRANT';

export interface CheckResult {
  decision: Decision;
  /** 机器可读判定码（英文契约） */
  code: CheckCode;
  /** 渲染用结构化参数（CLI / 面板按 locale 渲染） */
  params?: Record<string, string>;
}

/** 调用时声明的等级（CallMeta）——不同目录/命令的敏感度由调用方声明，权限点等级为兜底 */
export interface CallMeta {
  confidentiality?: Confidentiality;
  executionLevel?: ExecutionLevel;
}

/** 用户目录等级覆盖（pathLevels，只升不降） */
export interface UserLevelOverride {
  confidentiality?: Confidentiality;
  executionLevel?: ExecutionLevel;
}

/** 权限判定选项 */
export interface CheckOptions {
  /** 调用时声明的等级（未提供则用权限点默认） */
  meta?: CallMeta;
  /** 用户目录等级覆盖（涉及指定目录时） */
  userOverride?: UserLevelOverride;
  /** 已获显式授权的等级（安装流程授予，P4 落地；第一版 thirdparty 默认无） */
  explicitGrants?: { confidentiality?: Confidentiality[]; executionLevel?: ExecutionLevel[] };
}

/**
 * 权限判定（宿主侧强制，插件代码无权限判定路径——D3 单一强制点）。
 * @param requested 方法声明的权限点（如 fs.write.data）
 * @param granted   插件 manifest 声明的权限（请求）
 * @param tier      插件档位（official / thirdparty）
 */
export function checkPermission(
  registry: PermissionRegistry,
  requested: string,
  granted: string[],
  tier: Tier,
  opts: CheckOptions = {},
): CheckResult {
  // 1) 未在注册表登记的权限点 → 拒绝（未知即拒绝）
  const point = registry.get(requested);
  if (!point) {
    return { decision: 'deny', code: 'UNKNOWN_POINT', params: { permission: requested } };
  }

  // 2) 插件未声明 → 拒绝（无默认放行）
  if (!matchGrant(requested, granted)) {
    return { decision: 'deny', code: 'NOT_DECLARED', params: { permission: requested } };
  }

  // 3) 双档默认值（thirdparty 降级在注册表 defaults 中体现）
  const d = point.defaults[tier];
  if (d === 'deny') {
    return { decision: 'deny', code: 'TIER_DENIED', params: { tier, permission: requested } };
  }

  // 4) 等级门槛（effective = max(调用方声明, 用户覆盖, 权限点默认)）
  const level = effectiveLevel(point, opts);
  const readCheck = checkLevelAccess(tier, level.confidentiality, 'read', opts);
  if (readCheck.decision === 'deny') return readCheck;
  const writeCheck = checkLevelAccess(tier, level.executionLevel, 'write', opts);
  if (writeCheck.decision === 'deny') return writeCheck;

  return {
    decision: 'allow',
    code: 'ALLOWED',
    params: {
      tier,
      permission: requested,
      confidentiality: level.confidentiality,
      executionLevel: level.executionLevel,
      via: 'tier',
    },
  };
}

/** effective 等级：取三者最高（只升不降） */
export function effectiveLevel(
  point: { confidentiality: Confidentiality; executionLevel: ExecutionLevel },
  opts: CheckOptions,
): { confidentiality: Confidentiality; executionLevel: ExecutionLevel } {
  const c = maxBy(CONF_ORDER, opts.userOverride?.confidentiality, opts.meta?.confidentiality, point.confidentiality);
  let e = maxBy(EXEC_ORDER, opts.userOverride?.executionLevel, opts.meta?.executionLevel, point.executionLevel);
  // 一致性校正：执行等级不得低于保密等级（仲裁通道 = 保密旁路，必须封死）
  if (EXEC_ORDER[e] < CONF_ORDER[c]) {
    e = (Object.entries(EXEC_ORDER).find(([, rank]) => rank >= CONF_ORDER[c])?.[0] as ExecutionLevel) ?? 'high';
  }
  return { confidentiality: c, executionLevel: e };
}

function maxBy<T extends string>(
  order: Record<T, number>,
  ...candidates: Array<T | undefined>
): T {
  let best: T | undefined;
  let bestRank = -1;
  for (const c of candidates) {
    if (c !== undefined && order[c] > bestRank) {
      best = c;
      bestRank = order[c];
    }
  }
  return best!;
}

/** 等级矩阵判定 */
export function checkLevelAccess(
  tier: Tier,
  level: Confidentiality | ExecutionLevel,
  mode: 'read' | 'write',
  opts: CheckOptions,
): CheckResult {
  const rank = mode === 'read' ? CONF_ORDER[level as Confidentiality] : EXEC_ORDER[level as ExecutionLevel];
  const grantedList =
    mode === 'read' ? opts.explicitGrants?.confidentiality : opts.explicitGrants?.executionLevel;
  const params = { level, mode };

  if (rank >= 2) {
    // secret / high：仅官方
    if (tier !== 'official') {
      return { decision: 'deny', code: 'LEVEL_OFFICIAL_ONLY', params };
    }
    return { decision: 'allow', code: 'ALLOWED', params: { ...params, via: 'official' } };
  }
  if (rank >= 1) {
    // sensitive / medium：需显式授权
    if (tier !== 'official' && !(grantedList ?? []).includes(level as never)) {
      return { decision: 'deny', code: 'LEVEL_NEEDS_GRANT', params };
    }
    return {
      decision: 'allow',
      code: 'ALLOWED',
      params: { ...params, via: tier === 'official' ? 'official' : 'granted' },
    };
  }
  // public / low：无需额外授权
  return { decision: 'allow', code: 'ALLOWED', params: { ...params, via: 'public' } };
}

/** 匹配链：精确 > 前缀通配（fs.*）> 全通配（*） */
export function matchGrant(requested: string, granted: string[]): boolean {
  return granted.some(
    (g) =>
      g === requested ||
      g === '*' ||
      (g.endsWith('.*') && requested.startsWith(g.slice(0, -1))),
  );
}
