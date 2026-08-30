// spike 版：无鉴权、无审计、无路径收敛——只验证链路，安全设计见 interface-audit-exec-fs.md
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 展开 ~ 为家目录（spike 简化，正式版走 realpath + 路径收敛） */
function expandPath(p: string): string {
  return p.startsWith('~/') || p === '~'
    ? join(homedir(), p.slice(p === '~' ? 1 : 2))
    : p;
}

export const hostApi = {
  // 插件入口：write('~/test.txt', 'HelloWorld')（spike 简化：无 'fs.' 命名空间前缀，正式版见 api-contract §4）
  write: (path: string, content: string) => {
    const abs = expandPath(path);
    writeFileSync(abs, content, 'utf8');
    return { ok: true, path: abs, bytes: Buffer.byteLength(content) };
  },
};