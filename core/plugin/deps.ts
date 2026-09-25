// 依赖解析（docs/events-and-hooks-design.md §3.5）
//
// 依赖声明的形状：`{ as?, id, origin?, version?, author: { pub, fingerprint? }, call? }`
// —— `author.pub` **必填**：`id` 与 `author.id` 都不唯一（同一把 `@a/x` 在两个源就是两个插件），
// 所以**唯一性来自 `origin`、同一性来自公钥**，两者缺一不可。
//
// `origin` 的写法按**目标**分四格（§3.5 的表；本地包这一格是 2026-09-24 补的）：
//
// | 声明者 → 目标 | 写法 |
// |---|---|
// | 任意 → 市场包 | `origin` **必填**（市场域名是作者发布时就知道的稳定标识） |
// | 本地包 → 本地包、省略 `origin` | **在本地源范围内**按 `author.pub + id` **唯一匹配** |
// | 本地包 → 本地包、写明 `local:<名字>` | 精确匹配该桶 |
// | **市场包 → 本地包** | **禁止**（本地源不存在于别人的机器上） |
//
// 为什么本地那一格要"范围内匹配"而不是"同源简写"：**本地桶名是装机的人起的标签**
// （`std（小A）`），作者签名时不可能知道它 ⇒ 写死桶名的声明本来就不自足。
// 副作用是 promote（把某个作者的插件搬进他自己的源）**不会打断本地→本地的依赖**。
import { isLocalSource } from '../config';
import { SpcError } from '../errors';
import { findAuthor, type AuthorsFile } from '../sources/authors';
import { fingerprintOf } from '../sources/keys';
import type { Manifest } from '../../sdk/types';
import type { PluginRecord } from './records';

/** 依赖声明的形状（`sdk/types.ts` 的子集；只取解析需要的字段） */
export type DependencyDecl = NonNullable<NonNullable<Manifest['dependencies']>['plugins']>[number];

export interface DepResolutionContext {
  /** 全部安装记录（本地范围匹配要扫它） */
  records: PluginRecord[];
  /** 作者名册（`authors.json`；判定比公钥，所以这里必须有 pub，不只是指纹） */
  authors: AuthorsFile;
}
/**
 * 某个 `(origin, id)` 的**作者公钥**（宿主侧记忆）：名册优先，退到记录里的指纹（拿不到公钥时返回 undefined）。
 * 为什么不从包里读：包内自述是**被验的对象**，不是期望值（§3bis：否则自签自证）。
 */
export function authorPubOf(origin: string, id: string, ctx: DepResolutionContext): string | undefined {
  return findAuthor(origin, id, ctx.authors)?.pub;
}

/** 记录里的作者指纹是否等于某个公钥的指纹（名册缺失时的退路） */
function recordMatchesPub(rec: PluginRecord, pub: string): boolean {
  return rec.authorFingerprint !== null && rec.authorFingerprint === fingerprintOf(pub);
}

/** 目标记录的作者是不是声明里要求的那把钥 */
function identityMatches(rec: PluginRecord, pub: string, ctx: DepResolutionContext): boolean {
  const known = authorPubOf(rec.origin, rec.id, ctx);
  if (known !== undefined) return known === pub;
  return recordMatchesPub(rec, pub);
}

/**
 * 「解析不到目标，但**同名同作者**的插件在别的来源下」——**换源（reanchor / promote）之后最典型的症状**。
 *
 * 为什么不能就此报"没装"：管理员真正需要知道的是"它搬到哪去了"（用户 2026-09-25 要求）。
 * 精确来源那份记录没了，但同一把作者公钥签的同名插件还在另一个来源里 ⇒ 把它报出来。
 * 匹配到的候选**不止一个**时不给提示（说不清是哪个），退回普通的 `PLUGIN_DEPENDENCY_MISSING`。
 */
function otherOriginHint(dep: DependencyDecl, ctx: DepResolutionContext, missingRef: string): string | undefined {
  const hits = ctx.records.filter(
    (r) => r.id === dep.id && `${r.origin}/${r.id}` !== missingRef && identityMatches(r, dep.author.pub, ctx),
  );
  return hits.length === 1 ? `${hits[0].origin}/${hits[0].id}` : undefined;
}

/** 找不到就抛：先看是不是"换过源"，再退回普通的"没装" */
function throwMissing(dep: DependencyDecl, self: { ref: string }, ctx: DepResolutionContext, missingRef: string, reason?: string): never {
  const moved = otherOriginHint(dep, ctx, missingRef);
  if (moved !== undefined) {
    throw new SpcError('PLUGIN_DEPENDENCY_SOURCE_CHANGED', {
      pluginId: self.ref,
      dependency: missingRef,
      foundAt: moved,
    });
  }
  throw new SpcError('PLUGIN_DEPENDENCY_MISSING', {
    pluginId: self.ref,
    dependency: missingRef,
    ...(reason === undefined ? {} : { reason }),
  });
}

