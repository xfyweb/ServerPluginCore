// CLI 端到端测试：spawn daemon → 跑 spc 命令 → 断言输出
// 覆盖：握手 / status / 插件全命令面（install → list → disable/enable → status → grant/revoke
// → reload → uninstall）/ daemon 未启动时的错误提示
//
// 状态目录必须隔离：daemon 会把安装记录与插件数据写进 SPC_STATE_DIR，
// 不隔离就会污染仓库里的 .spc（这也是"记录由 daemon 拥有"的直接后果）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = mkdtempSync(join(tmpdir(), 'spc-e2e-'));

/** 找一个空闲端口（测试专用） */
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const port = (srv.address() as { port: number }).port;
  srv.close();
  return port;
}

/** 跑一个 Node 进程（--import tsx 直接执行 TS） */
function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
      cwd: root,
      env: { ...process.env, SPC_STATE_DIR: STATE, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let daemon: ChildProcess | undefined;
let port = 0;
const env = () => ({ SPC_PORT: String(port) });

before(async () => {
  port = await freePort();
  daemon = spawn(process.execPath, ['--import', 'tsx', 'core/server.ts'], {
    cwd: root,
    env: { ...process.env, SPC_PORT: String(port), SPC_STATE_DIR: STATE },
  });
  // 等待 daemon 就绪（stdout 出现 listening）
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon 启动超时')), 15000);
    daemon!.stdout!.on('data', (d: Buffer) => {
      if (String(d).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    daemon!.on('exit', (code) => reject(new Error(`daemon 提前退出（code=${code}）`)));
  });
});

after(async () => {
  daemon?.kill();
  await new Promise((r) => setTimeout(r, 200));
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* Windows 上句柄未释放会 EPERM：尽力清理 */
  }
});

test('CLI status：握手 + 会话 + 状态查询 全链路（含插件计数）', async () => {
  const r = await run(['core/cli.ts', 'status'], env());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /核心运行中/);
  assert.match(r.stdout, /pid \d+/);
  assert.match(r.stdout, /插件：共 0 个，运行中 0 个/);
});

test('CLI plugin list：新状态目录下没有插件（记录驱动，不是扫目录）', async () => {
  const r = await run(['core/cli.ts', 'plugin', 'list'], env());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /（无插件）/);
});

test('CLI plugin install：写记录 → 立即装载 → init/start 跑通', async () => {
  const r = await run(
    ['core/cli.ts', 'plugin', 'install', 'plugin/hello', '--grant', 'exec.template.git.version'],
    env(),
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /已安装：local:default\/@xfy2412\/hello/);
  assert.match(r.stdout, /@xfy2412\/hello@0\.0\.1 \[running\]/);
  assert.match(r.stdout, /enabled=是/);
  assert.match(r.stdout, /已授予：exec\.template\.git\.version/);
  // 能力登记结果回落到记录
  assert.match(r.stdout, /能力：.*route:\/hello/);
  assert.match(r.stdout, /能力：.*endpoint:\/api\/hello\/status/);
});

test('CLI plugin list：显示状态而不是"目录里有没有 manifest"', async () => {
  const r = await run(['core/cli.ts', 'plugin', 'list'], env());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /@xfy2412\/hello@0\.0\.1 \[running\]/);
});

test('CLI plugin disable / enable：状态机往返，禁用后不再装载', async () => {
  const off = await run(['core/cli.ts', 'plugin', 'disable', '@xfy2412/hello'], env());
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /已禁用：@xfy2412\/hello/);
  assert.match(off.stdout, /\[disabled\]/);
  assert.match(off.stdout, /enabled=否/);

  const on = await run(['core/cli.ts', 'plugin', 'enable', '@xfy2412/hello'], env());
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /\[running\]/);
  assert.match(on.stdout, /enabled=是/);
});

test('CLI plugin status：详情含目录 / 数据目录 / 配置文件', async () => {
  const r = await run(['core/cli.ts', 'plugin', 'status', '@xfy2412/hello'], env());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /数据目录：.*data.*plugins.*xfy2412__hello/);
  assert.match(r.stdout, /配置文件：.*config.*plugins.*xfy2412__hello\.json/);
});

