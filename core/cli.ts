// spc CLI：ed25519 握手客户端（管理面，docs/management-channel.md）
// CLI 是本地化渲染点：HTTP 只回英文码，这里统一用 tError() 翻译（含服务端 detail.code）。
//
// 职责边界（intent-capture.md §10）：CLI 只做**插件与主题管理**，不承载业务操作。
// 所有写操作经 daemon（记录由 daemon 拥有），CLI 不直接碰 plugins.json。
import { request } from 'node:http';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { printAbout } from './about';
import { renderThrown, t, tError, type RenderableError } from './i18n';
import { verifyDaemon } from './handshake';
import { shortFingerprint } from './sources/keys';
import { BRAND } from './version';

const PORT = Number(process.env.SPC_PORT ?? 18777);

/**
 * **用法错误**（参数形状不对 / 缺参数）：退出码 **2**（`docs/cli-contract.md` §2 的退出码表）。
 * 与"一般失败"（1）分开，CI 才分得清"我参数写错了"和"操作失败了"。
 * ⚠️ 只有"参数本身不对"才用它；连不上核心、插件不存在这类是运行期失败 ⇒ 保持 1。
 */
class UsageError extends Error {}

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
  /** 作者公钥指纹（`sha256:…`）；null = 这个包没有作者身份（本地包没带信封） */
  authorFingerprint: string | null;
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

/**
 * 打印一个插件的状态块。
 *
 * ⚠️ **指纹默认不打**（2026-10-13 维护者定）：完整指纹是 64 位十六进制，运维基本不看
 * （撞名时他们多半"换一个人的同款"，或只用官方市场、根本没重名）。
 * 分级：**默认不打** / `status` 打**缩略**（前 8 位，够核对）/ 真做身份决策的地方（换钥、来源锚、keygen）打**全量**；
 * 机器要真值一律走 `--json`（`--json` 路径不经过这里）。
 */
function printPlugin(p: PluginView, fingerprint: 'none' | 'short' | 'full' = 'none'): void {
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
  if (p.authorFingerprint && fingerprint !== 'none') {
    console.log(
      t(fingerprint === 'full' ? 'cli.plugin.author' : 'cli.plugin.author.short', {
        fingerprint: fingerprint === 'full' ? p.authorFingerprint : shortFingerprint(p.authorFingerprint),
      }),
    );
  }
  if (p.capabilities.length > 0) console.log(t('cli.plugin.caps', { caps: p.capabilities.join(', ') }));
  if (p.lastError) console.log(t('cli.plugin.lastError', { code: p.lastError.code }));
  if (p.reloadRequired) console.log(t('cli.plugin.reloadRequired'));
}

/**
 * 子命令表：**认得的**动词。
 *
 * 为什么要有它：没给子命令 / 子命令打错时，要**立刻打用法**，而不是往下走去要参数 ——
 * 原先 `spc source`（无子命令）会撞上"缺少来源"（用法兜底写在了参数检查之后，永远到不了），
 * 而 `spc source help` 直接报错，用户看不到任何帮助。
 */
const PLUGIN_VERBS = ['list', 'install', 'status', 'grant', 'revoke', 'enable', 'disable', 'reload', 'uninstall', 'reanchor'];
const SOURCE_VERBS = ['list', 'add', 'remove', 'enable', 'disable', 'alias', 'anchor'];

/**
 * promote 建议（CLI 侧的**结构副本**；⚠️ 改这里要同步 `core/plugin/manager.ts` 的 `PromoteSuggestion`）。
 * "同一把钥的第二例出现了" ⇒ 建议给它建个专属桶并把这几个一起搬过去。
 */
interface PromoteView {
  origin: string;
  alias: string;
  anchor: string;
  pub: string;
  refs: string[];
}

/**
 * 换源预检计划（CLI 侧的**结构副本**）。
 * ⚠️ 改这里要同步 `core/plugin/manager.ts` 的 `ReanchorPlan`。
 */
interface ReanchorPlanView {
  target: {
    origin: string;
    kind: string | null;
    alias: string;
    enabled: boolean;
    suspended: string | null;
    anchorFingerprint: string | null;
  };
  moves: {
    from: string;
    fromOrigin: string;
    to: string;
    id: string;
    version: { code: number; name: string };
    enabled: boolean;
    state: string;
    authorFingerprint: string | null;
    dataDir: { from: string; to: string; exists: boolean };
    config: { from: string; to: string; exists: boolean };
    /** 托管副本（`.spc` 装的那种）也会跟着来源搬；就地安装 `exists: false`（⚠️ 与 manager.ts 的结构副本同步） */
    pkg: { from: string; to: string; exists: boolean };
  }[];
  grantRewrites: { ref: string; pairs: { from: string; to: string }[] }[];
  needsReload: string[];
  blockedBy: { ref: string; dependents: string[] }[];
  idleDependents: string[];
  warnings: { code: string; params: Record<string, string> }[];
  errors: { code: string; params: Record<string, string> }[];
}

