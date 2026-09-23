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
  assert.match(revoked.stdout, /⚠ 授权\/配置已变更，需要 reload 才生效/);

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
