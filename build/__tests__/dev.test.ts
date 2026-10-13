// `spcdev watch` / `dev` 的用例（纯编排逻辑：去抖、串行、失败不 reload、忽略产物目录）。
// ⚠️ 用例**不真起 watcher、不真跑构建**：那些是 `cli.ts` 的接线，真 watcher 的行为由 chokidar 保证。
// 这里钉的是**我们自己的那部分**：什么时候重建、失败怎么办、连按保存会不会触发 N 次。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const { isSourceChange, isWatchedPath, decideSandbox, createDevSession, parseDevMarker, isProcessAlive } =
  await import('../dev.ts');

test('开发沙箱判据：没装 ⇒ 自己装；装的就是这个目录 ⇒ 用；指向别处 ⇒ 只警告；多来源 ⇒ 不猜', () => {
  const other = join('D:', 'box', 'plugin', 'other');
  // ① 一个都没装 ⇒ 装进缺省源
  assert.deepEqual(decideSandbox([], '@std/demo', ROOT), { kind: 'auto-install', origin: 'local:default' });
  assert.deepEqual(
    decideSandbox([{ ref: 'local:default/@std/other', id: '@std/other', dir: other }], '@std/demo', ROOT),
    { kind: 'auto-install', origin: 'local:default' },
    '别的插件装了不算',
  );
  // ② 就地装在这个目录（路径经 resolve 归一）
  assert.deepEqual(decideSandbox([{ ref: 'local:default/@std/demo', id: '@std/demo', dir: ROOT }], '@std/demo', ROOT), {
    kind: 'reuse',
    ref: 'local:default/@std/demo',
  });
  // ③ 指向别处（别的目录 / `.spc` 的托管副本）⇒ 只警告，不替他重装
  assert.deepEqual(decideSandbox([{ ref: 'local:default/@std/demo', id: '@std/demo', dir: other }], '@std/demo', ROOT), {
    kind: 'foreign',
    ref: 'local:default/@std/demo',
    dir: other,
  });
  // ④ **没给 --source** 且同一 id 装在多个来源下 ⇒ 不猜，让调用方提示用 `--source` 选一个
  assert.deepEqual(
    decideSandbox(
      [
        { ref: 'local:default/@std/demo', id: '@std/demo', dir: ROOT },
        { ref: 'local:b/@std/demo', id: '@std/demo', dir: other },
      ],
      '@std/demo',
      ROOT,
    ),
    { kind: 'ambiguous', refs: ['local:b/@std/demo', 'local:default/@std/demo'] },
  );
  // ⑤ **给了 --source** ⇒ 钉死在那个源：别的源同名的一律不管（身份是 (origin, id)）
  assert.deepEqual(
    decideSandbox(
      [
        { ref: 'local:default/@std/demo', id: '@std/demo', dir: other },
        { ref: 'local:b/@std/demo', id: '@std/demo', dir: ROOT },
      ],
      '@std/demo',
      ROOT,
      'local:b',
    ),
    { kind: 'reuse', ref: 'local:b/@std/demo' },
    '钉死 local:b：那里就地装着 ⇒ 直接用，哪怕 local:default 下也有一份',
  );
  assert.deepEqual(
    decideSandbox([{ ref: 'local:default/@std/demo', id: '@std/demo', dir: ROOT }], '@std/demo', ROOT, 'local:b'),
    { kind: 'auto-install', origin: 'local:b' },
    '钉死 local:b：那里没装 ⇒ 装进 local:b（不沿用 local:default 那份）',
  );
  // ⑥ 没给 --source 但只装在一个**非缺省**源 ⇒ 沿用那个源（不凭空多出一份记录）
  assert.deepEqual(
    decideSandbox([{ ref: 'local:b/@std/demo', id: '@std/demo', dir: ROOT }], '@std/demo', ROOT),
    { kind: 'reuse', ref: 'local:b/@std/demo' },
  );
});

const ROOT = join('D:', 'box', 'plugin', 'demo');
const p = (...segs: string[]) => join(ROOT, ...segs);
/** 让去抖定时器与微任务跑一轮（debounceMs=0，所以 5ms 足够） */
const tick = () => new Promise((r) => setTimeout(r, 5));

