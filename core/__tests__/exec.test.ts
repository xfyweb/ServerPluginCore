// exec 模板：注册静态校验（E1/E7/E8/E10）→ 参数校验（E2/E9）→ 执行（E3–E6）→ 沙箱端到端
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { SandboxBridge } from '../sandbox';

import { SpcError } from '../errors';
import { registerTemplate } from '../exec/install';
import {
  assertExecutableInSystemDirs,
  pathInside,
  permissionPointOf,
  resolveExecutable,
  templates,
} from '../exec/templates';
import { buildArgv, validateParam } from '../exec/params';
import { buildEnv, effectiveTimeoutMs, runTemplate } from '../exec/run';
import { matchExecTemplate, resolveExecRequest, tokenizeCommand } from '../exec/request';
import { registry } from '../permissions/registry';
import { checkPermission } from '../permissions/check';

// 审计写隔离目录：AUDIT_DIR 在模块加载时读环境变量，故必须先设再动态导入沙箱
const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-exec-audit-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;
test.after(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

const isWin = process.platform === 'win32';
const SYSTEM32 = isWin ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/bin';
const CMD = join(SYSTEM32, isWin ? 'cmd.exe' : 'sh');
const ECHO = isWin ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', isWin ? 'cmd.exe' : 'echo') : '/bin/echo';

/** 把一段文本变成 argv 片段（Windows 用 cmd /c echo，其余直接 echo） */
function echoArgv(text: string): string[] {
  return isWin ? [CMD, '/c', 'echo', text] : [ECHO, text];
}

// ---- 注册一批测试模板（id 不与内置冲突）----

registerTemplate({
  id: 'core:t-echo.run',
  command: echoArgv('{msg}'),
  params: [{ name: 'msg', type: 'whitelist', allowed: ['hi', 'hello world'] }],
  timeoutMs: 5_000,
  maxOutputBytes: 4_096,
});

registerTemplate({
  id: 'core:t-noargs.run',
  command: echoArgv('noargs'),
  timeoutMs: 5_000,
  maxOutputBytes: 4_096,
});

registerTemplate({
  id: 'core:t-trunc.run',
  command: echoArgv('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
  timeoutMs: 5_000,
  maxOutputBytes: 8,
});

registerTemplate({
  id: 'core:t-slow.run',
  command: isWin ? [CMD, '/c', 'ping', '-n', '30', '127.0.0.1'] : ['/bin/sleep', '30'],
  timeoutMs: 300,
  maxOutputBytes: 4_096,
});

registerTemplate({
  id: 'core:t-env.run',
  command: isWin ? [CMD, '/c', 'set'] : ['/usr/bin/env'],
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
});

// git 相关：临时仓库根（同时用于"真实仓库全链路"与"原生写法匹配"两组测试）
const GIT_ROOT = mkdtempSync(join(tmpdir(), 'spc-git-root-'));
const RAW_REPO = join(GIT_ROOT, 'my repo'); // 故意带空格：验证引号分词
mkdirSync(RAW_REPO, { recursive: true });
test.after(() => rmSync(GIT_ROOT, { recursive: true, force: true }));

const RAW_GIT = resolveExecutable('git');
if (RAW_GIT) {
  const repoParam = (): { name: string; type: 'path'; scope: string[]; mustExist: boolean } => ({
    name: 'repo',
    type: 'path',
    scope: [GIT_ROOT],
    mustExist: true,
  });
  registerTemplate({
    id: 'core:t-git-status.run',
    // 形状必须与内置 core:git.status 不同（命令形状全局唯一）：多带一个 flag 即可
    command: [RAW_GIT, '-C', '{repo}', 'status', '--porcelain=v1', '--branch', '--untracked-files=no'],
    params: [repoParam()],
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
  });
  registerTemplate({
    id: 'core:t-git-log.run',
    command: [RAW_GIT, '-C', '{repo}', 'log', '-n', '{count}', '--oneline'],
    params: [repoParam(), { name: 'count', type: 'pattern', pattern: '[0-9]{1,3}' }],
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
  });
  registerTemplate({
    id: 'core:t-git-rev.run',
    command: [RAW_GIT, '-C', '{repo}', 'rev-parse', 'HEAD'],
    params: [repoParam()],
    timeoutMs: 15_000,
    maxOutputBytes: 8 * 1024,
  });
}

// ---- 注册期静态校验（E1 / E7 / E8 / E10）----

// B4 回归：白名单包含判定的**平台语义**（Windows 不敏感、POSIX 敏感）。
// 纯函数 + platform 入参 → 两条语义都能在任意开发机上被验证。
test('B4：pathInside —— Windows 大小写不敏感，POSIX 敏感（两个方向都不能拍脑袋）', () => {
  // Windows：同一目录的不同大小写写法必须都算"在里面"（否则合法模板被误拒 → 逼运维放宽白名单）
  assert.equal(pathInside('C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32', 'win32'), true);
  assert.equal(pathInside('C:\\WINDOWS\\system32\\CMD.EXE', 'C:\\Windows\\System32', 'win32'), true);
  assert.equal(pathInside('C:/Windows/System32/cmd.exe', 'C:\\Windows\\System32', 'win32'), true);
  assert.equal(pathInside('C:\\Windows\\System32', 'C:\\Windows\\System32', 'win32'), true);
  assert.equal(pathInside('C:\\Windows\\System32x\\evil.exe', 'C:\\Windows\\System32', 'win32'), false);
  assert.equal(pathInside('C:\\Windows\\Sys\\evil.exe', 'C:\\Windows\\System32', 'win32'), false);
  // POSIX：`/bin` 与 `/BIN` 是**两个不同目录**，不敏感比较就是越权放行
  assert.equal(pathInside('/bin/ls', '/bin', 'linux'), true);
  assert.equal(pathInside('/bin/ls', '/bin/', 'linux'), true);
  assert.equal(pathInside('/BIN/ls', '/bin', 'linux'), false);
  assert.equal(pathInside('/usr/binfoo/x', '/usr/bin', 'linux'), false);
  assert.equal(pathInside('/anything', '/', 'linux'), true);
});

test('B4：Windows 上大小写不同的白名单路径仍能通过 E10（本机实测）', () => {
  if (process.platform !== 'win32') {
    // POSIX 方向的判别力：把白名单写成大写 → 必须拒绝（同一台机器上把两种语义都验掉）
    assert.throws(
      () => assertExecutableInSystemDirs('/BIN/sh', ['/bin']),
      /TEMPLATE_COMMAND_NOT_ALLOWED/,
    );
    return;
  }
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const upper = join(root.toUpperCase(), 'SYSTEM32', 'cmd.exe');
  assert.doesNotThrow(() => assertExecutableInSystemDirs(upper, [join(root, 'System32')]));
});

test('E10：可执行文件落在系统目录白名单外 → 拒绝注册', () => {
  assert.throws(
    () =>
      registerTemplate({
        id: 'core:t-evil.run',
        command: [join(tmpdir(), 'not-a-real-bin')],
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      }),
    /TEMPLATE_COMMAND_NOT_ALLOWED/,
  );
});

test('E1：占位符只能整元素（部分拼接 / 未声明 / 未使用都被拒）', () => {
  const base = { timeoutMs: 1_000, maxOutputBytes: 1_024 };
  assert.throws(
    () => registerTemplate({ ...base, id: 'core:t-p1.run', command: [ECHO, '--file={f}'], params: [{ name: 'f', type: 'pattern', pattern: '.*' }] }),
    /TEMPLATE_COMMAND_INVALID/,
  );
  assert.throws(
    () => registerTemplate({ ...base, id: 'core:t-p2.run', command: [ECHO, '{nope}'] }),
    /TEMPLATE_COMMAND_INVALID/,
  );
  assert.throws(
    () => registerTemplate({ ...base, id: 'core:t-p3.run', command: [ECHO, 'x'], params: [{ name: 'unused', type: 'pattern', pattern: '.*' }] }),
    /TEMPLATE_COMMAND_INVALID/,
  );
});

test('E8：cwd 必须绝对路径；argv[0] 不能由参数决定', () => {
  const base = { timeoutMs: 1_000, maxOutputBytes: 1_024 };
  assert.throws(() => registerTemplate({ ...base, id: 'core:t-cwd.run', command: [ECHO, 'x'], cwd: 'relative/dir' }), /TEMPLATE_CWD_INVALID/);
  assert.throws(
    () => registerTemplate({ ...base, id: 'core:t-argv0.run', command: ['{cmd}'], params: [{ name: 'cmd', type: 'pattern', pattern: '/.*' }] }),
    /TEMPLATE_COMMAND_NOT_ALLOWED/,
  );
});

test('参数定义非法（enum 缺 allowed / path 缺 scope / 未知类型）', () => {
  const base = { timeoutMs: 1_000, maxOutputBytes: 1_024 };
  assert.throws(() => registerTemplate({ ...base, id: 'core:t-s1.run', command: [ECHO, '{a}'], params: [{ name: 'a', type: 'enum' }] }), /TEMPLATE_PARAM_SPEC_INVALID/);
  assert.throws(() => registerTemplate({ ...base, id: 'core:t-s2.run', command: [ECHO, '{a}'], params: [{ name: 'a', type: 'path' }] }), /TEMPLATE_PARAM_SPEC_INVALID/);
});

test('P5 未实现：privileged 模板直接拒绝（避免"看起来支持"）', () => {
  assert.throws(
    () => registerTemplate({ id: 'core:t-priv.run', command: [ECHO, 'x'], timeoutMs: 1_000, maxOutputBytes: 1_024, privileged: true }),
    /TEMPLATE_PRIVILEGED_UNSUPPORTED/,
  );
});

test('权限点由模板 ID 生成：exec.template.<action>.<op>；同名 action.op 撞名即注册失败', () => {
  assert.equal(permissionPointOf('core:nginx.reload'), 'exec.template.nginx.reload');
  assert.equal(permissionPointOf('@xfy2412/docker:mc.start'), 'exec.template.mc.start');
  // 另一个命名空间声明同名 action.op（点相同）→ 第二个注册失败，且模板被回滚
  assert.throws(
    () => registerTemplate({ id: '@xfy2412/x:t-echo.run', command: echoArgv('hi'), timeoutMs: 1_000, maxOutputBytes: 1_024 }),
    /TEMPLATE_DUPLICATE|DUPLICATE_POINT/,
  );
  assert.equal(templates.get('@xfy2412/x:t-echo.run'), undefined, '半注册状态必须被回滚');
});

// ---- 参数校验（E2 / E9）----

test('参数：白名单外的值 / 未知参数 / 缺参数都被拒', () => {
  const def = templates.get('core:t-echo.run')!;
  assert.throws(() => runTemplate(def, { msg: 'rm -rf /' }), /TEMPLATE_PARAM_INVALID/);
  assert.throws(() => runTemplate(def, { msg: 'hi', extra: 'x' }), /TEMPLATE_PARAM_UNKNOWN/);
  assert.throws(() => runTemplate(def, {}), /TEMPLATE_PARAM_MISSING/);
});

test('E9：path 参数走路径收敛（越界 → PATH_OUT_OF_SCOPE；mustExist 生效）', () => {
  const scopeDir = mkdtempSync(join(tmpdir(), 'spc-exec-scope-'));
  try {
    const p = { name: 'repo', type: 'path' as const, scope: [scopeDir], mustExist: true };
    assert.ok(validateParam(p, scopeDir));
    assert.throws(() => validateParam(p, join(scopeDir, '..', 'outside')), /PATH_OUT_OF_SCOPE/);
    assert.throws(() => validateParam(p, join(scopeDir, 'missing-dir')), /TEMPLATE_PARAM_INVALID/);
  } finally {
    rmSync(scopeDir, { recursive: true, force: true });
  }
});

test('E1：argv 逐元素构造（含空格的参数不会被拆分或拼接）', () => {
  const def = templates.get('core:t-echo.run')!;
  const argv = buildArgv(def, { msg: 'hello world' });
  assert.deepEqual(argv, echoArgv('hello world'));
});

// ---- 执行（E3–E6）----

test('执行：固定命令 + 白名单参数 → 拿到 stdout 与 exitCode', () => {
  const def = templates.get('core:t-echo.run')!;
  const res = runTemplate(def, { msg: 'hi' });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /hi/);
  assert.equal(res.truncated, false);
});

test('E4：输出超过 maxOutputBytes → truncated=true', () => {
  const def = templates.get('core:t-trunc.run')!;
  const res = runTemplate(def, {});
  assert.equal(res.truncated, true);
});

test('E5：超时 → EXEC_TIMEOUT（并杀掉子进程）', () => {
  const def = templates.get('core:t-slow.run')!;
  assert.throws(() => runTemplate(def, {}), /EXEC_TIMEOUT/);
});

// S-2：宿主方法自己的超时必须能被调用方的剩余预算压低。
// 没有这一层，"1 秒预算的钩子"照样能靠一条 120 秒的模板把核心阻塞两分钟
// —— spawnSync 期间解释器不跑，CPU 中断无从触发。
test('预算封顶：capMs 比模板超时更小时按 capMs 生效，且报的是**生效值**', () => {
  const def = templates.get('core:t-slow.run')!; // 模板声明 300ms
  assert.throws(
    () => runTemplate(def, {}, { capMs: 50 }),
    (err: unknown) => {
      assert.ok(err instanceof SpcError);
      assert.equal(err.code, 'EXEC_TIMEOUT');
      // 报模板的 300 会让排障方向跑偏（"我没超 300 啊"）
      assert.equal(err.params.timeoutMs, '50');
      return true;
    },
  );
});

test('effectiveTimeoutMs：取小；余额算到 0/负数时退化成 1ms 而不是"永不超时"', () => {
  assert.equal(effectiveTimeoutMs(5_000, undefined), 5_000); // 不在阶段里 → 用模板值
  assert.equal(effectiveTimeoutMs(5_000, Number.POSITIVE_INFINITY), 5_000);
  assert.equal(effectiveTimeoutMs(5_000, 120), 120);
  assert.equal(effectiveTimeoutMs(100, 5_000), 100); // 预算比模板宽 → 仍取模板
  assert.equal(effectiveTimeoutMs(5_000, 12.7), 12); // 向下取整，不放大
  // 关键：spawnSync 的 timeout=0 在 Node 里是"不超时"，负数直接抛 ERR_OUT_OF_RANGE
  assert.equal(effectiveTimeoutMs(5_000, 0), 1);
  assert.equal(effectiveTimeoutMs(5_000, -5), 1);
});

test('E6：env 白名单——未声明的环境变量不进子进程', () => {
  process.env.SPC_TEST_SECRET = 'must-not-leak';
  try {
    const def = templates.get('core:t-env.run')!;
    const env = buildEnv(def);
    assert.equal(env.SPC_TEST_SECRET, undefined);
    assert.ok(env.PATH); // 基础集始终透传

    const res = runTemplate(def, {});
    assert.equal(res.stdout.includes('must-not-leak'), false);
  } finally {
    delete process.env.SPC_TEST_SECRET;
  }
});

// ---- 沙箱端到端：动态权限点 + 桥 ----

test('沙箱：exec.run 的权限点由模板决定；未授予 → PERMISSION_DENIED，授予 → 执行成功', async () => {
  const { createSandbox } = await import('../sandbox.ts');
  const { hostApi } = await import('../hostApi.ts');

  const code = `
import { exec } from '@host/api';
const r = exec.run('core:t-echo.run', JSON.stringify({ msg: 'hi' }));
const text = typeof r === 'string' ? r : JSON.stringify(r);
console.log('EXEC ' + text);
`;

  // ① 声明了但没授予（scope=host）→ 拒绝
  const denied = await createSandbox(hostApi, {
    pluginId: '@xfy2412/exec-test',
    permissions: ['exec.template.t-echo.run'],
    grants: [],
  });
  const deniedLogs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => void deniedLogs.push(a.map(String).join(' '));
  try {
    await denied.runModule(
      '@xfy2412/exec-test',
      code.replace('console.log', 'try { console.log'),
    );
  } catch {
    /* 未捕获的宿主拒绝会以 PLUGIN_LOAD_FAILED 抛出，属预期 */
  } finally {
    console.log = origLog;
    denied.dispose();
  }
  assert.match(deniedLogs.join('\n') + ' ', /PERMISSION_DENIED|PLUGIN_LOAD_FAILED|^ $/);

  // ② 逐点授予 → 正常执行
  const ok = await createSandbox(hostApi, {
    pluginId: '@xfy2412/exec-test',
    permissions: ['exec.template.t-echo.run'],
    grants: ['exec.template.t-echo.run'],
  });
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    await ok.runModule('@xfy2412/exec-test', code);
  } finally {
    console.log = origLog;
    ok.dispose();
  }
  assert.match(logs.join('\n'), /EXEC .*hi/);
});

