// 核心守护进程：HTTP 管理服务（127.0.0.1）+ ed25519 握手鉴权
// 设计见 docs/management-channel.md；插件管理端点见 docs/plugin-lifecycle-design.md §8
//
// 记录由 daemon 拥有：所有写操作（install/enable/disable/reload/grant/revoke/uninstall）
// 都必须经过这里——CLI 只是 HTTP 客户端，不直接碰 plugins.json。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { initAudit } from './audit';
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
    code === 'PLUGIN_RESERVED' ||
    code === 'PLUGIN_DISABLED' ||
    code === 'PLUGIN_ALREADY_RUNNING' ||
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

    // POST /api/plugins/install { dir, reserved?, grants?, start? }
    if (req.method === 'POST' && path === '/api/plugins/install') {
      const body = (await readBody(req)) as {
        dir?: unknown;
        reserved?: unknown;
        grants?: unknown;
        start?: unknown;
      };
      if (typeof body.dir !== 'string' || body.dir.length === 0) {
        sendError(res, 400, 'INVALID_ARGS', 'DIR_REQUIRED');
        return;
      }
      const view = await manager.install(body.dir, {
        reserved: body.reserved === true,
        grants: asStringArray(body.grants),
        start: body.start !== false,
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
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await manager.stopAll('shutdown');
  handshake.dispose();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