/** 计划里默认列出多少条点名映射（超出的只报数量；要看全部用 `--json`） */
const REANCHOR_GRANT_SAMPLE = 5;

function printReanchorPlan(plan: ReanchorPlanView): void {
  const tgt = plan.target;
  console.log(
    t('cli.reanchor.target', {
      origin: tgt.origin,
      kind: t(
        tgt.kind === 'local'
          ? 'cli.reanchor.kind.local'
          : tgt.kind === 'market'
            ? 'cli.reanchor.kind.market'
            : 'cli.reanchor.kind.none',
      ),
      alias: tgt.alias,
      enabled: tgt.enabled ? t('cli.yes') : t('cli.no'),
    }),
  );
  if (tgt.anchorFingerprint) console.log(t('cli.reanchor.anchor', { fingerprint: tgt.anchorFingerprint }));

  if (plan.moves.length > 0) {
    console.log(t('cli.reanchor.moves', { count: plan.moves.length }));
    for (const m of plan.moves) {
      console.log(
        t(m.enabled ? 'cli.reanchor.move.restart' : 'cli.reanchor.move', {
          from: m.from,
          to: m.to,
          version: m.version.name,
          state: m.state,
        }),
      );
      if (m.dataDir.exists) {
        console.log(t('cli.reanchor.move.dataDir', { from: m.dataDir.from, to: m.dataDir.to }));
      }
      if (m.config.exists) {
        console.log(t('cli.reanchor.move.config', { from: m.config.from, to: m.config.to }));
      }
      // 托管副本（`.spc` 装的那种）也会跟着搬：不说清楚，管理员会以为文件还在旧来源目录下
      if (m.pkg.exists) {
        console.log(t('cli.reanchor.move.pkg', { from: m.pkg.from, to: m.pkg.to }));
      }
    }
  }

  // 授权重写：默认列前 N 条 + 省略号 + 总数（2026-09-25 用户定的呈现）
  const pairs = plan.grantRewrites.flatMap((g) => g.pairs);
  if (pairs.length > 0) {
    console.log(t('cli.reanchor.grants', { records: plan.grantRewrites.length, pairs: pairs.length }));
    for (const pair of pairs.slice(0, REANCHOR_GRANT_SAMPLE)) {
      console.log(t('cli.reanchor.grants.sample', { from: pair.from, to: pair.to }));
    }
    if (pairs.length > REANCHOR_GRANT_SAMPLE) {
      console.log(t('cli.reanchor.grants.more', { count: pairs.length - REANCHOR_GRANT_SAMPLE }));
    }
  }

  if (plan.needsReload.length > 0) {
    console.log(t('cli.reanchor.needsReload', { refs: plan.needsReload.join(', ') }));
  }
  if (plan.idleDependents.length > 0) {
    console.log(t('cli.reanchor.idle', { refs: plan.idleDependents.join(', ') }));
  }
  for (const w of plan.warnings) console.log(t(`cli.reanchor.warn.${w.code}`, w.params));
  if (plan.errors.length > 0) {
    // 每条错误直接渲染成"发生了什么 + 该怎么办"（`tError` 与其它命令同一条路）
    console.log(t('cli.reanchor.errors', { count: plan.errors.length }));
    for (const e of plan.errors) console.log(t('cli.reanchor.error', { text: tError(e) }));
  }
}

/**
 * 交互确认。**故意不带超时**：等人回答就是它存在的意义（这不是"等一个可能永不到来的异步事件"）；
 * 非交互场景在调用点就被 `process.stdin.isTTY` 挡掉了，所以不会挂住脚本。
 */