test('CLI plugin grant/revoke：只接受具体权限点（通配被拒），并提示需要 reload', async () => {
  const bad = await run(['core/cli.ts', 'plugin', 'grant', '@xfy2412/hello', 'kv.*'], env());
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /授权不接受通配/);

  const revoked = await run(
    ['core/cli.ts', 'plugin', 'revoke', '@xfy2412/hello', 'exec.template.git.version'],
    env(),
  );
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.match(revoked.stdout, /授权或配置已变更：需 reload 后生效/);

  const reloaded = await run(['core/cli.ts', 'plugin', 'reload', '@xfy2412/hello'], env());
  assert.equal(reloaded.code, 0, reloaded.stderr);
  assert.match(reloaded.stdout, /\[running\]/);
  assert.doesNotMatch(reloaded.stdout, /需要 reload 才生效/);
});

test('CLI plugin uninstall：内置插件同样可卸载（v2 取消 reserved），记录随之消失', async () => {
  const r = await run(['core/cli.ts', 'plugin', 'uninstall', '@xfy2412/hello'], env());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /已卸载：@xfy2412\/hello/);
  const list = await run(['core/cli.ts', 'plugin', 'list'], env());
  assert.doesNotMatch(list.stdout, /@xfy2412\/hello/);
  // 卸载后 status 报 NOT_FOUND（记录真的没了，不是只改了状态）
  const st = await run(['core/cli.ts', 'plugin', 'status', '@xfy2412/hello'], env());
  assert.notEqual(st.code, 0);
  assert.match(st.stderr, /插件不存在/);
});

test('CLI source list：内置条目（官方市场 + 杂桶）在 daemon 启动时就已播种', async () => {
  const r = await run(['core/cli.ts', 'source', 'list'], env());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /market\.spc\.xfyweb\.cn · 市场源 · 官方市场/);
  assert.match(r.stdout, /local:default · 本地桶 · 杂桶/);
  // 杂桶不绑锚：绑了就等于宣称这台机器上只有一个作者（docs/plugin-signature-design.md §3bis）
  assert.match(r.stdout, /作者锚：未绑定/);
  // 而**锚只属于本地桶**：市场源印"作者锚：未绑定"是范畴错误（市场是多作者命名空间），
  // 它该回答的是"源公钥取到没有" ⇒ 用数量关系钉死，不依赖条目的排列顺序
  const locals = (r.stdout.match(/· 本地桶 ·/g) ?? []).length;
  const anchors = (r.stdout.match(/作者锚/g) ?? []).length;
  assert.equal(anchors, locals, '每个本地桶恰好一行作者锚；市场源不该有这一行');
  assert.match(r.stdout, /源公钥：未取到/, '市场源还没拉过公钥时要说明白');
});

test('CLI source add / anchor / remove：本地桶全链路（锚改完能解绑）', async () => {
  // 任意一把合法的 32 字节 Ed25519 公钥（本用例只验"桶能建、锚能改"，不验签名）
  const pub = Buffer.alloc(32, 7).toString('base64');
  const add = await run(
    ['core/cli.ts', 'source', 'add', 'local:std-a', '--alias', 'std（小A）', '--anchor', pub],
    env(),
  );
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /已添加来源：local:std-a/);
  assert.match(add.stdout, /本地桶 · std（小A）/);
  assert.match(add.stdout, /作者锚：sha256:/);

  const clear = await run(['core/cli.ts', 'source', 'anchor', 'local:std-a'], env());
  assert.equal(clear.code, 0, clear.stderr);
  assert.match(clear.stdout, /已解绑作者锚：local:std-a/);
  assert.match(clear.stdout, /作者锚：未绑定/);

  const rm = await run(['core/cli.ts', 'source', 'remove', 'local:std-a'], env());
  assert.equal(rm.code, 0, rm.stderr);
  assert.match(rm.stdout, /已删除来源：local:std-a/);
});

test('CLI source：内置条目不可删、非法来源被拒（错误文案可读）', async () => {
  const builtin = await run(['core/cli.ts', 'source', 'remove', 'local:default'], env());
  assert.notEqual(builtin.code, 0);
  assert.match(builtin.stderr, /内置来源不可删除/);

  const bad = await run(['core/cli.ts', 'source', 'add', 'Local:Bad'], env());
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /来源非法/);

  // 桶不存在时删除 ⇒ 明确报"没配过"，而不是静默成功
  const missing = await run(['core/cli.ts', 'source', 'remove', 'local:nope'], env());
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /源未配置|来源/);
});

