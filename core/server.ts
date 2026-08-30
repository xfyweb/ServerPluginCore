// 核心守护进程：HTTP 管理服务（127.0.0.1）+ ed25519 握手鉴权
// 设计见 docs/management-channel.md
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest } from '../sdk/validate';
import { t } from './i18n';
import { HandshakeServer } from './handshake';

const PORT = Number(process.env.SPC_PORT ?? 18777);
const pluginsDir = join(import.meta.dirname, '..', 'plugin');

// 非 root fail-closed（ADR-004）：daemon 拒绝以 root 运行
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error(t('daemon.root.deny'));
  process.exit(1);
}

const handshake = new HandshakeServer();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
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

/** 扫描插件目录：返回 manifest + 校验结果（复用 sdk schema 单一事实源） */
function listPlugins() {
  if (!existsSync(pluginsDir)) return [];
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const manifestPath = join(pluginsDir, d.name, 'manifest.json');
      if (!existsSync(manifestPath)) return null;
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const check = validateManifest(raw);
      return {
        dir: d.name,
        manifest: check.ok ? raw : null,
        valid: check.ok,
        errors: check.errors,
      };
    })
    .filter(Boolean);
}

/** Bearer token 校验中间件（/auth/* 除外） */
function requireAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return handshake.isValidToken(token);
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
        sendJson(res, 400, { error: 'INVALID_ARGS', message: 'challenge required' });
        return;
      }
      const session = handshake.openSession(body.challenge);
      if (!session) {
        sendJson(res, 403, { error: 'CHALLENGE_USED', message: 'challenge 已使用或无效' });
        return;
      }
      sendJson(res, 200, session);
      return;
    }

    // 其余端点需会话 token
    if (!requireAuth(req)) {
      sendJson(res, 401, { error: 'UNAUTHORIZED', message: t('server.unauthorized') });
      return;
    }

    // /api/status
    if (req.method === 'GET' && path === '/api/status') {
      sendJson(res, 200, {
        ok: true,
        version: '0.0.0',
        pid: process.pid,
        platform: process.platform,
        uptimeMs: process.uptime() * 1000,
      });
      return;
    }

    // /api/plugins
    if (req.method === 'GET' && path === '/api/plugins') {
      sendJson(res, 200, { plugins: listPlugins() });
      return;
    }

    sendJson(res, 404, { error: 'NOT_FOUND', message: t('server.notfound', { path }) });
  } catch (e) {
    sendJson(res, 500, { error: 'INTERNAL', message: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(t('daemon.listen', { port: PORT, pid: process.pid }));
  console.log(t('daemon.key', { key: handshake.publicKeyB64.slice(0, 24) }));
});

process.on('SIGINT', () => {
  handshake.dispose();
  server.close(() => process.exit(0));
});