/**
 * 把一条依赖声明解析成**实际引用**（`<origin>/<id>`）。
 *
 * 只做"引用 + 身份"这一段；"装没装 / 跑没跑"仍由调用方的 `dependencyStatus()` 回答
 * （那是运行态，不属于声明解析）。
 *
 * @param self 声明方自己（`origin` 用于四格规则；`ref` 只为了让错误文案能说清"是谁的依赖"）
 * @throws SpcError `PLUGIN_DEPENDENCY_IDENTITY`（身份对不上）/ `PLUGIN_DEPENDENCY_SOURCE`（声明本身不成立）/
 *                  `PLUGIN_REF_AMBIGUOUS`（本地范围内多个匹配）/ `PLUGIN_DEPENDENCY_MISSING`（找不到目标）/
 *                  `PLUGIN_DEPENDENCY_SOURCE_CHANGED`（找不到，但**同名同作者**的在别的来源下 ⇒ 多半是换过源）
 */
export function resolveDependency(
  dep: DependencyDecl,
  self: { origin: string; ref: string },
  ctx: DepResolutionContext,
): string {
  const selfOrigin = self.origin;
  const selfLocal = isLocalSource(selfOrigin);

  // ① 写明了 origin：市场目标的正常路径；本地目标就是"就在这个桶里"
  if (dep.origin !== undefined) {
    if (!selfLocal && isLocalSource(dep.origin)) {
      // 市场包不许依赖本地源：本地源**不存在于别人的机器上**，这种声明在任何别的机器上都不可能满足
      throw new SpcError('PLUGIN_DEPENDENCY_SOURCE', {
        dependency: `${dep.origin}/${dep.id}`,
        reason: 'market-depends-on-local',
        self: selfOrigin,
      });
    }
    const ref = `${dep.origin}/${dep.id}`;
    const rec = ctx.records.find((r) => `${r.origin}/${r.id}` === ref);
    if (!rec) throwMissing(dep, self, ctx, ref);
    assertIdentity(rec, dep, ref, ctx);
    return ref;
  }

  // ② 省略 origin + 自己是市场包 ⇒ 同源简写（市场域名稳定，这条语义不变）
  if (!selfLocal) {
    const ref = `${selfOrigin}/${dep.id}`;
    const rec = ctx.records.find((r) => `${r.origin}/${r.id}` === ref);
    if (!rec) throwMissing(dep, self, ctx, ref);
    assertIdentity(rec, dep, ref, ctx);
    return ref;
  }

  // ③ 省略 origin + 自己是本地包 ⇒ **在本地源范围内**按 (author.pub, id) 唯一匹配
  const sameId = ctx.records.filter((r) => isLocalSource(r.origin) && r.id === dep.id);
  const matches = sameId.filter((r) => identityMatches(r, dep.author.pub, ctx));
  if (matches.length === 1) return `${matches[0].origin}/${matches[0].id}`;
  if (matches.length > 1) {
    // 同一把钥、同一个 id 出现在多个本地源 ⇒ 说不清是哪一个（fail-closed）
    throw new SpcError('PLUGIN_REF_AMBIGUOUS', {
      input: dep.id,
      refs: matches.map((r) => `${r.origin}/${r.id}`).join('、'),
    });
  }
  if (sameId.length > 0) {
    // 装了同名的，但作者公钥不是声明里那把 ⇒ 身份不符（不是"没装"）。
    // 再分两种：**对端压根没有作者身份**（没带信封）与**有身份但不是这把钥** ——
    // 前者管理员要做的动作是"让它带上签名"，后者是"你依赖错人了/该换钥了"。
    const hasIdentity = sameId.some(
      (r) => authorPubOf(r.origin, r.id, ctx) !== undefined || r.authorFingerprint !== null,
    );
    throw new SpcError('PLUGIN_DEPENDENCY_IDENTITY', {
      dependency: dep.id,
      reason: hasIdentity ? 'author-mismatch' : 'author-unknown',
      expected: dep.author.fingerprint ?? fingerprintOf(dep.author.pub),
      actual: sameId[0].authorFingerprint ?? 'none',
    });
  }
  throwMissing(dep, self, ctx, dep.id, 'not-in-local-sources');
}

/** 精确目标的身份比对：名册里没有它的公钥 ⇒ `author-unknown`（对端没有可验证的作者身份） */
function assertIdentity(rec: PluginRecord, dep: DependencyDecl, ref: string, ctx: DepResolutionContext): void {
  const known = authorPubOf(rec.origin, rec.id, ctx);
  if (known === undefined && rec.authorFingerprint === null) {
    throw new SpcError('PLUGIN_DEPENDENCY_IDENTITY', {
      dependency: ref,
      reason: 'author-unknown',
      expected: dep.author.fingerprint ?? fingerprintOf(dep.author.pub),
      actual: 'none',
    });
  }
  if (!identityMatches(rec, dep.author.pub, ctx)) {
    throw new SpcError('PLUGIN_DEPENDENCY_IDENTITY', {
      dependency: ref,
      reason: 'author-mismatch',
      expected: dep.author.fingerprint ?? fingerprintOf(dep.author.pub),
      actual: rec.authorFingerprint ?? (known ? fingerprintOf(known) : 'none'),
    });
  }
}
