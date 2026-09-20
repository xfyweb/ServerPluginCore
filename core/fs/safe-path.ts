// 路径收敛（interface-audit-exec-fs.md F1–F7）
// 所有 fs 路径先过本模块校验，宿主才能使用——校验与打开分离点要防 TOCTOU。
// 错误只携带机器可读的 { code, params }；本地化文本由边界层（CLI / 面板）渲染。
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { SpcError } from '../errors';

/** 路径收敛错误码（契约：只增不改） */
export type PathErrorCode =
  | 'PATH_OUT_OF_SCOPE'
  | 'SYMLINK_DANGLING'
  | 'SYMLINK_ESCAPE'
  | 'PARENT_MISSING'
  | 'PARENT_ESCAPE'
  | 'SPECIAL_PATH_DENIED'
  | 'INODE_PRECHECK_MISSING'
  | 'INODE_MISMATCH';

export class PathError extends SpcError {
  constructor(code: PathErrorCode, params: Record<string, string> = {}) {
    super(code, params);
    this.name = 'PathError';
  }
}

/** 特殊路径黑名单（F3）：拒绝设备/内核接口/系统目录 */
const FORBIDDEN_PREFIXES = ['/dev', '/proc', '/sys', '/etc', '/boot', '/lost+found'];

/**
 * Windows **保留设备名**（F3 的 Windows 分支）。
 *
 * 为什么必须有：`<dataDir>\nul`、`con`、`com1` 在 Windows 上是**设备对象**而不是文件——
 * 写进去的字节会进核心控制台（`con`）/并口（`lpt1`）/被静默丢弃（`nul`），
 * 而 `readdir` 里**看不到它**。于是"插件唯一可写位置 = 自己数据目录"这条不变量被绕开
 * （`fs.write.data` 是 scope=self，本来就没有管理员授予那道闸）。
 *
 * 判定要点：**只看基名**（`sub/nul` 同样中招）、**大小写不敏感**、**带扩展名也算**（`nul.txt`）。
 * 名字表对齐 Node `lib/path.js` 的 `WINDOWS_RESERVED_NAMES`（契约宗主），含上标变体 `COM¹/LPT²`。
 * 纯函数，与平台无关——平台判断留给调用方，这样它可以在任何开发机上被单测。
 */
const WIN32_DEVICE_RE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
export function isWindowsDeviceName(segment: string): boolean {
  return WIN32_DEVICE_RE.test(segment);
}

/** 打开后校验用：预检的 inode（F5 TOCTOU / F7 硬链接） */
export interface ExpectedInode {
  dev: number;
  ino: number;
}

export interface PathValidation {
  /** 已校验的安全绝对路径（后续操作必须使用此路径） */
  path: string;
  /** 已存在文件：预检 inode，打开后需比对（F5）；新文件：null */
  expected: ExpectedInode | null;
}

/**
 * 路径收敛校验（F1–F3/F6）：
 * 1) 绝对路径化 + 字符串级前缀检查
 * 2) 逐级 lstat：符号链接 → realpath 解析目标，目标必须在作用域内（F2）
 * 3) 已存在文件：realpath 最终校验 + 预检 inode（F5/F7）
 * 4) 新文件：父目录 realpath 校验（F6）
 * 5) 特殊路径黑名单（F3）
 */
