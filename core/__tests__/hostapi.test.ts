// 宿主 API 行为测试（P1.5 补的 kv / timers / events / lifecycle / fs.read·list·stat）
//
// 与 exec.test.ts 的分工：那边测 exec 模板与原生写法匹配，这边测"插件真的能用这些 API 干什么、
// 越界会怎样"。全部走**真实装载链路**（manager.install → 沙箱 → 钩子），不直接调宿主函数——
// 只有这样才能同时验证权限点、桥的 JSON 编解码、以及 ctx 注入。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-hostapi-'));
process.env.SPC_STATE_DIR = TMP;
process.env.SPC_AUDIT_DIR = join(TMP, 'audit');

const { manager } = await import('../plugin/manager.ts');
const { SpcError } = await import('../errors.ts');
// 动态导入（不是静态）：静态导入会被提升到上面两行环境变量赋值之前
const { createKvStore } = await import('../hostApi.ts');

const id = (n: string) => `@spc/${n}`;
const sanitized = (p: string) => p.replace(/^@/, '').replace(/\//g, '__');
const dataPath = (pluginId: string, file: string) =>
  join(TMP, 'data', 'plugins', sanitized(pluginId), file);

function readData(pluginId: string, file: string): string {
  return readFileSync(dataPath(pluginId, file), 'utf8');
}

/** 读插件 kv（宿主侧文件；用来断言插件在沙箱里写了什么） */
function readKv(pluginId: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(dataPath(pluginId, 'kv.json'), 'utf8')) as {
    values: Record<string, unknown>;
  };
  return raw.values;
}

function makePlugin(
  name: string,
  code: string,
  opts: { permissions?: string[]; exports?: Record<string, unknown> } = {},
): string {
  const dir = join(TMP, 'plugins', name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schema: 2,
    id: id(name),
    name: `Host ${name}`,
    version: { code: 1, name: '0.0.1' },
    runtime: { type: 'quickjs', esm: true },
    permissions: (
      opts.permissions ?? [
        'fs.write.data',
        'fs.read.data',
        'kv.read',
        'kv.write',
        'timers.schedule',
        'events.publish',
        'lifecycle.version',
        'lifecycle.health',
      ]
    ).map((n) => ({ name: n })),
    exports: {
      // topic 必须每个插件唯一（能力登记：同一 topic 只能有一个发布者），
      // 且段名只允许 [a-z][a-z0-9]*（不能有连字符）——所以要去掉名字里的 '-'
      events: { publish: [{ topic: `host.${name.replace(/-/g, '')}.tick`, classification: 'public' }] },
      ...(opts.exports ?? {}),
    },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(join(dir, 'main.ts'), code, 'utf8');
  return dir;
}

async function rejects(fn: () => unknown, code: string): Promise<void> {
  let caught: unknown;
  let thrown = false;
  try {
    await fn();
  } catch (err) {
    caught = err;
    thrown = true;
  }
  assert.ok(thrown, `期望被拒（${code}），但调用成功了`);
  assert.ok(caught instanceof SpcError, `期望 SpcError，实际 ${String(caught)}`);
  assert.equal((caught as InstanceType<typeof SpcError>).code, code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(() => {
  mkdirSync(join(TMP, 'plugins'), { recursive: true });
  mkdirSync(join(TMP, 'audit'), { recursive: true });
});

after(async () => {
  await manager.stopAll('shutdown');
  manager.resetMemory();
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* Windows 上沙箱句柄未释放会 EPERM：尽力清理即可 */
  }
});

test('fs：写/读/列/查都在数据目录内，相对路径按数据目录解析', async () => {
  const dir = makePlugin(
    'fs',
    `import { fs } from '@host/api';
     export function init(){
       const w = fs.write('sub/a.txt', 'hello');
       const r = fs.read('sub/a.txt');
       const s = fs.stat('sub/a.txt');
       const l = fs.list('.');
       const st = fs.stat('sub');
       fs.write('probe.json', JSON.stringify({
         wBytes: w.bytes, rContent: r.content, rBytes: r.bytes,
         size: s.size, isFile: s.isFile, isDir: s.isDirectory,
         entries: l.entries.map(function(e){ return e.name + ':' + e.type; }).sort(),
         subIsDir: st.isDirectory,
       }));
     }`,
  );
  const view = await manager.install(dir);
  assert.equal(view.state, 'running');
  const probe = JSON.parse(readData(id('fs'), 'probe.json')) as Record<string, unknown>;
  assert.equal(probe.wBytes, 5);
  assert.equal(probe.rContent, 'hello');
  assert.equal(probe.rBytes, 5);
  assert.equal(probe.size, 5);
  assert.equal(probe.isFile, true);
  assert.equal(probe.isDir, false);
  assert.equal(probe.subIsDir, true);
  // probe.json 是最后才写的，所以列目录时只看到刚建出来的 sub
  assert.deepEqual(probe.entries, ['sub:dir']);
  await manager.disable(id('fs'));
});

test('fs：越界（数据目录之外）一律 PATH_OUT_OF_SCOPE，插件按 code 分支', async () => {
  const dir = makePlugin(
    'fs-escape',
    `import { fs } from '@host/api';
     export function init(){
       const codes = [];
       const cases = ['/etc/passwd', '../escape.txt', 'sub/../../escape.txt'];
       for (const p of cases) {
         try { fs.write(p, 'x'); codes.push(p + '=NO-ERROR'); }
         catch (e) { codes.push(p + '=' + e.code); }
       }
       try { fs.read('/etc/passwd'); codes.push('read=NO-ERROR'); }
       catch (e) { codes.push('read=' + e.code); }
       fs.write('codes.txt', codes.join('|'));
     }`,
  );
  await manager.install(dir);
  const codes = readData(id('fs-escape'), 'codes.txt').split('|');
  assert.deepEqual(codes, [
    '/etc/passwd=PATH_OUT_OF_SCOPE',
    '../escape.txt=PATH_OUT_OF_SCOPE',
    'sub/../../escape.txt=PATH_OUT_OF_SCOPE',
    'read=PATH_OUT_OF_SCOPE',
  ]);
  // 逃逸文件绝不能真的被建出来
  assert.equal(existsSync(join(TMP, 'data', 'plugins', 'escape.txt')), false);
  await manager.disable(id('fs-escape'));
});

test('fs：读取上限 1MB（FILE_TOO_LARGE）——大内容进不了 32MiB 的沙箱堆', async () => {
  const dir = makePlugin(
    'fs-big',
    `import { fs } from '@host/api';
     export function init(){
       let code = 'NO-ERROR';
       try { fs.read('big.bin'); } catch (e) { code = e.code; }
       fs.write('code.txt', code);
     }`,
  );
  // 宿主先造一个 2MB 的文件放进数据目录（模拟"插件自己之前写大的"）
  const dataDir = join(TMP, 'data', 'plugins', sanitized(id('fs-big')));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'big.bin'), 'x'.repeat(2 * 1024 * 1024), 'utf8');
  await manager.install(dir);
  assert.equal(readData(id('fs-big'), 'code.txt'), 'FILE_TOO_LARGE');
  await manager.disable(id('fs-big'));
});

