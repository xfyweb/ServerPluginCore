// 三态判定（D1/D2）：ALLOW / DENY / UNSET→DENY
//
// 判定链（v3，见 docs/api-contract.md §7）：
//   1  权限点未在注册表登记            → UNKNOWN_POINT（未知即拒绝）
//   2  manifest 未声明该点             → NOT_DECLARED（无默认放行）
//   3  scope = host 且管理员未授予     → NOT_GRANTED
//   4  通过 → 作用域与参数校验在各方法内层
//
// 等级（confidentiality / executionLevel）只用于：effective 合成、审计分级、
// 安装时的提示强度与二次确认——**不再决定 deny/allow**，也不再区分"官方/第三方"。
// 判定结果只携带机器可读的 { decision, code, params }；本地化文本由边界层渲染。
import {
  CONF_ORDER,
  EXEC_ORDER,
  type Confidentiality,
  type Decision,
  type ExecutionLevel,
  type PermissionRegistry,
} from './registry';

/** 判定码（契约：只增不改） */
export type CheckCode = 'ALLOWED' | 'UNKNOWN_POINT' | 'NOT_DECLARED' | 'NOT_GRANTED';

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

/** 权限判定选项（等级信息只影响 effective 合成与审计，不影响 allow/deny） */
export interface CheckOptions {
  /** 调用时声明的等级（未提供则用权限点默认） */
  meta?: CallMeta;
  /** 用户目录等级覆盖（涉及指定目录时） */
  userOverride?: UserLevelOverride;
}

/**
 * 权限判定（宿主侧强制，插件代码无权限判定路径——D3 单一强制点）。
 * @param requested 方法声明的权限点（如 fs.write.data）
 * @param declared  插件 manifest 声明的权限（**请求**，可含通配 `fs.*` / `*`）
 * @param grants    管理员逐点授予的权限点（**精确匹配，不接受通配**；见 isValidGrantPoint）
 * @param opts      等级信息（仅用于 effective 合成与审计）
 */
export function checkPermission(
  registry: PermissionRegistry,
  requested: string,
  declared: string[],
  grants: string[] = [],
  opts: CheckOptions = {},
): CheckResult {
  // 1) 未在注册表登记的权限点 → 拒绝（未知即拒绝）
  const point = registry.get(requested);
  if (!point) {
    return { decision: 'deny', code: 'UNKNOWN_POINT', params: { permission: requested } };
  }

  // 2) 插件未声明 → 拒绝（无默认放行）
  if (!matchDeclaration(requested, declared)) {
    return { decision: 'deny', code: 'NOT_DECLARED', params: { permission: requested } };
  }

  // 3) host 作用域必须由管理员逐点授予（精确匹配；通配授予无效）
  if (point.scope === 'host' && !grants.includes(requested)) {
    return {
      decision: 'deny',
      code: 'NOT_GRANTED',
      params: { permission: requested, scope: point.scope },
    };
  }

  // 4) 通过（等级随结果返回，供审计与渲染层使用）
  const level = effectiveLevel(point, opts);
  return {
    decision: 'allow',
    code: 'ALLOWED',
    params: {
      permission: requested,
      scope: point.scope,
      confidentiality: level.confidentiality,
      executionLevel: level.executionLevel,
    },
  };
}

/**
 * 授权记录只接受**精确权限点**：不接受空串、不接受通配。
 * 安装流在写入安装记录前用它校验（防止一次点击等于全授）。
 */
export function isValidGrantPoint(grant: string): boolean {
  return grant.length > 0 && !grant.includes('*');
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

/** 声明匹配链：精确 > 前缀通配（fs.*）> 全通配（*）——**只用于 manifest 声明** */
export function matchDeclaration(requested: string, declared: string[]): boolean {
  return declared.some(
    (d) =>
      d === requested ||
      d === '*' ||
      (d.endsWith('.*') && requested.startsWith(d.slice(0, -1))),
  );
}
