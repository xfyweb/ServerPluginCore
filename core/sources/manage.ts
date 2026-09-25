// 源的管理动作（CLI / 面板的落点）：docs/plugin-signature-design.md §5 / §6.3 / §7.3
//
// 为什么单独一层：HTTP 与 CLI 都只该"传参 + 渲染"，**校验 / 占用检查 / 审计**必须只有一份
// （与 `core/plugin/manager.ts` 的分工同构）。`keyring.ts` 只管"条目形状与落盘"，不碰业务。
//
// 三条业务规则（都有出处，不是这里新定的）：
//   ① **市场源不带 `--pub` ⇒ 远程 TOFU 拉取状态文档**（§5 添加源的第 2 步；失败即 `SOURCE_KEY_FETCH_FAILED`，
//      不添加该源 —— "加一个公钥未知的源"等于加一个谁都验不了的源）；
//   ② **有插件归属的源不许删**（§5"永不自动新增源"的另一面：源是归属，删源会让记录指向不存在的来源）；
//   ③ **改锚不追溯**（§3bis）：只影响后续安装，已装插件的 `authorFingerprint` 不动，但必须落审计
//      并把"还有 N 个按旧锚记录"这个数字**报给管理员** —— 提示是这一步唯一的产品价值。
import { audit, digest, digestParams } from '../audit';
import { SpcError } from '../errors';
import { loadRecords } from '../plugin/records';
import {
  DEFAULT_ORIGIN,
  anchorOf,
  keyring,
  newLocalSource,
  type AuthorAnchor,
  type HighWater,
  type SourceEntry,
  type SourceKind,
  type SuspendedState,
} from './keyring';
import { fetchKeyStatus, verifyRotation } from './status';
import { fingerprintOf } from './keys';
import { DEFAULT_LOCAL_SOURCE, isLocalSource, isValidSource } from '../config';

/** 源的展示视图（§6.3：`suspended` 与吊销列表要能给管理员看见，它们不参与判定） */
export interface SourceView {
  origin: string;
  kind: SourceKind;
  alias: string;
  enabled: boolean;
  /** 源签名公钥（**只有市场源有**） */
  pub: string | null;
  fingerprint: string | null;
  /** 本地桶的作者锚（**只有本地源有**） */
  authorAnchor: AuthorAnchor | null;
  firstTrust: 'tofu' | 'manual';
  suspended: SuspendedState | null;
  highWater: HighWater | null;
  addedAt: string;
  /** 归属该源的已装插件数（删源前的占用判据，也是展示信息） */
  installedCount: number;
}

/** 归属某来源的已装插件数（身份是 `(origin, id)` ⇒ 这正是"这个源里有几个插件"） */
export function sourceUsage(origin: string): number {
  return loadRecords().plugins.filter((p) => p.origin === origin).length;
}

function toView(entry: SourceEntry): SourceView {
  return {
    origin: entry.origin,
    kind: entry.kind,
    alias: entry.alias,
    enabled: entry.enabled,
    pub: entry.pub ?? null,
    fingerprint: entry.fingerprint ?? null,
    authorAnchor: entry.authorAnchor ?? null,
    firstTrust: entry.firstTrust,
    suspended: entry.suspended ?? null,
    highWater: entry.highWater ?? null,
    addedAt: entry.addedAt,
    installedCount: sourceUsage(entry.origin),
  };
}

