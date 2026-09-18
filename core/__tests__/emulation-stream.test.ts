// node:stream 仿真（B1）的对齐测试
//
// **验收口径写在这里，因为它是这个模块的核心难点**：我们与 Node 的**事件交错顺序**本来就
// 无法保证（沙箱只有微任务，没有 `nextTick`/`setImmediate` 的区分），所以差分只比：
//   1. **终态**（收集到的数据、拼接结果、`write()` 的返回值序列）；
//   2. **事件集合**（按首次出现的顺序去重后的名字集合，不比对同一 tick 内的交错）；
//   3. **错误码**（`ERR_STREAM_WRITE_AFTER_END` 这类）。
// 另有**结构性断言**（`Stream.call(this)` 可用、`instanceof` 链、别名身份）与**真沙箱冒烟**。
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as hostStream from 'node:stream';
import { pathToFileURL } from 'node:url';

const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-stream-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;
after(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

const { buildHostApi } = await import('../../core/hostApi.ts');
const { buildEnvFacts } = await import('../../core/emulated-env.ts');

const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-shims-stream-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
const SHIM_SRC = join(process.cwd(), 'core', 'sandbox-modules');
for (const f of ['node-stream.js', 'node-events.js', 'node-buffer.js']) {
  copyFileSync(join(SHIM_SRC, f), join(SHIM_DIR, f));
}
after(() => rmSync(SHIM_DIR, { recursive: true, force: true }));

const DATA_DIR = mkdtempSync(join(tmpdir(), 'spc-stream-data-'));
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));
(globalThis as any).__spcEnv = JSON.stringify(buildEnvFacts(DATA_DIR));

const st = await import(pathToFileURL(join(SHIM_DIR, 'node-stream.js')).href);

/** 收集"同一剧本"的终态 + 事件集合（两套实现的收集方式完全一致） */
interface Trace {
  data: string[];
  events: string[];
  returns: boolean[];
}
function mkTrace(): Trace {
  return { data: [], events: [], returns: [] };
}
function record(trace: Trace, owner: any, events: string[]): void {
  for (const e of events) {
    owner.on(e, () => {
      if (!trace.events.includes(e)) trace.events.push(e);
    });
  }
}

function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('仿真 node:stream —— 结构性断言（形状与继承）', () => {
  it('`Stream` 是**可 call 的函数**，也能被 `extends`（两条路都要通）', () => {
    // graceful-fs 的 legacy 路径。这里的 `function` 是**故意的**（不能用箭头函数）：
    // 要复刻 `Stream.call(this)` 这种 2013 年的写法
    /* eslint-disable-next-line prefer-arrow-callback */
    const Legacy: any = function Legacy(this: any) {
      st.Stream.call(this);
    };
    Object.setPrototypeOf(Legacy.prototype, st.Stream.prototype);
    const legacy = new Legacy();
    assert.equal(typeof legacy.on, 'function');
    assert.equal(typeof legacy.emit, 'function');
    legacy.on('x', () => {});
    assert.equal(legacy.emit('x'), true);

    // ES class 路径
    class Modern extends st.Stream {}
    const modern = new Modern();
    assert.equal(modern instanceof st.Stream, true);
    assert.equal(typeof modern.once, 'function');
  });

  it('继承链：Transform → Duplex → Readable → Stream → EventEmitter', () => {
    const t = new st.Transform({ transform: (c: any, _e: any, cb: any) => cb() });
    assert.equal(t instanceof st.Transform, true);
    assert.equal(t instanceof st.Duplex, true);
    assert.equal(t instanceof st.Readable, true);
    assert.equal(t instanceof st.Stream, true);
    assert.equal(typeof t.write, 'function');
    assert.equal(typeof t.push, 'function');
  });

  it('`PassThrough`/`Transform` 通过**选项注入**拿到 `read`/`transform`/`flush`/`destroy`', () => {
    // `@nodelib/fs.walk/out/providers/stream.js:10-18` 就是这么用的
    let destroyed = false;
    const r = new st.Readable({ objectMode: true, read: () => {}, destroy: () => { destroyed = true; } });
    r.destroy();
    assert.equal(destroyed, true);
    const t = new st.Transform({ transform: (c: any, _e: any, cb: any) => cb(), flush: (cb: any) => cb() });
    assert.equal(typeof t._transform, 'function');
    assert.equal(typeof t._flush, 'function');
  });

  it('明确不做的入口一律**响亮抛错**（不给假流）', () => {
    for (const name of ['addAbortSignal', 'readableWebStream', 'isErrored', 'compose', 'setDefaultHighWaterMark']) {
      assert.equal(typeof (st as any)[name], 'function', `${name} 应当是函数`);
      assert.throws(
        () => (st as any)[name](),
        (err: any) => err.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
        `${name} 应当明确抛错`,
      );
    }
    assert.equal(st.getDefaultHighWaterMark(true), 16);
    assert.equal(st.getDefaultHighWaterMark(false), 16 * 1024);
  });
});

