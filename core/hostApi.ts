// 宿主 API（第一版：方法级权限点声明；权限检查与审计在 sandbox 包装层强制）
// fs 走路径收敛（interface-audit-exec-fs.md F1–F7）；exec 只走模板注册表（E1–E10，无自由命令）
import { closeSync, existsSync, fstatSync, openSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HostApi } from './sandbox';
import { assertInodeMatch, validatePath } from './fs/safe-path';
import { SpcError } from './errors';
import './exec/install'; // 副作用：注册内置模板 + 其权限点
import { permissionPointOf } from './exec/templates';
import { matchExecTemplate, resolveExecRequest } from './exec/request';
import { runTemplate } from './exec/run';

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

  // exec：**只能调用已注册模板**（没有自由命令）。两种写法都接受：
  //   ① 模板 ID：exec.run('core:git.status', { repo: '/srv/demo' })
  //   ② 原生写法：exec.run('git -C /srv/demo status --porcelain=v1 --branch')
  //      —— 原生写法只用于**匹配模板**，执行的仍是模板的 argv；匹配不到直接拒（core/exec/request.ts）
  // 权限点由匹配到的模板决定：`exec.template.<action>.<op>`，scope=host ⇒ 必须管理员逐点授予
  'exec.run': {
    permissionFor: (args) => {
      const def = matchExecTemplate(args);
      if (!def) {
        // 此处只做结构匹配，不做参数校验（参数校验在权限通过之后）
        throw new SpcError('TEMPLATE_NOT_FOUND', { reason: 'no-matching-template' });
      }
      return permissionPointOf(def.id);
    },
    fn: (...args: string[]) => {
      const req = resolveExecRequest(args);
      if (!req.ok) {
        throw new SpcError(req.code, req.params ?? {});
      }
      return runTemplate(req.def, req.params);
    },
  },
};
