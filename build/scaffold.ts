// 脚手架：`spcdev new <名字>`（docs/build-layer-design.md §10.5）
//
// 生成的是一支**能直接跑**的最小插件（不是空壳）：清单里带真实权限声明 + configSchema，
// 入口导出 `init`/`start`/`stop` 并真的读写自己的数据目录 —— 这样 `spcdev check` / `spcdev build` /
// 装进 daemon 每一步都有东西可验。
//
// ⚠️ 生成器**不跑** `git init`、不装依赖、不碰工作区之外的东西（"整理别人的东西要先问"同理：
// 工具只做被要求的那一件事），只把"下一步该敲什么"打印出来。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SpcError } from '../core/errors';
import { ID_SEGMENT_RE, PLUGIN_ID_RE } from '../sdk/ids';
import { checkAuthorId, type Workspace } from './workspace';

export interface ScaffoldOptions {
  /** 目录名（同时是 id 的尾段），如 `demo` */
  name: string;
  /**
   * **作者 ID**（`@<作者 ID>/<名字>` 的 `@` 前缀）—— **必填、无默认值**。
   * 来源只有两个：`.spcdev/config.json` 的 `author`（`spcdev keygen` 问过一次），或显式 `--author`。
   * 工具**不猜**身份：猜错的代价是"插件挂到别人名下"，而那是发布出去就改不回来的事。
   */
  author: string;
  /** 覆盖目标目录（缺省 `<工作区根>/plugin/<name>`） */
  dir?: string;
  /** 目标目录已存在且非空时是否覆盖（默认否） */
  force?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  id: string;
  files: string[];
}

function manifestTemplate(id: string, displayName: string): string {
  return `${JSON.stringify(
    {
      schema: 2,
      id,
      name: displayName,
      version: { code: 1, name: '0.0.1' },
      description: '一句话说明这个插件做什么（会出现在插件列表里）',
      runtime: { type: 'quickjs', esm: true },
      entry: 'main.ts',
      // 权限点要**精确**写，并写清 reason（它会出现在安装提示里给管理员看）。
      // 这里的三条都是 self 档（够不着宿主资源，声明即用）；要碰宿主资源就加 host 档的点。
      permissions: [
        { name: 'fs.write.data', reason: '在自己的数据目录里写一份问候记录' },
        { name: 'fs.read.data', reason: '把刚写的那份读回来演示' },
        { name: 'lifecycle.version', reason: '启动时做契约协商（确认核心提供的 API 版本）' },
      ],
      configSchema: {
        type: 'object',
        required: ['greeting'],
        additionalProperties: false,
        properties: {
          greeting: { type: 'string', default: 'hello', description: '写进数据目录的问候语' },
        },
      },
    },
    null,
    2,
  )}\n`;
}

function mainTemplate(name: string): string {
  return `// ${name} —— 最小可跑插件（\`spcdev new\` 生成）
//
// 契约（docs/plugin-lifecycle-design.md §1）：
//   · 入口模块导出 \`init\` / \`start\`（\`stop\` 可选）；\`ctx\` 是**只读**的环境事实（@spc/sdk）
//   · 能力全部来自 \`@host/api\`；沙箱里**没有** process / require / 网络
//   · 要碰宿主资源（别的目录、命令、网络）必须先在 manifest 里声明权限点，再由管理员授予
import { fs, lifecycle } from '@host/api';
import type { PluginContext } from '@spc/sdk';

/** 装载后一次。\`ctx.config\` 已按 manifest 的 configSchema 校验并补过默认值（深度冻结） */
export async function init(ctx: PluginContext): Promise<void> {
  const v = lifecycle.version();
  ctx.logger.info(\`\${ctx.pluginId} init：core=\${v.core} api=\${v.api}\`);

  // 相对路径按**自己的数据目录**解析；写 \`../\` 或绝对路径会 PATH_OUT_OF_SCOPE（不是被静默改写）
  const written = fs.write('hello.txt', \`\${String(ctx.config.greeting ?? 'hello')}\\n\`);
  ctx.logger.info(\`已写入 \${written.path}（\${written.bytes} 字节）\`);
}

/** 启用后一次（这里顺带读回刚写的东西，证明数据目录真的通了） */
export async function start(ctx: PluginContext): Promise<void> {
  const back = fs.read('hello.txt');
  ctx.logger.info(\`回读：\${back.content.trim()}\`);
}

/** 停用 / 卸载前（可选：宿主会清定时器与句柄，但显式清语义更清楚） */
export async function stop(ctx: PluginContext): Promise<void> {
  ctx.logger.info('stop');
}
`;
}