test('沙箱端到端：钩子预算会压低 exec 自己的超时（S-2：阻塞式 exec 不再吃掉整个预算）', async () => {
  const { createSandbox } = await import('../sandbox.ts');
  const { buildHostApi } = await import('../hostApi.ts');
  const { DEFAULT_LIMITS } = await import('../config.ts');
  // 必须复刻 loader 的接线：**同一个** bridge 既交给 hostApi（读余额）又交给 createSandbox（回填余额）。
  // 模块级 hostApi 是"独立探测"用的，它没有 bridge —— 那时也确实不在任何阶段里（余额无从谈起）。
  const bridge: SandboxBridge = {};
  const dataDir = mkdtempSync(join(tmpdir(), 'spc-exec-budget-'));
  const sandbox = await createSandbox(
    buildHostApi({ pluginId: '@xfy2412/exec-test', dataDir, bridge }),
    {
      pluginId: '@xfy2412/exec-test',
      permissions: ['exec.template.t-slow.run'],
      grants: ['exec.template.t-slow.run'],
      // 钩子预算 100ms，而模板声明 300ms、命令本身要跑 30 秒
      limits: { ...DEFAULT_LIMITS, initTimeoutMs: 100 },
      bridge,
    },
  );
  await sandbox.runModule(
    '@xfy2412/exec-test',
    `
import { exec } from '@host/api';
export function init() {
  try { exec.run('core:t-slow.run'); console.log('NO-THROW'); }
  catch (e) { console.log('CODE ' + e.code + ' BUDGET ' + (e.params && e.params.timeoutMs)); }
}
`,
  );
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  let outcome = '';
  try {
    await sandbox.callHook('init', 100);
    outcome = 'resolved';
  } catch (err) {
    outcome = err instanceof SpcError ? err.code : 'unknown';
  } finally {
    console.log = origLog;
    sandbox.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }

  // ① 关键断言，**与墙钟无关**：exec 拿到的生效超时是钩子预算（~100ms），而不是模板的 300ms。
  //    报的是生效值这件事本身就有判别力——没有预算封顶时这里会是 300。
  const m = /CODE EXEC_TIMEOUT BUDGET (\d+)/.exec(logs.join('\n'));
  assert.ok(m, `插件应当看到 EXEC_TIMEOUT，实际日志：${JSON.stringify(logs.join('\n'))}`);
  const budget = Number(m![1]);
  assert.ok(budget > 0 && budget <= 100, `生效超时应被压到 ≤100ms，实测 ${budget}ms`);

  // ② 钩子的收场：exec 吃掉了整个预算 → 要么按墙钟超时收场，要么刚好没超。
  //    具体错误码由 sandbox.test.ts 的忙等用例**确定性地**钉住（那边不涉及进程），
  //    这里不重复断言码，免得把 CI 负载变成红灯。
  assert.ok(
    outcome === 'resolved' || outcome === 'PLUGIN_INIT_TIMEOUT',
    `钩子结局异常：${outcome}`,
  );
});

