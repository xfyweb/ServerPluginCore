// 宿主 API（第一版：方法级权限点声明；权限检查与审计在 sandbox 包装层强制）
// 安全设计见 interface-audit-exec-fs.md；正式版 fs 走路径收敛（F1–F7）
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HostApi } from './sandbox';

/** 展开 ~ 为家目录（spike 简化，正式版走 realpath + 路径收敛） */
function expandPath(p: string): string {
  return p.startsWith('~/') || p === '~'
    ? join(homedir(), p.slice(p === '~' ? 1 : 2))
    : p;
}

export const hostApi: HostApi = {
  // 分组命名：fs.write ↔ 权限点 fs.write.home（spike 演示用，正式版 fs.write.data）
  'fs.write': {
    permission: 'fs.write.home',
    fn: (path: string, content: string) => {
      const abs = expandPath(path);
      writeFileSync(abs, content, 'utf8');
      return { ok: true, path: abs, bytes: Buffer.byteLength(content) };
    },
  },
};