export function validatePath(requested: string, roots: string[]): PathValidation {
  /**
   * ⚠️ **一切判定都必须用规范化后的路径**（`resolve()` 一次），不能拿调用方写的那串直接比。
   *
   * 为什么（实测踩到，`tools/smoke/dep-smoke.mts`）：Windows 上 `C:/a/b` 与 `C:\a\b` 是同一个位置，
   * 但字符串不同。而 `node-path.js` 的 `resolve()` 产出的**正是正斜杠形式**（POSIX 语义 + 盘符），
   * 真实依赖又普遍写 `fs.mkdirSync(path.resolve(p))`（`mkdirp/dist/mjs/path-arg.js:11`）——
   * 于是"前缀匹配"拿 `C:/…` 去比 `C:\…` 的根，判定为**越界**（EACCES），而它其实就在数据目录里。
   * 同一个坑还会让第 2 步的逐级软链扫描 `split(sep)` 切不开，整段被跳过（fail-open）。
   *
   * 错误文案仍报 `requested`：插件作者要看到的是**自己写的那串**（F1 注释的老约定）。
   */
  const abs = resolve(requested);
  // 作用域匹配：根自身也算在作用域内（否则作用域根被自己拒绝），子路径按 "根 + sep" 前缀匹配。
  // 特判盘根：resolve('/') 是 '/'（Windows 是 'C:\\'），此时不能再补 sep（'//' 会导致白名单失效）。
  const normRoots = roots.map((r) => resolve(r));
  const inRoot = (p: string): boolean =>
    normRoots.some((root) => {
      if (p === root) return true;
      const prefix = root.endsWith(sep) ? root : root + sep;
      return p.startsWith(prefix);
    });

  // 1) 快速前缀检查（字符串级，先拦明显越界）
  if (!inRoot(abs)) {
    throw new PathError('PATH_OUT_OF_SCOPE', { path: requested });
  }

  // 2) 逐级符号链接检查（F2）：从卷根开始，每级 lstat
  // 起点必须是卷根（POSIX '/'；Windows 'D:\'）——直接以 sep 起步会在 Windows 拼出 '\D:'，
  // 使 lstat 立即失败并 break，整段扫描被跳过（悬空软链因此可被放行）。
  const vol = parse(abs).root;
  const segments = abs.slice(vol.length).split(sep).filter(Boolean);
  let current: string = vol;
  for (const seg of segments) {
    current = join(current, seg);
    let st;
    try {
      st = lstatSync(current);
    } catch {
      break; // 路径尚不存在（新文件场景），停止逐级检查
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(current);
      } catch {
        // 悬空软链（目标不存在）：无法证明其在作用域内 → fail-closed
        throw new PathError('SYMLINK_DANGLING', { path: current });
      }
      if (!inRoot(target)) {
        throw new PathError('SYMLINK_ESCAPE', { path: current, target });
      }
    }
  }

  // 3/4) 最终解析
  let final: string;
  let expected: ExpectedInode | null = null;
  if (existsSync(abs)) {
    final = realpathSync(abs);
    if (!inRoot(final)) {
      throw new PathError('SYMLINK_ESCAPE', { path: abs, target: final });
    }
    const st = statSync(final);
    expected = { dev: st.dev, ino: st.ino };
  } else {
    // 新文件：父目录必须存在且在校验范围内（F6）
    const parent = dirname(abs);
    let realParent: string;
    try {
      realParent = realpathSync(parent);
    } catch {
      // 父目录不存在（或链中断）：明确报错，避免裸 ENOENT 冒泡
      throw new PathError('PARENT_MISSING', { path: parent });
    }
    if (!inRoot(realParent)) {
      throw new PathError('PARENT_ESCAPE', { path: parent });
    }
    final = join(realParent, basename(abs));
  }

  // 5) 特殊路径黑名单（F3）：POSIX 前缀 + **Windows 设备名**（后者只在 Windows 上生效——
  //    在 Linux 上 `nul` 是合法文件名，无条件拒绝会误伤正常插件）
  const windowsDevice =
    process.platform === 'win32' && final.split(/[\\/]/).some(isWindowsDeviceName);
  if (windowsDevice || FORBIDDEN_PREFIXES.some((p) => final.startsWith(p))) {
    throw new PathError('SPECIAL_PATH_DENIED', { path: final });
  }

  return { path: final, expected };
}

/**
 * 打开后 inode 比对（F5 TOCTOU）：校验后文件被替换的检测
 * 用法：openSync(final, flag) → fstatSync(fd) 与 expected 比对 → 一致才继续
 */
export function assertInodeMatch(actual: { dev: number; ino: number }, expected: ExpectedInode | null): void {
  if (expected === null) {
    throw new PathError('INODE_PRECHECK_MISSING');
  }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new PathError('INODE_MISMATCH');
  }
}
