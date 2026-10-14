// 核心守护进程：HTTP 管理服务（127.0.0.1）+ ed25519 握手鉴权
// 设计见 docs/management-channel.md；插件管理端点见 docs/plugin-lifecycle-design.md §8
//
// 记录由 daemon 拥有：所有写操作（install/enable/disable/reload/grant/revoke/uninstall）
// 都必须经过这里——CLI 只是 HTTP 客户端，不直接碰 plugins.json。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  audit,
  coreActor,
  digest,
  digestParams,
  flushAudit,
  initAudit,
  readAuditTail,
  enterChannel,
  scheduleAuditMidnight,
    type AuditActorKind,
    type AuditVia,
  } from './audit';
import { attachConsole, parseInstallArgs, shouldAttachConsole } from './console';
import { asLogLevel, logs } from './logs';
import { pluginDetailLines } from './plugin/render';import { t } from './i18n';
import { toErrorShape } from './errors';
import { HandshakeServer } from './handshake';
import { manager } from './plugin/manager';
import {
  addSource,
  listSources,
  removeSource,
  seedBuiltinSources,
  setSourceAlias,
  setSourceAnchor,
  setSourceEnabled,
} from './sources/manage';
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
// 跨日换文件 + 打包昨天的审计（整夜空闲的守护进程也得换，所以不能只靠写路径的惰性检查）
scheduleAuditMidnight();

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
  // 源：没配过 = 找不到；"有插件归属"与"内置条目"是冲突（409）；拉不到公钥是上游的问题（502）
  if (code === 'SOURCE_NOT_CONFIGURED') return 404;
  if (code === 'SOURCE_IN_USE' || code === 'SOURCE_ALREADY_EXISTS') return 409;
  if (code === 'SOURCE_KEY_FETCH_FAILED') return 502;
  if (code === 'UNAUTHENTICATED' || code === 'PERMISSION_DENIED' || code === 'NOT_GRANTED') return 403;
  if (code === 'PLUGIN_DISABLED' ||
    code === 'PLUGIN_ALREADY_RUNNING' ||
    code === 'PLUGIN_BUSY' ||
    code === 'PLUGIN_EXPORT_INVALID' ||
    // 换源：冲突与被依赖都是"当前状态不允许"，不是参数错（400）也不是内部错（500）
    code === 'PLUGIN_IN_USE' ||
    code === 'PLUGIN_REANCHOR_CONFLICT' ||
    code === 'PLUGIN_ANCHOR_MISMATCH'
  ) {
    return 409;
  }
  if (
    code === 'PLUGIN_MANIFEST_INVALID' ||
    code === 'PLUGIN_CONFIG_INVALID' ||
    code === 'CONFIG_INVALID' ||
    code === 'RECORDS_INVALID' ||
    code === 'KEYRING_INVALID' ||
    code === 'SOURCE_ORIGIN_INVALID' ||
    code === 'SOURCE_ANCHOR_NOT_ALLOWED' ||
    code === 'SOURCE_PUB_NOT_APPLICABLE' ||
    code === 'SOURCE_KIND_IMMUTABLE' ||
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

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const server = createServer(async (req, res) => {
  // 管理通道 = HTTP（`spc` 命令 / 面板）：这一整段异步上下文都算 `cli` 通道，
  // 于是里面的管理动作条目自动带 `via: cli`（P3 接面板时在这里分流即可）
  enterChannel('cli');
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

    /**
     * GET /api/logs?plugin=&level=&limit=&since= —— 插件日志（内存环形，见 `core/logs.ts`）
     *
     * `plugin` 支持**完整引用或裸 id**：解析用 `manager.status()`（与其它管理命令**同一套**解析），
     * 于是"没有这个插件"与"裸 id 有多义"报的是同一批码，CLI 不必为读面另造一套说法。
     */
    if (req.method === 'GET' && path === '/api/logs') {
      const q = url.searchParams;
      const ref = q.get('plugin') === null ? undefined : manager.status(q.get('plugin')!).ref;
      const levelRaw = q.get('level');
      const level = levelRaw === null ? undefined : asLogLevel(levelRaw);
      if (levelRaw !== null && level === undefined) {
        sendError(res, 400, 'INVALID_ARGS', 'LOG_LEVEL_INVALID', { level: levelRaw });
        return;
      }
      const limitRaw = q.get('limit');
      const sinceRaw = q.get('since');
      const result = logs.query({
        ...(ref === undefined ? {} : { ref }),
        ...(level === undefined ? {} : { level }),
        ...(limitRaw === null ? {} : { limit: Number(limitRaw) }),
        // 日志的游标是**数字 seq**（内存环形，见 `core/logs.ts`）；审计的游标是字符串 `"<日期>#<seq>"` —— 两者别混
        ...(sinceRaw === null ? {} : { since: Number(sinceRaw) }),
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    /**
     * GET /api/audit?plugin=&method=&result=&limit= —— 审计**尾部读**（见 `core/audit.ts` 的 `readAuditTail`）
     *
     * 为什么由守护进程读文件、而不是让 CLI 自己找状态目录：状态目录是守护进程的事实（`SPC_STATE_DIR`），
     * 而且"只读末尾一段"这条约束只有一处实现才不会两边不一致。
     */
    if (req.method === 'GET' && path === '/api/audit') {
      const q = url.searchParams;
      const ref = q.get('plugin') === null ? undefined : manager.status(q.get('plugin')!).ref;
      const method = q.get('method') ?? undefined;
      const resultRaw = q.get('result');
      // `tail` 是最早写在契约里的参数名（`management-channel.md` §4 那行），`limit` 是后来统一的叫法：
      // **两个都认**（契约只增不改），`tail` 优先。
      const limitRaw = q.get('tail') ?? q.get('limit');
      // `since` = 续读游标 `"<日期>#<seq>"`（`spc audit tail -f` 用它）
      const sinceRaw = q.get('since');
      // `actor` / `via` = 按发起者与通道过滤（"插件自己干的"还是"管理员在 CLI 上干的"）
      const actorRaw = q.get('actor');
      const viaRaw = q.get('via');
      if (resultRaw !== null && resultRaw !== 'ok' && resultRaw !== 'denied' && resultRaw !== 'error') {
        sendError(res, 400, 'INVALID_ARGS', 'AUDIT_RESULT_INVALID', { result: resultRaw });
        return;
      }
      const tail = readAuditTail({
        ...(ref === undefined ? {} : { plugin: ref }),
        ...(method === undefined ? {} : { method }),
        ...(resultRaw === null ? {} : { result: resultRaw }),
        ...(limitRaw === null ? {} : { limit: Number(limitRaw) }),
        ...(sinceRaw === null ? {} : { since: sinceRaw }),
        ...(actorRaw === null ? {} : { actor: actorRaw as AuditActorKind }),
        ...(viaRaw === null ? {} : { via: viaRaw as AuditVia }),
        });
        sendJson(res, 200, { ok: true, ...tail });
      return;
    }

    // POST /api/plugins/install { dir | file, grants?, start?, source?, acceptKeyChange? }
    // `dir` = 源码**就地**安装；`file` = `.spc` 装进**托管副本**（§10.6 的两条入口，同一条管线）
    if (req.method === 'POST' && path === '/api/plugins/install') {
      const body = (await readBody(req)) as {
        dir?: unknown;
        file?: unknown;
        grants?: unknown;
        start?: unknown;
        source?: unknown;
        acceptKeyChange?: unknown;
      };
      const hasDir = typeof body.dir === 'string' && body.dir.length > 0;
      const hasFile = typeof body.file === 'string' && body.file.length > 0;
      // 二选一（都给 = 说不清装哪个 ⇒ 拒；都不给 = 没说要装什么 ⇒ 拒）
      if (hasDir && hasFile) {
        sendError(res, 400, 'INVALID_ARGS', 'DIR_AND_FILE');
        return;
      }
      if (!hasDir && !hasFile) {
        sendError(res, 400, 'INVALID_ARGS', 'DIR_OR_FILE_REQUIRED');
        return;
      }
      // `source` 决定**归属**（身份是 `(origin, id)`，同 id 不同来源是两个插件）；缺省 `local:default`
      // `acceptKeyChange` = 管理员**显式接受换钥**（否则同 (origin,id) 换钥一律拒装）
      const installOpts = {
        grants: asStringArray(body.grants),
        start: body.start !== false,
        acceptKeyChange: body.acceptKeyChange === true,
        ...(typeof body.source === 'string' ? { source: body.source } : {}),
      };
      const view = hasFile
        ? await manager.installPackage(body.file as string, installOpts)
        : await manager.install(body.dir as string, installOpts);
      sendJson(res, 200, {
        plugin: view,
        // promote 建议（§3bis）：装完之后"这一组该不该单独成桶"由核心算好，CLI/面板只负责渲染
        promote: manager.promoteSuggestion(view.ref) ?? null,
      });
      return;
    }

    // POST /api/plugins/reanchor[/plan] { refs, origin } —— 换源（批量、原子）
    // `plan` 是**只读预检**：不改任何东西，返回"这一搬会发生什么"；执行会在锁内重算一遍（TOCTOU）。
    // refs 走 body 而不是路径：完整引用里有 `@` 与 `/`，塞进 URL 只会自找编码麻烦。
    if (req.method === 'POST' && (path === '/api/plugins/reanchor' || path === '/api/plugins/reanchor/plan')) {
      const body = (await readBody(req)) as { refs?: unknown; origin?: unknown };
      const refs = asStringArray(body.refs);
      const origin = asString(body.origin);
      if (refs.length === 0) {
        sendError(res, 400, 'INVALID_ARGS', 'REFS_REQUIRED');
        return;
      }
      if (!origin) {
        sendError(res, 400, 'INVALID_ARGS', 'SOURCE_ORIGIN_REQUIRED');
        return;
      }
      if (path.endsWith('/plan')) {
        sendJson(res, 200, { plan: manager.planReanchor(refs, origin) });
        return;
      }
      const result = await manager.reanchor(refs, origin);
      sendJson(res, 200, {
        plan: result.plan,
        moved: result.moved,
        plugins: result.views,
        failedToStart: result.failedToStart,
      });
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
      // `ref` = **解析后的完整引用**（`pluginId` 是请求里那个串）：管理命令允许传裸 id，
      // 调用方要能把"到底卸的是哪一个来源"打出来（2026-10-13 手工验收指出回显输入串没法复核）
      const { ref } = await manager.uninstall(pluginId);
      sendJson(res, 200, { ok: true, pluginId, ref });
      return;
    }

    // GET /api/plugins/<id>
    const one = PLUGIN_ONE.exec(path);
    if (one && req.method === 'GET') {
      sendJson(res, 200, { plugin: manager.status(decodeURIComponent(one[1])) });
      return;
    }

    // ---- 源（keyring）：`docs/plugin-signature-design.md` §5 ----
    // 与插件管理同款：**HTTP 只回英文码与结构**，本地化文案由 CLI / 面板渲染。
    if (path === '/api/sources' && req.method === 'GET') {
      sendJson(res, 200, { sources: listSources() });
      return;
    }
    if (path.startsWith('/api/sources/') && req.method === 'POST') {
      const verb = path.slice('/api/sources/'.length);
      const body = (await readBody(req)) as Record<string, unknown>;
      const origin = asString(body.origin);
      if (!origin) {
        sendError(res, 400, 'INVALID_ARGS', 'SOURCE_ORIGIN_REQUIRED');
        return;
      }
      if (verb === 'add') {
        // 市场源不带 `pub` ⇒ 远程 TOFU 拉取状态文档（`core/sources/manage.ts` 的 addSource）
        const view = await addSource({
          origin,
          pub: asString(body.pub),
          alias: asString(body.alias),
          anchorPub: asString(body.anchorPub),
        });
        sendJson(res, 200, { source: view });
        return;
      }
      if (verb === 'remove') {
        removeSource(origin);
        sendJson(res, 200, { ok: true, origin });
        return;
      }
      if (verb === 'enable' || verb === 'disable') {
        sendJson(res, 200, { source: setSourceEnabled(origin, verb === 'enable') });
        return;
      }
      if (verb === 'alias') {
        const alias = asString(body.alias);
        if (alias === undefined) {
          sendError(res, 400, 'INVALID_ARGS', 'ALIAS_REQUIRED');
          return;
        }
        sendJson(res, 200, { source: setSourceAlias(origin, alias) });
        return;
      }
      if (verb === 'anchor') {
        // `pub` 缺省或显式 null ⇒ **解绑锚**（解绑是正当动作，不该逼管理员写魔法值）
        const pub = body.pub === undefined || body.pub === null ? null : asString(body.pub);
        if (pub === undefined) {
          sendError(res, 400, 'INVALID_ARGS', 'PUB_MUST_BE_STRING_OR_NULL');
          return;
        }
        const change = setSourceAnchor(origin, pub);
        // `staleCount` = 仍按旧锚记录的已装插件数（改锚**不追溯**，这个数要报给管理员）
        sendJson(res, 200, { source: change.view, staleCount: change.staleCount });
        return;
      }
      sendError(res, 404, 'NOT_FOUND', 'ROUTE_NOT_FOUND', { path });
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
  // 内置源条目（官方市场 + 杂桶 `local:default`）**先于任何安装/更新**播种：桶是**归属**，
  // 先有桶才谈得上"安装默认落进作者的桶"（docs/plugin-signature-design.md §3bis）。
  // 读不进来即启动失败 —— **不静默降级成空 keyring**：那会把"没配过源"与"源丢了"混成一件事，
  // 与 `AUTHORS_INVALID` 同一条 fail-closed 口径。
  try {
    seedBuiltinSources();
  } catch (e) {
    const shape = toErrorShape(e);
    console.error(`[daemon] keyring: ${shape?.code ?? 'INTERNAL'} ${JSON.stringify(shape?.params ?? {})}`);
    process.exit(1);
  }
  // 启动时自动装载 enabled 的插件（单插件失败不影响其它插件，逐个记 failed）
  const rows = await manager.startAll();
  const running = rows.filter((p) => p.state === 'running').length;
  const failed = rows.filter((p) => p.state === 'failed').length;
  console.log(t('daemon.plugins', { total: String(rows.length), running: String(running), failed: String(failed) }));

  /**
   * **前台控制台**：只在真终端里挂（`shouldAttachConsole` 只认 TTY）——
   * 服务模式（pm2 / systemd / 管道）下连 stdin 都不碰，免得 EOF 变成悬案。
   *
   * 命令刻意的少：`help` / `status` / `list` / `stop`。会改插件状态的动词不进这里（那是管理面 + 审计的职责），
   * 而 `stop` 走的就是**下面那个 `shutdown()`** —— 与 `spc daemon stop`（reason=`request`）和信号同一条路。
   */
  if (shouldAttachConsole(process.stdin)) {
    attachConsole(
      { input: process.stdin, output: process.stdout },
      {
        status: () => [
          t('console.status', {
            version: VERSION,
            brand: BRAND,
            pid: String(process.pid),
            platform: process.platform,
            uptime: String(Math.round(process.uptime())),
            total: String(manager.list().length),
            running: String(manager.runningCount()),
          }),
        ],
        list: () => {
          const views = manager.list();
          if (views.length === 0) return [t('console.list.empty')];
          // 只给"一眼看清"的最小字段；指纹 / 能力 / 授权那些留给 `spc plugin list`
          // （那是管理面的呈现契约，控制台不复制它）
          return views.map((p) =>
            t('console.list.line', {
              ref: p.ref,
              version: p.version.name,
              state: p.state,
              enabled: p.enabled ? t('console.list.on') : t('console.list.off'),
            }),
          );
        },
        stop: () => void shutdown('console'),
        /**
         * 单个插件的详情：与 `spc plugin status` **同一份渲染**（`core/plugin/render.ts`）——
         * 声明 / 已授予 / **未授予**（host 作用域里还差哪些）/ 能力 / 指纹 / 错误，都在这一份里。
         */
        show: (ref) => pluginDetailLines(manager.status(ref)),
        /**
         * 插件生命周期：与 `spc plugin …` 走 HTTP 时**最终落到的是同一批 manager 方法**
         * （语义与审计都在 manager 层）—— 这里只是换了个传输，没有第二份实现。
         */
        plugin: async (verb, args) => {
          if (verb === 'install') {
            const p = parseInstallArgs(args);
            if (p.bad.length > 0) {
              return [t('console.flag.unknown', { arg: p.bad.join(' ') }), t('console.usage.install')];
            }
            if (p.target === undefined) return [t('console.usage.install')];
            const opts = {
              grants: p.grants,
              start: true,
              acceptKeyChange: p.acceptKeyChange,
              ...(p.source === undefined ? {} : { source: p.source }),
            };
            // 判后缀而不是 statSync：路径是在**这台机器**上解析的，而 `.spc` = 托管副本、目录 = 就地安装
            // （两条入口同一条管线，见 `build-layer-design.md` §10.6）—— 与 HTTP 路由同一份判断
            const view = /\.spc$/i.test(p.target)
              ? await manager.installPackage(p.target, opts)
              : await manager.install(p.target, opts);
            return [t('cli.plugin.installed', { id: view.ref, dir: view.dir })];
          }
          const ref = args[0]!;
          // 其余四个只吃一个引用；多给的一律拒（不猜他要对哪个动手）
          if (args.length > 1) {
            return [t('console.flag.unknown', { arg: args.slice(1).join(' ') }), t('console.usage.ref', { verb })];
          }
          switch (verb) {
            case 'uninstall':
              return [t('cli.plugin.uninstall.done', { id: (await manager.uninstall(ref)).ref })];
            case 'reload':
              return [t('cli.plugin.reload.done', { id: (await manager.reload(ref)).ref })];
            case 'enable':
              return [t('cli.plugin.enable.done', { id: (await manager.enable(ref)).ref })];
            case 'disable':
              return [t('cli.plugin.disable.done', { id: (await manager.disable(ref)).ref })];
          }
        },
      },
    );
  }
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

function auditShutdown(reason: string, result: 'ok' | 'error', started: number, detail?: string): void {
  audit({
    ts: Date.now(),
    // 核心自身的动作（没有操作者、没有"关于谁"）；停机原因进明细
    actor: coreActor(),
    method: 'core.shutdown',
    paramsDigest: digestParams(detail === undefined ? { reason } : { reason, detail }) ?? digest(reason),
    result,
    detail: { reason, ...(detail === undefined ? {} : { code: detail }) },
    timing: { ms: Date.now() - started },
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
async function shutdown(reason: 'SIGINT' | 'SIGTERM' | 'request' | 'console'): Promise<void> {
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
