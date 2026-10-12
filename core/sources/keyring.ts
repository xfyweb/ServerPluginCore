// 源与 keyring（宿主侧，docs/plugin-signature-design.md §5）：<SPC_KEYRING_DIR 或 <repo>/.spc>/keyring.json
//
// **两类条目**（本地源条目 2026-09-25 落地）：
//   · `kind: 'market'`（**缺省**，老条目就是它）—— 以市场域名为主键，带**源签名公钥**（`pub`/`fingerprint`），
//     可链式轮换、有更新渠道；包由它签名才算 anchored（§7）。
//   · `kind: 'local'` —— 具名本地桶 `local:<名字>`，**没有源公钥**（它不签任何包，只做命名空间归属），
//     可选带 `authorAnchor`（"本桶只收这把作者公钥签的包"，§3bis）。
//
// **为什么桶要落成条目**（2026-09-25）：桶是**归属**。不落成条目时，"这台机器上有哪些桶"没有权威答案，
// 于是"安装时默认落进该作者的桶"与 promote（为某个作者单独建桶并搬迁）都只能靠推断。
// 落成条目之后就一句话：桶必须先存在（`spc source add local:std-a`），安装才谈得上往里放。
//
// **两级校验（刻意的差异）**：
//   · **读文件宽松**：单条非法 ⇒ 忽略该条 + 告警（不让一条手改坏的名目把核心挡在门外；
//     与"缺 origin 的条目忽略并告警"这条既有行为一致）。被忽略的桶等于不存在 ⇒ 往它安装会撞
//     `SOURCE_NOT_CONFIGURED`，仍然是 fail-closed，只是失败点后移。
//   · **写入口严格**：`add` / `update` / `setAnchor` 违反任何一条规则**直接抛** —— CLI 与面板永远
//     写不进一条坏条目（校验函数两边共用，见 `validateSourceEntry`）。
//   · 文件整体读不了 / 形状不对 ⇒ `KEYRING_INVALID` **拒**（不猜、不"当空 keyring 继续跑"）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_LOCAL_SOURCE, isLocalSource, isValidSource, stateDir } from '../config';
import { SpcError } from '../errors';
import { assertFingerprint, fingerprintOf } from './keys';

/** 官方市场（内置默认条目；其余源一律由管理员显式添加） */
export const DEFAULT_ORIGIN = 'market.spc.xfyweb.cn';

/**
 * 内置 `local:default` 的**默认别名**（2026-10-12 用户定）。
 *
 * 为什么叫"混合来源"：它装的是**多个作者的插件**（每个作者只出现过一次的那些），
 * 与"本地源 = 一个作者的桶"形成对照 —— 名字要说出这件事，别用开发期的内部叫法。
 */
export const DEFAULT_LOCAL_ALIAS = '本地混合来源';

/**
 * `local:default` 在**早期开发文档**里的叫法（"杂桶"）。**只用来把旧种改成新默认别名**：
 * 别名是标签不是契约，但这个标签是核心播的种（不是管理员起的名字）⇒ 跟着改名走一次；
 * 管理员自己改过的标签**不动**（只认这一个字符串）。
 */
const LEGACY_LOCAL_ALIAS = '杂桶';

export interface SuspendedState {
  at: string;
  /** §7.3 的判定码（如 KEY_CHAIN_INVALID / KEY_ROTATION_UNVERIFIABLE / KEY_STATUS_ROLLBACK / KEY_STATUS_MALFORMED） */
  reason: string;
  pendingFingerprint?: string;
}

export interface HighWater {
  rotatedAt: string;
  fingerprint: string;
  /** 累计的吊销指纹：**仅展示/审计，不参与判定**（§6.1.1） */
  revoked: string[];
}

/** 条目种类：市场域名 / 具名本地桶（见文件头） */
export type SourceKind = 'market' | 'local';

