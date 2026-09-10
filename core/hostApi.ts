// 宿主 API（第一版：方法级权限点声明；权限检查与审计在 sandbox 包装层强制）
// fs 走路径收敛（interface-audit-exec-fs.md F1–F7）
import { closeSync, existsSync, fstatSync, openSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HostApi } from './sandbox';
import { assertInodeMatch, validatePath } from './fs/safe-path';
import { SpcError } from './errors';

/** 展开 ~ 为用户主目录（路径收敛要求绝对路径输入） */
function expandPath(p: string): string {
  return p.startsWith('~/') || p === '~'
    ? join(homedir(), p.slice(p === '~' ? 1 : 2))
    : p;
}

/** 单文件大小上限（F4 放大攻击防护） */
const MAX_FILE_BYTES = 64 * 1024 * 1024; // 64MB

export const hostApi: HostApi = {
  // 分组命名：fs.write ↔ 权限点 fs.write.home（spike 演示用，正式版 fs.write.data）
  'fs.write': {
    permission: 'fs.write.home',
    fn: (path: string, content: string) => {
      // ① 路径收敛（F1–F3/F6）：只允许写用户主目录
      const { path: safe, expected } = validatePath(expandPath(path), [homedir()]);

      // ② 大小限制（F4）：内容长度 + 目标文件现有大小
      const bytes = Buffer.byteLength(content);
      if (bytes > MAX_FILE_BYTES) {
        throw new SpcError('FILE_TOO_LARGE', { bytes: String(bytes), limit: String(MAX_FILE_BYTES) });
      }
      if (existsSync(safe) && statSync(safe).size > MAX_FILE_BYTES) {
        throw new SpcError('TARGET_TOO_LARGE', { path: safe, limit: String(MAX_FILE_BYTES) });
      }

      // ③ 打开 + inode 比对（F5 TOCTOU）+ 写入
      const fd = openSync(safe, 'w');
      try {
        if (expected) {
          const st = fstatSync(fd);
          assertInodeMatch({ dev: st.dev, ino: st.ino }, expected);
        }
        writeFileSync(fd, content, 'utf8');
      } finally {
        closeSync(fd);
      }
      return { ok: true, path: safe, bytes };
    },
  },
};