test('kv：对象/数组/数字/布尔都能存取，delete 幂等，keys 有序', async () => {
  const dir = makePlugin(
    'kv',
    `import { kv } from '@host/api';
     export function init(){
       kv.set('obj', { a: 1, nested: { b: [2, 3] } });
       kv.set('num', 42);
       kv.set('flag', true);
       kv.set('str', 'text');
       const back = kv.get('obj');
       const first = kv.delete('num');
       const second = kv.delete('num');
       kv.set('probe', {
         a: back.a, nested: back.nested.b[1],
         numGone: kv.get('num') === undefined,
         firstExisted: first.existed, secondExisted: second.existed,
         keys: kv.keys(),
       });
     }`,
  );
  await manager.install(dir);
  // 探针写在 kv 里（这个插件没用 fs，读文件会 ENOENT）
  const probe = readKv(id('kv')).probe as Record<string, unknown>;
  assert.equal(probe.a, 1);
  assert.equal(probe.nested, 3);
  assert.equal(probe.numGone, true);
  assert.equal(probe.firstExisted, true);
  assert.equal(probe.secondExisted, false);
  // keys() 在 set('probe') 之前求值，所以不含 probe 自己
  assert.deepEqual(probe.keys, ['flag', 'obj', 'str']);
  // 落盘的是真值，不是字符串
  assert.deepEqual(readKv(id('kv')).obj, { a: 1, nested: { b: [2, 3] } });
  await manager.disable(id('kv'));
});

test('kv：**总容量**受限（KV_TOTAL_LIMIT_EXCEEDED），且已有键不受影响', async () => {
  const dir = makePlugin(
    'kv-total',
    `import { kv } from '@host/api';
     export function init(){
       const codes = [];
       let n = 0;
       const chunk = 'y'.repeat(250 * 1024);   // 单值 250KB（低于单值上限 256KB）
       for (let i = 0; i < 60; i++) {
         try { kv.set('k' + i, chunk); n++; }
         catch (e) { codes.push('total=' + e.code); break; }
       }
       kv.set('probe', { n: n, codes: codes.join('|'), first: (kv.get('k0') || '').length });
     }`,
  );
  await manager.install(dir);
  const probe = readKv(id('kv-total')).probe as Record<string, unknown>;
  // 8MiB / 250KB ≈ 33 个：写到第 34 个左右必须被拒，而不是把 256MB 的理论上限当空气
  assert.ok(Number(probe.n) >= 30 && Number(probe.n) <= 34, `实际写入 ${probe.n} 个`);
  assert.equal(probe.codes, 'total=KV_TOTAL_LIMIT_EXCEEDED');
  // 超限只拒新写入，已存的值照旧可读（不是把整个 kv 废掉）
  assert.equal(probe.first, 250 * 1024);
  await manager.disable(id('kv-total'));
});

