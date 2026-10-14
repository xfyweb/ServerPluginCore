// 启动器参数面的守门用例（2026-10-14）。
//
// 三条判据：
//   ① `core/**` 里每个 `process.env.SPC_*` 读取点**都必须在本表里**（kind 标明 ops/internal/test）——
//      以后加变量忘了登记会红；
//   ② 帮助里出现每一个 ops 项（含 `--maintenance`）；
//   ③ 未知参数拒；认识的旗标翻译成环境变量；`--maintenance` 原样留在 argv（核心读它）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { LAUNCH_ARGS, parseLaunchArgs, renderLaunchHelp } = await import('../launch-args.ts');

const REPO = join(import.meta.dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith('.ts') || name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

test('守门：core/** 里读到的每个 SPC_* 变量都必须在这张表里', () => {
  const declared = new Set(LAUNCH_ARGS.map((a) => a.env).filter((e) => e !== ''));
  const found = new Map<string, string>();
  for (const file of sourceFiles(join(REPO, 'core'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/process\.env\.(SPC_[A-Z0-9_]+)/g)) {
      const name = m[1]!;
      if (!found.has(name)) found.set(name, file.slice(REPO.length + 1));
    }
  }
  const missing = [...found.keys()].filter((n) => !declared.has(n)).sort();
  assert.deepEqual(
    missing,
    [],
    '这些变量在代码里被读了、却没登记进 core/launch-args.ts：' + missing.map((n) => `${n}（${found.get(n)}）`).join('、'),
  );
});

test('守门：帮助里出现每个 ops 项，且不含 internal / test 项', () => {
  const help = renderLaunchHelp();
  for (const a of LAUNCH_ARGS.filter((x) => x.kind === 'ops')) {
    const needle = a.boolean === true ? `--${a.flag}` : `--${a.flag}`;
    assert.equal(help.includes(needle), true, '帮助里缺 ' + needle);
  }
  for (const a of LAUNCH_ARGS.filter((x) => x.kind !== 'ops')) {
    assert.equal(help.includes(a.env), false, 'internal/test 项不该进帮助：' + a.env);
  }
});

test('解析：旗标翻译成环境变量（两种写法都认）', () => {
  const a = parseLaunchArgs(['--port', '18888', '--state-dir=/tmp/x']);
  assert.equal(a.ok, true);
  assert.deepEqual((a as { env: Record<string, string> }).env, { SPC_PORT: '18888', SPC_STATE_DIR: '/tmp/x' });
});

test('解析：--maintenance 不进环境变量（留 argv 给核心读）', () => {
  const a = parseLaunchArgs(['--maintenance']);
  assert.equal(a.ok, true);
  assert.deepEqual((a as { env: Record<string, string> }).env, {});
});

test('解析：未知参数一律拒（--prot 这种手滑不许静默生效）', () => {
  const a = parseLaunchArgs(['--prot', '18778']);
  assert.equal(a.ok, false);
  assert.deepEqual((a as { bad: string[] }).bad, ['--prot', '18778']);
  assert.equal(parseLaunchArgs(['--port']).ok, false, '给了旗标却没给值 ⇒ 拒');
});

test('解析：--help / -h 走帮助分支', () => {
  assert.equal((parseLaunchArgs(['--help']) as { help?: boolean }).help, true);
  assert.equal((parseLaunchArgs(['-h']) as { help?: boolean }).help, true);
});