test('CLI 子命令用法：没给/打错/help ⇒ 打用法且**不需要核心在线**', async () => {
  // 判别点①：用法是本地事实 —— 核心没起时也该看得到（原先第一行就握手 ⇒ 报"无法连接核心"）
  const deadPort = String(await freePort());
  for (const argv of [
    ['core/cli.ts', 'source'],
    ['core/cli.ts', 'source', 'help'],
    ['core/cli.ts', 'source', 'lst'],
    ['core/cli.ts', 'plugin', 'help'],
    ['core/cli.ts', 'plugin', 'lst'],
  ]) {
    const r = await run(argv, { SPC_PORT: deadPort });
    assert.equal(r.code, 0, `${argv.join(' ')} 应打印用法后正常退出：${r.stderr}`);
    assert.match(r.stdout, /用法：/, argv.join(' '));
    assert.doesNotMatch(r.stderr, /无法连接核心/, '打用法不该去连核心');
  }

  // 判别点②：子命令认得、只是**缺参数**时，报的是参数错误（不是静默打用法）
  const noOrigin = await run(['core/cli.ts', 'source', 'add'], env());
  assert.notEqual(noOrigin.code, 0);
  assert.match(noOrigin.stderr, /缺少来源/);
});

test('CLI plugin reanchor：先预检、非交互必须 --yes、搬完旧引用消失', async () => {
  // 桶必须先存在（⑥a 起"桶"就是 keyring 里的源条目）
  const made = await run(['core/cli.ts', 'source', 'add', 'local:tui-a'], env());
  assert.equal(made.code, 0, made.stderr);

  const installed = await run(['core/cli.ts', 'plugin', 'install', 'plugin/hello'], env());
  assert.equal(installed.code, 0, installed.stderr);
  const from = 'local:default/@xfy2412/hello';
  const to = 'local:tui-a/@xfy2412/hello';

  // 非交互（spawn 的 stdio 不是 TTY）且没给 --yes ⇒ 打计划，但**拒绝执行**
  const refused = await run(['core/cli.ts', 'plugin', 'reanchor', from, '--origin', 'local:tui-a'], env());
  assert.notEqual(refused.code, 0);
  assert.match(refused.stdout, /将搬迁 1 个插件/);
  assert.match(refused.stdout, /停机、搬完再重启/, '计划要说明它会停机重启');
  assert.match(refused.stderr, /不是交互终端/);

  const done = await run(['core/cli.ts', 'plugin', 'reanchor', from, '--origin', 'local:tui-a', '--yes'], env());
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /已搬迁：local:default\/@xfy2412\/hello → local:tui-a\/@xfy2412\/hello/);
  assert.match(done.stdout, /local:tui-a\/@xfy2412\/hello@0\.0\.1 \[running\]/);

  const list = await run(['core/cli.ts', 'plugin', 'list'], env());
  assert.doesNotMatch(list.stdout, /local:default\/@xfy2412\/hello/);
  assert.match(list.stdout, /local:tui-a\/@xfy2412\/hello/);
  const status = await run(['core/cli.ts', 'plugin', 'status', to], env());
  assert.equal(status.code, 0, status.stderr);

  // 搬不了的计划：逐条说清"为什么搬不了、该怎么办"，且**不进入确认**
  const missing = await run(['core/cli.ts', 'plugin', 'reanchor', to, '--origin', 'local:nope'], env());
  assert.notEqual(missing.code, 0);
  assert.match(missing.stdout, /不能执行/);
  assert.match(missing.stdout, /源未配置|来源非法/);
});

test('CLI plugin install：显式 --source 指向不存在的桶 ⇒ 拒（提示先建桶），不落记录', async () => {
  const r = await run(['core/cli.ts', 'plugin', 'install', 'plugin/hello', '--source', 'local:nope'], env());
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /源未配置|来源非法/);
  const list = await run(['core/cli.ts', 'plugin', 'list'], env());
  assert.doesNotMatch(list.stdout, /local:nope/);
});

test('CLI about：输出品牌与构建指纹（本地信息，无需 daemon）', async () => {
  const r = await run(['core/cli.ts', 'about'], env());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ServerPluginCore 0\.0\.0 \(spc.xfyweb\.cn\) build dev-\d{4}-\d{2}-\d{2}/);
});

test('CLI 未指定子命令：打印用法', async () => {
  const r = await run(['core/cli.ts'], env());
  assert.equal(r.code, 0);
  assert.match(r.stdout, /用法/);
});

test('daemon 未启动：错误提示清晰（非静默失败）', async () => {
  const deadPort = await freePort(); // 没有 daemon 在听这个端口
  const r = await run(['core/cli.ts', 'status'], { SPC_PORT: String(deadPort) });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /无法连接核心/);
});

test('daemon 以 root 运行被拒（fail-closed，仅 Linux 有效）', async () => {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return; // 非 root 环境跳过
  }
  const r = await run(['core/server.ts'], { SPC_PORT: String(await freePort()) });
  assert.match(r.stderr, /拒绝以 root 运行/);
});
