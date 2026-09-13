// 模板注册的落地入口：模板 + 它自动生成的权限点（docs/exec-sandbox-design.md §2.2）
//
// scope = host ⇒ 该权限点必须由管理员**逐点授予**，插件声明了也调不动（api-contract §7）。
import { registry } from '../permissions/registry';
import {
  permissionPointOf,
  resolveExecutable,
  templates,
  type TemplateDef,
  type TemplateParam,
} from './templates';
import { delimiter, join } from 'node:path';

/** 注册模板并自动生成权限点 `exec.template.<action>.<op>` */
export function registerTemplate(def: TemplateDef): void {
  templates.register(def);
  try {
    registry.register({
      name: permissionPointOf(def.id),
      group: 'exec',
      description: `exec 模板：${def.id}（命令固定 + 参数校验，无自由命令）`,
      scope: 'host',
      confidentiality: 'sensitive',
      executionLevel: 'high',
    });
  } catch (err) {
    // 权限点冲突（action.op 撞名）→ 回滚模板，避免"模板在、权限点不在"的半注册状态
    templates.unregister(def.id);
    throw err;
  }
}

/**
 * 内置模板允许操作的仓库根。
 * 默认按平台给（Windows `%ProgramData%\spc\repos`；Linux `/srv`、`/var/lib/spc/repos`），
 * 部署时可用 `SPC_REPO_ROOTS`（平台分隔符）覆盖——管理员决定"哪些目录里的仓库允许被模板操作"。
 */
function repoRoots(): string[] {
  const raw = process.env.SPC_REPO_ROOTS;
  if (raw) {
    const dirs = raw
      .split(delimiter)
      .map((s) => s.trim())
      .filter(Boolean);
    if (dirs.length > 0) return dirs;
  }
  return process.platform === 'win32'
    ? [join(process.env.ProgramData ?? 'C:\\ProgramData', 'spc', 'repos')]
    : ['/srv', '/var/lib/spc/repos'];
}

/**
 * 内置模板（P1 起步：nginx + git 一族）。
 *
 * 跨平台解析：git 在 Windows 上通常在 `%ProgramFiles%\Git\cmd\git.exe`（已在 E10 白名单内），
 * Linux 上通常在 /usr/bin 或 /usr/local/bin——统一走 `resolveExecutable`（PATH + 候选目录），
 * 再交给注册期的 E10 白名单收口。
 *
 * 单个模板注册失败（例如可执行文件装在白名单外）**只告警、不影响核心启动**：
 * 内置能力缺失是可以接受的降级，让核心起不来不行。
 */
export function registerBuiltinTemplates(): void {
  const register = (def: TemplateDef) => {
    try {
      registerTemplate(def);
    } catch (err) {
      console.warn(
        `[exec] 内置模板 ${def.id} 未注册：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const nginx = resolveExecutable('nginx');
  if (nginx) {
    register({ id: 'core:nginx.test', command: [nginx, '-t'], timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
    register({ id: 'core:nginx.reload', command: [nginx, '-s', 'reload'], timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  }

  const git = resolveExecutable('git');
  if (git) {
    const repoParam = (): TemplateParam => ({ name: 'repo', type: 'path', scope: repoRoots(), mustExist: true });
    // 诊断类：不需要仓库，任何装了 git 的机器都能跑（示例插件用它演示 exec 调用形状）
    register({ id: 'core:git.version', command: [git, '--version'], timeoutMs: 10_000, maxOutputBytes: 16 * 1024 });
    // 只读类：不改变仓库状态
    register({
      id: 'core:git.status',
      command: [git, '-C', '{repo}', 'status', '--porcelain=v1', '--branch'],
      params: [repoParam()],
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024,
    });
    register({
      id: 'core:git.log',
      command: [git, '-C', '{repo}', 'log', '--oneline', '-n', '{count}'],
      params: [repoParam(), { name: 'count', type: 'pattern', pattern: '[0-9]{1,3}' }],
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024,
    });
    register({
      id: 'core:git.rev-parse',
      command: [git, '-C', '{repo}', 'rev-parse', '--short', 'HEAD'],
      params: [repoParam()],
      timeoutMs: 10_000,
      maxOutputBytes: 8 * 1024,
    });
    register({
      id: 'core:git.branch',
      command: [git, '-C', '{repo}', 'branch', '--show-current'],
      params: [repoParam()],
      timeoutMs: 10_000,
      maxOutputBytes: 8 * 1024,
    });
    // 会动仓库 / 走网络的：超时给足，输出给宽
    register({
      id: 'core:git.fetch',
      command: [git, '-C', '{repo}', 'fetch', '--prune'],
      params: [repoParam()],
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024,
    });
    register({
      id: 'core:git.pull',
      command: [git, '-C', '{repo}', 'pull', '--ff-only'],
      params: [repoParam()],
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
    });
  }
}

registerBuiltinTemplates();
