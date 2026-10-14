// 契约兼容闸的用例（三层，**不用环境变量、不用 mock**）：
//   ① 规则矩阵 ⇒ 纯函数，`core` 当参数注入（与"当前 checkout 是哪个版本"解耦）
//   ② 接线用例 ⇒ 夹具**相对当前版本**构造（major+1 ⇒ 必然不兼容）⇒ 断言拒装 + 留审计
//   ③ 正向用例 ⇒ 夹具写当前版本（或不声明）⇒ 照常装载
// 要观察另一个核心版本的行为：`git checkout` 到那个版本，不靠开关假装（2026-10-14 维护者定）。
import type { AuditEntry } from '../audit';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { major } from 'semver';

const TMP = mkdtempSync(join(tmpdir(), 'spc-compat-'));
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

function auditFileToday(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return join(TMP, 'audit', `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`);
}

const { initAudit } = await import('../audit.ts');
initAudit();
const { coreCompat } = await import('../plugin/compat.ts');
const { manager } = await import('../plugin/manager.ts');
const { SpcError } = await import('../errors.ts');
const { VERSION } = await import('../version.ts');

const id = (name: string) => `@spc/${name}`;
/** 与当前核心**必然不兼容**的版本要求（major 抬一级 ⇒ 无论 checkout 到哪都成立） */
const INCOMPATIBLE = `${major(VERSION) + 1}.0.0`;

function auditEntries(): AuditEntry[] {
  const file = auditFileToday();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AuditEntry);
}

function makePlugin(name: string, minCore?: string): string {
  const dir = join(TMP, 'src', name);
  mkdirSync(dir, { recursive: true });
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
      ...(minCore === undefined ? {} : { compat: { minCore } }),
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'main.ts'), 'export function init(){}', 'utf8');
  return dir;
}

// ---------------- ① 规则矩阵（纯函数） ----------------

test('没声明 minCore ⇒ 不要求（清单里 compat 不是必填）', () => {
  const v = coreCompat(undefined, '1.2.3');
  assert.equal(v.ok, true);
  assert.equal((v as { exempted?: string }).exempted, 'not-declared');
  assert.equal(coreCompat('   ', '1.2.3').ok, true, '空白也算没声明');
});

test('major 相同且核心 ≥ minCore ⇒ 放行（相等也算满足）', () => {
  assert.equal(coreCompat('0.4.0', '0.4.2').ok, true);
  assert.equal(coreCompat('0.4.2', '0.4.2').ok, true);
  assert.equal(coreCompat('0.4.0', '0.5.0').ok, true);
});

test('核心低于 minCore ⇒ 拒（too-old）', () => {
  const v = coreCompat('0.4.0', '0.3.9');
  assert.equal(v.ok, false);
  assert.equal((v as { reason?: string }).reason, 'too-old');
});

test('major 不同 ⇒ 拒（major 是硬闸；这也是不需要 targetCore/coreRange 的原因）', () => {
  for (const [want, core] of [
    ['0.4.0', '1.0.0'],
    ['1.0.0', '0.9.9'],
    ['0.0.0', '0.0.0'.replace('0.0.0', '2.0.0')],
  ]) {
    const v = coreCompat(want!, core!);
    assert.equal(v.ok, false, `${want} vs ${core}`);
    assert.equal((v as { reason?: string }).reason, 'major-mismatch');
  }
});

test('minCore 形状非法 ⇒ 拒（fail-closed，不当成"没声明"）', () => {
  for (const bad of ['abc', '1.2', '>=1.0.0', '1.2.3.4']) {
    const v = coreCompat(bad, '1.2.3');
    assert.equal(v.ok, false, bad + ' 应当被拒');
    assert.equal((v as { reason?: string }).reason, 'invalid-min-core');
  }
});

test('**没有开发豁免**：核心版本 0.0.0 时，要求 ≥ 0.1.0 的插件照样被拒', () => {
  const v = coreCompat('0.1.0', '0.0.0');
  assert.equal(v.ok, false, '0.0.0 是正经可比的版本，不是"放行"的信号');
  assert.equal((v as { reason?: string }).reason, 'too-old');
});

// ---------------- ② 接线用例（相对当前版本构造夹具） ----------------

test('装载闸：核心版本不满足 minCore ⇒ 拒装 + 留审计（CONTRACT_MISMATCH）', async () => {
  const dir = makePlugin('needs-newer', INCOMPATIBLE);
  await assert.rejects(
    () => manager.install(dir, { source: 'local:default' }),
    (e: unknown) => {
      assert.ok(e instanceof SpcError, '应当是结构化错误');
      assert.equal((e as { code: string }).code, 'CONTRACT_MISMATCH');
      const params = (e as { params?: { minCore?: string; core?: string } }).params ?? {};
      assert.equal(params.minCore, INCOMPATIBLE);
      assert.equal(params.core, VERSION);
      return true;
    },
  );

  const view = manager.list().find((v) => v.ref === 'local:default/' + id('needs-newer'));
  if (view) assert.notEqual(view.state, 'running', '被兼容闸拒掉的插件不许是 running');

  const rows = auditEntries().filter((e) => e.method === 'lifecycle.load');
  const refused = rows.filter((e) => e.error?.code === 'CONTRACT_MISMATCH');
  assert.equal(refused.length >= 1, true, '应当留一条 CONTRACT_MISMATCH 的 lifecycle.load');
  assert.equal(refused[0]!.detail?.minCore, INCOMPATIBLE);
  assert.equal(refused[0]!.detail?.core, VERSION);
  assert.equal(refused[0]!.result, 'error');
});

// ---------------- ③ 正向用例 ----------------

test('装载闸：满足 minCore ⇒ 照常装载（闸不能把正常插件也拦了）', async () => {
  const dir = makePlugin('ok-compat', VERSION);
  const view = await manager.install(dir, { source: 'local:default' });
  assert.equal(view.state, 'running', `${VERSION} 满足 ${VERSION}`);
  await manager.uninstall(view.ref);
});

test('装载闸：不声明 compat ⇒ 照常装载', async () => {
  const dir = makePlugin('no-compat');
  const view = await manager.install(dir, { source: 'local:default' });
  assert.equal(view.state, 'running');
  await manager.uninstall(view.ref);
});