/**
 * **作者锚**（§3bis）：这个桶里的包**必须**由这把作者公钥签。
 * ⚠️ 它是**管理员的断言**，不是事实 —— 它声明"我认定这个桶只出 K 签的包"，不证明"K 是谁"；
 * 也**只在 `kind: 'local'` 上允许**（市场是多作者命名空间，给它钉一把作者钥是范畴错误）。
 */
export interface AuthorAnchor {
  /** base64 裸 32 字节 Ed25519 公钥 */
  pub: string;
  /** `sha256:` + 裸公钥哈希；**必须与 `pub` 自洽** */
  fingerprint: string;
}

export interface SourceEntry {
  /** 主键：市场域名 或 `local:<名字>`（不可为空、不可重复、不可修改） */
  origin: string;
  /** 条目种类。**磁盘上缺省视为 `'market'`**（该字段是后加的），载入时归一化 */
  kind: SourceKind;
  /** 源签名公钥（**只有市场源有**；本地源不签包 ⇒ 永远没有） */
  pub?: string;
  /** 与 `pub` 同时存在或同时缺省；必须自洽（`assertFingerprint`） */
  fingerprint?: string;
  /** 本地桶的作者锚（可选；市场源禁止带） */
  authorAnchor?: AuthorAnchor;
  /** 管理员可改，仅用于显示（"来源"标签就是它） */
  alias: string;
  enabled: boolean;
  addedAt: string;
  firstTrust: 'tofu' | 'manual';
  suspended: SuspendedState | null;
  highWater?: HighWater;
}

interface KeyringFile {
  keyringSchema: 1;
  sources: SourceEntry[];
}

/** 市场域名合法性（本机开发市场用 localhost 或 localhost:port） */
export function isValidOrigin(origin: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/.test(origin);
}

export function keyringDir(): string {
  // 状态目录统一（`core/config.ts` 文件头：`keyring.json ← 源与密钥` 就在 `<STATE_DIR>` 下，
  // `SPC_KEYRING_DIR` 只是**覆盖项**）。2026-09-25 接线时对齐：原先这里自己拼了一个 `<repo>/.spc`，
  // 于是"设了 `SPC_STATE_DIR`"的测试与部署照样会往**仓库里**写 keyring.json，
  // 而 `spc source` 读的又是另一个目录 —— 两套状态目录并存的经典症状。
  return process.env.SPC_KEYRING_DIR ?? stateDir();
}

/** `null` 与缺省同义（设计里的示例写 `"pub": null`）——统一成"没有这个字段" */
function absent(v: unknown): boolean {
  return v === undefined || v === null;
}

/**
 * 条目校验：返回问题清单（空 = 合法）。**读文件与写入口共用这一份**（口径分叉过一次就会有两套规则）。
 */
