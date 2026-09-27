// E10 白名单的**符号链接语义**（2026-09-27 修"Linux 上 exec.test.ts 整文件崩"带出来的）
//
// 现场：`/bin/echo` 在 WSL 上 realpath 到 `/usr/lib/cargo/bin/coreutils/echo`（rust coreutils 的布局），
// 旧实现只比 realpath ⇒ 把它判成 `outside-system-dirs`，于是测试文件在顶层 `registerTemplate` 就抛，
// **整个 exec.test.ts 39 条用例塌成 1 条**（这也是 Linux 套件少 38 条的原因）。
//
// 判据（两条都要有判别力）：
//   · 白名单目录里的**符号链接**（字面在目录内、realpath 在目录外）⇒ **必须接受**（修复前必红）；
//   · 白名单**外**的路径、以及用 `..` 装成"在目录内"的路径 ⇒ **必须拒绝**（防这次放宽把闸门开大）。
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertExecutableInSystemDirs, pathInside } from '../exec/templates';

const isWin = process.platform === 'win32';
const root = mkdtempSync(join(tmpdir(), 'spc-e10-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

/**
 * 造一个"系统目录 + 目录外的真身"布局（跨平台可测，不依赖本机真实布局）：
 *   <root>/sys/linked  →  <root>/real/tool      （符号链接：字面在 sys 内，realpath 在外）
 *   <root>/sys/plain                              （普通文件：两条判定都在内）
 */
function makeLayout(): { sys: string; outside: string; linked: string; plain: string } {
  const sys = join(root, 'sys');
  const real = join(root, 'real');
  mkdirSync(sys, { recursive: true });
  mkdirSync(real, { recursive: true });
  const target = join(real, 'tool');
  writeFileSync(target, '#!/bin/sh\nexit 0\n');
  if (!isWin) chmodSync(target, 0o755);
  const linked = join(sys, 'linked');
  // Windows 建符号链接要特权 ⇒ 那边改用"硬链接/拷贝"没有意义，直接跳过该布局
  if (!isWin) symlinkSync(target, linked);
  const plain = join(sys, 'plain');
  writeFileSync(plain, '#!/bin/sh\nexit 0\n');
  if (!isWin) chmodSync(plain, 0o755);
  return { sys, outside: target, linked, plain };
}

// ⚠️ **只建一次**：每个用例各建一次会在第二次 `symlinkSync` 上撞 `EEXIST`（踩过）
const L = makeLayout();

test('E10：白名单目录里的**符号链接**要接受（字面在目录内、realpath 在目录外）', { skip: isWin }, () => {
  const { sys, linked } = L;
  // 修复前：只比 realpath ⇒ 这里必抛 outside-system-dirs（本用例就是那条 bug 的判别对）
  assert.doesNotThrow(() => assertExecutableInSystemDirs(linked, [sys]));
});

test('E10：白名单**外**的真身仍然拒（不是"凡链接都放行"）', () => {
  const { sys, outside } = L;
  assert.throws(
    () => assertExecutableInSystemDirs(outside, [sys]),
    /TEMPLATE_COMMAND_NOT_ALLOWED/,
  );
});

test('E10：用 `..` 装成"在白名单目录内"必须拒（这条守住上面那次放宽）', () => {
  const { sys, outside } = L;
  // 字面以 `<sys>/` 开头，但归一后是白名单外的真身 —— 只看 startsWith 就会漏
  // ⚠️ 必须**手工拼分隔符**：`path.join` 自带 normalize，`..` 会被吃掉，这条用例就废了（踩过）
  const disguised = [sys, '..', 'real', 'tool'].join(sep);
  assert.equal(pathInside(disguised, sys), true, '前提：未归一前它"看起来"在目录内');
  assert.throws(() => assertExecutableInSystemDirs(disguised, [sys]), /TEMPLATE_COMMAND_NOT_ALLOWED/);
});

test('E10：普通文件（两条判定都在内）照旧放行', () => {
  const { sys, plain } = L;
  assert.doesNotThrow(() => assertExecutableInSystemDirs(plain, [sys]));
});

test('E10：本机真实的 `/bin/echo`（Linux 上的 rust-coreutils 布局）必须能注册', { skip: isWin }, () => {
  // 这条不注入白名单，走 `executableAllowlist()` 的真值 —— 它就是这次事故的原样复现
  assert.doesNotThrow(() => assertExecutableInSystemDirs('/bin/echo'));
});
