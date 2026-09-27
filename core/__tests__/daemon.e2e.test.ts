// 守护进程**停机契约**的端到端测试（2026-09-23）
//
// 为什么单独一个文件：停机是"进程怎么退、退成什么码"的契约，与插件功能无关；
// 而且它必须**真的起进程**才测得出来（今天要钉住的三件事都在进程边界上）：
//   ① **keep-alive 连接不该拖住停机** —— 以前 `server.close()` 等所有连接自然断开，
//      而 CLI 用的是全局 agent（Node ≥19 默认 keepAlive）⇒ 回调几秒不来、面板挂着时永不到来；
//   ② `spc daemon stop` 这条**命令行停机**通道要真的能用（Windows 上它还是唯一优雅的停法）；
//   ③ 插件卡住时必须**强退（124）**，不能无限等。
//
// 说明：**信号（SIGINT/SIGTERM）那条路径在本机 Windows 上没法真测** ——
// `child.kill('SIGINT')` 在 Windows 上实际是 TerminateProcess，信号处理函数不会被调用；
// 那一条只能在 Linux 上验（`systemd` 发的就是 SIGTERM）。这里测的是同一段 `shutdown()` 的 API 入口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Daemon {
  child: ChildProcess;
  port: number;
  state: string;
  stdout: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const port = (srv.address() as { port: number }).port;
  srv.close();
  return port;
}

/** 起一个隔离的 daemon（独立状态目录 + 独立端口），等它打印出监听端口 */
async function startDaemon(env: Record<string, string> = {}): Promise<Daemon> {
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), 'spc-daemon-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'core/server.ts'], {
    cwd: root,
    // ⚠️ `SPC_AUDIT_DIR` **显式钉到自己的 state 目录**：不然 `...process.env` 会把跑测环境里的
    // `SPC_AUDIT_DIR`（AGENTS.md 要求测试指向临时目录，很多人导出在环境里）继承给 daemon，
    // 审计就写到别处，而本文件读的是 `<state>/audit/` ⇒ 断言"0 条 core.shutdown"（踩过：只在我设了
    // 那个变量的 Linux 跑法上红，裸 `pnpm test` 是绿的 —— 一个只在特定环境复现的假 bug）。
    env: { ...process.env, SPC_PORT: String(port), SPC_STATE_DIR: state, SPC_AUDIT_DIR: join(state, 'audit'), ...env },
  });
  const d: Daemon = {
    child,
    port,
    state,
    stdout: '',
    exited: new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    }),
  };
  child.stdout!.on('data', (b: Buffer) => (d.stdout += String(b)));
  child.stderr!.on('data', (b: Buffer) => (d.stdout += String(b)));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon 启动超时：${d.stdout}`)), 20_000);
    const check = () => {
      if (d.stdout.includes(String(port))) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon 提前退出（code=${code}）：${d.stdout}`));
    });
  });
  return d;
}