test('watcher 判据：**根目录必须放行**（否则 chokidar 连下降都不下降）', () => {
  assert.equal(isWatchedPath(ROOT, ROOT), true, '根目录放行 —— 这条错了就是"改文件毫无反应"');
  assert.equal(isWatchedPath(ROOT, p('main.ts')), true);
  assert.equal(isWatchedPath(ROOT, p('dist', 'bundle.js')), false);
  assert.equal(isWatchedPath(ROOT, p('release', 'x.spc')), false);
});

test('start()：进来先建一次（此时可能还没产物）', async () => {
  const h = harness();
  const started = h.session.start();
  await tick();
  assert.deepEqual(h.builds, [0], 'start 应当立刻建一次');
  h.releaseOne();
  await started;
  assert.equal(h.reloads.length, 1, '建完也走一次重载');
  await h.session.close();
});

test('开发标记：形状不对就当没有（宁可不清理，也不拿坏标记去卸东西）', () => {
  const good = { ref: 'local:default/@std/demo', pid: 1234, at: '2026-10-13T00:00:00.000Z' };
  assert.deepEqual(parseDevMarker(JSON.stringify(good)), good);
  assert.equal(parseDevMarker('不是 JSON'), null);
  assert.equal(parseDevMarker('{}'), null);
  assert.equal(parseDevMarker(JSON.stringify({ ...good, ref: '' })), null, 'ref 空 ⇒ 不认');
  assert.equal(parseDevMarker(JSON.stringify({ ...good, pid: 0 })), null, 'pid 必须是正整数');
  assert.equal(parseDevMarker(JSON.stringify({ ...good, pid: 1.5 })), null);
  assert.equal(parseDevMarker(JSON.stringify({ ...good, at: 123 })), null);
  assert.equal(isProcessAlive(process.pid), true, '自己一定活着');
  assert.equal(isProcessAlive(0x7ffffffe), false, '这个 pid 不该存在');
});

test('哪些改动算源码改动：产物 / 工具态 / 依赖 / 版本库 / 发布物都排除', () => {
  assert.equal(isSourceChange(ROOT, p('main.ts')), true);
  assert.equal(isSourceChange(ROOT, p('web', 'index.html')), true);
  assert.equal(isSourceChange(ROOT, p('manifest.json')), true);

  assert.equal(isSourceChange(ROOT, p('dist', 'bundle.js')), false, '构建产物自己不该触发重建');
  assert.equal(isSourceChange(ROOT, p('.spcdev', 'keys', 'author.key')), false);
  assert.equal(isSourceChange(ROOT, p('node_modules', 'x', 'index.js')), false);
  assert.equal(isSourceChange(ROOT, p('.git', 'HEAD')), false);
  assert.equal(isSourceChange(ROOT, p('release', 'demo-0.0.1.spc')), false, '发布物不算');
  assert.equal(isSourceChange(ROOT, p('demo-0.0.1.spc')), false, '丢在别处的 .spc 也不算');
  assert.equal(isSourceChange(ROOT, join('D:', 'elsewhere', 'x.ts')), false, '根目录外的不算');
  assert.equal(isSourceChange(ROOT, ROOT), false, '根目录本身的目录事件不算');
});

/**
 * 受控会话：每次 build 都**卡在一道闸门上**，用例放行一次才继续。
 * 这样才能观察"构建在飞时又来改动"的行为（也就是"连按保存会不会触发 N 次"）。
 */
function harness(opts: { buildCodes?: number[]; autoReload?: boolean } = {}) {
  const builds: number[] = [];
  const reloads: number[] = [];
  const logs: string[] = [];
  const gates: (() => void)[] = [];

  const session = createDevSession({
    root: ROOT,
    debounceMs: 0,
    autoReload: opts.autoReload !== false,
    io: {
      build: async () => {
        const code = opts.buildCodes?.[builds.length] ?? 0;
        builds.push(code);
        await new Promise<void>((ok) => gates.push(ok));
        return code;
      },
      reload: async () => {
        reloads.push(1);
        return { code: 0, text: '' };
      },
      onBuilt: (ms) => logs.push(`built:${ms}`),
      onBuildFailed: (code) => logs.push(`build-failed:${code}`),
      onReloaded: () => logs.push('reloaded'),
      onReloadFailed: (code, text) => logs.push(`reload-failed:${code}:${text}`),
      now: () => 0,
    },
  });
  return { session, builds, reloads, logs, releaseOne: () => gates.shift()?.(), gates };
}

