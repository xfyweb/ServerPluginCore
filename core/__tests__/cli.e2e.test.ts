// CLI 端到端测试：spawn daemon → 跑 spc 命令 → 断言输出
// 覆盖：status / plugin list / daemon 未启动时的错误提示
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
      cwd: root,
      env: { ...process.env, ...env },
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

before(async () => {
  port = await freePort();
  daemon = spawn(process.execPath, ['--import', 'tsx', 'core/server.ts'], {
    cwd: root,
    env: { ...process.env, SPC_PORT: String(port) },
  });
  // 等待 daemon 就绪（stdout 出现 listening）
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon 启动超时')), 10000);
    daemon!.stdout!.on('data', (d: Buffer) => {
      if (String(d).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    daemon!.on('exit', (code) => reject(new Error(`daemon 提前退出（code=${code}）`)));
  });
});

after(() => {
  daemon?.kill();
});

test('CLI status：握手 + 会话 + 状态查询 全链路', async () => {
  const r = await run(['core/cli.ts', 'status'], { SPC_PORT: String(port) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /核心运行中/);
  assert.match(r.stdout, /pid \d+/);
});

test('CLI plugin list：复用 schema 校验器返回插件列表', async () => {
  const r = await run(['core/cli.ts', 'plugin', 'list'], { SPC_PORT: String(port) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /@xfy2412\/sample@0\.0\.1/);
});


test('CLI about：输出品牌与构建指纹（本地信息，无需 daemon）', async () => {
  const r = await run(['core/cli.ts', 'about'], { SPC_PORT: String(port) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ServerPluginCore 0\.0\.0 \(spc\.xfyweb\.cn\) build dev-\d{4}-\d{2}-\d{2}/);
});

test('CLI 未指定子命令：打印用法', async () => {
  const r = await run(['core/cli.ts'], { SPC_PORT: String(port) });
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