async function askYesNo(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((res) => rl.question(prompt, res));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function pluginCommand(sub: string | undefined, args: string[]): Promise<void> {
  // 打用法**不碰 daemon**：帮助信息是本地事实，核心没跑时也该看得到
  // （原先第一行就 acquireToken ⇒ 核心没起时 `spc plugin` 报的是"无法连接核心"）
  if (sub === undefined || sub === 'help' || !PLUGIN_VERBS.includes(sub)) {
    console.log(t('cli.plugin.usage'));
    return;
  }
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
    const target = args.find((a) => !a.startsWith('--'));
    if (!target) throw new UsageError(t('cli.plugin.install.usage'));
    const grants: string[] = [];
    let source: string | undefined;
    let acceptKeyChange = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--grant' && args[i + 1]) grants.push(args[i + 1]);
      // `--source <来源>`：决定**归属**（身份是 `(origin, id)`，同 id 不同源是两个插件）；
      // 缺省 `local:default`
      if (args[i] === '--source' && args[i + 1]) source = args[i + 1];
      // 显式接受换钥：同 `(origin,id)` 的作者公钥与宿主记忆不符时**默认拒装**（fail-closed）
      if (args[i] === '--accept-key-change') acceptKeyChange = true;
    }
    // 两条入口（`build-layer-design.md` §10.6）：**目录** = 源码就地安装；**`.spc` 文件** = 装进**托管副本**。
    // 判后缀而不是本地 `statSync`：路径是在 **daemon 那台机器**上解析的（CLI 只把它转过去），本地 stat 不作数。
    const isPackage = /\.spc$/i.test(target);
    const r = (await httpJson('POST', '/api/plugins/install', token, {
      ...(isPackage ? { file: resolve(target) } : { dir: resolve(target) }),
      grants,
      acceptKeyChange,
      ...(source === undefined ? {} : { source }),
    })) as {
      status: number;
      body: { plugin: PluginView; promote: PromoteView | null };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.plugin.install.fail');
    console.log(t('cli.plugin.installed', { id: r.body.plugin.ref, dir: r.body.plugin.dir }));
    printPlugin(r.body.plugin);
    // promote 建议（§3bis）：同钥第二例出现了 ⇒ 给两条**现成命令**（建桶 + 搬家），不自动执行
    const promote = r.body.promote;
    if (promote) {
      console.log(
        t('cli.plugin.promote.hint', { count: promote.refs.length, author: promote.anchor }),
      );
      console.log(t('cli.plugin.promote.cmd', {
        bucket: promote.origin,
        alias: promote.alias,
        pub: promote.pub,
        refs: promote.refs.join(' '),
      }));
    }
    return;
  }

  if (sub === 'status') {
    const id = args[0];
    if (!id) throw new UsageError(t('cli.plugin.id.required'));
    const r = (await httpJson('GET', `/api/plugins/${idPath(id)}`, token)) as {
      status: number;
      body: { plugin: PluginView };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.plugin.status.fail');
    const p = r.body.plugin;
    // 详情页给**缩略**指纹：这里够核对（完整值走 --json），不再默认甩 64 位十六进制
    printPlugin(p, 'short');
    console.log(t('cli.plugin.detail', { dir: p.dir, dataDir: p.dataDir, config: p.configPath }));
    return;
  }

  if (sub === 'grant' || sub === 'revoke') {
    const [id, ...points] = args;
    if (!id || points.length === 0) throw new UsageError(t('cli.plugin.grant.usage'));
    const r = (await httpJson('POST', `/api/plugins/${idPath(id)}/grants`, token, {
      add: sub === 'grant' ? points : [],
      remove: sub === 'revoke' ? points : [],
    })) as { status: number; body: { plugin: PluginView } };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.plugin.grant.fail');
    console.log(t(sub === 'grant' ? 'cli.plugin.granted' : 'cli.plugin.revoked', { id }));
    printPlugin(r.body.plugin);
    return;
  }

  if (sub === 'reanchor') {
    const { positional, flags } = parseArgs(args);
    // `--source` 当别名收下：install 用的就是它，同一个概念不该因为命令不同而换名字
    const origin = flags.get('--origin') ?? flags.get('--source');
    if (positional.length === 0 || origin === undefined) throw new UsageError(t('cli.reanchor.usage'));

    const planRes = (await httpJson('POST', '/api/plugins/reanchor/plan', token, {
      refs: positional,
      origin,
    })) as { status: number; body: { plan: ReanchorPlanView } };
    if (planRes.status !== 200) throw httpFailure(planRes.status, planRes.body, 'cli.plugin.op.fail');
    const plan = planRes.body.plan;

    if (flags.has('--json')) {
      // 脚本用：计划原样吐出（含 errors），由调用方判断
      console.log(JSON.stringify(plan, null, 2));
      if (plan.errors.length > 0) process.exitCode = 1;
      return;
    }

    printReanchorPlan(plan);
    if (plan.errors.length > 0) {
      // 计划里已经逐条说了"为什么搬不了、该怎么办"，这里不再另说一句
      process.exitCode = 1;
      return;
    }

    if (!flags.has('--yes')) {
      // 交互不是禁忌，但**必须能关掉**：非 TTY 直接拒，免得脚本/CI 在没人看的时候把插件搬走
      // （口径见 `docs/intent-capture.md` §10；`--yes` 就是那个开关）
      if (!process.stdin.isTTY) throw new Error(t('cli.reanchor.notty'));
      const yes = await askYesNo(t('cli.reanchor.confirm'));
      if (!yes) {
        console.log(t('cli.reanchor.cancelled'));
        return;
      }
    }

    const r = (await httpJson('POST', '/api/plugins/reanchor', token, { refs: positional, origin })) as {
      status: number;
      body: {
        moved: { from: string; to: string }[];
        plugins: PluginView[];
        failedToStart: { ref: string; code: string }[];
      };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.plugin.op.fail');
    for (const m of r.body.moved) console.log(t('cli.reanchor.done', { from: m.from, to: m.to }));
    for (const f of r.body.failedToStart) {
      console.log(t('cli.reanchor.failedToStart', { ref: f.ref, code: f.code }));
    }
    for (const p of r.body.plugins) printPlugin(p);
    return;
  }

  if (sub === 'enable' || sub === 'disable' || sub === 'reload' || sub === 'uninstall') {
    const id = args[0];
    if (!id) throw new UsageError(t('cli.plugin.id.required'));
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

/**
 * 源视图（CLI 侧的**结构副本**，与 `PluginView` 同一条理由：CLI 走 HTTP、不 import 核心类型）。
 * ⚠️ 改这里要同步 `core/sources/manage.ts` 的 `SourceView`。
 */
interface SourceView {
  origin: string;
  kind: string;
  alias: string;
  enabled: boolean;
  fingerprint: string | null;
  authorAnchor: { pub: string; fingerprint: string } | null;
  firstTrust: string;
  suspended: { at: string; reason: string } | null;
  installedCount: number;
}

/**
 * 简易参数解析：位置参数与 `--flag value` 分开。
 * 为什么要它（而不是 `args.find(a => !a.startsWith('--'))`）：后者会把**旗标的值**当成位置参数
 * —— `add local:std-a --alias "小A"` 里 `小A` 会被当成第二个位置参数。
 */
function parseArgs(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(a, next);
        i++;
      } else {
        flags.set(a, '');
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printSource(s: SourceView): void {
  console.log(
    t('cli.source.line', {
      origin: s.origin,
      kind: t(s.kind === 'local' ? 'cli.source.kind.local' : 'cli.source.kind.market'),
      alias: s.alias,
      enabled: s.enabled ? t('cli.yes') : t('cli.no'),
      installed: s.installedCount,
    }),
  );
  if (s.fingerprint) {
    console.log(t('cli.source.pub', { fingerprint: s.fingerprint, firstTrust: s.firstTrust }));
  }
  if (s.kind === 'local') {
    // 锚**只属于本地桶**（市场是多作者命名空间，钉一把作者钥是范畴错误 —— 见设计 §3bis）：
    // 本地桶唯一有意义的身份信息就是"有没有绑锚、绑的是哪把钥"，必须一眼看到
    console.log(
      s.authorAnchor
        ? t('cli.source.anchor', { fingerprint: s.authorAnchor.fingerprint })
        : t('cli.source.anchor.none'),
    );
  } else if (!s.fingerprint) {
    // 市场源印"作者锚：未绑定"是范畴错误，它该回答的是"源公钥取到没有"
    console.log(t('cli.source.pub.none'));
  }
  if (s.suspended) console.log(t('cli.source.suspended', { reason: s.suspended.reason, at: s.suspended.at }));
}

async function sourceCommand(sub: string | undefined, args: string[]): Promise<void> {
  // 同 pluginCommand：没给子命令 / 不认识 / `help` ⇒ 只打用法，**不握手、不碰 daemon**
  if (sub === undefined || sub === 'help' || !SOURCE_VERBS.includes(sub)) {
    console.log(t('cli.source.usage'));
    return;
  }
  const token = await acquireToken();
  const { positional, flags } = parseArgs(args);

  if (sub === 'list') {
    const r = (await httpJson('GET', '/api/sources', token)) as {
      status: number;
      body: { sources: SourceView[] };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.source.op.fail');
    if (r.body.sources.length === 0) {
      console.log(t('cli.source.list.empty'));
      return;
    }
    for (const s of r.body.sources) printSource(s);
    return;
  }

  const origin = positional[0];
  if (!origin) throw new UsageError(t('cli.source.origin.required'));

  if (sub === 'add') {
    // **本地源要写全**：不写成 `local:<名字>` 的话，服务端会把它当**市场域名**去远程取公钥
    // （`isValidSource` 的市场正则同样接受裸名字），失败后甩回来的是远端错误码 —— 运维看不懂、
    // 也不知道该改什么（2026-10-13 维护者手工验收指出）。所以形状不对就在这里拒，并给出两条出路。
    // ⚠️ 判据要留出 `localhost:8080` 这类**不带点但带端口**的写法：既没有 `.` 也没有 `:` 才像"裸桶名"。
    if (!origin.startsWith('local:') && !origin.includes('.') && !origin.includes(':')) {
      throw new UsageError(t('cli.source.add.hint', { origin }));
    }
    const pub = flags.get('--pub');
    const alias = flags.get('--alias');
    const anchor = flags.get('--anchor');
    const r = (await httpJson('POST', '/api/sources/add', token, {
      origin,
      ...(pub === undefined ? {} : { pub }),
      ...(alias === undefined ? {} : { alias }),
      ...(anchor === undefined ? {} : { anchorPub: anchor }),
    })) as { status: number; body: { source: SourceView } };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.source.op.fail');
    console.log(t('cli.source.added', { origin }));
    printSource(r.body.source);
    return;
  }

  if (sub === 'remove') {
    const r = (await httpJson('POST', '/api/sources/remove', token, { origin })) as {
      status: number;
      body: unknown;
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.source.op.fail');
    console.log(t('cli.source.removed', { origin }));
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const r = (await httpJson('POST', `/api/sources/${sub}`, token, { origin })) as {
      status: number;
      body: { source: SourceView };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.source.op.fail');
    console.log(t(`cli.source.${sub}.done`, { origin }));
    printSource(r.body.source);
    return;
  }

  if (sub === 'alias') {
    const alias = positional[1];
    if (alias === undefined) throw new UsageError(t('cli.source.usage'));
    const r = (await httpJson('POST', '/api/sources/alias', token, { origin, alias })) as {
      status: number;
      body: { source: SourceView };
    };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.source.op.fail');
    console.log(t('cli.source.alias.done', { origin, alias }));
    printSource(r.body.source);
    return;
  }

  if (sub === 'anchor') {
    // 不给 `--pub` ⇒ 解绑锚（解绑是一个正当动作，不该逼管理员写魔法值）
    const pub = flags.get('--pub');
    const r = (await httpJson('POST', '/api/sources/anchor', token, {
      origin,
      ...(pub === undefined ? {} : { pub }),
    })) as { status: number; body: { source: SourceView; staleCount: number } };
    if (r.status !== 200) throw httpFailure(r.status, r.body, 'cli.source.op.fail');
    const view = r.body.source;
    console.log(
      pub === undefined
        ? t('cli.source.anchor.cleared', { origin })
        : t('cli.source.anchor.done', { origin, fingerprint: view.authorAnchor?.fingerprint ?? '' }),
    );
    printSource(view);
    // 改锚**不追溯**：已装插件仍按旧锚记录，这个数必须报出来（否则管理员会以为存量也换了）
    if (r.body.staleCount > 0) console.log(t('cli.source.anchor.stale', { count: r.body.staleCount }));
    return;
  }

  console.log(t('cli.source.usage'));
}

async function main() {
  const cmd = process.argv[2] ?? 'help';
  const args = process.argv.slice(3);

  if (cmd === 'about') {
    // 本地信息，不需要 daemon。⚠️ 多打几行"这条命令是哪来的"：
    // 同一个名字可能来自 `npm link`、将来的全局包、或直接 `node core/cli.ts` ——
    // 三者对应的代码可能不是同一份，"工具与本体不一致"是最难查的一类错（2026-09-25 定）。
    printAbout('admin');
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

  if (cmd === 'source') {
    await sourceCommand(args[0], args.slice(1));
    return;
  }

  console.log(t('cli.usage', { port: PORT }));
  console.log(BRAND);
}

main().catch((e) => {
  // 顶层兜底：SpcError 渲染成"码 + 参数"的本地化文案（`e.message` 只有英文码，参数会丢）
  console.error(`[spc] ${renderThrown(e)}`);
  // 用法错（参数形状不对）⇒ 2；其余运行期失败 ⇒ 1（docs/cli-contract.md §2 的退出码表）
  process.exit(e instanceof UsageError ? 2 : 1);
});