export function validateSourceEntry(entry: SourceEntry): string[] {
  const errors: string[] = [];
  const e = entry as unknown as Record<string, unknown>;
  if (typeof e.origin !== 'string' || e.origin.length === 0) {
    errors.push('origin: 必须是非空字符串');
  } else if (entry.kind === 'local') {
    if (!isLocalSource(e.origin)) errors.push(`origin: 本地源必须形如 local:<名字>（收到 ${e.origin}）`);
  } else if (!isValidOrigin(e.origin)) {
    errors.push(`origin: 市场源必须是域名（收到 ${e.origin}）`);
  }
  if (entry.kind !== 'market' && entry.kind !== 'local') {
    errors.push(`kind: 必须是 market | local（收到 ${String(entry.kind)}）`);
  }
  if (typeof e.alias !== 'string') errors.push('alias: 必须是字符串（可为空串）');
  if (typeof e.enabled !== 'boolean') errors.push('enabled: 必须是布尔');
  if (typeof e.addedAt !== 'string') errors.push('addedAt: 必须是字符串');
  if (entry.firstTrust !== 'tofu' && entry.firstTrust !== 'manual') {
    errors.push(`firstTrust: 必须是 tofu | manual（收到 ${String(entry.firstTrust)}）`);
  }
  if (!(entry.suspended === null || (typeof entry.suspended === 'object' && entry.suspended !== null))) {
    errors.push('suspended: 对象或 null');
  }
  // pub/fingerprint：要么都有、要么都没有，且必须自洽（§4 的硬规矩）
  const hasPub = !absent(e.pub);
  const hasFp = !absent(e.fingerprint);
  if (hasPub !== hasFp) errors.push('pub/fingerprint: 必须同时存在或同时缺省');
  if (hasPub && hasFp) {
    if (typeof e.pub !== 'string' || typeof e.fingerprint !== 'string') {
      errors.push('pub/fingerprint: 必须是字符串');
    } else {
      try {
        assertFingerprint(e.pub, e.fingerprint);
      } catch {
        errors.push('fingerprint: 与 pub 不自洽');
      }
    }
  }
  // 本地源不签任何包 ⇒ 带源公钥是配置错误；市场源钉作者锚是范畴错误（§3bis / §5 末）
  if (entry.kind === 'local' && hasPub) {
    errors.push('pub/fingerprint: 本地源不签包，不能带源公钥（要绑作者请用 authorAnchor）');
  }
  if (entry.kind === 'market' && !absent(e.authorAnchor)) {
    errors.push('authorAnchor: 只有本地源能带作者锚（市场是多作者命名空间）');
  }
  if (!absent(e.authorAnchor)) {
    const a = e.authorAnchor as Record<string, unknown>;
    if (typeof a !== 'object' || a === null) {
      errors.push('authorAnchor: 必须是对象');
    } else if (typeof a.pub !== 'string' || typeof a.fingerprint !== 'string') {
      errors.push('authorAnchor: 需要 { pub, fingerprint } 两个字符串');
    } else {
      try {
        assertFingerprint(a.pub, a.fingerprint);
      } catch {
        errors.push('authorAnchor.fingerprint: 与 pub 不自洽');
      }
    }
  }
  return errors;
}

/** 造一条本地桶条目（**只造对象，不落盘**；`pub`/`fingerprint` 恒缺省） */
export function newLocalSource(origin: string, alias: string, anchor?: AuthorAnchor): SourceEntry {
  return {
    origin,
    kind: 'local',
    alias,
    enabled: true,
    addedAt: new Date().toISOString(),
    firstTrust: 'manual',
    suspended: null,
    ...(anchor === undefined ? {} : { authorAnchor: anchor }),
  };
}

/** 由裸作者公钥造锚（指纹在这里算，杜绝"手抄指纹抄错"） */
export function anchorOf(pub: string): AuthorAnchor {
  return { pub, fingerprint: fingerprintOf(pub) };
}

/**
 * 写入口的严格校验。**先报有专码的问题**，再报通用条目问题 —— 否则管理员拿到的是
 * "keyring 文件非法"，而真正的原因只是"来源名字打错了"（`SOURCE_ORIGIN_INVALID`）。
 */
function assertWritable(entry: SourceEntry, file: string): void {
  const kind = entry.kind === 'local' ? 'local' : 'market';
  const originOk =
    typeof entry.origin === 'string' &&
    entry.origin.length > 0 &&
    (kind === 'local' ? isLocalSource(entry.origin) : isValidOrigin(entry.origin));
  if (!originOk) throw new SpcError('SOURCE_ORIGIN_INVALID', { origin: String(entry.origin) });
  // 只给公钥不给指纹是允许的（指纹由这里算出来补上）；给了就必须自洽（`assertFingerprint` 自己抛专码）
  if (entry.pub !== undefined) {
    if (entry.fingerprint === undefined) entry.fingerprint = fingerprintOf(entry.pub);
    assertFingerprint(entry.pub, entry.fingerprint);
  }
  if (entry.authorAnchor) assertFingerprint(entry.authorAnchor.pub, entry.authorAnchor.fingerprint);
  const errors = validateSourceEntry(entry);
  if (errors.length > 0) {
    throw new SpcError('KEYRING_INVALID', { file, reason: 'entry', detail: errors.join('; ') });
  }
}

