// 锁文件解析（`docs/build-layer-design.md` §9-3；2026-10-12 用户定：**上 lockfile**）
//
// 为什么需要它：区间声明（`^1.2.3` / `3.x` / `>=1`）原先**只记录不判** —— 判区间要 semver 解析器，
// 而"要不要为它引一个 semver"2026-10-12 仍待拍（依赖政策已放宽，见 `AGENTS.md` §2：不再是"不能引"）。
// 锁文件给出另一条**不用 semver**的路：**锁文件里那个版本就是这次构建该用的版本**，于是
//   ① 声明是区间时，只要"锁文件里的 pin == 真正打进产物的版本"，就算**核过**（不再报"未核"）；
//   ② 反过来，装了与锁不符 ⇒ **构建失败**（`BUILD_LOCKFILE_DRIFT`）：这次构建不可复现 ——
//      而这正是插件在**自己的 CI** 里最需要挡住的事（用户 2026-10-12 的原话：lockfile 有利于插件本身 CI）。
//
// ⚠️ **不实现 semver 区间判定**：只做 `pin == bundled` 这一个**等式**判断。
// 判"1.5.0 满不满足 ^1.2.0"是另一件事，没做就是没做 —— 绝不假装判过区间语义。
// ⚠️ 认不出来就**出声**（`note`），不静默放过：没有锁文件 ⇒ 区间照旧"未核"。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type LockKind = 'npm' | 'pnpm' | 'yarn' | 'none';

export interface LockInfo {
  kind: LockKind;
  /** 相对插件目录的锁文件名；没有锁文件时 `null` */
  file: string | null;
  /** 包名 → 被锁的版本（认不出来就是空表，理由写在 `note`） */
  pinned: Map<string, string>;
  /** 认出来了但没解析（或没有锁文件）时，给作者看的一句话 */
  note?: string;
}

/** 按优先级找一个锁文件并解析（npm 与 pnpm 都是**窄解析**：只取"包名 → 版本"） */
export function readLockfile(dir: string): LockInfo {
  return readNpmLock(dir) ?? readPnpmLock(dir) ?? readYarnLock(dir) ?? noneFound();
}

function noneFound(): LockInfo {
  return { kind: 'none', file: null, pinned: new Map() };
}

// ---------------- npm：package-lock.json / npm-shrinkwrap.json ----------------

function readNpmLock(dir: string): LockInfo | null {
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const abs = join(dir, file);
    if (!existsSync(abs)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch {
      return { kind: 'npm', file, pinned: new Map(), note: '不是合法 JSON，没解析' };
    }
    const pinned = new Map<string, string>();
    const record = parsed as { packages?: Record<string, { version?: unknown }>; dependencies?: unknown };
    // v2 / v3：`packages` 的键是**路径**（`node_modules/a`、`node_modules/a/node_modules/b`，
    // 作用域包是 `node_modules/@s/n`）⇒ 取**最后一个** node_modules 段之后的名字，与 facts.ts 同一套规矩
    if (record.packages !== undefined) {
      for (const [path, meta] of Object.entries(record.packages)) {
        const name = nameFromPath(path);
        if (name === null) continue;
        if (typeof meta?.version === 'string' && meta.version.length > 0) pinned.set(name, meta.version);
      }
    } else {
      // v1：`dependencies` 是嵌套树
      walkV1(record.dependencies, pinned);
    }
    return { kind: 'npm', file, pinned };
  }
  return null;
}

/** `node_modules/@s/n` / `node_modules/a/node_modules/b` ⇒ 包名；根条目（`""`）返回 null */
function nameFromPath(path: string): string | null {
  const segs = path.split('/');
  let last = -1;
  for (let i = 0; i < segs.length; i += 1) if (segs[i] === 'node_modules') last = i;
  if (last < 0) return null;
  const first = segs[last + 1];
  if (first === undefined) return null;
  return first.startsWith('@') && segs[last + 2] !== undefined ? `${first}/${segs[last + 2]}` : first;
}

