// 控制台的**业务手柄**：把 `attachConsole` 收到的动词接到 manager 上。
//
// 为什么单独一个模块（原先写在 `core/server.ts` 的 `listen` 回调里）：
//   · **维护模式**（`--maintenance`）要用同一套手柄，只有两处语义不同 —— `install` / `enable` **只改记录**、
//     `reload` **拒绝**（那时不该有任何插件在跑，装载就自毁前提）；
//   · 埋在回调里就没法给这两种形态写用例，而"维护模式下不许装载"正是最该钉住的那条。
//
// 语义与审计**仍然复用 manager**：这里没有第二份实现，`via: console` 由 `attachConsole` 的通道戳负责。
import { parseInstallArgs, type ConsoleHandlers, type SourceVerb } from './console';
import { SpcError } from './errors';
import {
  addSource,
  listSources,
  removeSource,
  setSourceAlias,
  setSourceAnchor,
  setSourceEnabled,
} from './sources/manage';
import type { SourceView } from './sources/manage';
import { t } from './i18n';
import { manager } from './plugin/manager';
import { pluginDetailLines } from './plugin/render';
import { BRAND, VERSION } from './version';

export type ConsoleMode = 'normal' | 'maintenance';

/** 一行/两行的源渲染：与 `spc source list` **同一批文案**（`cli.source.*`），控制台不另造说法 */
function sourceLines(s: SourceView): string[] {
  const out = [
    t('cli.source.line', {
      origin: s.origin,
      kind: t(s.kind === 'local' ? 'cli.source.kind.local' : 'cli.source.kind.market'),
      alias: s.alias,
      enabled: s.enabled ? t('cli.yes') : t('cli.no'),
      installed: s.installedCount,
    }),
  ];
  if (s.fingerprint) out.push(t('cli.source.pub', { fingerprint: s.fingerprint, firstTrust: s.firstTrust }));
  return out;
}

/** 只认 `--flag value` 两种旗标；**不认识的旗标一律拒**（与 install 那条同一条 fail-closed 口径） */
function parseSourceFlags(args: string[], allowed: readonly string[]): { flags: Map<string, string>; bad: string[] } {
  const flags = new Map<string, string>();
  const bad: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      bad.push(a);
      continue;
    }
    if (!allowed.includes(a) || args[i + 1] === undefined) {
      bad.push(a);
      continue;
    }
    flags.set(a, args[i + 1]!);
    i += 1;
  }
  return { flags, bad };
}

