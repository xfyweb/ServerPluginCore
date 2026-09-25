// 核心守护进程：HTTP 管理服务（127.0.0.1）+ ed25519 握手鉴权
// 设计见 docs/management-channel.md；插件管理端点见 docs/plugin-lifecycle-design.md §8
//
// 记录由 daemon 拥有：所有写操作（install/enable/disable/reload/grant/revoke/uninstall）
// 都必须经过这里——CLI 只是 HTTP 客户端，不直接碰 plugins.json。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { audit, digest, digestParams, flushAudit, initAudit } from './audit';
import { t } from './i18n';
import { toErrorShape } from './errors';
import { HandshakeServer } from './handshake';
import { manager } from './plugin/manager';
import { BRAND, VERSION } from './version';

const PORT = Number(process.env.SPC_PORT ?? 18777);

// 非 root fail-closed（ADR-004）：daemon 拒绝以 root 运行
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error(t('daemon.root.deny'));
  process.exit(1);
}

// 审计链路启动探测（写不了就退出）：**必须早于任何插件装载**，
// 否则插件调用会写进内存缓冲，运维以为审计正常、实际读不到。
initAudit();

const handshake = new HandshakeServer();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * 错误响应：**只传英文码**（`error` 顶层码 + `detail.code/params`），不承载本地化文本。
 * 渲染发生在客户端：CLI 用 tError()，面板自行请求 locale 文件在前端渲染。
 */
function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  code: string,
  params?: Record<string, string>,
): void {
  sendJson(res, status, { error, detail: params ? { code, params } : { code } });
}

/** SpcError → HTTP 状态码（只做粗分类，具体原因靠 detail.code） */
function httpStatusFor(code: string): number {
  if (code === 'PLUGIN_NOT_FOUND') return 404;
  if (code === 'UNAUTHENTICATED' || code === 'PERMISSION_DENIED' || code === 'NOT_GRANTED') return 403;
  if (
    code === 'PLUGIN_DISABLED' ||
    code === 'PLUGIN_ALREADY_RUNNING' ||
    code === 'PLUGIN_BUSY' ||
    code === 'PLUGIN_EXPORT_INVALID'
  ) {
    return 409;
  }
  if (
    code === 'PLUGIN_MANIFEST_INVALID' ||
    code === 'PLUGIN_CONFIG_INVALID' ||
    code === 'CONFIG_INVALID' ||
    code === 'RECORDS_INVALID' ||
    code === 'INVALID_ARGS' ||
    code === 'PLUGIN_DIR_MISSING'
  ) {
    return 400;
  }
  return 500;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Bearer token 校验中间件（/auth/* 除外） */
function requireAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return handshake.isValidToken(token);
}

