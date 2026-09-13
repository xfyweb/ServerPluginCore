// 样板插件：fs（写文件）+ exec（调用已注册模板）——权限由宿主侧检查 + 审计
import { fs, exec } from '@host/api';

// 1) fs：向用户主目录写文件（权限点 fs.write.home，scope=host ⇒ 需管理员授予）
const writeResult = fs.write('~/test.txt', 'HelloWorld');
console.log('[plugin] write result:', writeResult);

// 2) exec：只能调用**已注册模板**，没有自由命令（docs/interface-audit-exec-fs.md §1）。
//    注意：宿主方法返回值目前是 JSON 文本（spike 桥约定），P2 桥契约落地后统一为对象。
function runTemplate(id: string, params?: Record<string, string>) {
  // 无参数时不要传第二个实参：桥会把 undefined 当字符串传过去
  const raw = (
    params ? exec.run(id, JSON.stringify(params)) : exec.run(id)
  ) as unknown as string;
  return JSON.parse(raw) as { exitCode: number | null; stdout: string; stderr: string; truncated: boolean };
}

try {
  const v = runTemplate('core:git.version');
  console.log('[plugin] git version:', v.stdout.trim());
} catch (e) {
  // git 不在本机时模板不会被注册 ⇒ 权限点是未知点 ⇒ UNKNOWN_POINT；
  // 演示插件的重点是"调用形状"，因此这里只记录码，不让 spike 失败。
  console.log('[plugin] git.version unavailable:', (e as { code?: string }).code ?? 'UNKNOWN');
}
