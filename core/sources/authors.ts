// 作者名册（docs/plugin-signature-design.md §3bis）
//
// `(origin, id) → { pub, fingerprint, firstSeenAt }`：**宿主见过的签名主体**。
//
// 与 `keyring`（源）**共用机制、分开存储**，但语义相反：
//   · 源 = "我信任的更新渠道" —— **只有管理员能加，永不自动新增**；
//   · 作者 = "我见过谁签过这个名字" —— **首见即记**（那是**识别**，不是信任）。
// 所以它落在**核心状态目录**（与 `plugins.json` 同处，`<STATE_DIR>/authors.json`），
// 而不是 keyring 那个目录：它描述的是"这台机器上装过什么"，跟着安装记录走。
//
// ⛔ **fail-closed**：文件损坏/结构非法一律拒（`AUTHORS_INVALID`），**绝不"当空名册继续跑"** ——
// 空名册会把"已知作者"降级成"首见"，于是**换一把钥就能静默装进来**，那正是本机制要挡的事。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureDir, stateDir } from '../config';
import { SpcError } from '../errors';
import { assertFingerprint, fingerprintOf } from './keys';

export interface AuthorEntry {
  /** 来源（身份的一半）：市场域名或 `local:<名字>` */
  origin: string;
  /** 插件 id（`@user/name`） */
  id: string;
  /** 作者公钥（base64 裸 32 字节）——**同一性判据** */
  pub: string;
  /** `sha256:` + 裸公钥的 sha256（展示/审计用；判定比公钥） */
  fingerprint: string;
  /** 首见时刻（ISO） */
  firstSeenAt: string;
}

export interface AuthorsFile {
  authorsSchema: 1;
  authors: AuthorEntry[];
}

/** 名册文件：与安装记录同目录（`SPC_STATE_DIR`） */
export function authorsFilePath(): string {
  return process.env.SPC_AUTHORS_FILE ?? join(stateDir(), 'authors.json');
}

function isEntry(v: unknown): v is AuthorEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.origin === 'string' &&
    e.origin.length > 0 &&
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    typeof e.pub === 'string' &&
    typeof e.fingerprint === 'string' &&
    typeof e.firstSeenAt === 'string'
  );
}

/** 读名册；不存在 → 空名册；结构非法 → 抛 `AUTHORS_INVALID`（fail-closed，不猜） */
export function loadAuthors(file = authorsFilePath()): AuthorsFile {
  if (!existsSync(file)) return { authorsSchema: 1, authors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SpcError('AUTHORS_INVALID', {
      file,
      reason: 'malformed-json',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const root = parsed as Partial<AuthorsFile> | null;
  if (!root || typeof root !== 'object' || root.authorsSchema !== 1 || !Array.isArray(root.authors)) {
    throw new SpcError('AUTHORS_INVALID', { file, reason: 'shape' });
  }
  const seen = new Set<string>();
  for (const e of root.authors) {
    if (!isEntry(e)) {
      throw new SpcError('AUTHORS_INVALID', { file, reason: 'entry' });
    }
    // 指纹必须与公钥自洽：不自洽的名册等于"记了一把对不上的钥"，判定会跟着错
    try {
      assertFingerprint(e.pub, e.fingerprint);
    } catch {
      throw new SpcError('AUTHORS_INVALID', { file, reason: 'fingerprint-mismatch', ref: `${e.origin}/${e.id}` });
    }
    const key = `${e.origin}/${e.id}`;
    if (seen.has(key)) {
      throw new SpcError('AUTHORS_INVALID', { file, reason: 'duplicate-ref', ref: key });
    }
    seen.add(key);
  }
  return { authorsSchema: 1, authors: root.authors };
}

export function saveAuthors(data: AuthorsFile, file = authorsFilePath()): void {
  ensureDir(dirname(file));
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function findAuthor(origin: string, id: string, data = loadAuthors()): AuthorEntry | undefined {
  return data.authors.find((a) => a.origin === origin && a.id === id);
}

export interface RememberResult {
  entry: AuthorEntry;
  /** true = 这条是**换钥**（原来记的是另一把）—— 调用方必须已获管理员显式接受 */
  changed: boolean;
  previous?: AuthorEntry;
}

/**
 * 记下"这个名字的作者是这把钥"（首见即记；换钥要调用方先确认）。
 * 返回是否**换了钥**，让调用方能落审计。
 */
export function rememberAuthor(
  input: { origin: string; id: string; pub: string; at?: string },
  file = authorsFilePath(),
): RememberResult {
  const data = loadAuthors(file);
  const fingerprint = fingerprintOf(input.pub);
  const prev = findAuthor(input.origin, input.id, data);
  if (prev) {
    if (prev.pub !== input.pub) {
      // 换钥：**这里只负责写**，"该不该接受"由调用方（管理员动作）判定
      const entry: AuthorEntry = { ...prev, pub: input.pub, fingerprint };
      data.authors = data.authors.map((a) => (a === prev ? entry : a));
      saveAuthors(data, file);
      return { entry, changed: true, previous: prev };
    }
    return { entry: prev, changed: false, previous: prev };
  }
  const entry: AuthorEntry = {
    origin: input.origin,
    id: input.id,
    pub: input.pub,
    fingerprint,
    firstSeenAt: input.at ?? new Date().toISOString(),
  };
  data.authors = [...data.authors, entry];
  saveAuthors(data, file);
  return { entry, changed: false };
}
