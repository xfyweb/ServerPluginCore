// spc CLI：ed25519 握手客户端（管理面，docs/management-channel.md）
// CLI 是本地化渲染点：HTTP 只回英文码，这里统一用 tError() 翻译（含服务端 detail.code）。
//
// 职责边界（intent-capture.md §10）：CLI 只做**插件与主题管理**，不承载业务操作。
// 所有写操作经 daemon（记录由 daemon 拥有），CLI 不直接碰 plugins.json。
import { request } from 'node:http';
import { resolve } from 'node:path';
import { t, tError, type RenderableError } from './i18n';
import { verifyDaemon } from './handshake';
import { BRAND } from './version';

const PORT = Number(process.env.SPC_PORT ?? 18777);

/**
 * 插件视图（CLI 侧的**结构副本**：CLI 走 HTTP、不 import 核心类型）——
 * ⚠️ 改这里要同步 `core/plugin/manager.ts` 的 `PluginView`。
 * `ref` = **完整引用** `<origin>/<id>`（身份是 `(origin, id)`，同 id 不同来源是两个插件）。
 */
interface PluginView {
  ref: string;
  id: string;
  origin: string;
  dir: string;
  version: { code: number; name: string };
  type: string;
  enabled: boolean;
  state: string;
  grants: string[];
  capabilities: string[];
  lastError: { code: string; at: number } | null;
  restartAttempts: number;
  dataDir: string;
  configPath: string;
  reloadRequired: boolean;
}

/** HTTP 失败 → 优先渲染服务端 detail.code；无 detail 时回退到 CLI 本地文案 */
function httpFailure(status: number, body: unknown, fallbackKey: string): Error {
  const detail = (body as { detail?: RenderableError } | null | undefined)?.detail;
  if (detail && typeof detail.code === 'string') {
    return new Error(`${tError(detail)}（HTTP ${status}）`);
  }
  return new Error(t(fallbackKey, { code: status }));
}

function httpJson(method: string, path: string, token?: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve_, reject) => {
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
            resolve_({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
          } catch {
            resolve_({ status: res.statusCode ?? 0, body: text });
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

/** 插件 id 进 URL：`@xfy2412/hello` → `%40xfy2412%2Fhello` */
const idPath = (id: string): string => encodeURIComponent(id);

function printPlugin(p: PluginView): void {
  console.log(
    t('cli.plugin.line', {
      // 打**完整引用**（身份是 `(origin, id)`）：同 id 不同来源是两个插件，只打裸 id 分不清是谁，
      // 而且管理员要复制这个字符串去做后续命令
      id: p.ref,
      version: p.version.name,
      state: p.state,
      enabled: p.enabled ? t('cli.yes') : t('cli.no'),
      type: p.type,
    }),
  );
  if (p.grants.length > 0) console.log(t('cli.plugin.grants', { grants: p.grants.join(', ') }));
  if (p.capabilities.length > 0) console.log(t('cli.plugin.caps', { caps: p.capabilities.join(', ') }));
  if (p.lastError) console.log(t('cli.plugin.lastError', { code: p.lastError.code }));
  if (p.reloadRequired) console.log(t('cli.plugin.reloadRequired'));
}

async function pluginCommand(sub: string | undefined, args: string[]): Promise<void> {
  const token = await acquireToken();

  if (sub === 'list') {
    const r = (await httpJson('GET', '/api/plugins', token)) as {
      status: number;
      body: { plugins: PluginView[] };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.status.fail');
    if (r.body.plugins.length === 0) {
      console.log(t('cli.plugin.list.empty'));
      return;
    }
    for (const p of r.body.plugins) printPlugin(p);
    return;
  }

  if (sub === 'install') {
    const dir = args.find((a) => !a.startsWith('--'));
    if (!dir) throw new Error(t('cli.plugin.install.usage'));
    const grants: string[] = [];
    let source: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--grant' && args[i + 1]) grants.push(args[i + 1]);
      // `--source <来源>`：决定**归属**（身份是 `(origin, id)`，同 id 不同源是两个插件）；
      // 缺省 `local:default`
      if (args[i] === '--source' && args[i + 1]) source = args[i + 1];
    }
    const r = (await httpJson('POST', '/api/plugins/install', token, {
      dir: resolve(dir),
      grants,
      ...(source === undefined ? {} : { source }),
    })) as { status: number; body: { plugin: PluginView } };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.plugin.install.fail');
    console.log(t('cli.plugin.installed', { id: r.body.plugin.ref, dir: r.body.plugin.dir }));
    printPlugin(r.body.plugin);
    return;
  }

  if (sub === 'status') {
    const id = args[0];
    if (!id) throw new Error(t('cli.plugin.id.required'));
    const r = (await httpJson('GET', `/api/plugins/${idPath(id)}`, token)) as {
      status: number;
      body: { plugin: PluginView };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.plugin.status.fail');
    const p = r.body.plugin;
    printPlugin(p);
    console.log(t('cli.plugin.detail', { dir: p.dir, dataDir: p.dataDir, config: p.configPath }));
    return;
  }

  if (sub === 'grant' || sub === 'revoke') {
    const [id, ...points] = args;
    if (!id || points.length === 0) throw new Error(t('cli.plugin.grant.usage'));
    const r = (await httpJson('POST', `/api/plugins/${idPath(id)}/grants`, token, {
      add: sub === 'grant' ? points : [],
      remove: sub === 'revoke' ? points : [],
    })) as { status: number; body: { plugin: PluginView } };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.plugin.grant.fail');
    console.log(t(sub === 'grant' ? 'cli.plugin.granted' : 'cli.plugin.revoked', { id }));
    printPlugin(r.body.plugin);
    return;
  }

  if (sub === 'enable' || sub === 'disable' || sub === 'reload' || sub === 'uninstall') {
    const id = args[0];
    if (!id) throw new Error(t('cli.plugin.id.required'));
    const r = (await httpJson('POST', `/api/plugins/${idPath(id)}/${sub}`, token)) as {
      status: number;
      body: { plugin?: PluginView };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.plugin.op.fail');
    console.log(t(`cli.plugin.${sub}.done`, { id }));
    if (r.body.plugin) printPlugin(r.body.plugin);
    return;
  }

  console.log(t('cli.plugin.usage'));
}

async function main() {
  const cmd = process.argv[2] ?? 'help';
  const args = process.argv.slice(3);

  if (cmd === 'about') {
    console.log(BRAND);
    return;
  }

  if (cmd === 'status') {
    const token = await acquireToken();
    const r = (await httpJson('GET', '/api/status', token)) as {
      status: number;
      body: {
        ok: boolean;
        version: string;
        pid: number;
        platform: string;
        uptimeMs: number;
        plugins: { total: number; running: number };
      };
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
    console.log(t('cli.status.plugins', { total: s.plugins.total, running: s.plugins.running }));
    return;
  }

  if (cmd === 'daemon') {
    const sub = args[0];
    if (sub !== 'stop') {
      console.log(t('cli.daemon.usage'));
      return;
    }
    const token = await acquireToken();
    const r = (await httpJson('POST', '/api/daemon/shutdown', token)) as {
      status: number;
      body: { ok?: boolean; pid?: number };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.daemon.stop.fail');
    console.log(t('cli.daemon.stop.ok', { pid: String(r.body.pid ?? '?') }));
    return;
  }

  if (cmd === 'plugin') {
    await pluginCommand(args[0], args.slice(1));
    return;
  }

  console.log(t('cli.usage', { port: PORT }));
  console.log(BRAND);
}

main().catch((e) => {
  console.error(`[spc] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
