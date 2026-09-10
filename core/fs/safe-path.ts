// 路径收敛（interface-audit-exec-fs.md F1–F7）
// 所有 fs 路径先过本模块校验，宿主才能使用——校验与打开分离点要防 TOCTOU。
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/** 特殊路径黑名单（F3）：拒绝设备/内核接口/系统目录 */
const FORBIDDEN_PREFIXES = ['/dev', '/proc', '/sys', '/etc', '/boot', '/lost+found'];

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
  const abs = isAbsolute(requested) ? requested : resolve(requested);
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
    throw new PathError(`路径不在允许的作用域内: ${abs}`);
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
        throw new PathError(`符号链接无法解析（目标不存在）: ${current}`);
      }
      if (!inRoot(target)) {
        throw new PathError(`符号链接逃逸拦截: ${current} → ${target}`);
      }
    }
  }

  // 3/4) 最终解析
  let final: string;
  let expected: ExpectedInode | null = null;
  if (existsSync(abs)) {
    final = realpathSync(abs);
    if (!inRoot(final)) {
      throw new PathError(`符号链接逃逸拦截: ${abs} → ${final}`);
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
      throw new PathError(`父目录不存在: ${parent}`);
    }
    if (!inRoot(realParent)) {
      throw new PathError(`父目录逃逸拦截: ${parent}`);
    }
    final = join(realParent, basename(abs));
  }

  // 5) 特殊路径黑名单（F3）
  if (FORBIDDEN_PREFIXES.some((p) => final.startsWith(p))) {
    throw new PathError(`特殊路径被拒: ${final}`);
  }

  return { path: final, expected };
}

/**
 * 打开后 inode 比对（F5 TOCTOU）：校验后文件被替换的检测
 * 用法：openSync(final, flag) → fstatSync(fd) 与 expected 比对 → 一致才继续
 */
export function assertInodeMatch(actual: { dev: number; ino: number }, expected: ExpectedInode | null): void {
  if (expected === null) {
    throw new PathError('inode 校验缺少预检值（新文件场景不应调用）');
  }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new PathError('TOCTOU 检测：文件在校验后被替换');
  }
}