test('改动 ⇒ 先重建、后重载（顺序不能反）', async () => {
  const h = harness();
  h.session.changed(p('main.ts'));
  await tick();
  assert.deepEqual(h.builds, [0], '应当已经在构建');
  h.releaseOne();
  await h.session.idle();
  assert.equal(h.reloads.length, 1, '构建成功才重载');
  assert.ok(h.logs.includes('built:0'), `日志：${h.logs.join(' | ')}`);
  assert.ok(h.logs.includes('reloaded'));
  await h.session.close();
});

test('构建失败 ⇒ **不重载**，而且不停（改好下一次自动再来）', async () => {
  const h = harness({ buildCodes: [1, 0] });
  h.session.changed(p('main.ts'));
  await tick();
  h.releaseOne();
  await h.session.idle();
  assert.deepEqual(
    h.logs.filter((l) => l.startsWith('build-failed')),
    ['build-failed:1'],
  );
  assert.equal(h.reloads.length, 0, '失败不许 reload（否则等于把一个坏包推上去）');

  h.session.changed(p('main.ts'));
  await tick();
  h.releaseOne();
  await h.session.idle();
  assert.deepEqual(h.builds, [1, 0]);
  assert.equal(h.reloads.length, 1, '第二次构建成功后才重载');
  await h.session.close();
});

test('非源码改动（产物目录）不触发任何事', async () => {
  const h = harness();
  h.session.changed(p('dist', 'bundle.js'));
  h.session.changed(p('release', 'demo-0.0.1.spc'));
  await h.session.idle();
  assert.deepEqual(h.builds, [], '一次构建都不该有');
  assert.deepEqual(h.reloads, []);
  await h.session.close();
});

test('重建在飞时又来改动 ⇒ 只**排队一次**（连按保存不会触发 N 次构建）', async () => {
  const h = harness();
  h.session.changed(p('main.ts'));
  await tick(); // 第一次构建开始，卡在闸门上
  assert.deepEqual(h.builds, [0]);

  h.session.changed(p('main.ts'));
  h.session.changed(p('a.ts'));
  h.session.changed(p('b.ts'));
  await tick();
  assert.deepEqual(h.builds, [0], '在飞期间不该再开新的构建');

  h.releaseOne(); // 放行第一次
  await tick();
  assert.deepEqual(h.builds, [0, 0], '三次改动只补一次构建');
  h.releaseOne(); // 放行排队的那一次
  await h.session.idle();
  assert.equal(h.reloads.length, 2, '两次构建各重载一次');
  await h.session.close();
});

test('--no-reload：只重建，不碰 daemon（作者想自己 reload）', async () => {
  const h = harness({ autoReload: false });
  h.session.changed(p('main.ts'));
  await tick();
  h.releaseOne();
  await h.session.idle();
  assert.deepEqual(h.builds, [0]);
  assert.deepEqual(h.reloads, [], '不许重载');
  await h.session.close();
});

test('close 之后不再响应改动（Ctrl+C 之后不该还在跑构建）', async () => {
  const h = harness();
  h.session.changed(p('main.ts'));
  // close 会**取消还没触发的那次去抖**（作者按了 Ctrl+C，就别再开新构建了）；
  // 已经在飞的那次不会被砍，而是等它跑完。
  await h.session.close();
  assert.deepEqual(h.builds, [], '还没开始的构建应当被取消');
  h.session.changed(p('main.ts'));
  h.session.changed(p('other.ts'));
  await tick();
  assert.deepEqual(h.builds, [], 'close 之后的改动一律不理');
  assert.deepEqual(h.reloads, []);
});

test('close 时**在飞的那次**要跑完（不能砍在半路）', async () => {
  const h = harness();
  h.session.changed(p('main.ts'));
  await tick(); // 构建已开始，卡在闸门上
  assert.deepEqual(h.builds, [0]);
  let closed = false;
  const closing = h.session.close().then(() => (closed = true));
  await tick();
  assert.equal(closed, false, 'close 应当等这次构建结束');
  h.releaseOne();
  await closing;
  assert.equal(closed, true, '构建结束后 close 才返回');
  assert.equal(h.reloads.length, 1, '在飞的那次照常走完（含 reload）');
});
