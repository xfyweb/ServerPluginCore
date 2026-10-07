// events 差分电池（A14–A18 + 既有语义）：同一批剧本分别喂给 shim 与宿主 Node，比"可观测结果"。
// 用法（从仓库根）：node tools/batteries/events-battery.mjs
// 每个用例返回一个字符串签名；不一致就打印双方签名。
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as nodeEvents from 'node:events';
import { SANDBOX_MODULES } from '../paths.mjs';

// 旧实现会把 async 监听器的 rejection 漏成未处理拒绝：别让它打断整轮电池（A16 的失败本身就是证据）
process.on('unhandledRejection', () => {});

const dir = mkdtempSync(join(tmpdir(), 'spc-ev-'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
copyFileSync(SANDBOX_MODULES + '/node-events.js', join(dir, 'node-events.js'));
const shimMod = await import(pathToFileURL(join(dir, 'node-events.js')).href);

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 用例：async (m) => string —— m 是模块命名空间（default=EventEmitter, on/once/errorMonitor…） */
const CASES = [
  // ── A18：构造形态（ES5 继承模式）──
  ['A18 EventEmitter.call(this)', async (m) => {
    const EE = m.default;
    function Foo() {
      EE.call(this);
    }
    Foo.prototype = Object.create(EE.prototype);
    const f = new Foo();
    let seen = '';
    f.on('x', (v) => {
      seen = v;
    });
    f.emit('x', 'ok');
    return `seen=${seen} instanceof=${f instanceof EE}`;
  }],
  ['A18 原型方法可枚举（Node 是普通赋值）', async (m) => {
    const keys = Object.keys(m.default.prototype);
    return ['on', 'emit', 'once', 'removeListener'].map((k) => `${k}=${keys.includes(k)}`).join(',');
  }],
  ['A18 二次 init 不丢监听器', async (m) => {
    const EE = m.default;
    const e = new EE();
    e.on('x', () => {});
    EE.init.call(e); // 有些库会这么干
    return `count=${e.listenerCount('x')}`;
  }],
  ['A18 _eventsCount 维护', async (m) => {
    const e = new m.default();
    e.on('x', () => {});
    e.on('y', () => {});
    e.removeListener('y', e.listeners('y')[0]);
    return `count=${e._eventsCount}`;
  }],

  // ── A14：元事件 ──
  ['A14 newListener 在加入**之前**触发', async (m) => {
    const e = new m.default();
    const log = [];
    e.on('newListener', (type, fn) => log.push(`nl:${String(type)}:${fn.name}:${e.listenerCount(type)}`));
    function handler() {}
    e.on('x', handler);
    return log.join('|') + ` after=${e.listenerCount('x')}`;
  }],
  ['A14 newListener 收到的是 once 的**原函数**', async (m) => {
    const e = new m.default();
    const log = [];
    e.on('newListener', (type, fn) => log.push(`${String(type)}:${fn.name}`));
    function handler() {}
    e.once('x', handler);
    return log.join('|');
  }],
  ['A14 removeListener 在移除**之后**触发', async (m) => {
    const e = new m.default();
    const log = [];
    e.on('removeListener', (type, fn) => log.push(`rl:${String(type)}:${fn.name}:${e.listenerCount(type)}`));
    function handler() {}
    e.on('x', handler);
    e.removeListener('x', handler);
    return log.join('|');
  }],
  ['A14 移除不存在的监听器不发元事件', async (m) => {
    const e = new m.default();
    let n = 0;
    e.on('removeListener', () => n++);
    e.removeListener('x', () => {});
    return `n=${n}`;
  }],
  ['A14 once 自动摘除时也发 removeListener（带原函数）', async (m) => {
    const e = new m.default();
    const log = [];
    e.on('removeListener', (type, fn) => log.push(`${String(type)}:${fn.name}`));
    function handler() {}
    e.once('x', handler);
    e.emit('x');
    return log.join('|') + ` count=${e.listenerCount('x')}`;
  }],
  ['A14 removeAllListeners() 会逐个发 removeListener', async (m) => {
    const e = new m.default();
    const log = [];
    e.on('a', function fa() {});
    e.on('b', function fb() {});
    e.on('removeListener', (type, fn) => log.push(`${String(type)}:${fn.name}`));
    e.removeAllListeners();
    return log.sort().join('|');
  }],

  // ── A15：errorMonitor ──
  ['A15 errorMonitor 无 error 监听器时也收到（且仍然抛）', async (m) => {
    const e = new m.default();
    const log = [];
    e.on(m.errorMonitor, (err) => log.push('mon:' + err.message));
    let thrown = 'none';
    try {
      e.emit('error', new Error('boom'));
    } catch (err) {
      thrown = err.message;
    }
    return `${log.join('|')} thrown=${thrown}`;
  }],
  ['A15 errorMonitor 有 error 监听器时先于它触发', async (m) => {
    const e = new m.default();
    const log = [];
    e.on(m.errorMonitor, () => log.push('mon'));
    e.on('error', () => log.push('handler'));
    e.emit('error', new Error('x'));
    return log.join('|');
  }],
  ['A15 errorMonitor 不吞掉非 error 事件', async (m) => {
    const e = new m.default();
    const log = [];
    e.on(m.errorMonitor, () => log.push('mon'));
    e.emit('x', 1);
    return `${log.length} emit=${e.emit('x', 1)}`;
  }],

  // ── A16：captureRejections ──
  ['A16 async 监听器 rejection 送到 error', async (m) => {
    const e = new m.default({ captureRejections: true });
    const log = [];
    e.on('error', (err) => log.push('err:' + err.message));
    e.on('x', async () => {
      throw new Error('async-boom');
    });
    e.emit('x');
    await tick();
    await tick();
    return log.join('|');
  }],
  ['A16 自定义 rejection 钩子（Symbol.for(nodejs.rejection)）优先', async (m) => {
    const e = new m.default({ captureRejections: true });
    const log = [];
    e[Symbol.for('nodejs.rejection')] = (err, type) => log.push(`rej:${type}:${err.message}`);
    e.on('error', () => log.push('err')); // 不该走到这里
    e.on('x', async () => {
      throw new Error('boom');
    });
    e.emit('x');
    await tick();
    await tick();
    return log.join('|');
  }],
  ['A16 captureRejections 关闭时不路由', async (m) => {
    const e = new m.default();
    let n = 0;
    e.on('error', () => n++);
    e.on('x', async () => {
      throw new Error('boom');
    });
    e.emit('x');
    await tick();
    return `n=${n}`;
  }],
  ['A16 静态 captureRejections 影响新实例', async (m) => {
    const EE = m.default;
    const prev = EE.captureRejections;
    try {
      EE.captureRejections = true;
      const e = new EE();
      const log = [];
      e.on('error', (err) => log.push('err:' + err.message));
      e.on('x', async () => {
        throw new Error('boom');
      });
      e.emit('x');
      await tick();
      await tick();
      return log.join('|');
    } finally {
      EE.captureRejections = prev;
    }
  }],
  ['A16 实例上的 captureRejections 读数', async (m) => {
    const on = new m.default({ captureRejections: true });
    const off = new m.default();
    return `on=${on.captureRejections} off=${off.captureRejections}`;
  }],
  ['A16 同步监听器抛错不被捕获机制吞掉', async (m) => {
    const e = new m.default({ captureRejections: true });
    e.on('x', () => {
      throw new Error('sync-boom');
    });
    let msg = 'none';
    try {
      e.emit('x');
    } catch (err) {
      msg = err.message;
    }
    return msg;
  }],

  // ── A17：静态 on() 迭代器 ──
  ['A17 迭代两个事件后 return 摘掉监听', async (m) => {
    const e = new m.default();
    const it = m.on(e, 'x');
    e.emit('x', 1);
    e.emit('x', 2);
    const a = await it.next();
    const b = await it.next();
    await it.return();
    return `${JSON.stringify(a.value)}|${JSON.stringify(b.value)}|count=${e.listenerCount('x')}`;
  }],
  ['A17 error 事件让挂起的 next() 拒绝', async (m) => {
    const e = new m.default();
    const it = m.on(e, 'x');
    const pending = it.next().then(
      (r) => 'resolved:' + JSON.stringify(r),
      (err) => 'rejected:' + err.message,
    );
    e.emit('error', new Error('boom'));
    return pending;
  }],
  ['A17 error 队列里的错误在下次 next() 时抛出一次', async (m) => {
    const e = new m.default();
    const it = m.on(e, 'x');
    e.emit('error', new Error('boom'));
    const first = await it.next().then(() => 'resolved', (err) => 'rejected:' + err.message);
    const second = await it.next().then((r) => `resolved:${r.done}`, () => 'rejected');
    return `${first}|${second}`;
  }],
  ['A17 throw() 让挂起的 next() 拒绝', async (m) => {
    const e = new m.default();
    const it = m.on(e, 'x');
    const pending = it.next().then(() => 'resolved', (err) => 'rejected:' + err.message);
    it.throw(new Error('manual'));
    return pending;
  }],
  ['A17 throw() 非 Error 参数报错', async (m) => {
    const e = new m.default();
    const it = m.on(e, 'x');
    let sig = 'no-throw';
    try {
      it.throw('nope');
    } catch (err) {
      sig = 'throw:' + (err.code || err.name);
    }
    await it.return();
    return sig;
  }],
  ['A17 on(emitter,"error") 不额外注册 error 监听', async (m) => {
    const e = new m.default();
    const it = m.on(e, 'error');
    const n = e.listenerCount('error');
    await it.return();
    return `count=${n}`;
  }],
  ['A17 迭代器自身可 await for-of', async (m) => {
    const e = new m.default();
    const it = m.on(e, 'x');
    setTimeout(() => {
      e.emit('x', 'a');
      e.emit('x', 'b');
    }, 0);
    const got = [];
    for await (const v of it) {
      got.push(v[0]);
      if (got.length === 2) break;
    }
    return `${got.join(',')} count=${e.listenerCount('x')}`;
  }],

  // ── 既有语义（回归护栏）──
  ['既有 on 返回 this 且 listeners 解包', async (m) => {
    const e = new m.default();
    function f() {}
    const r = e.on('x', f);
    e.once('x', f);
    return `same=${r === e} listeners=${e.listeners('x').length} raw=${e.rawListeners('x').length}`;
  }],
  ['既有 emit 返回有无监听器', async (m) => {
    const e = new m.default();
    const before = e.emit('x');
    e.on('x', () => {});
    return `before=${before} after=${e.emit('x')}`;
  }],
  ['既有 removeAllListeners(undefined) 只删该事件', async (m) => {
    const e = new m.default();
    e.on(undefined, () => {});
    e.on('a', () => {});
    e.removeAllListeners(undefined);
    return `undef=${e.listenerCount(undefined)} a=${e.listenerCount('a')}`;
  }],
  ['既有 listenerCount(type,null) 与不传等价', async (m) => {
    const e = new m.default();
    const f = () => {};
    e.on('x', f);
    e.on('x', f);
    return `${e.listenerCount('x', null)}/${e.listenerCount('x', undefined)}/${e.listenerCount('x', f)}`;
  }],
  ['既有 defaultMaxListeners 惰性继承', async (m) => {
    const EE = m.default;
    const prev = EE.defaultMaxListeners;
    try {
      EE.defaultMaxListeners = 7;
      const e = new EE();
      return `lazy=${e.getMaxListeners()} own=${e.setMaxListeners(3).getMaxListeners()}`;
    } finally {
      EE.defaultMaxListeners = prev;
    }
  }],
  ['既有 defaultMaxListeners 非法值', async (m) => {
    const EE = m.default;
    const prev = EE.defaultMaxListeners;
    let sig = 'no-throw';
    try {
      EE.defaultMaxListeners = -1;
      sig = 'accepted:' + EE.defaultMaxListeners;
    } catch (err) {
      sig = 'throw:' + (err.code || err.name);
    } finally {
      EE.defaultMaxListeners = prev;
    }
    return sig;
  }],
  ['既有 once 静态：事件到达即 resolve', async (m) => {
    const e = new m.default();
    const p = m.once(e, 'x');
    e.emit('x', 1, 2);
    return JSON.stringify(await p);
  }],
  ['既有 once 静态：error 时拒绝', async (m) => {
    const e = new m.default();
    const p = m.once(e, 'x');
    e.emit('error', new Error('nope'));
    return await p.then(() => 'resolved', (err) => 'rejected:' + err.message);
  }],
];

const sig = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    return `THROW:${err && err.code ? err.code : err && err.name}:${err && err.message}`;
  }
};

let bad = 0;
for (const [label, run] of CASES) {
  const got = await sig(() => run(shimMod));
  const want = await sig(() => run(nodeEvents));
  if (got !== want) {
    bad++;
    console.log(`✖ ${label}\n    shim=${got}\n    node=${want}`);
  }
}
console.log(`\n用例 ${CASES.length} 组，分歧 ${bad} 处`);
process.exit(bad ? 1 : 0);
