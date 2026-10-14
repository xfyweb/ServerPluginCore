// 审计结构 v2：**谁做的 / 关于谁** 的用例（结构与拍板理由见 `docs/api-contract.md` §8）。
//
// 判据（都是 2026-10-14 那次改结构要治的病）：
//   ① 管理动作（install / uninstall / enable / disable / reload）**必须有条目** —— 以前一条都不落，
//      只有它们带出来的 `lifecycle.*`；`uninstall` 之后记录没了，"谁卸的、从哪个源装的"就查不回来；
//   ② 插件自己干的与管理员干的**必须分得开**：`actor.kind` 分别是 `plugin` / `operator`；
//   ③ 通道要记下来：HTTP 路由（CLI）⇒ `via: cli`，TTY 控制台（进程内）⇒ `via: console`，
//      都不是（测试里直接调、自动重启、收尾）⇒ `internal`；
//   ④ 对象进 `subject`（不再挤在 `pluginId`/`target` 里靠 method 家族猜）。
//
// 隔离：`SPC_STATE_DIR` / `SPC_AUDIT_DIR` 必须在**动态 import 之前**设好（见 `reanchor.test.ts` 顶部说明）。
import type { AuditEntry } from '../audit';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-audit-admin-'));

/** 当天的审计文件（**按天分文件**）；**本地算**，理由同 `reanchor.test.ts` 顶部 */
function auditFileToday(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return join(TMP, 'audit', `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`);
}
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

const { initAudit } = await import('../audit.ts');
// ⚠️ 通道助手必须从 **manager 用的同一个 specifier**（`../audit`）拿：
// `'../audit'` 与 `'../audit.ts'` 在 ESM 里是**两份模块实例**，通道设在 A 上、manager 读 B ⇒ 永远是 internal。
const { runAsChannel } = await import('../audit');
initAudit();
const { manager } = await import('../plugin/manager.ts');

const id = (name: string) => `@spc/${name}`;
const ref = (name: string) => `local:default/${id(name)}`;

function auditEntries(): AuditEntry[] {
  const file = auditFileToday();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AuditEntry);
}

function makePlugin(name: string, code = 'export function init(){}'): string {
  const dir = join(TMP, 'src', name);
  mkdirSync(dir, { recursive: true });
  // manifest 形状照 `lifecycle.test.ts` 的夹具（schema 2 的必填项一个都不能少，否则 PLUGIN_MANIFEST_INVALID）
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema: 2,
      id: id(name),
      name: `Fixture ${name}`,
      version: { code: 1, name: '0.0.1' },
      runtime: { type: 'quickjs', esm: true },
      permissions: [{ name: 'kv.read' }],
      entry: 'main.ts',
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'main.ts'), code, 'utf8');
  return dir;
}

test('五个管理动作**都有自己的条目**：actor=operator、subject=那个插件、旧字段不再出现', async () => {
  const dir = makePlugin('lifecycle-one');
  await manager.install(dir, { source: 'local:default' });
  await manager.disable(ref('lifecycle-one'));
  await manager.enable(ref('lifecycle-one'));
  await manager.reload(ref('lifecycle-one'));
  await manager.uninstall(ref('lifecycle-one'));

  const rows = auditEntries();
  for (const method of ['plugin.install', 'plugin.disable', 'plugin.enable', 'plugin.reload', 'plugin.uninstall']) {
    const row = rows.find((e) => e.method === method);
    assert.ok(row, `${method} 必须落一条审计（以前一条都没有）`);
    assert.equal(row!.actor.kind, 'operator', `${method} 的发起者是管理员`);
    assert.equal(row!.subject?.kind, 'plugin');
    assert.equal(row!.subject?.ref, ref('lifecycle-one'), `${method} 的对象是那个插件`);
    // 旧字段一个都不许再出现（未发布，直接替换；留着就是"两条真相"）
    assert.equal((row as unknown as Record<string, unknown>).pluginId, undefined, 'pluginId 已死');
    assert.equal((row as unknown as Record<string, unknown>).target, undefined, 'target 已死');
    assert.equal((row as unknown as Record<string, unknown>).durationMs, undefined, 'durationMs 已进 timing');
  }
  // 装/卸的明细里记着来源（**路径只进摘要**）；install 的 seed 授权也在
  assert.equal(rows.find((e) => e.method === 'plugin.install')!.detail?.origin, 'local:default');
  assert.equal(rows.find((e) => e.method === 'plugin.uninstall')!.detail?.origin, 'local:default');
});