describe('仿真 node:stream —— 与宿主 Node 差分（终态 + 事件集合）', () => {
  /**
   * 同一剧本在两套实现上各跑一次，比对 trace 与数据。
   *
   * ⚠️ 两条纪律（都是被坑出来的）：
   *   1. **数据监听要挂在自己那行，别挂在 `record` 之后**：`record` 挂的 `data` 监听也会让流进入
   *      flowing，于是"自己挂监听"时数据可能已经被 flush 掉了（我们比 Node 更早 flush）；
   *   2. **一定要有超时**：剧本写错时可能是"永远等不到回调"，没有超时会挂住整个测试进程
   *      （本轮就挂了一次：`finished`/`pipeline` 没回调）。
   */
  async function diff(
    name: string,
    script: (s: any, trace: Trace) => void | Promise<void>,
  ): Promise<void> {
    it(name, async () => {
      const ours = mkTrace();
      const theirs = mkTrace();
      const TIMEOUT = Symbol('timeout');
      const guard = (p: Promise<void> | void) =>
        Promise.race([
          Promise.resolve(p),
          new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 2500)),
        ]);
      const oursDone = await guard(script(st, ours));
      const theirsDone = await guard(script(hostStream, theirs));
      if (oursDone === TIMEOUT || theirsDone === TIMEOUT) {
        assert.fail(
          `${name}：剧本在 2.5 秒内没跑完（我们 ${oursDone === TIMEOUT ? '挂起' : 'ok'}，` +
            `宿主 ${theirsDone === TIMEOUT ? '挂起' : 'ok'}）—— 数据=${JSON.stringify(ours.data)}`,
        );
      }
      await settle();
      assert.deepEqual(ours.data, theirs.data, `${name}：数据不一致`);
      assert.deepEqual(ours.events.slice().sort(), theirs.events.slice().sort(), `${name}：事件集合不一致`);
      assert.deepEqual(ours.returns, theirs.returns, `${name}：write() 返回值序列不一致`);
    });
  }

  diff('Readable：push → data → end（objectMode）', (s, trace) => {
    const r = new s.Readable({ objectMode: true, read: () => {} });
    record(trace, r, ['data', 'end', 'close']);
    r.on('data', (v: unknown) => trace.data.push('d:' + String(v)));
    r.push('a');
    r.push('b');
    r.push(null);
  });

  diff('Readable：先 push 再监听 data（缓冲里的数据要补发）', (s, trace) => {
    const r = new s.Readable({ objectMode: true, read: () => {} });
    r.push('x');
    r.push(null);
    record(trace, r, ['data', 'end']);
    r.on('data', (v: unknown) => trace.data.push('d:' + String(v)));
  });

  diff('Readable：byte mode 的字符串块拼起来是 Buffer', (s, trace) => {
    const r = new s.Readable({ read: () => {} });
    record(trace, r, ['data', 'end']);
    r.on('data', (chunk: any) => trace.data.push(Buffer.isBuffer(chunk) + ':' + chunk.toString()));
    r.push('he');
    r.push('llo');
    r.push(null);
  });

  diff('Writable：write → _write → finish → close', (s, trace) => {
    const w = new s.Writable({
      write(chunk: any, _e: any, cb: any) {
        trace.data.push('w:' + Buffer.from(chunk).toString());
        cb();
      },
    });
    record(trace, w, ['finish', 'close', 'drain']);
    trace.returns.push(w.write('a'), w.write('b'));
    w.end();
  });

  diff('Writable：异步 _write 的回调顺序与 drain', (s, trace) => {
    const w = new s.Writable({
      highWaterMark: 1,
      write(chunk: any, _e: any, cb: any) {
        setTimeout(() => {
          trace.data.push('w:' + Buffer.from(chunk).toString());
          cb();
        }, 1);
      },
    });
    record(trace, w, ['finish', 'drain', 'close']);
    trace.returns.push(w.write('a'), w.write('b'));
    w.end('c');
  });

  diff('Writable：写完再写 → ERR_STREAM_WRITE_AFTER_END（响亮报错）', (s, trace) => {
    const w = new s.Writable({ write: (_c: any, _e: any, cb: any) => cb() });
    // ⚠️ 错误码由**一个**监听读出来，并且**不**让 `record` 也记 `'error'`——
    // 两个 `'error'` 监听会让同一次错误被记两遍（差分测试踩过）
    w.on('error', (err: any) => trace.data.push('err:' + err.code));
    record(trace, w, ['finish']);
    trace.events.push('error-watched'); // 占位：宿主与我们的剧本形状一致
    w.end('x');
    w.write('y');
  });

  diff('pipe：Readable → Writable 的数据搬运与结束', (s, trace) => {
    const r = new s.Readable({ objectMode: true, read: () => {} });
    const w = new s.Writable({
      objectMode: true,
      write(chunk: any, _e: any, cb: any) {
        trace.data.push('p:' + String(chunk));
        cb();
      },
    });
    record(trace, r, ['data', 'end']);
    record(trace, w, ['finish', 'close']);
    r.pipe(w);
    r.push(1);
    r.push(2);
    r.push(null);
  });

  diff('Transform 子类化：_transform + _flush + push', (s, trace) => {
    class Upper extends s.Transform {
      _transform(chunk: any, _enc: any, cb: any) {
        this.push(Buffer.from(chunk).toString().toUpperCase());
        cb();
      }
      _flush(cb: any) {
        this.push('-FLUSH');
        cb(); // 注意：这里**不** push(null) —— 见下面那条"可读侧要自己 push(null)"的用例
      }
    }
    const t: any = new (Upper as any)({});
    t.on('data', (c: any) => trace.data.push('t:' + Buffer.from(c).toString()));
    record(trace, t, ['data', 'end', 'finish', 'close']);
    t.write('a');
    t.write('b');
    t.end();
  });

  diff('Transform：可读侧要自己 `push(null)` 才算结束（`_flush` 里补上）', (s, trace) => {
    class Upper extends s.Transform {
      _transform(chunk: any, _enc: any, cb: any) {
        this.push(Buffer.from(chunk).toString().toUpperCase());
        cb();
      }
      _flush(cb: any) {
        this.push('-FLUSH');
        this.on('end', this.destroy); // csv-parse/lib/index.js:72 的写法
        this.push(null);
        cb();
      }
    }
    const t: any = new (Upper as any)({});
    t.on('data', (c: any) => trace.data.push('t:' + Buffer.from(c).toString()));
    record(trace, t, ['data', 'end', 'finish', 'close']);
    t.write('a');
    t.end();
  });

  diff('Transform：`push(null)` 在 _transform 里结束可读侧', (s, trace) => {
    const t = new s.Transform({
      transform(chunk: any, _e: any, cb: any) {
        if (Buffer.from(chunk).toString() === 'stop') {
          this.push(null);
          cb();
          return;
        }
        this.push(chunk);
        cb();
      },
      flush(cb: any) {
        cb();
      },
    });
    record(trace, t, ['data', 'end', 'finish', 'close']);
    t.on('data', (c: any) => trace.data.push('s:' + Buffer.from(c).toString()));
    t.write('x');
    t.write('stop');
    t.end();
  });

  diff('PassThrough：实例上覆写 `_write`（fast-glob 的用法）', (s, trace) => {
    const p = new s.PassThrough({ objectMode: true });
    p._write = (index: any, _enc: any, done: any) => {
      trace.data.push('idx:' + String(index));
      p.push(index);
      if (index === 2) {
        p.push(null); // fast-glob 是在 `_write` 里 `end()`；可读侧的结束一律靠 push(null)
        p.end();
      }
      done();
    };
    p.on('data', (v: any) => trace.data.push('out:' + String(v)));
    record(trace, p, ['data', 'end', 'finish']);
    for (let i = 0; i < 3; i++) trace.returns.push(p.write(i));
  });

  diff('Readable：async iteration（for await）', async (s, trace) => {
    const r = new s.Readable({ objectMode: true, read: () => {} });
    setTimeout(() => {
      r.push('a');
      r.push('b');
      r.push(null);
    }, 1);
    for await (const v of r) trace.data.push('it:' + String(v));
    trace.events.push('iterated');
  });

  diff('finished()：可读侧等 end、可写侧等 finish（成功时参数是 `undefined`）', async (s, trace) => {
    const r = new s.Readable({ read: () => {} });
    const w = new s.Writable({ write: (_c: any, _e: any, cb: any) => cb() });
    r.resume(); // 可读侧必须被**消费**才会发 `'end'`——`finished` 等的就是它
    await new Promise<void>((resolve) => {
      r.push('x');
      r.push(null);
      w.end('y');
      s.finished(r, (err: any) => {
        trace.data.push('r:' + (err === undefined));
        s.finished(w, (err2: any) => {
          trace.data.push('w:' + (err2 === undefined));
          resolve();
        });
      });
    });
    trace.events.push('finished');
  });

  diff('pipeline()：基础串联 + 结束回调（三段的错误传播不在这里测）', async (s, trace) => {
    const r = new s.Readable({ objectMode: true, read: () => {} });
    const t = new s.Transform({
      objectMode: true,
      transform(chunk: any, _e: any, cb: any) {
        this.push(String(chunk) + '!');
        cb();
      },
      flush(cb: any) {
        this.push(null);
        cb();
      },
    });
    const w = new s.Writable({
      objectMode: true,
      write(chunk: any, _e: any, cb: any) {
        trace.data.push('pl:' + String(chunk));
        cb();
      },
    });
    await new Promise<void>((resolve) => {
      s.pipeline(r, t, w, (err: any) => {
        trace.data.push('cb:' + (err === undefined));
        resolve();
      });
      r.push('a');
      r.push(null);
    });
    trace.events.push('pipeline');
  });
});

