// 权限点元测试：**每个点的 `{scope, grant}` 必须与这份显式清单一致**。
//
// 为什么要有它（用户点名的那个坑）：`scope` 判定错了就是**安卓传感器权限那种坑**——
// "一个碰得到别人的能力被划成拒绝不了的 self"，界面上看不出来、判定链也不会报错。
// 所以这里用**显式清单**：改任何一个点的 scope/grant，都必须同时改这张表，
// 而改这张表会在 review 里被看见。**这不是"跑得过就行"的一致性检查，是一份需要人签字的清单。**
//
// 加新权限点时必须做的三件事：① 注册表里加；② 这张表里加；③ 想清楚它为什么是这个档
// （档位定义见 core/permissions/registry.ts 的 `Grant`）。
//
// ⚠️ **本测试必须对"机器上装了什么"不敏感**：`exec.template.*` 是内置模板**运行时**按
// `resolveExecutable` 的结果注册的（装了 git 才有 `exec.template.git.*`）⇒ 断言里
// **不能出现具体的模板点名字**，只能断言"这类点必须是 host/explicit"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registry } from '../permissions/registry';
import type { Grant, Scope } from '../permissions/registry';

/** API 面（`@host/api` 的方法组）的档位清单——这 17 个是**稳定契约**，与机器无关 */
const API_POINTS: Record<string, { scope: Scope; grant: Grant }> = {
  // ── self / auto：够不着别人 ⇒ 免声明、免授予、安装即用 ──
  // 判据：输入是调用方给的、输出还给调用方；不持有跨调用状态；碰不到别人的数据。
  'kv.read': { scope: 'self', grant: 'auto' },
  'kv.write': { scope: 'self', grant: 'auto' },
  'bytes.encode': { scope: 'self', grant: 'auto' },
  'bytes.decode': { scope: 'self', grant: 'auto' },
  'url.parse': { scope: 'self', grant: 'auto' },
  'url.encode': { scope: 'self', grant: 'auto' },
  'zlib.compress': { scope: 'self', grant: 'auto' },
  'zlib.decompress': { scope: 'self', grant: 'auto' },
  'crypto.hash': { scope: 'self', grant: 'auto' },
  'crypto.random': { scope: 'self', grant: 'auto' },
  'crypto.cipher': { scope: 'self', grant: 'auto' },
  'timers.schedule': { scope: 'self', grant: 'auto' },
  'events.publish': { scope: 'self', grant: 'auto' },
  'lifecycle.version': { scope: 'self', grant: 'auto' },
  'lifecycle.health': { scope: 'self', grant: 'auto' },
  // ── fs：**待讨论项**（用户 2026-09-18 定："fs 先不动，仅 self + 仅自身目录"）──
  // 语义上的张力：它们碰的是宿主文件系统里的真实文件 ⇒ 按 `scope` 的定义像 host；
  // 而 `grant: install`（要声明、安装即生效、可一键收回）正是"宿主资源但属于该插件"那一档。
  // 「内容式权限」（按路径/内容而不是按方法名划权）要单独讨论，见 `_audit/batch-4-plan.md` §2.3。
  // 在那之前保持现状：**self + auto = 免声明**，不引入新摩擦（真实插件几乎必然用 fs）。
  'fs.read.data': { scope: 'self', grant: 'auto' },
  'fs.write.data': { scope: 'self', grant: 'auto' },
};

const isExecPoint = (name: string) => name.startsWith('exec.template.');

test('API 面权限点：注册表与显式清单**逐项相等**（改 scope/grant 必须改这张表）', () => {
  const actual: Record<string, { scope: Scope; grant: Grant }> = {};
  for (const p of registry.all()) {
    if (isExecPoint(p.name)) continue; // 模板点按机器不同（见文件头）
    actual[p.name] = { scope: p.scope, grant: p.grant ?? 'auto' };
  }
  assert.deepEqual(actual, API_POINTS, 'API 面档位与显式清单不一致（见本文件顶部说明）');
});

test('清单与注册表无悬空项；点数变化必须显式改（防悄悄新增）', () => {
  const registered = new Set(registry.all().map((p) => p.name));
  for (const name of Object.keys(API_POINTS)) {
    assert.ok(registered.has(name), `清单里的 ${name} 已不在注册表——删点时要同步删表`);
  }
  assert.equal(Object.keys(API_POINTS).length, 17, 'API 面点数变了就要显式改这个数字');
});

test('`exec.template.*`（机器相关）：**必须是 host/explicit**——命令执行是提权面', () => {
  const execPoints = registry.all().filter((p) => isExecPoint(p.name));
  for (const p of execPoints) {
    assert.equal(p.scope, 'host', `${p.name}：exec 模板碰的是宿主进程，必须是 host`);
    assert.equal(p.grant, 'explicit', `${p.name}：exec 必须逐点授予（默认拒绝）`);
  }
  // 一个都没有也算通过（机器上没装 git/nginx 时就是这个状态）
});

test('不变式：`self ⇒ auto`（注册期已挡，这里确认注册结果自洽）', () => {
  for (const p of registry.all()) {
    if (p.scope === 'self') {
      assert.equal(p.grant, 'auto', `${p.name}：self 点只能是 auto`);
    }
  }
});

test('不变式：`host` 点**一律不能是 auto**（host 免声明就等于没闸）', () => {
  for (const p of registry.all()) {
    if (p.scope === 'host') {
      assert.notEqual(p.grant, 'auto', `${p.name}：host 点不能免声明`);
    }
  }
});