export class Keyring {
  private sources = new Map<string, SourceEntry>();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      // fail-closed：不猜内容，也不"当空 keyring 继续跑"（那会把已知的源降级成"没配过"）
      throw new SpcError('KEYRING_INVALID', {
        file,
        reason: 'malformed-json',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const root = parsed as Partial<KeyringFile> | null;
    if (!root || typeof root !== 'object' || root.keyringSchema !== 1 || !Array.isArray(root.sources)) {
      throw new SpcError('KEYRING_INVALID', { file, reason: 'shape' });
    }
    for (const raw of root.sources) {
      const entry = normalize(raw);
      const errors = validateSourceEntry(entry);
      if (errors.length > 0) {
        // 读文件宽松（见文件头）：一条坏条目不该把核心挡在门外，但也**绝不**按它判定
        console.error(`[keyring] 忽略无效条目 ${String((raw as { origin?: unknown })?.origin)}：${errors.join('; ')}`);
        continue;
      }
      if (this.sources.has(entry.origin)) {
        console.error(`[keyring] 忽略重复条目 ${entry.origin}`);
        continue;
      }
      this.sources.set(entry.origin, entry);
    }
  }

  static open(dir = keyringDir()): Keyring {
    return new Keyring(join(dir, 'keyring.json'));
  }

  list(): SourceEntry[] {
    return [...this.sources.values()];
  }

  get(origin: string): SourceEntry | undefined {
    return this.sources.get(origin);
  }

  /** 新增源（等价于管理员的显式动作；已存在则报错，避免静默覆盖） */
  add(entry: SourceEntry): void {
    assertWritable(entry, this.file);
    if (this.sources.has(entry.origin)) {
      throw new SpcError('SOURCE_ALREADY_EXISTS', { origin: entry.origin });
    }
    this.sources.set(entry.origin, entry);
    this.save();
  }

  /** 更新已有条目（轮换 / 暂停 / 启停 / 别名 / 锚）。⚠️ `origin` 与 `kind` **不可改** */
  update(origin: string, patch: Partial<Omit<SourceEntry, 'origin'>>): SourceEntry {
    const cur = this.sources.get(origin);
    if (!cur) throw new SpcError('SOURCE_NOT_CONFIGURED', { origin });
    if (patch.kind !== undefined && patch.kind !== cur.kind) {
      throw new SpcError('SOURCE_KIND_IMMUTABLE', { origin, from: cur.kind, to: patch.kind });
    }
    const next: SourceEntry = { ...cur, ...patch, origin, kind: cur.kind };
    assertWritable(next, this.file);
    this.sources.set(origin, next);
    this.save();
    return next;
  }

  remove(origin: string): boolean {
    const ok = this.sources.delete(origin);
    if (ok) this.save();
    return ok;
  }

  setEnabled(origin: string, enabled: boolean): SourceEntry {
    return this.update(origin, { enabled });
  }

  setAlias(origin: string, alias: string): SourceEntry {
    return this.update(origin, { alias });
  }

  /**
   * 改锚 / 解绑锚（`null` = 解绑，回到"靠名册逐插件首见"的杂桶语义）。
   * 解绑走 `{ authorAnchor: undefined }`：展开合并会把这个键覆盖成 undefined ⇒ 序列化时不落盘。
   */
  setAnchor(origin: string, anchor: AuthorAnchor | null): SourceEntry {
    return this.update(origin, { authorAnchor: anchor === null ? undefined : anchor });
  }

  suspend(origin: string, reason: string, pendingFingerprint?: string): SourceEntry {
    return this.update(origin, {
      suspended: { at: new Date().toISOString(), reason, pendingFingerprint },
    });
  }

  clearSuspended(origin: string): SourceEntry {
    return this.update(origin, { suspended: null });
  }

  /** 内置官方源：缺失时补一条（无公钥 → 首次使用时 TOFU 拉取） */
  ensureDefaultOrigin(alias = '官方市场'): SourceEntry {
    const cur = this.sources.get(DEFAULT_ORIGIN);
    if (cur) return cur;
    const entry: SourceEntry = {
      origin: DEFAULT_ORIGIN,
      kind: 'market',
      alias,
      enabled: true,
      addedAt: new Date().toISOString(),
      firstTrust: 'manual',
      suspended: null,
    };
    this.sources.set(DEFAULT_ORIGIN, entry);
    this.save();
    return entry;
  }

  /**
   * 内置混合来源 `local:default`：装着"作者只出现过一次"的插件（§3bis）。
   * 它**不绑锚**（绑了就等于宣称机器上只有一个作者），靠作者名册逐 `(origin, id)` 首见（TOFU）。
   */
  ensureLocalDefault(alias = DEFAULT_LOCAL_ALIAS): SourceEntry {
    const cur = this.sources.get(DEFAULT_LOCAL_SOURCE);
    if (cur) {
      // 旧种改名：只认 `LEGACY_LOCAL_ALIAS` 这一个字符串（管理员自己起的标签一律不动）
      return cur.alias === LEGACY_LOCAL_ALIAS ? this.setAlias(DEFAULT_LOCAL_SOURCE, alias) : cur;
    }
    const entry = newLocalSource(DEFAULT_LOCAL_SOURCE, alias);
    this.sources.set(DEFAULT_LOCAL_SOURCE, entry);
    this.save();
    return entry;
  }

  /** 启动期播种：两个内置条目（官方市场 + 混合来源） */
  ensureBuiltins(): { market: SourceEntry; localDefault: SourceEntry } {
    return { market: this.ensureDefaultOrigin(), localDefault: this.ensureLocalDefault() };
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const data: KeyringFile = { keyringSchema: 1, sources: this.list() };
    writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

/**
 * 磁盘上的原始条目 → 归一化条目：补 `kind`（缺省 `market`）、把 `null` 当成"没有"。
 * 归一化只做这两件**无歧义**的事；判合法是 `validateSourceEntry` 的活。
 */
function normalize(raw: unknown): SourceEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  const entry: SourceEntry = {
    origin: typeof r.origin === 'string' ? r.origin : '',
    kind: r.kind === 'local' ? 'local' : r.kind === undefined || r.kind === null ? 'market' : (r.kind as SourceKind),
    alias: typeof r.alias === 'string' ? r.alias : '',
    enabled: r.enabled === true,
    addedAt: typeof r.addedAt === 'string' ? r.addedAt : '',
    firstTrust: r.firstTrust === 'tofu' ? 'tofu' : 'manual',
    suspended: (r.suspended ?? null) as SuspendedState | null,
  };
  if (!absent(r.pub)) entry.pub = r.pub as string;
  if (!absent(r.fingerprint)) entry.fingerprint = r.fingerprint as string;
  if (!absent(r.authorAnchor)) entry.authorAnchor = r.authorAnchor as AuthorAnchor;
  if (!absent(r.highWater)) entry.highWater = r.highWater as HighWater;
  return entry;
}

/**
 * 进程内单例。**按目录缓存**：路径一律用函数求值（`SPC_KEYRING_DIR` 可在测试里动态设置），
 * 所以目录变了就重开一个 —— 不然测试之间会互相看到对方的状态。
 */
let cached: { dir: string; kr: Keyring } | null = null;

export function keyring(): Keyring {
  const dir = keyringDir();
  if (!cached || cached.dir !== dir) cached = { dir, kr: Keyring.open(dir) };
  return cached.kr;
}

/** 测试用：丢掉单例（改了 `SPC_KEYRING_DIR` 或直接改了文件之后） */
export function resetKeyring(): void {
  cached = null;
}