/** `/api/plugins/<encoded-id>/<action>`：id 里有 `@` 与 `/`，所以按**原始路径**切、再解码 */
const PLUGIN_ACTION = /^\/api\/plugins\/(.+?)\/(enable|disable|reload|uninstall|grants)$/;
const PLUGIN_ONE = /^\/api\/plugins\/(.+)$/;

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // ① 握手：返回 challenge + daemon 签名 + 公钥
    if (req.method === 'GET' && path === '/auth/handshake') {
      const { challenge, signature } = handshake.issueChallenge();
      sendJson(res, 200, { challenge, signature, pubkey: handshake.publicKeyB64 });
      return;
    }

    // ③ 换会话：一次性 challenge → 短时 token
    if (req.method === 'POST' && path === '/auth/session') {
      const body = (await readBody(req)) as { challenge?: string };
      if (typeof body.challenge !== 'string') {
        sendError(res, 400, 'INVALID_ARGS', 'CHALLENGE_REQUIRED');
        return;
      }
      const session = handshake.openSession(body.challenge);
      if (!session) {
        sendError(res, 403, 'INVALID_ARGS', 'CHALLENGE_USED');
        return;
      }
      sendJson(res, 200, session);
      return;
    }

    // 其余端点需会话 token
    if (!requireAuth(req)) {
      sendError(res, 401, 'PERMISSION_DENIED', 'UNAUTHENTICATED');
      return;
    }

    // POST /api/daemon/shutdown —— **优雅停机**（管理员不必 Ctrl+C；Windows 上更是唯一优雅的停法，
    // 因为 Ctrl+C 只对前台控制台有效、`taskkill` 是硬杀）。先回包再停机：CLI 要拿得到答复。
    if (req.method === 'POST' && path === '/api/daemon/shutdown') {
      sendJson(res, 200, { ok: true, pid: process.pid });
      setImmediate(() => void shutdown('request'));
      return;
    }

    // /api/status
    if (req.method === 'GET' && path === '/api/status') {
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        brand: BRAND,
        pid: process.pid,
        platform: process.platform,
        uptimeMs: process.uptime() * 1000,
        plugins: { total: manager.list().length, running: manager.runningCount() },
      });
      return;
    }

    // /api/plugins
    if (req.method === 'GET' && path === '/api/plugins') {
      sendJson(res, 200, { plugins: manager.list() });
      return;
    }

    // POST /api/plugins/install { dir, grants?, start?, source?, acceptKeyChange? }
    if (req.method === 'POST' && path === '/api/plugins/install') {
      const body = (await readBody(req)) as {
        dir?: unknown;
        grants?: unknown;
        start?: unknown;
        source?: unknown;
        acceptKeyChange?: unknown;
      };
      if (typeof body.dir !== 'string' || body.dir.length === 0) {
        sendError(res, 400, 'INVALID_ARGS', 'DIR_REQUIRED');
        return;
      }
      // `source` 决定**归属**（身份是 `(origin, id)`，同 id 不同来源是两个插件）；缺省 `local:default`
      // `acceptKeyChange` = 管理员**显式接受换钥**（否则同 (origin,id) 换钥一律拒装）
      const view = await manager.install(body.dir, {
        grants: asStringArray(body.grants),
        start: body.start !== false,
        acceptKeyChange: body.acceptKeyChange === true,
        ...(typeof body.source === 'string' ? { source: body.source } : {}),
      });
      sendJson(res, 200, { plugin: view });
      return;
    }

    // /api/plugins/<id>/<action>
    const action = PLUGIN_ACTION.exec(path);
    if (action) {
      const pluginId = decodeURIComponent(action[1]);
      const verb = action[2];
      if (verb === 'grants') {
        if (req.method !== 'POST') {
          sendError(res, 405, 'INVALID_ARGS', 'METHOD_NOT_ALLOWED');
          return;
        }
        const body = (await readBody(req)) as { add?: unknown; remove?: unknown };
        const add = asStringArray(body.add);
        const remove = asStringArray(body.remove);
        let view = manager.status(pluginId);
        if (add.length > 0) view = manager.grant(pluginId, add);
        if (remove.length > 0) view = manager.revoke(pluginId, remove);
        sendJson(res, 200, { plugin: view });
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'INVALID_ARGS', 'METHOD_NOT_ALLOWED');
        return;
      }
      if (verb === 'enable') {
        sendJson(res, 200, { plugin: await manager.enable(pluginId) });
        return;
      }
      if (verb === 'disable') {
        sendJson(res, 200, { plugin: await manager.disable(pluginId) });
        return;
      }
      if (verb === 'reload') {
        sendJson(res, 200, { plugin: await manager.reload(pluginId) });
        return;
      }
      await manager.uninstall(pluginId);
      sendJson(res, 200, { ok: true, pluginId });
      return;
    }

    // GET /api/plugins/<id>
    const one = PLUGIN_ONE.exec(path);
    if (one && req.method === 'GET') {
      sendJson(res, 200, { plugin: manager.status(decodeURIComponent(one[1])) });
      return;
    }

    sendError(res, 404, 'NOT_FOUND', 'ROUTE_NOT_FOUND', { path });
  } catch (e) {
    const shape = toErrorShape(e);
    const code = shape?.code ?? 'UNEXPECTED';
    sendError(res, httpStatusFor(code), code === 'UNEXPECTED' ? 'INTERNAL' : 'PLUGIN_OP_FAILED', code, shape?.params);
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[daemon] ${BRAND}`);
  console.log(t('daemon.listen', { port: PORT, pid: process.pid }));
  console.log(t('daemon.key', { key: handshake.publicKeyB64.slice(0, 24) }));
  // 启动时自动装载 enabled 的插件（单插件失败不影响其它插件，逐个记 failed）
  const rows = await manager.startAll();
  const running = rows.filter((p) => p.state === 'running').length;
  const failed = rows.filter((p) => p.state === 'failed').length;
  console.log(t('daemon.plugins', { total: String(rows.length), running: String(running), failed: String(failed) }));
});

let shuttingDown = false;
/** 停机超时：到点强退。插件卡住或连接收不掉时也必须退出——一个插件不该拖住核心停机 */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SPC_SHUTDOWN_TIMEOUT_MS ?? 10_000);
/**
 * 留给"停机收尾"的余量：插件预算用完后还要落审计、关连接、flush 缓冲，然后才轮到硬超时兜底。
 * 取 min(500ms, 总预算/4)：总预算被调得很小时（测试），余量也跟着缩，不然插件预算会变成 0。
 */
const SHUTDOWN_GRACE_MS = Math.min(500, Math.floor(SHUTDOWN_TIMEOUT_MS / 4));

/** 核心自身的审计条目用这个 pluginId（不可能与插件 id 撞：插件 id 形如 `@user/name`） */
const CORE_ACTOR = '<core>';

function auditShutdown(reason: string, result: 'ok' | 'error', started: number, detail?: string): void {
  audit({
    ts: Date.now(),
    pluginId: CORE_ACTOR,
    method: 'core.shutdown',
    paramsDigest: digestParams(detail === undefined ? { reason } : { reason, detail }) ?? digest(reason),
    result,
    durationMs: Date.now() - started,
  });
}

/** 统一出口：显式退出码 + **flush 审计缓冲**（否则运行期攒下的条目随进程消失） */
function exitNow(code: number, why: string): never {
  const flushed = flushAudit();
  if (flushed < 0) console.error(t('daemon.shutdown.audit_pending', { count: String(-flushed) }));
  if (code !== 0) console.error(t('daemon.shutdown.forced', { why, code: String(code) }));
  process.exitCode = code;
  process.exit(code);
}

/**
 * 优雅停机。三件事按顺序做，缺一不可：
 *
 *   ① **不再接新请求 + 主动踢掉空闲连接**（`closeIdleConnections`）。只 `server.close()` 是**不够**的：
 *      它会等所有连接自然断开，而 CLI 用的是全局 agent（Node ≥19 默认 `keepAlive: true`）
 *      ⇒ 回调要等几秒；面板/长连接挂着时更是**永不到来**。
 *      ⚠️ 这就是"Ctrl+C 退不掉、只能强杀（255）"的根因，不是"没接信号"。
 *   ② 停插件（`manager.stopAll('shutdown')`：stop → 撤销登记 → dispose；单个插件抛错/超时都继续）。
 *   ③ 落一条 `core.shutdown` 审计 + flush 缓冲，然后按契约退出。
 *
 * **退出码契约**：优雅停完 = `0`；第二次信号（用户催了）= `130`（128+SIGINT 惯例）；
 * 超时 = `124`（timeout 惯例）；停机过程自身出错 = `1`。
 */
async function shutdown(reason: 'SIGINT' | 'SIGTERM' | 'request'): Promise<void> {
  if (shuttingDown) {
    // 第二次：用户在催（Ctrl+C 连按 / 脚本重发）⇒ 立刻走。
    // 以前这里是 `return`（空转）——那等于"第二次 Ctrl+C 什么也不做"，只剩强杀一条路。
    exitNow(130, 'second-signal');
  }
  shuttingDown = true;
  const started = Date.now();
  console.log(t('daemon.shutdown.begin', { reason }));
  // 硬超时：到点记一笔 error(timeout) 再走——**必须能强退**，否则一个卡住的插件就能让核心停不下来
  setTimeout(() => {
    auditShutdown(reason, 'error', started, 'timeout');
    exitNow(124, 'timeout');
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    server.close();
    server.closeIdleConnections();
    // 停插件时把**整场停机的总预算**一起交下去：每个插件的 stop 预算被压成
    // `min(它自己的 stopTimeoutMs, 剩余总预算)`。少了这一条，N 个卡住的插件就是 N × stopTimeoutMs
    // ——而插件 stop 里的死循环会**同步阻塞宿主**，连上面那个硬超时定时器都轮不上（实测 3s 才回来）。
    await manager.stopAll('shutdown', {
      budgetMs: Math.max(0, SHUTDOWN_TIMEOUT_MS - SHUTDOWN_GRACE_MS),
    });
  } catch (err) {
    auditShutdown(reason, 'error', started, toErrorShape(err)?.code ?? 'INTERNAL');
    exitNow(1, 'shutdown-error');
  }
  auditShutdown(reason, 'ok', started);
  handshake.dispose();
  console.log(t('daemon.shutdown.done', { ms: String(Date.now() - started) }));
  exitNow(0, 'graceful');
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