// ──────────────────────────── 真沙箱冒烟 ────────────────────────────

describe('仿真 node:stream —— 真实 QuickJS 沙箱里跑通', async () => {
  const { createSandbox } = await import('../../core/sandbox.ts');
  const SMOKE_DIR = mkdtempSync(join(tmpdir(), 'spc-smoke-stream-'));
  after(() => rmSync(SMOKE_DIR, { recursive: true, force: true }));
  // 冒烟里用 `Buffer.from(str)`/`toString()` 只是为了把字节读成字符串 ⇒ 要编解码两个权限点
  // （不申请的话拿到的是 EACCES，而错误发生在微任务里、只表现为"没有输出"）
  const SMOKE_PERMS = ['bytes.encode', 'bytes.decode'];

  async function runInSandbox(code: string, permissions: string[] = SMOKE_PERMS): Promise<string> {
    const api = buildHostApi({ pluginId: '@spc-test/stream', dataDir: SMOKE_DIR });
    const sandbox = await createSandbox(api, {
      pluginId: '@spc-test/stream',
      permissions,
      facts: { version: { code: 1, name: 'test' }, dataDir: SMOKE_DIR, manifest: {}, config: {} },
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule('@spc-test/stream', code);
      await sandbox.callHook('init', 5_000);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    return logs.join('\n');
  }

  it('legacy 基类 / Transform 子类化 / async iteration 在沙箱里都成立（零权限）', async () => {
    try {
      const out = await runInSandbox(`
import stream, { Stream, Readable, Transform } from 'node:stream';
export function init() {
  // ① legacy 函数基类（graceful-fs 的写法）
  function Legacy() { Stream.call(this); }
  Object.setPrototypeOf(Legacy.prototype, Stream.prototype);
  const legacy = new Legacy();
  legacy.on('x', () => {});
  console.log('LEGACY ' + (legacy.emit('x') && typeof legacy.on === 'function'));

  // ② Transform 子类化（csv-parse 的写法）
  class T extends Transform {
    _transform(chunk, _enc, cb) { this.push(Buffer.from(chunk).toString().toUpperCase()); cb(); }
    _flush(cb) { this.push('|END'); cb(); }
  }
  const t = new T({});
  const seen = [];
  t.on('data', (c) => seen.push(Buffer.from(c).toString()));
  t.on('end', () => console.log('TRANSFORM ' + seen.join(',')));
  t.on('error', (e) => console.log('TERROR ' + e.code + '/' + e.message));
  t.write('a'); t.write('b'); t.end();

  // ③ 异步迭代
  const r = new Readable({ objectMode: true, read: () => {} });
  const collected = [];
  (async () => {
    r.push(1); r.push(2); r.push(null);
    for await (const v of r) collected.push(v);
    console.log('ITER ' + collected.join('-'));
  })();

  // ④ 默认导出也必须是同一套
  console.log('DEFAULT ' + (stream.Readable === Readable));
  console.log('PASSTHROUGH ' + (typeof stream.PassThrough));
}
`);
      // ⚠️ 不能按行号断言：流的事件在**微任务**里发，所以 `TRANSFORM`/`ITER` 那两行会排在
      // 同步的 `DEFAULT`/`PASSTHROUGH` 之后（宿主也一样）。按内容找行。
      const lines = out.split('\n');
      const line = (prefix: string) => lines.find((l) => l.startsWith(prefix)) ?? `<缺 ${prefix}>`;
      assert.equal(line('LEGACY'), 'LEGACY true');
      // 分块边界可能不同（宿主把 `A`/`B`/`|END` 合成 `A,B,|END`），所以也比拼接后的内容
      assert.equal(line('TRANSFORM').replace(/,/g, ''), 'TRANSFORM AB|END', `实际输出：${JSON.stringify(out)}`);
      assert.equal(line('ITER'), 'ITER 1-2');
      assert.equal(line('DEFAULT'), 'DEFAULT true');
      assert.equal(line('PASSTHROUGH'), 'PASSTHROUGH function');
      assert.equal(lines.length, 5, `不该有多余输出：${JSON.stringify(out)}`);
    } catch (err: any) {
      assert.fail(`沙箱冒烟失败：${err?.code} ${JSON.stringify(err?.params ?? err?.message)}`);
    }
  });

  it('`stream/promises` 与 `stream/web` 登记了但**明确抛错**（不是构建期未知模块）', async () => {
    const out = await runInSandbox(`
import { finished } from 'node:stream/promises';
import { TransformStream } from 'node:stream/web';
export function init() {
  try { finished(null, () => {}); } catch (e) { console.log('PROMISES ' + e.code); }
  try { new TransformStream(); } catch (e) { console.log('WEB ' + e.code); }
}
`);
    assert.deepEqual(out.split('\n'), ['PROMISES ERR_NOT_SUPPORTED_IN_SANDBOX', 'WEB ERR_NOT_SUPPORTED_IN_SANDBOX']);
  });
});
