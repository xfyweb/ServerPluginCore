// 三态判定（D1/D2）：ALLOW / DENY / UNSET→DENY
//
// 判定链（v4，见 docs/api-contract.md §7）：
//   1  权限点查不到（冻结表 ∪ 临时表都没有） → UNKNOWN_POINT（未知即拒绝）
//   2  `grant != auto` 且 manifest 未声明   → NOT_DECLARED（无默认放行；**auto 档免声明**）
//   3  不在 `grants` 里                     → NOT_GRANTED（auto 档免逐点授予）
//   4  通过 → 作用域与参数校验在各方法内层
//
// **v4 的变化（第四批 B）**：第 2、3 步从"看 scope"改成"**只看 grant**"。
// 为什么要把"要不要声明"也交给 grant：`scope` 回答的是"够不够得着别人"（资源语义），
// 而"要不要在 manifest 里自报家门"是**摩擦**问题——两者混在一个字段里就是 v3 那套
// "self 也要声明"的由来（纯摩擦，且拦不住恶意方）。
// 现在的口径：**`self` = 免声明免授予**（够不着别人，没有理由再要一次仪式）；
// **`host` = 必须声明**（哪怕是"插件自己的数据目录"，那也是宿主文件系统里的一块，
// 管理员该在安装时看见它），再按 grant 档决定要不要逐点授予。
//
// **2026-09-23/24**：一度加过第 2 步 `REVOKED`（专门记"管理员撤回过的点"的名单），后来**撤掉了** ——
// `install` 与 `explicit` 合并走**同一条白名单**（`install` = 首次安装时把清单里的声明播种进 `grants`），
// 于是"撤回"就是把点从 `grants` 移出，和"从未授予"同一个动作、同一个码（`NOT_GRANTED`）。
// 少一个字段、少一步、少一组状态叉乘；"是谁撤的"由 `plugin.revoke` 审计条目回答，不靠状态字段。
// `auto` 档够不着别人、也没有承载授权的载体 ⇒ `grant` / `revoke` 对它直接报错（`GRANT_NOT_APPLICABLE`）。
//
// 等级（confidentiality / executionLevel）只用于：effective 合成、审计分级、
// 安装时的提示强度与二次确认——**不再决定 deny/allow**，也不再区分"官方/第三方"。
// 判定结果只携带机器可读的 { decision, code, params }；本地化文本由边界层渲染。
import {
  CONF_ORDER,
  EXEC_ORDER,
  resolveGrant,
  type Confidentiality,
  type Decision,
  type ExecutionLevel,
} from './registry';
import type { PointSource } from './source';

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
 * @param points    点表：**冻结表 ∪ 临时表**（`core/permissions/source.ts` 的 `pointSource`）。
 *                  这里只用到 `get`：判定只需要回答"这个点现在存不存在"。
 * @param requested 方法声明的权限点（如 fs.write.data）
 * @param declared  插件 manifest 声明的权限（**请求**，可含通配 `fs.*` / `*`）
 * @param grants    管理员授予的权限点（**精确匹配，不接受通配**；见 isValidGrantPoint）。
 *                  `install` 档的点由**首次安装时按清单播种**进来，之后与 `explicit` 同一条道。
 * @param opts      等级信息（仅用于 effective 合成与审计）
 */
export function checkPermission(
  points: PointSource,
  requested: string,
  declared: string[],
  grants: string[] = [],
  opts: CheckOptions = {},
): CheckResult {
  // 1) 查不到这个点 → 拒绝（未知即拒绝）。临时表里的点会随对端插件卸载而消失，于是自然变成这一支。
  const point = points.get(requested);
  if (!point) {
    return { decision: 'deny', code: 'UNKNOWN_POINT', params: { permission: requested } };
  }
  // `grant` 在注册时已解析并存下（缺省 `self → auto` / `host → explicit`）；
  // 这里再兜一次是给"直接构造的 PermissionPoint"（测试夹具）用，语义与 registry 一致。
  const grant = resolveGrant(point.scope, point.grant);

  // 2) `auto` 档**免声明**；其余档未声明 → 拒绝（无默认放行）
  if (grant !== 'auto' && !matchDeclaration(requested, declared)) {
    return {
      decision: 'deny',
      code: 'NOT_DECLARED',
      params: { permission: requested, grant },
    };
  }

  // 3) `auto` 档免逐点授予；其余档必须在 `grants` 里。
  //    审计要能区分"授予的"与"安装即生效的"，所以 params 里带上 grant。
  if (grant !== 'auto' && !grants.includes(requested)) {
    return {
      decision: 'deny',
      code: 'NOT_GRANTED',
      params: { permission: requested, scope: point.scope, grant },
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
      grant,
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