test('插件自己干的 vs 管理员干的：`actor.kind` 分得开（这正是改结构的初衷）', async () => {
  const dir = makePlugin('who-did-it', `import { kv } from '@host/api';\nexport function init(){ kv.set('k', 1); }`);
  await manager.install(dir, { source: 'local:default' });
  await manager.uninstall(ref('who-did-it'));

  const rows = auditEntries();
  const pluginRows = rows.filter((e) => e.actor.kind === 'plugin');
  const operatorRows = rows.filter((e) => e.actor.kind === 'operator');
  assert.ok(pluginRows.length > 0, '插件里的 kv.set 应当算"插件干的"');
  assert.ok(operatorRows.length >= 2, 'install + uninstall 至少两条管理动作');
  assert.ok(
    pluginRows.every((e) => e.actor.ref === ref('who-did-it')),
    '插件条目的 actor.ref 是**它自己**（完整引用）',
  );
  assert.ok(
    operatorRows.every((e) => e.actor.ref === undefined),
    '管理动作的 actor 留空（P3 才填用户）—— 对象在 subject 里',
  );
});

test('通道：HTTP/CLI 与 TTY 控制台分得开；都不是则记 internal', async () => {
  const dir = makePlugin(
    'via-probe',
    `import { kv } from '@host/api';
export function init(){ kv.set('probe', 1); }`,
  );
  // ① 直接调（= 测试/自动重启/收尾那种）：没有通道 ⇒ internal
  await manager.install(dir, { source: 'local:default' });
  // ② 控制台那条路（进程内）⇒ console
  await runAsChannel('console', () => manager.disable(ref('via-probe')));
  // ③ CLI 那条路（HTTP 路由里 enterChannel('cli')）⇒ cli
  await runAsChannel('cli', () => manager.enable(ref('via-probe')));

  const rows = auditEntries();
  // ⚠️ 取**最后**一条：同一个审计文件跨用例共享，前面用例也调过 install/disable/enable
  // （那些是"没有通道"的 internal）—— `find()` 会拿到它们，断言就假红（2026-10-14 踩到）。
  const viaOf = (method: string): string | undefined =>
    rows.filter((e) => e.method === method).at(-1)?.actor.via;
  assert.equal(viaOf('plugin.install'), 'internal', '没有通道就不是人从某条通道发起的');
  assert.equal(viaOf('plugin.disable'), 'console');
  assert.equal(viaOf('plugin.enable'), 'cli');
});

test('读面按 actor / via 过滤（`spc audit tail --actor/--via` 走的就是它）', async () => {
  const { readAuditTail } = await import('../audit.ts');
  const all = readAuditTail({ limit: 200 });
  const operators = readAuditTail({ limit: 200, actor: 'operator' });
  const plugins = readAuditTail({ limit: 200, actor: 'plugin' });
  assert.ok(all.entries.length >= operators.entries.length + plugins.entries.length - 1);
  assert.ok(
    operators.entries.every((e) => e.actor.kind === 'operator'),
    '--actor operator 只给管理员动作',
  );
  assert.ok(
    plugins.entries.every((e) => e.actor.kind === 'plugin'),
    '--actor plugin 只给插件行为（管理条目不许混进来）',
  );
  const viaConsole = readAuditTail({ limit: 200, via: 'console' });
  assert.ok(
    viaConsole.entries.every((e) => e.actor.via === 'console'),
    '--via console 只给控制台那条通道',
  );
  // `--plugin` 匹配 actor 或 subject：管理动作（对象是它）与插件行为（发起者是它）都该被查出来
  const aboutIt = readAuditTail({ limit: 200, plugin: ref('via-probe') });
  assert.ok(aboutIt.entries.some((e) => e.actor.kind === 'operator'), '它被管理过 ⇒ 查得到');
  assert.ok(aboutIt.entries.some((e) => e.actor.kind === 'plugin'), '它自己干的 ⇒ 也查得到');
});