export function buildConsoleHandlers(input: { mode: ConsoleMode; stop: () => void }): ConsoleHandlers {
  const maintenance = input.mode === 'maintenance';
  /** 维护模式的尾巴：**改了记录但没跑**必须说出来，否则人会以为它已经在跑了 */
  const recordOnly = (lines: string[]): string[] =>
    maintenance ? [...lines, t('console.plugin.record_only')] : lines;

  return {
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
      ...(maintenance ? [t('console.maintenance.line')] : []),
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

    show: (ref) => pluginDetailLines(manager.status(ref)),

    stop: input.stop,

    source: async (verb, args) => {
      if (verb === 'list') {
        const rows = listSources();
        if (rows.length === 0) return [t('cli.source.list.empty')];
        return rows.flatMap(sourceLines);
      }
      const origin = args[0]!;
      if (verb === 'add') {
        // 与 `spc source add` 同一条提示：本地源要写全 `local:<名字>`，否则会被当市场域名去远程取公钥
        if (!origin.startsWith('local:') && !origin.includes('.') && !origin.includes(':')) {
          return [t('cli.source.add.hint', { origin })];
        }
        const { flags, bad } = parseSourceFlags(args.slice(1), ['--pub', '--alias', '--anchor']);
        if (bad.length > 0) return [t('console.flag.unknown', { arg: bad.join(' ') }), t('console.usage.source')];
        const view = await addSource({
          origin,
          ...(flags.get('--pub') === undefined ? {} : { pub: flags.get('--pub')! }),
          ...(flags.get('--alias') === undefined ? {} : { alias: flags.get('--alias')! }),
          ...(flags.get('--anchor') === undefined ? {} : { anchorPub: flags.get('--anchor')! }),
        });
        return [t('cli.source.added', { origin }), ...sourceLines(view)];
      }
      if (verb === 'remove') {
        removeSource(origin);
        return [t('cli.source.removed', { origin })];
      }
      if (verb === 'enable' || verb === 'disable') {
        const view = setSourceEnabled(origin, verb === 'enable');
        return [t(`cli.source.${verb}.done`, { origin }), ...sourceLines(view)];
      }
      if (verb === 'alias') {
        const alias = args[1];
        if (alias === undefined) return [t('console.usage.source')];
        return [t('cli.source.alias.done', { origin, alias }), ...sourceLines(setSourceAlias(origin, alias))];
      }
      // anchor：与 CLI 一致 —— **不给 `--pub` 就是解绑**（解绑是正当动作，不逼人写魔法值）
      const { flags, bad } = parseSourceFlags(args.slice(1), ['--pub']);
      if (bad.length > 0) return [t('console.flag.unknown', { arg: bad.join(' ') }), t('console.usage.source')];
      const pub = flags.get('--pub');
      const change = setSourceAnchor(origin, pub ?? null);
      return [
        pub === undefined
          ? t('cli.source.anchor.cleared', { origin })
          : t('cli.source.anchor.done', { origin, fingerprint: change.view.authorAnchor?.fingerprint ?? '' }),
        ...sourceLines(change.view),
      ];
    },

    plugin: async (verb, args) => {
      if (verb === 'install') {
        const p = parseInstallArgs(args);
        if (p.bad.length > 0) {
          return [t('console.flag.unknown', { arg: p.bad.join(' ') }), t('console.usage.install')];
        }
        if (p.target === undefined) return [t('console.usage.install')];
        const opts = {
          grants: p.grants,
          // 维护模式**不装载**（只落记录 + 授权）：装载就自毁维护模式的前提
          start: !maintenance,
          acceptKeyChange: p.acceptKeyChange,
          ...(p.source === undefined ? {} : { source: p.source }),
        };
        // 判后缀而不是 statSync：路径是在**这台机器**上解析的，而 `.spc` = 托管副本、目录 = 就地安装
        // （两条入口同一条管线，见 `build-layer-design.md` §10.6）—— 与 HTTP 路由同一份判断
        const view = /\.spc$/i.test(p.target)
          ? await manager.installPackage(p.target, opts)
          : await manager.install(p.target, opts);
        // 维护模式：`start: false` 只落「装好了、未启用」⇒ 再走一次 record-only 的 enable，
        // 让记录变成「已启用、未装载」—— 提示承诺的就是下次正常启动时装载
        if (maintenance && !view.enabled) await manager.enable(view.ref, { load: false });
        return recordOnly([t('cli.plugin.installed', { id: view.ref, dir: view.dir })]);
      }

      if (verb === 'grant' || verb === 'revoke') {
        const [ref, ...points] = args;
        if (ref === undefined || points.length === 0) return [t('cli.plugin.grant.usage')];
        const view = verb === 'grant' ? manager.grant(ref, points) : manager.revoke(ref, points);
        return [t(verb === 'grant' ? 'cli.plugin.granted' : 'cli.plugin.revoked', { id: view.ref })];
      }

      const ref = args[0]!;
      // 其余动词只吃一个引用；多给的一律拒（不猜他要对哪个动手）
      if (args.length > 1) {
        return [t('console.flag.unknown', { arg: args.slice(1).join(' ') }), t('console.usage.ref', { verb })];
      }
      switch (verb) {
        case 'uninstall':
          return [t('cli.plugin.uninstall.done', { id: (await manager.uninstall(ref)).ref })];
        case 'reload':
          // 维护模式没有插件在跑：装载会自毁前提 ⇒ 明说，不做无提示的空转
          if (maintenance) return [t('console.plugin.reload_in_maintenance')];
          return [t('cli.plugin.reload.done', { id: (await manager.reload(ref)).ref })];
        case 'enable':
          return recordOnly([t('cli.plugin.enable.done', { id: (await manager.enable(ref, { load: !maintenance })).ref })]);
        case 'disable':
          return [t('cli.plugin.disable.done', { id: (await manager.disable(ref)).ref })];
      }
    },
  };
}