/** 跑一次 CLI（同一个状态目录 = 同一个 daemon） */
function runCli(
  args: string[],
  state: string,
  port: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
      cwd: root,
      env: { ...process.env, SPC_STATE_DIR: state, SPC_PORT: String(port) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b));
    child.stderr.on('data', (b: Buffer) => (stderr += b));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function auditRows(state: string): Record<string, unknown>[] {
  const file = join(state, 'audit', 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function cleanup(d: Daemon): void {
  try {
    d.child.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
  try {
    rmSync(d.state, { recursive: true, force: true });
  } catch {
    /* Windows 上句柄未释放会 EPERM：尽力清理 */
  }
}

test('停机契约：`spc daemon stop` ⇒ 退出码 0 + 审计 core.shutdown（且不被 keep-alive 连接拖住）', async () => {
  const d = await startDaemon();
  try {
    // ① 在**测试进程**里挂一条 keep-alive 连接，并让它一直开着：
    //    这正是以前"Ctrl+C 退不掉"的根因（`server.close()` 在等它自然断开）。
    //    用**裸 TCP** 而不是 http.Agent：agent 会在响应结束后把空闲 socket 收进自己的池子、
    //    甚至按需回收，拿它当"连接还开着"的证据太脆；裸 socket 就是那条连接本身。
    const sock = connect(d.port, '127.0.0.1');
    await once(sock, 'connect');
    sock.write(
      'GET /auth/handshake HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n',
    );
    await once(sock, 'data'); // 拿到响应，但连接保持打开
    assert.equal(sock.destroyed, false, '连接应仍然活着');

    // ② 命令行停机
    const stopped = Date.now();
    const r = await runCli(['core/cli.ts', 'daemon', 'stop'], d.state, d.port);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /已停机/);

    // ③ daemon 自己退：**退出码 0**（契约），且不能因为那条连接而拖住
    const exit = await Promise.race([
      d.exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`daemon 未在 5s 内退出（keep-alive 拖住了）：${d.stdout}`)), 5000),
      ),
    ]);
    assert.equal(exit.code, 0, `停机应退 0，实际 ${exit.code}（stdout: ${d.stdout}）`);
    assert.match(d.stdout, /已停机/);
    assert.ok(Date.now() - stopped < 5000);

    // ④ 审计：`core.shutdown` 一条 ok，且用核心自己的 actor（不是某个插件）
    const rows = auditRows(d.state).filter((e) => e.method === 'core.shutdown');
    assert.equal(rows.length, 1, `应有且仅有一条 core.shutdown，实际 ${rows.length}`);
    assert.equal(rows[0].pluginId, '<core>');
    assert.equal(rows[0].result, 'ok');
    // ⑤ 那条空闲连接被核心**主动踢掉**（closeIdleConnections），而不是等它自己走
    assert.equal(sock.destroyed, true, '停机应主动断开空闲连接');

    sock.destroy();
  } finally {
    cleanup(d);
  }
});

test('停机契约：插件 stop 卡住 ⇒ 仍在**总预算**内收尾（不是 N × stopTimeoutMs）', async () => {
  // 总预算 300ms；插件自己的 stop 预算默认 3000ms。
  // 关键点：插件 stop 里的死循环会**同步阻塞宿主**，所以"全局超时定时器"根本轮不上 ——
  // 只有在进沙箱之前就把这一次的 stop 预算压低，停机时长才不随插件数线性增长。
  const d = await startDaemon({ SPC_SHUTDOWN_TIMEOUT_MS: '300' });
  try {
    const dir = join(d.state, 'slow-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(
        {
          schema: 2,
          id: '@spc/slow-stop',
          name: 'Slow Stop',
          version: { code: 1, name: '0.0.1' },
          runtime: { type: 'quickjs', esm: true },
          permissions: [{ name: 'fs.write.data' }],
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(dir, 'main.ts'),
      `export function init(){}
       export function stop(){ for(;;){} }`,
      'utf8',
    );
    const installed = await runCli(['core/cli.ts', 'plugin', 'install', dir], d.state, d.port);
    assert.equal(installed.code, 0, installed.stderr);

    const r = await runCli(['core/cli.ts', 'daemon', 'stop'], d.state, d.port);
    assert.equal(r.code, 0, r.stderr); // API 一侧仍成功应答（停机是异步进行的）
    // ⚠️ 计时从**这一步之后**开始：上面 `runCli` 的开销是 `node --import tsx` 的**启动**（0.6–1.5s，
    // 随平台与负载变），跟"停机总预算"无关 —— 原来把起点放在它之前，Linux 上必然顶到 2s 上限而误报。
    const started = Date.now();

    const exit = await Promise.race([
      d.exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`daemon 未退出：${d.stdout}`)), 8000),
      ),
    ]);
    const elapsed = Date.now() - started;
    // 预算内收尾：要么被硬超时兜住（124），要么压着预算优雅收完（0）——**不允许**是"等了 3 秒插件的 stop 预算"
    assert.ok(
      exit.code === 0 || exit.code === 124,
      `应退 0（预算内收完）或 124（硬超时兜底），实际 ${exit.code}（stdout: ${d.stdout}）`,
    );
    assert.ok(elapsed < 2000, `停机应在总预算量级内完成，实际 ${elapsed}ms（stdout: ${d.stdout}）`);

    const rows = auditRows(d.state).filter((e) => e.method === 'core.shutdown');
    assert.equal(rows.length, 1, '停机必须有且仅有一条 core.shutdown 审计');
  } finally {
    cleanup(d);
  }
});