function walkV1(node: unknown, out: Map<string, string>): void {
  if (node === null || typeof node !== 'object') return;
  for (const [name, meta] of Object.entries(node as Record<string, { version?: unknown; dependencies?: unknown }>)) {
    if (typeof meta?.version === 'string' && meta.version.length > 0 && !out.has(name)) out.set(name, meta.version);
    walkV1(meta?.dependencies, out);
  }
}

// ---------------- pnpm：pnpm-lock.yaml ----------------

/**
 * pnpm 的锁文件是 YAML，但我们要的只有**包条目键**（`name@version`）：
 *   v9/v10：`packages:` 与 `snapshots:` 两段都列，键形如 `  '@scope/name@1.2.3':` 或 `  name@1.2.3:`
 *   v6    ：`  /name@1.2.3:`（peer 后缀用 `_` 接，如 `/vite@5.0.0_@types+node@20.0.0`）
 *   v5    ：`  /name/1.2.3:`
 * 所以**不引 YAML 解析器**，只按缩进扫这两段（两个空格的键就是条目，别的行一律跳过）。
 *
 * ⚠️ 两条实测踩到的坑（拿本仓库那份真实锁文件跑出来的）：
 *   ① 一个文件里可能有**多个 YAML 文档**（`---` 分段；pnpm 的 configDependencies 会另起一份）
 *      ⇒ 不能"找到第一个 `packages:` 就完事"，得把**全文件**的所有段都扫一遍；
 *   ② `packages:` 在 v9 里只放**带 resolution 元数据**的包（平台包之类），真正装的那些在 `snapshots:`
 *      ⇒ 两段都得收。
 */
function readPnpmLock(dir: string): LockInfo | null {
  const file = 'pnpm-lock.yaml';
  const abs = join(dir, file);
  if (!existsSync(abs)) return null;
  const pinned = new Map<string, string>();
  let inSection = false;
  for (const raw of readFileSync(abs, 'utf8').split('\n')) {
    if (/^(?:packages|snapshots):\s*$/.test(raw)) {
      inSection = true;
      continue;
    }
    if (/^\S/.test(raw)) {
      inSection = false; // 回到顶层键（含 `---` 新文档）⇒ 这一段结束
      continue;
    }
    if (!inSection) continue;
    const m = /^ {2}(\S.*?):\s*$/.exec(raw);
    if (m === null) continue;
    const entry = parsePnpmKey(m[1]);
    if (entry !== null && !pinned.has(entry.name)) pinned.set(entry.name, entry.version);
  }
  return { kind: 'pnpm', file, pinned };
}

/**
 * `'@s/n@1.2.3'` / `name@1.2.3` / `/name@1.2.3` / `/name/1.2.3` / `vite@5.0.0_@types+node@20.0.0`
 * ⇒ `{name, version}`；认不出返回 null。
 */
export function parsePnpmKey(keyRaw: string): { name: string; version: string } | null {
  let key = keyRaw.trim();
  if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
    key = key.slice(1, -1);
  }
  if (key.startsWith('/')) key = key.slice(1); // v5/v6 的前导斜杠
  const paren = key.indexOf('(');
  if (paren >= 0) key = key.slice(0, paren); // peer 后缀（v9/v10 的括号形式）
  const underscore = key.indexOf('_');
  if (underscore >= 0) key = key.slice(0, underscore); // peer 后缀（v6 的下划线形式）
  const at = key.lastIndexOf('@');
  if (at > 0) {
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (version !== '' && /^\d/.test(version)) return { name, version };
    return null; // `@scope/name`（没有版本段）之类
  }
  const slash = key.lastIndexOf('/'); // v5：`name/1.2.3`
  if (slash > 0) {
    const version = key.slice(slash + 1);
    if (/^\d/.test(version)) return { name: key.slice(0, slash), version };
  }
  return null;
}

// ---------------- yarn：认出来但**不解析** ----------------

function readYarnLock(dir: string): LockInfo | null {
  const file = 'yarn.lock';
  if (!existsSync(join(dir, file))) return null;
  return {
    kind: 'yarn',
    file,
    pinned: new Map(),
    note: 'yarn.lock 暂不解析（v1 与 v2+ 两套格式差异大）⇒ 区间声明照旧"未核"',
  };
}
