// `server.js` 是给**进程管理器**用的入口（pm2 / systemd / 计划任务 / 双击 `run.*`）：它们只会 `node server.js`
// —— 不认识 `.ts`，也不会给我们加 `--import tsx`。这条用例钉的就是那个契约本身：
// **裸 node 能把它跑起来 → 真的开始服务 → 能被停掉 → 端口会释放**。
//
// 为什么单独一条（而不是并进 `daemon.e2e.test.ts`）：那个文件验的是**守护进程的行为**，
// 这条验的是**入口能不能被裸 node 拉起**，判据完全不同（少一个 `tsImport`，行为全对但入口是死的）。
// ⚠️ 这里不测 `pnpm daemon`（那是开发入口、经 cmd/tsx CLI）；两个入口都该能起，但这条只认"裸 node"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'spc-entry-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const port = (srv.address() as { port: number }).port;
  srv.close();
  return port;
}

/** 起一个入口，等到它**真的开始服务**（任何 HTTP 状态码都算活着：401 = 服务在、只是没握手） */
async function bootAndProbe(argv: string[]): Promise<{ child: ChildProcess; out: () => string; up: boolean }> {
  const port = await freePort();
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: REPO,
    env: {
      ...process.env,
      SPC_PORT: String(port),
      // ⚠️ 状态与审计都要指到临时目录：不这么干会污染仓库状态（见 AGENTS.md §6）
      SPC_STATE_DIR: join(TMP, 'state'),
      SPC_AUDIT_DIR: join(TMP, 'audit'),
    },
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d));
  child.stderr?.on('data', (d: Buffer) => (out += d));

  let up = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      up = true;
      break;
    } catch {
      if (child.exitCode !== null) break; // 已经死了就别等了
      await sleep(200);
    }
  }
  // 端口释放：入口被停之后应当马上让出端口，否则重启会 EADDRINUSE
  const closed = new Promise<void>((ok) => child.on('close', () => ok()));
  if (child.exitCode === null) child.kill();
  const exited = await Promise.race([closed.then(() => true), sleep(8000).then(() => false)]);
  assert.equal(exited, true, `${argv.join(' ')} 被停之后 8 秒内没退出。输出：\n${out.slice(0, 1500)}`);

  let freed = false;
  for (let i = 0; i < 20 && !freed; i += 1) {
    try {
      const srv = createServer();
      srv.listen(port, '127.0.0.1');
      await once(srv, 'listening');
      srv.close();
      freed = true;
    } catch {
      await sleep(100);
    }
  }
  assert.equal(freed, true, `${argv.join(' ')} 停掉之后端口还没释放`);
  return { child, out: () => out, up };
}

test('run.bat / run.ps1：注释必须是纯 ASCII（否则会被当成命令执行）', () => {
  // 2026-10-13 实测踩到：`run.bat` 用 UTF-8 无 BOM 写中文注释，cmd.exe 按 **OEM 代码页**（本机 936）
  // 解码 ⇒ 乱码里连 `REM` 都被前一个字节吃掉 ⇒ cmd 把乱码**当命令执行**，屏幕上刷出
  // `'弽搴旓紝' 不是内部或外部命令`。Windows PowerShell 5.1 对**无 BOM 的 UTF-8 .ps1** 同样按 ANSI 处理。
  // ⇒ 这两个入口一律纯 ASCII（中文解释放 README：那是给人看的，不是给 cmd 解析的）。
  // `run.sh` 不在此列：POSIX shell 只把 `#` 之后当字节，没有代码页这一说。
  for (const name of ['run.bat', 'run.ps1']) {
    const bytes = readFileSync(join(REPO, name));
    const bad = [...bytes].filter((b) => b > 127).length;
    assert.equal(bad, 0, `${name} 里有 ${bad} 个非 ASCII 字节 ⇒ cmd/PowerShell 5.1 会解码错并当命令执行`);
  }
});

test('server.js：裸 node 能起守护进程、真的开始服务、能停能释放端口', async () => {
  const { up, out } = await bootAndProbe([process.execPath, 'server.js']);
  assert.equal(up, true, `server.js 没起来。输出：\n${out().slice(0, 1500)}`);
  // 守护进程**自己**打的横幅必须出现在**这个进程**的 stdout 上 —— 这才证明它是同进程加载的，
  // 而不是又 spawn 了一层（夹一层的话，pm2 记录到的 PID 就不是守护进程，信号也会打偏）
  assert.match(out(), /listening/, `server.js 应当是**同进程**加载守护进程（没看到它自己的横幅）：\n${out().slice(0, 1500)}`);
});

test(
  'run.sh：POSIX 入口等价于裸 node（exec ⇒ 不留中间层）',
  { skip: process.platform === 'win32' ? 'run.sh 是 POSIX 入口' : false },
  async () => {
    const { up, out } = await bootAndProbe(['sh', 'run.sh']);
    assert.equal(up, true, `run.sh 没起来。输出：\n${out().slice(0, 1500)}`);
    assert.match(out(), /listening/);
  },
);