export function listSources(): SourceView[] {
  return keyring()
    .list()
    .map(toView)
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

export function getSource(origin: string): SourceView | undefined {
  const entry = keyring().get(origin);
  return entry ? toView(entry) : undefined;
}

/**
 * 源级审计条目。
 * ⚠️ `pluginId` 是必填字段，源不是插件 ⇒ 这里填 **origin**；读审计时靠 `method` 的 `source.` 前缀区分
 * （加一个 `sourceId` 字段是"只增不改"允许的，但当下没有第二个读者，先不加字段）。
 */
function auditSource(origin: string, method: string, target: string, params?: Record<string, string>): void {
  audit({
    ts: Date.now(),
    pluginId: origin,
    method,
    target,
    paramsDigest: digestParams(params) ?? digest(origin),
    result: 'ok',
    durationMs: 0,
  });
}

export interface AddSourceInput {
  origin: string;
  /** 市场源的签名公钥（base64 裸 32 字节）。**不给就远程 TOFU 拉取**；本地源禁止给 */
  pub?: string;
  /** 显示用标签，缺省 = origin */
  alias?: string;
  /** 本地桶的作者锚（base64 裸 32 字节作者公钥）；**市场源禁止给** */
  anchorPub?: string;
}

/**
 * 添加源。本地桶 / 市场源两条路（判据就是来源的形状，与 `core/config.ts` 的 `isValidSource` 同源）。
 * @param opts.fetchImpl 测试注入用（与 `status.ts` 的 `fetchKeyStatus` 同一个口子）
 */
export async function addSource(
  input: AddSourceInput,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SourceView> {
  const { origin } = input;
  if (!isValidSource(origin)) {
    throw new SpcError('SOURCE_ORIGIN_INVALID', { origin });
  }
  const kr = keyring();
  const alias = input.alias ?? origin;

  if (isLocalSource(origin)) {
    // 本地源：不签包 ⇒ 没有源公钥；可选带作者锚（§3bis）
    if (input.pub !== undefined) throw new SpcError('SOURCE_PUB_NOT_APPLICABLE', { origin });
    const entry = newLocalSource(origin, alias, input.anchorPub ? anchorOf(input.anchorPub) : undefined);
    kr.add(entry);
    auditSource(origin, 'source.add', origin, { kind: 'local', anchor: entry.authorAnchor?.fingerprint ?? '' });
    return toView(entry);
  }

  // 市场源：多作者命名空间 ⇒ 不许钉作者锚
  if (input.anchorPub !== undefined) throw new SpcError('SOURCE_ANCHOR_NOT_ALLOWED', { origin });

  let entry: SourceEntry;
  if (input.pub !== undefined) {
    // 离线 / 手填：firstTrust = manual（下次更新时再自动尝试拉取状态文档）
    entry = {
      origin,
      kind: 'market',
      pub: input.pub,
      fingerprint: fingerprintOf(input.pub),
      alias,
      enabled: true,
      addedAt: new Date().toISOString(),
      firstTrust: 'manual',
      suspended: null,
    };
  } else {
    // TOFU：拉状态文档，把 current 当信任起点 + 落高水位（防回滚，§6.2）
    const fetched = await fetchKeyStatus(origin, { fetchImpl: opts.fetchImpl });
    if (!fetched.ok) {
      throw new SpcError('SOURCE_KEY_FETCH_FAILED', { origin, reason: fetched.code });
    }
    const doc = fetched.doc;
    const node = doc.keys.find((k) => k.fingerprint === doc.current);
    const verified = node
      ? verifyRotation(doc, { fingerprint: doc.current, pub: node.pub })
      : ({ ok: false, code: 'KEY_CHAIN_INVALID' } as const);
    if (!verified.ok) {
      throw new SpcError('SOURCE_KEY_FETCH_FAILED', { origin, reason: verified.code });
    }
    entry = {
      origin,
      kind: 'market',
      pub: verified.current.pub,
      fingerprint: verified.current.fingerprint,
      alias,
      enabled: true,
      addedAt: new Date().toISOString(),
      firstTrust: 'tofu',
      suspended: null,
      highWater: verified.highWater,
    };
  }
  kr.add(entry);
  auditSource(origin, 'source.add', origin, { kind: 'market', pub: entry.fingerprint ?? '' });
  return toView(entry);
}

/** 内置条目（官方市场 + 杂桶）：它们由启动期播种，删了下次启动还会回来 ⇒ 拒绝删 */
const BUILTINS: readonly string[] = [DEFAULT_ORIGIN, DEFAULT_LOCAL_SOURCE];

/**
 * 删除源。**有插件归属时拒绝**（§5：源是归属 —— 删掉它，记录就指向一个不存在的来源，
 * "这个插件从哪来"当场失去答案；要删先搬走或卸载）。
 */
export function removeSource(origin: string): void {
  const kr = keyring();
  if (!kr.get(origin)) throw new SpcError('SOURCE_NOT_CONFIGURED', { origin, reason: 'not-found' });
  if (BUILTINS.includes(origin)) {
    // 内置条目由启动期播种（删了下次启动还会回来）⇒ 单独一个码，别让管理员以为"删成功了"
    throw new SpcError('SOURCE_BUILTIN', { origin });
  }
  const count = sourceUsage(origin);
  if (count > 0) {
    throw new SpcError('SOURCE_IN_USE', { origin, count: String(count) });
  }
  kr.remove(origin);
  auditSource(origin, 'source.remove', origin);
}

/** 启停源（停用 ⇒ `SOURCE_DISABLED`；已装插件照常运行，§6.4 同款口径） */
export function setSourceEnabled(origin: string, enabled: boolean): SourceView {
  const entry = keyring().setEnabled(origin, enabled);
  auditSource(origin, enabled ? 'source.enable' : 'source.disable', origin);
  return toView(entry);
}

/** 改别名（仅显示；**别名永不进点名**，见 `core/permissions/points.ts` 的文件头） */
export function setSourceAlias(origin: string, alias: string): SourceView {
  const entry = keyring().setAlias(origin, alias);
  auditSource(origin, 'source.alias', origin, { alias });
  return toView(entry);
}

export interface AnchorChange {
  view: SourceView;
  /** 改锚时仍有几个插件按**旧锚**记录（改锚不追溯，§3bis）——提示里要报这个数 */
  staleCount: number;
}

/**
 * 改锚 / 解绑锚（`pub === null` = 解绑）。
 * **改锚不追溯**：已装插件的 `authorFingerprint` 一律不动（与"加载时不重验签名"一致），
 * 但要把"还有 N 个按旧锚记录"报回去 —— 否则管理员会以为改完锚就把存量插件也重新认了一遍。
 */
export function setSourceAnchor(origin: string, pub: string | null): AnchorChange {
  const kr = keyring();
  const cur = kr.get(origin);
  if (!cur) throw new SpcError('SOURCE_NOT_CONFIGURED', { origin, reason: 'not-found' });
  if (cur.kind !== 'local') throw new SpcError('SOURCE_ANCHOR_NOT_ALLOWED', { origin });
  const before = cur.authorAnchor?.fingerprint ?? '';
  const entry = kr.setAnchor(origin, pub === null ? null : anchorOf(pub));
  const after = entry.authorAnchor?.fingerprint ?? '';
  const staleCount = sourceUsage(origin);
  auditSource(origin, 'source.anchor', origin, { from: before, to: after, installed: String(staleCount) });
  return { view: toView(entry), staleCount };
}

/** 启动期播种内置条目并回读（daemon 启动时调；失败即启动失败，不静默降级） */
export function seedBuiltinSources(): SourceView[] {
  const kr = keyring();
  const { market, localDefault } = kr.ensureBuiltins();
  return [toView(market), toView(localDefault)];
}