function tsconfigTemplate(): string {
  return `${JSON.stringify(
    {
      // 继承本体的编译选项（strict / noEmit / allowImportingTsExtensions…）。
      // include 只列自己的入口 + 两个 ambient 声明：`@host/api` / `@spc/sdk` 就是靠它们才有类型。
      extends: '../../tsconfig.json',
      include: ['main.ts', '../../sdk/host-api.d.ts', '../../sdk/plugin.d.ts', '../../sdk/types.ts'],
    },
    null,
    2,
  )}\n`;
}

function packageTemplate(name: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: 'module',
      description: 'ServerPluginCore 插件：第三方依赖装在本目录（构建层只解析真实闭包，不替你安装）',
      // 让**在插件目录里**也能用短命令（不依赖全局 link）：`pnpm spcdev check .`
      scripts: { spcdev: 'tsx ../../core/cli-dev.ts' },
      dependencies: {},
    },
    null,
    2,
  )}\n`;
}

function readmeTemplate(name: string, id: string): string {
  return `# ${name}

ServerPluginCore 插件（\`${id}\`）。

## 开发

两个命令各管一半：\`spcdev\` = **作者工具**（keygen / new / check / build / pack，全程本地、要与本体同版本）·
\`spc\` = **管理面**（plugin install / reload / status / grant / source，需要 daemon 在跑）。

**一次性**：在本体根目录（克隆下来的 ServerPluginCore）跑 \`npm link\` ⇒ 之后**任何目录**都能直接用这两个命令。
不装全局也能用：仓库根 \`pnpm spcdev …\`；本插件目录 \`pnpm spcdev …\`（模板已在 package.json 里带好这条脚本）。

\`\`\`bash
npm link                        # 一次性（在本体根执行；⚠️ pnpm 没有 link --global）
spcdev keygen                   # 首次：**问一次作者 ID** + 生成作者密钥到 .spcdev/keys/
spcdev new <名字>               # 建新插件（插件 id = @作者 ID/名字，作者 ID 取自 .spcdev/config.json）
spcdev check .                  # 秒级自检：清单 / 权限点对账 / 导入面
spc plugin install .            # 装进本机核心（需 daemon 在跑）
spc plugin reload ${id}         # 改完代码重载（不重启核心）
\`\`\`

## 权限点

清单里声明了什么、为什么，见 \`manifest.json\` 的 \`permissions\`。要点：

- \`self\` 档（\`fs.read.data\` / \`fs.write.data\` / \`kv.*\` / \`timers.*\`）——**声明即用**，够不着宿主资源；
- \`host\` 档（如 \`exec.template.git.version\`、别处目录的读写）——**必须管理员逐点授予**，否则运行期 \`PERMISSION_DENIED\`。

## 目录

\`\`\`
manifest.json   清单（作者声明；权限要精确写 + 写 reason）
main.ts         入口（导出 init / start / stop）
tsconfig.json   给编辑器用的类型配置（继承本体）
package.json    第三方依赖（可选）
\`\`\`
`;
}

function gitignoreTemplate(): string {
  return ['node_modules/', 'dist/', '.spcdev/', '*.key', ''].join('\n');
}

/** 写一支新插件；返回实际落盘的文件清单（供 CLI 打印） */
export function scaffoldPlugin(ws: Workspace, opts: ScaffoldOptions): ScaffoldResult {
  if (!ID_SEGMENT_RE.test(opts.name)) throw new SpcError('PLUGIN_NAME_INVALID', { name: opts.name });
  const author = checkAuthorId(opts.author);
  if (author === null) throw new SpcError('AUTHOR_ID_INVALID', { id: opts.author });
  const id = `@${author}/${opts.name}`;
  // 理论上到不了（两段各自校验过，且拼法与 `PLUGIN_ID_CORE` 同构）；留着是因为 id 的形状是**外部契约**，
  // 哪天 `<作者>/<名字>` 不再是两段，这里得有人喊 —— 而不是悄悄生成一个装不进去的 id。
  if (!PLUGIN_ID_RE.test(id)) throw new SpcError('PLUGIN_ID_INVALID', { id });

  const dir = opts.dir ?? join(ws.root, 'plugin', opts.name);
  if (existsSync(dir) && readdirSync(dir).length > 0 && opts.force !== true) {
    throw new SpcError('PLUGIN_DIR_EXISTS', { dir });
  }
  mkdirSync(dir, { recursive: true });

  const displayName = opts.name;
  const files: [string, string][] = [
    ['manifest.json', manifestTemplate(id, displayName)],
    ['main.ts', mainTemplate(opts.name)],
    ['tsconfig.json', tsconfigTemplate()],
    ['package.json', packageTemplate(opts.name)],
    ['README.md', readmeTemplate(opts.name, id)],
    ['.gitignore', gitignoreTemplate()],
  ];
  for (const [name, content] of files) writeFileSync(join(dir, name), content, 'utf8');
  return { dir, id, files: files.map(([name]) => name) };
}