test('kv：合并写 —— 同一阶段内多次 set 只落盘一次，阶段结束（钩子返回）时数据已在文件里', async () => {
  const dir = makePlugin(
    'kv-coalesce',
    `import { kv } from '@host/api';
     export function init(){
       for (let i = 0; i < 5; i++) kv.set('k' + i, i);
     }`,
  );
  await manager.install(dir);
  // install 返回 = init 阶段已结束：5 次 set 全部落盘（这就是"阶段边界落盘"的验收点）
  const values = readKv(id('kv-coalesce'));
  for (let i = 0; i < 5; i++) assert.equal(values[`k${i}`], i);
  await manager.disable(id('kv-coalesce'));
});

// ---- kv 落盘策略（内部单元：写放大与原子性都是"整文件重写"逼出来的） ----

test('createKvStore：set 只标脏不落盘，flushNow 才写，且内容是原子替换的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spc-kv-store-'));
  try {
    const store = createKvStore(dir);
    store.set('a', 1, 1);
    store.set('b', 2, 1);
    // 同步块里没有 await → setImmediate 还没机会跑：文件此刻必须**不存在**
    // （这条断言就是"合并写"的判据；退化成"每次 set 立即重写整文件"它会立刻失败）
    assert.equal(existsSync(join(dir, 'kv.json')), false, 'set 不该立即落盘');
    assert.equal(store.read().a, 1, '读走内存，写没落盘也要能读到');

    store.flushNow();
    const onDisk = JSON.parse(readFileSync(join(dir, 'kv.json'), 'utf8')) as { values: Record<string, unknown> };
    assert.deepEqual(onDisk.values, { a: 1, b: 2 });
    // 原子替换：不留半截临时文件
    assert.equal(existsSync(join(dir, 'kv.json.tmp')), false, '不该留下 .tmp');

    // 没改动时 flushNow 是空操作（不会白写一遍）
    const before = readFileSync(join(dir, 'kv.json'), 'utf8');
    store.flushNow();
    assert.equal(readFileSync(join(dir, 'kv.json'), 'utf8'), before);

    // 总预算按值核算：写入即超限时拒绝，且不污染已有键
    const store2 = createKvStore(dir);
    assert.throws(
      () => store2.set('big', 'x', 9 * 1024 * 1024),
      (err: unknown) => (err as { code?: string }).code === 'KV_TOTAL_LIMIT_EXCEEDED',
    );
    assert.equal(store2.read().big, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kv：键名与值大小受限（KV_KEY_INVALID / KV_VALUE_TOO_LARGE）', async () => {
  const dir = makePlugin(
    'kv-limit',
    `import { kv } from '@host/api';
     export function init(){
       const codes = [];
       try { kv.set('bad key!', 1); codes.push('key=NO-ERROR'); } catch (e) { codes.push('key=' + e.code); }
       try { kv.set('ok', 'y'.repeat(300 * 1024)); codes.push('value=NO-ERROR'); } catch (e) { codes.push('value=' + e.code); }
       try { kv.get('bad key!'); codes.push('get=NO-ERROR'); } catch (e) { codes.push('get=' + e.code); }
       kv.set('codes', codes.join('|'));
     }`,
  );
  await manager.install(dir);
  assert.equal(
    readKv(id('kv-limit')).codes,
    'key=KV_KEY_INVALID|value=KV_VALUE_TOO_LARGE|get=KV_KEY_INVALID',
  );
  await manager.disable(id('kv-limit'));
});

test('kv：跨 reload 持久（宿主侧作用域存储，不是内存表）', async () => {
  const dir = makePlugin(
    'kv-persist',
    `import { kv } from '@host/api';
     export function init(){
       const n = (kv.get('runs') || 0) + 1;
       kv.set('runs', n);
     }`,
  );
  await manager.install(dir);
  assert.equal(readKv(id('kv-persist')).runs, 1);
  await manager.reload(id('kv-persist'));
  assert.equal(readKv(id('kv-persist')).runs, 2);
  await manager.disable(id('kv-persist'));
});

