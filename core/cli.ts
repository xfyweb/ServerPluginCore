// spc CLI：ed25519 握手客户端（管理面，docs/management-channel.md）
// CLI 是本地化渲染点：HTTP 只回英文码，这里统一用 tError() 翻译（含服务端 detail.code）。
import { request } from 'node:http';
import { t, tError, type RenderableError } from './i18n';
import { verifyDaemon } from './handshake';
import { BRAND } from './version';

const PORT = Number(process.env.SPC_PORT ?? 18777);

/** HTTP 失败 → 优先渲染服务端 detail.code；无 detail 时回退到 CLI 本地文案 */
function httpFailure(status: number, body: unknown, fallbackKey: string): Error {
  const detail = (body as { detail?: RenderableError } | null | undefined)?.detail;
  if (detail && typeof detail.code === 'string') {
    return new Error(`${tError(detail)}（HTTP ${status}）`);
  }
  return new Error(t(fallbackKey, { code: status }));
}

function httpJson(method: string, path: string, token?: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: text });
          }
        });
      },
    );
    req.on('error', (e) => reject(new Error(t('cli.connect.fail', { msg: e.message }))));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 握手三步：验签 daemon → 换会话 token（docs/management-channel.md §3.2） */
async function acquireToken(): Promise<string> {
  // ① 拿 challenge + daemon 签名 + 公钥
  const hs = (await httpJson('GET', '/auth/handshake')) as {
    status: number;
    body: { challenge: string; signature: string; pubkey: string };
  };
  if (hs.status !== 200) throw httpFailure(hs.status, hs.body, 'cli.handshake.fail');

  // ② 验签：确认对面是真正的 daemon（防假冒）
  if (!verifyDaemon(hs.body.pubkey, hs.body.challenge, hs.body.signature)) {
    throw new Error(t('cli.handshake.verify.fail'));
  }

  // ③ 一次性 challenge 换短时会话 token
  const sess = (await httpJson('POST', '/auth/session', undefined, {
    challenge: hs.body.challenge,
  })) as { status: number; body: { token: string } };
  if (sess.status !== 200) throw httpFailure(sess.status, sess.body, 'cli.handshake.session.fail');
  return sess.body.token;
}

async function main() {
  const cmd = process.argv[2] ?? 'help';

  if (cmd === 'about') {
    console.log(BRAND);
    return;
  }

  if (cmd === 'status') {
    const token = await acquireToken();
    const r = (await httpJson('GET', '/api/status', token)) as {
      status: number;
      body: { ok: boolean; version: string; pid: number; platform: string; uptimeMs: number };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.status.fail');
    const s = r.body;
    console.log(
      t('cli.status.running', {
        version: s.version,
        pid: s.pid,
        platform: s.platform,
        uptime: (s.uptimeMs / 1000).toFixed(0),
      }),
    );
    return;
  }

  if (cmd === 'plugin' && process.argv[3] === 'list') {
    const token = await acquireToken();
    const r = (await httpJson('GET', '/api/plugins', token)) as {
      status: number;
      body: {
        plugins: {
          dir: string;
          valid: boolean;
          manifest: { id: string; name: string; version: { name: string } } | null;
        }[];
      };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.status.fail');
    const plugins = r.body.plugins;
    if (plugins.length === 0) {
      console.log(t('cli.plugin.list.empty'));
      return;
    }
    for (const p of plugins) {
      if (p.valid && p.manifest) {
        console.log(
          t('cli.plugin.list.item.valid', {
            dir: p.dir,
            id: p.manifest.id,
            version: p.manifest.version.name,
            name: p.manifest.name,
          }),
        );
      } else {
        console.log(t('cli.plugin.list.item.invalid', { dir: p.dir }));
      }
    }
    return;
  }

  console.log(t('cli.usage', { port: PORT }));
  console.log(BRAND);
}

main().catch((e) => {
  console.error(`[spc] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