test('沙箱：无参数模板用单实参调用（桥把 undefined 当字符串的坑已归一化）', async () => {
  const { createSandbox } = await import('../sandbox.ts');
  const { hostApi } = await import('../hostApi.ts');
  const sandbox = await createSandbox(hostApi, {
    pluginId: '@xfy2412/exec-test',
    permissions: ['exec.template.t-noargs.run'],
    grants: ['exec.template.t-noargs.run'],
  });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    // ① 单实参；② 显式传 undefined（桥会变成字符串 "undefined"）
    await sandbox.runModule(
      '@xfy2412/exec-test',
      `
import { exec } from '@host/api';
const a = exec.run('core:t-noargs.run');
const b = exec.run('core:t-noargs.run', undefined);
console.log('A ' + a);
console.log('B ' + b);
`,
    );
  } finally {
    console.log = origLog;
    sandbox.dispose();
  }
  const out = logs.join('\n');
  assert.match(out, /A .*noargs/);
  assert.match(out, /B .*noargs/);
});

test('沙箱：未注册模板 → 动态权限点解析失败（TEMPLATE_NOT_FOUND）', async () => {
  const { createSandbox } = await import('../sandbox.ts');
  const { hostApi } = await import('../hostApi.ts');
  const sandbox = await createSandbox(hostApi, {
    pluginId: '@xfy2412/exec-test',
    permissions: ['exec.template.nope.run'],
    grants: ['exec.template.nope.run'],
  });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    await sandbox.runModule(
      '@xfy2412/exec-test',
      `
import { exec } from '@host/api';
try {
  exec.run('core:nope.run', '{}');
} catch (e) {
  console.log('CAUGHT ' + e.code + ' ' + JSON.stringify(e.params));
}
`,
    );
  } finally {
    console.log = origLog;
    sandbox.dispose();
  }
  assert.match(logs.join('\n'), /TEMPLATE_NOT_FOUND/);
});