test('events：只能发布 manifest 声明过的 topic（声明即审核面）', async () => {
  const dir = makePlugin(
    'events',
    `import { events } from '@host/api';
     export function init(){
       const r = events.publish('host.events.tick', { n: 1 });
       let undeclared = 'NO-ERROR';
       try { events.publish('host.secret', { n: 1 }); } catch (e) { undeclared = e.code; }
       events.publish('host.events.tick', { probe: [r.ok, r.topic, r.bytes, undeclared] });
     }`,
  );
  await manager.install(dir);
  // 最后一条 publish 的 payload 不落盘（总线是 P2），所以这里改从审计侧验证"非法 topic 被拒"
  const audit = readFileSync(join(TMP, 'audit', 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { pluginId: string; method: string; result: string; error?: { code: string } });
  const denied = audit.filter((e) => e.pluginId === id('events') && e.method === 'events.publish' && e.result === 'error');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].error?.code, 'EVENT_TOPIC_NOT_DECLARED');
  const ok = audit.filter((e) => e.pluginId === id('events') && e.method === 'events.publish' && e.result === 'ok');
  assert.equal(ok.length, 2);
  await manager.disable(id('events'));
});

test('timers：回调在沙箱内按间隔执行；卸载后宿主自动清掉（不再跑）', async () => {
  const dir = makePlugin(
    'timer',
    `import { kv, timers } from '@host/api';
     export function init(){ kv.set('ticks', 0); }
     export function start(){
       timers.every(150, function () {
         kv.set('ticks', (kv.get('ticks') || 0) + 1);
       });
     }`,
  );
  await manager.install(dir);
  await sleep(600); // 150ms × 4 左右
  const ticks = readKv(id('timer')).ticks as number;
  assert.ok(ticks >= 2, `定时器应至少跑过 2 次，实际 ${ticks}`);

  await manager.disable(id('timer'));
  await sleep(400);
  const afterStop = readKv(id('timer')).ticks as number;
  await sleep(400);
  assert.equal(readKv(id('timer')).ticks, afterStop, '卸载后定时器仍在跑（宿主没清干净）');
});

test('timers：非法间隔被拒（TIMER_INTERVAL_INVALID），回调不是函数也拒', async () => {
  const dir = makePlugin(
    'timer-bad',
    `import { kv, timers } from '@host/api';
     export function init(){
       const codes = [];
       try { timers.every(10, function(){}); codes.push('small=NO-ERROR'); } catch (e) { codes.push('small=' + e.code); }
       try { timers.every(1000, 'not-a-fn'); codes.push('fn=NO-ERROR'); } catch (e) { codes.push('fn=' + e.code); }
       kv.set('codes', codes.join('|'));
     }`,
  );
  await manager.install(dir);
  assert.equal(
    readKv(id('timer-bad')).codes,
    'small=TIMER_INTERVAL_INVALID|fn=TIMER_HANDLER_INVALID',
  );
  await manager.disable(id('timer-bad'));
});

test('lifecycle：version 做契约协商、health 回执（对象返回值被自动解码）', async () => {
  const dir = makePlugin(
    'lc',
    `import { kv, lifecycle } from '@host/api';
     export function init(ctx){
       const v = lifecycle.version();
       const h = lifecycle.health();
       kv.set('probe', { core: v.core, api: v.api, vPlugin: v.pluginId, ok: h.ok, same: h.pluginId === ctx.pluginId });
     }`,
  );
  await manager.install(dir);
  const probe = readKv(id('lc')).probe as Record<string, unknown>;
  assert.equal(typeof probe.core, 'string');
  assert.equal(probe.api, 1);
  assert.equal(probe.vPlugin, id('lc'));
  assert.equal(probe.ok, true);
  assert.equal(probe.same, true);
  await manager.disable(id('lc'));
});

test('权限：方法未在 manifest 声明 → PERMISSION_DENIED（NOT_DECLARED，无默认放行）', async () => {
  // 只声明 fs.write.data，却去调 kv.set
  const dir = makePlugin(
    'perm',
    `import { fs, kv } from '@host/api';
     export function init(){
       let code = 'NO-ERROR';
       try { kv.set('x', 1); } catch (e) { code = e.code; }
       fs.write('code.txt', code);
     }`,
    { permissions: ['fs.write.data'] },
  );
  await manager.install(dir);
  assert.equal(readData(id('perm'), 'code.txt'), 'PERMISSION_DENIED');
  const audit = readFileSync(join(TMP, 'audit', 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { pluginId: string; method: string; result: string; permission?: { code: string } });
  const denied = audit.find((e) => e.pluginId === id('perm') && e.method === 'kv.set');
  assert.equal(denied?.result, 'denied');
  assert.equal(denied?.permission?.code, 'NOT_DECLARED');
  await manager.disable(id('perm'));
});