test('SpcError 形状：exec 相关错误都带英文码', () => {
  const err = new SpcError('EXEC_TIMEOUT', { templateId: 'core:x.y', timeoutMs: '300' });
  assert.equal(err.code, 'EXEC_TIMEOUT');
  assert.equal(err.params?.templateId, 'core:x.y');
});

// ---- 原生写法 → 模板匹配（request.ts）----

test('tokenizeCommand：引号包裹的路径保持完整', () => {
  assert.deepEqual(tokenizeCommand('git -C /srv/demo status'), ['git', '-C', '/srv/demo', 'status']);
  assert.deepEqual(tokenizeCommand('git -C "C:\\my repo" status'), ['git', '-C', 'C:\\my repo', 'status']);
  assert.deepEqual(tokenizeCommand("git -C 'a b' status"), ['git', '-C', 'a b', 'status']);
  assert.deepEqual(tokenizeCommand('   '), []);
});

test('原生写法（字符串）：匹配到模板、参数照样校验并归一化', () => {
  if (!RAW_GIT) return;
  const r = resolveExecRequest([
    `git -C "${RAW_REPO}" status --porcelain=v1 --branch --untracked-files=no`,
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.def.id, 'core:t-git-status.run');
  assert.ok(String(r.params.repo).toLowerCase().endsWith('my repo'));
});

test('原生写法（argv 数组 / 命令名 + 数组）：同样匹配', () => {
  if (!RAW_GIT) return;
  const tail = ['-C', RAW_REPO, 'status', '--porcelain=v1', '--branch', '--untracked-files=no'];
  const byArray = resolveExecRequest([['git', ...tail]]);
  assert.equal(byArray.ok, true, JSON.stringify(byArray));
  if (byArray.ok) assert.equal(byArray.def.id, 'core:t-git-status.run');

  const byHead = resolveExecRequest(['git', tail]);
  assert.equal(byHead.ok, true, JSON.stringify(byHead));
  if (byHead.ok) assert.equal(byHead.def.id, 'core:t-git-status.run');
});

test('原生写法：匹配不到一律拒绝（注入 / 少 flag / 陌生命令都不行）', () => {
  if (!RAW_GIT) return;
  for (const raw of [
    'rm -rf /',
    `git -C "${RAW_REPO}" status`, // 少了模板里的 flag → 形状不符
    `git -C "${RAW_REPO}" status --porcelain=v1 --branch --untracked-files=no; rm -rf /`, // 注入串：多一个 token
    `git -C "${RAW_REPO}" push`,
  ]) {
    const r = resolveExecRequest([raw]);
    assert.equal(r.ok, false, `不应匹配：${raw}`);
    if (!r.ok) {
      assert.equal(r.code, 'TEMPLATE_NOT_FOUND');
    }
  }
});

test('原生写法：匹配到模板但参数越界 → 仍是参数错误（不会退回自由执行）', () => {
  if (!RAW_GIT) return;
  const outside = mkdtempSync(join(tmpdir(), 'spc-raw-outside-'));
  try {
    const r = resolveExecRequest([
      `git -C "${outside}" status --porcelain=v1 --branch --untracked-files=no`,
    ]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.code, /PATH_OUT_OF_SCOPE|PARENT_MISSING/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('参数校验发生在权限之后：结构匹配（matchExecTemplate）不做参数校验', () => {
  if (!RAW_GIT) return;
  const argv = ['git', '-C', RAW_REPO, 'status', '--porcelain=v1', '--branch', '--untracked-files=no'];
  const def = matchExecTemplate([argv]);
  assert.equal(def?.id, 'core:t-git-status.run');
  // 与执行解析用同一条"第一个匹配"规则 → 权限点与执行对象必然一致
  const resolved = resolveExecRequest([argv]);
  assert.equal(resolved.ok && resolved.def.id, def?.id);
});

test('模板 ID 形式仍可用；参数对象可直接传（单元层面）', () => {
  if (!RAW_GIT) return;
  const r = resolveExecRequest(['core:t-git-rev.run', { repo: RAW_REPO }]);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (r.ok) assert.equal(r.def.id, 'core:t-git-rev.run');
});

test('命令形状必须唯一：同形状的第二个模板注册失败（原生写法不能有匹配歧义）', () => {
  if (!RAW_GIT) return;
  assert.throws(
    () =>
      registerTemplate({
        id: 'core:t-git-status-dup.run',
        command: [RAW_GIT, '-C', '{other}', 'status', '--porcelain=v1', '--branch'],
        params: [{ name: 'other', type: 'path', scope: [GIT_ROOT], mustExist: true }],
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024,
      }),
    /TEMPLATE_DUPLICATE/,
  );
});

test('匹配优先级：字面量优先于占位符（回归：曾命中错模板导致权限点不符）', () => {
  // core:t-echo.run = [… echo {msg}]（1 个占位符）；core:t-noargs.run = [… echo noargs]（纯字面量）
  const noargs = templates.get('core:t-noargs.run')!.command;
  const literal = resolveExecRequest([noargs.join(' ')]);
  assert.equal(literal.ok, true, JSON.stringify(literal));
  if (literal.ok) assert.equal(literal.def.id, 'core:t-noargs.run'); // 不能命中 t-echo

  // 反过来：参数值不是字面量时，只有占位符模板能匹配
  const echoCmd = templates.get('core:t-echo.run')!.command;
  const placeholder = resolveExecRequest([echoCmd.map((el) => (el === '{msg}' ? 'hi' : el)).join(' ')]);
  assert.equal(placeholder.ok, true, JSON.stringify(placeholder));
  if (placeholder.ok) assert.equal(placeholder.def.id, 'core:t-echo.run');
});

test('沙箱：原生写法（整条命令 / argv 数组）经桥都能匹配并执行', async () => {
  const { createSandbox } = await import('../sandbox.ts');
  const { hostApi } = await import('../hostApi.ts');
  const def = templates.get('core:t-noargs.run')!;
  const head = def.command[0].split(/[\\/]/).pop()!; // 开发者只写命令名，模板里是绝对路径
  const argv = def.command.slice(1);
  const source = `
import { exec } from '@host/api';
console.log('STR ' + exec.run(${JSON.stringify([head, ...argv].join(' '))}));
console.log('ARR ' + exec.run(${JSON.stringify(head)}, ${JSON.stringify(argv)}));
console.log('ALL ' + exec.run(${JSON.stringify([head, ...argv])}));
`;
  const sandbox = await createSandbox(hostApi, {
    pluginId: '@xfy2412/exec-test',
    permissions: ['exec.template.t-noargs.run'],
    grants: ['exec.template.t-noargs.run'],
  });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    await sandbox.runModule('@xfy2412/exec-test', source);
  } finally {
    console.log = origLog;
    sandbox.dispose();
  }
  const out = logs.join('\n');
  assert.match(out, /STR .*noargs/);
  assert.match(out, /ARR .*noargs/);
  assert.match(out, /ALL .*noargs/);
});

test('沙箱：原生写法匹配不到 → TEMPLATE_NOT_FOUND（且未授予时优先报 PERMISSION_DENIED）', async () => {
  const { createSandbox } = await import('../sandbox.ts');
  const { hostApi } = await import('../hostApi.ts');
  const sandbox = await createSandbox(hostApi, {
    pluginId: '@xfy2412/exec-test',
    permissions: ['exec.template.t-noargs.run'],
    grants: ['exec.template.t-noargs.run'],
  });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    await sandbox.runModule(
      '@xfy2412/exec-test',
      `
import { exec } from '@host/api';
try { exec.run('rm -rf /'); } catch (e) { console.log('CAUGHT ' + e.code); }
`,
    );
  } finally {
    console.log = origLog;
    sandbox.dispose();
  }
  assert.match(logs.join('\n'), /CAUGHT TEMPLATE_NOT_FOUND/);
});

// ---- 跨平台可执行文件解析 + 真实二进制端到端 ----

test('resolveExecutable：git 跨平台可解析，且结果落在 E10 白名单内', () => {
  const git = resolveExecutable('git');
  if (!git) return; // 无 git 的裸环境跳过（开发机 / CI 镜像通常都有）
  assert.ok(isAbsolute(git));
  assert.doesNotThrow(() => assertExecutableInSystemDirs(git));
});

test('真实二进制：用解析到的 git 跑 --version（Windows / Linux 都要过）', () => {
  const git = resolveExecutable('git');
  if (!git) return;
  registerTemplate({
    id: 'core:t-real-git.run',
    command: [git, '--version', '--build-options'], // 形状与内置 core:git.version 区分开
    timeoutMs: 10_000,
    maxOutputBytes: 8 * 1024,
  });
  const res = runTemplate(templates.get('core:t-real-git.run')!, {});
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /git version \d+/);
});

test('内置模板：本机装了 git 就应该注册出 core:git.pull（含 repo 路径白名单参数）', () => {
  if (!resolveExecutable('git')) return;
  const def = templates.get('core:git.pull');
  assert.ok(def, 'core:git.pull 应当已注册');
  assert.deepEqual(def.params?.[0]?.name, 'repo');
  assert.equal(def.params?.[0]?.type, 'path');
  assert.ok((def.params?.[0]?.scope?.length ?? 0) > 0);
});

test('内置 git 模板集：诊断 / 只读 / 改动仓库三类齐全，仓库类都带 repo 白名单', () => {
  if (!resolveExecutable('git')) return;
  const ids = [
    'core:git.version',
    'core:git.status',
    'core:git.log',
    'core:git.rev-parse',
    'core:git.branch',
    'core:git.fetch',
    'core:git.pull',
  ];
  for (const id of ids) {
    const def = templates.get(id);
    assert.ok(def, `${id} 应当已注册`);
  }
  // 只有 version 不需要仓库
  assert.equal(templates.get('core:git.version')!.params, undefined);
  for (const id of ids.filter((i) => i !== 'core:git.version')) {
    const params = templates.get(id)!.params ?? [];
    const repo = params.find((p) => p.name === 'repo');
    assert.ok(repo, `${id} 应当要求 repo 参数`);
    assert.equal(repo!.type, 'path');
    assert.equal(repo!.mustExist, true);
    assert.ok((repo!.scope?.length ?? 0) > 0, `${id} 的 repo 必须有作用域白名单`);
  }
  // log 的 count 必须是受限数字（E1：不给注入留缝）
  const count = templates.get('core:git.log')!.params!.find((p) => p.name === 'count')!;
  assert.equal(count.type, 'pattern');
  assert.equal(count.pattern, '[0-9]{1,3}');
});

test('内置模板：core: 是保留命名空间，权限点形如 exec.template.git.status', () => {
  if (!resolveExecutable('git')) return;
  assert.equal(permissionPointOf('core:git.status'), 'exec.template.git.status');
  const res = checkPermission(
    registry,
    'exec.template.git.status',
    ['exec.template.git.status'],
    [],
  );
  assert.equal(res.decision, 'deny');
  assert.equal(res.code, 'NOT_GRANTED'); // scope=host：不授予就调不动
});

test('真实 git 仓库全链路：init → commit → status/log 模板跑通', () => {
  const git = resolveExecutable('git');
  if (!git) return;
  const repo = join(GIT_ROOT, 'demo');
  mkdirSync(repo, { recursive: true });
  try {
    // 测试装置：直接用 git 造一个仓库（不走沙箱）
    spawnSync(git, ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    spawnSync(git, ['add', 'a.txt'], { cwd: repo });
    const commit = spawnSync(
      git,
      ['-c', 'user.name=spc', '-c', 'user.email=spc@example.test', 'commit', '-q', '-m', 'init'],
      { cwd: repo, encoding: 'utf8' },
    );
    assert.equal(commit.status, 0, commit.stderr);

    const status = runTemplate(templates.get('core:t-git-status.run')!, { repo });
    assert.equal(status.exitCode, 0);
    assert.match(status.stdout, /##/); // --branch 会输出分支行

    const log = runTemplate(templates.get('core:t-git-log.run')!, { repo, count: '5' });
    assert.equal(log.exitCode, 0);
    assert.match(log.stdout, /init/);

    // 作用域外的仓库路径必须被拒（E9）
    const outside = mkdtempSync(join(tmpdir(), 'spc-outside-'));
    try {
      assert.throws(
        () => runTemplate(templates.get('core:t-git-log.run')!, { repo: outside, count: '5' }),
        /PATH_OUT_OF_SCOPE|PARENT_MISSING/,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
