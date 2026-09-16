// 仿真模块：**对齐测试**
//
// 判卷人是 Node 自己：同一个输入，喂给真模块与 shim，比输出。
// 这样正确性不靠记忆、也不需要人判——Node 说什么就是什么。
//
// 加载方式：读**文件内容**再按 data: URL 求值，而不是 import 路径。理由：
//   · 沙箱 loader 服务的就是这份源码文本，构建层内联的也是这份字节——测的就是**真实产物**
//   · 不需要给项目开 `allowJs`（shim 是 .js，TS 不做类型检查，但我们比的是**值**）
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/** 按文件内容加载 shim（返回 any：我们要比的是运行时值，不是类型） */
async function loadShim(fileName: string): Promise<any> {
  const src = readFileSync(new URL(`../sandbox-modules/${fileName}`, import.meta.url), 'utf8');
  const url = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
  return import(url);
}

// ─────────────────────────────────────────────────────────────
// node:path
// ─────────────────────────────────────────────────────────────
describe('仿真 node:path —— 与 node:path.posix 对齐', async () => {
  const shim = await loadShim('node-path.js');
  // 说明：这里刻意用 any——比的是**运行时值**，而 shim 没有类型声明（它就是产物字节）
  const node: any = (await import('node:path')).posix;

  /** 一元函数：同一串输入逐个比 */
  const unary = (name: string, inputs: string[]) => {
    it(name, () => {
      for (const input of inputs) {
        assert.deepStrictEqual(
          shim[name](input),
          node[name](input),
          `${name}(${JSON.stringify(input)}) 不一致`,
        );
      }
    });
  };

  unary('normalize', [
    '', '.', '..', '/', '//', '///', '/foo', '/foo/', '/foo//bar', 'foo/bar//baz/asdf/quux/..',
    'foo/../../bar', '/foo/../../bar', 'a/b/../c/', './a', '../a', 'foo/', 'a//b', '...', '/..',
    'a/./b', '/a/./b/', 'a/b/c/../../..', '/..', '//foo//bar',
  ]);

  unary('dirname', [
    '', '.', '..', '/', '//', '/foo', '//foo', '/foo/bar', 'foo/bar', 'foo', '/a/b/', 'a/',
    './a', '/a/b//c', 'a//b',
  ]);

  unary('extname', [
    '', '.', '..', '...', 'index.html', 'index.coffee.md', '.bashrc', 'foo.', '/a/b.c',
    'a/.b', '/a.b/c', 'a.b.c', 'foo/', '/foo/', '/.',
  ]);

  unary('isAbsolute', ['', '/', '//', '/foo', 'foo', '.', './foo', '/foo/bar', 'a/b']);

  unary('parse', ['', '/', '//', '/foo', '/foo/bar.txt', 'foo.txt', '.bashrc', '/a/b/', 'a.b.c', 'foo/']);

  it('basename（含后缀参数）', () => {
    const cases: [string, string?][] = [
      ['/foo/bar/baz', undefined],
      ['/foo/bar/baz', 'baz'],
      ['/foo/bar/baz.txt', '.txt'],
      ['/foo/bar/baz.txt', 'txt'],
      ['/', undefined],
      ['', undefined],
      ['foo/', undefined],
      ['/a/b/', undefined],
      ['.txt', '.txt'],
      ['a/b.c', '.c'],
    ];
    for (const [p, ext] of cases) {
      assert.deepStrictEqual(
        shim.basename(p, ext),
        node.basename(p, ext),
        `basename(${JSON.stringify(p)}, ${JSON.stringify(ext)}) 不一致`,
      );
    }
  });

  it('join（含空参与绝对段）', () => {
    const cases: string[][] = [
      [], [''], ['a'], ['a', 'b'], ['a', 'b', '..', 'c'], ['/a', 'b'], ['a', '/b'], ['', 'a'],
      ['a', ''], ['/', 'b'], ['a', '..', '..', 'b'], ['/a', '/b'], ['a/', '/b/'], ['/', '/'],
    ];
    for (const args of cases) {
      assert.deepStrictEqual(
        shim.join(...args),
        node.join(...args),
        `join(${JSON.stringify(args)}) 不一致`,
      );
    }
  });

  it('format（pathObject → 字符串）', () => {
    const cases = [
      { dir: '/a', base: 'b.txt' },
      { root: '/', base: 'b.txt' },
      { name: 'b', ext: '.txt' },
      { base: 'b.txt' },
      { dir: '/a' },
      { root: '/' },
      {},
      { dir: '/a', name: 'b', ext: '.txt' },
    ];
    for (const c of cases) {
      assert.deepStrictEqual(
        shim.format(c as any),
        node.format(c as any),
        `format(${JSON.stringify(c)}) 不一致`,
      );
    }
  });

  it('relative（相对↔相对时 cwd 会抵消，可与 Node 直接比）', () => {
    const cases: [string, string][] = [
      ['/a/b', '/a/c'], ['/a/b/c', '/a/b'], ['/', '/foo'], ['/foo', '/'], ['/a', '/a'],
      ['a', 'b'], ['/data/orandea/test/aaa', '/data/orandea/impl/bbb'], ['/a/b/c', '/a/b/c/d'],
    ];
    for (const [from, to] of cases) {
      assert.deepStrictEqual(
        shim.relative(from, to),
        node.relative(from, to),
        `relative(${from}, ${to}) 不一致`,
      );
    }
  });

  it('resolve（只比含绝对段的用例：沙箱没有 cwd）', () => {
    const cases: string[][] = [
      ['/'], ['/a', 'b'], ['a', '/b'], ['/a', '/b'], ['/a/b', '../c'], ['/a', 'b', '..', 'c'],
      ['/', 'a'],
    ];
    for (const args of cases) {
      assert.deepStrictEqual(
        shim.resolve(...args),
        node.resolve(...args),
        `resolve(${JSON.stringify(args)}) 不一致`,
      );
    }
  });

  it('**故意与 Node 不同**：resolve 用虚拟根 `/` 兜底（沙箱没有 cwd）', () => {
    // Node 用 process.cwd() 兜底，沙箱没有 cwd —— 这是**记录在案的有意差异**，不是 bug。
    // 见 core/sandbox-modules/node-path.js 文件头。
    assert.equal(shim.resolve('a.txt'), '/a.txt');
    assert.notEqual(shim.resolve('a.txt'), node.resolve('a.txt'));
  });

  it('常量与 win32 的处置', () => {
    assert.equal(shim.sep, '/');
    assert.equal(shim.delimiter, ':');
    // posix 自指（与 Node 一致：path.posix.posix === path.posix）；default 与 posix 同体
    assert.equal(shim.posix.posix, shim.posix);
    assert.equal(shim.default, shim.posix);
    assert.equal(shim.default.sep, node.sep);
    // win32 明确抛错，不静默给出 posix 结果
    assert.throws(() => shim.win32.join('a', 'b'), /not supported in the sandbox/);
    assert.equal((shim.win32.join as any).name, 'join');
  });

  it('类型校验与 Node 同形（ERR_INVALID_ARG_TYPE）', () => {
    for (const bad of [3, null, undefined, {}]) {
      assert.throws(() => shim.join(bad as any), (e: any) => e.code === 'ERR_INVALID_ARG_TYPE', `join(${String(bad)})`);
      assert.throws(() => shim.normalize(bad as any), (e: any) => e.code === 'ERR_INVALID_ARG_TYPE');
    }
  });
});

// ─────────────────────────────────────────────────────────────
// node:tty
// ─────────────────────────────────────────────────────────────
describe('仿真 node:tty', async () => {
  const shim = await loadShim('node-tty.js');
  const nodeTty = await import('node:tty');

  it('isatty 恒 false（沙箱没有终端）', () => {
    assert.equal(shim.isatty(0), false);
    assert.equal(shim.isatty(1), false);
    assert.equal(shim.isatty(2), false);
  });

  it('ReadStream / WriteStream 明确抛错，不静默假装', () => {
    assert.throws(() => new shim.ReadStream(1), (e: any) => e.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX');
    assert.throws(() => new shim.WriteStream(1), (e: any) => e.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX');
    // 构造函数名要保留（`X.name` 常用于日志/判定）
    assert.equal(shim.ReadStream.name, 'ReadStream');
  });

  it('**必须保持"是个函数"**：`instanceof` 探测不能炸', () => {
    // 生态里 `x instanceof tty.WriteStream` 是常见的"是不是终端流"探测。
    // 若把它做成 `undefined`（"不导出"那条路），这里会抛
    // `TypeError: Right-hand side of 'instanceof' is not callable` —— 比抛错更糟。
    assert.equal(({} as any) instanceof shim.WriteStream, false);
    assert.equal(({} as any) instanceof shim.ReadStream, false);
    // 与 Node 对照：真实现同样不抛，同样返回 false
    assert.equal(({} as any) instanceof nodeTty.WriteStream, false);
    assert.equal(typeof shim.WriteStream, typeof nodeTty.WriteStream);
  });
});

// ─────────────────────────────────────────────────────────────
// node:events
// ─────────────────────────────────────────────────────────────
describe('仿真 node:events —— 与 node:events 对齐', async () => {
  const shim = await loadShim('node-events.js');
  const nodeEvents = await import('node:events');

  /**
   * 同一段剧本跑两遍比日志。
   * 逐方法断言容易漏掉"顺序 / 返回值 / 摘除时机"这类语义，剧本式比对能整片抓住。
   */
  function scenario(EE: any): string[] {
    const log: string[] = [];
    const e = new EE();
    const h1 = (x: unknown) => log.push('h1:' + String(x));
    const h2 = (x: unknown) => log.push('h2:' + String(x));
    const h0 = (x: unknown) => log.push('h0:' + String(x));

    e.on('a', h1);
    e.on('a', h2);
    e.prependListener('a', h0);
    log.push('emit=' + e.emit('a', 1));
    log.push('count=' + e.listenerCount('a'));
    log.push('listeners=' + e.listeners('a').length);
    log.push('names=' + e.eventNames().map(String).sort().join(','));

    let onceCalls = 0;
    e.once('b', () => {
      onceCalls++;
      log.push('once');
    });
    log.push('emitB1=' + e.emit('b'));
    log.push('emitB2=' + e.emit('b'));
    log.push('onceCalls=' + onceCalls);
    log.push('rawB=' + e.rawListeners('b').length);
    log.push('listenersB=' + e.listeners('b').length);

    e.off('a', h1);
    log.push('afterOff=' + e.listenerCount('a'));
    e.removeAllListeners('a');
    log.push('afterRemoveAll=' + e.listenerCount('a'));
    log.push('names2=' + e.eventNames().map(String).sort().join(','));

    log.push('chain=' + (e.on('z', () => {}) === e));
    log.push('max=' + e.getMaxListeners());
    log.push('setMax=' + (e.setMaxListeners(3) === e) + '/' + e.getMaxListeners());
    log.push('emitNone=' + e.emit('nope'));
    return log;
  }

  it('同一段剧本：行为日志逐行一致', () => {
    assert.deepStrictEqual(scenario(shim.EventEmitter), scenario(nodeEvents.EventEmitter));
  });

  it("emit('error') 无监听器 → 抛出（不静默吞掉）", () => {
    const mine = new shim.EventEmitter();
    const boom = new Error('boom');
    assert.throws(() => mine.emit('error', boom), /boom/);
    mine.on('error', () => {});
    assert.equal(mine.emit('error', boom), true);
  });

  it('once 的 rawListeners 带包装器、listeners 是原函数', () => {
    const e = new shim.EventEmitter();
    const fn = () => {};
    e.once('x', fn);
    assert.equal(e.listeners('x')[0], fn);
    assert.notEqual(e.rawListeners('x')[0], fn);
    assert.equal((e.rawListeners('x')[0] as any).listener, fn);
  });

  it('静态 once(emitter, event) 返回 Promise', async () => {
    const e = new shim.EventEmitter();
    const p = shim.EventEmitter.once(e, 'k');
    e.emit('k', 1, 2);
    assert.deepStrictEqual(await p, [1, 2]);
  });

  it('defaultMaxListeners 是惰性继承（构造后改静态值仍生效）', () => {
    const e = new shim.EventEmitter();
    const real = new nodeEvents.EventEmitter();
    assert.equal(e.getMaxListeners(), real.getMaxListeners());
  });
});

// ─────────────────────────────────────────────────────────────
// 登记表一致性
// ─────────────────────────────────────────────────────────────
describe('仿真模块登记表', async () => {
  const reg = await import('../sandbox-modules/registry.ts');
  const DIR = fileURLToPath(new URL('../sandbox-modules/', import.meta.url));

  it('归一化：`node:` 前缀与裸名等价，子路径独立保留', () => {
    assert.equal(reg.normalizeSpecifier('node:path'), 'path');
    assert.equal(reg.normalizeSpecifier('path'), 'path');
    assert.equal(reg.normalizeSpecifier('node:fs/promises'), 'fs/promises');
    assert.equal(reg.normalizeSpecifier('fs/promises'), 'fs/promises');
  });

  it('isRegistered 同时认裸名与前缀名；未登记的一律 false', () => {
    assert.equal(reg.isRegistered('path'), true);
    assert.equal(reg.isRegistered('node:path'), true);
    assert.equal(reg.isRegistered('node:fs'), false, 'fs 尚未仿真，应为未登记');
    assert.equal(reg.isRegistered('@host/api'), false, '@host/api 不是仿真模块');
  });

  it('**每个登记项都有对应 shim 文件**（防止悬空条目）', () => {
    for (const m of reg.SANDBOX_MODULES) {
      const file = reg.shimFileName(m.canonical);
      assert.ok(existsSync(`${DIR}${file}`), `登记了 ${m.canonical} 却没有 ${file}`);
    }
  });

  it('**每个 node-*.js 都已登记**（防止实现了却漏登记，那样 loader 不会服务它）', () => {
    const registered = new Set(reg.SANDBOX_MODULES.map((m) => reg.shimFileName(m.canonical)));
    const files = readdirSync(DIR).filter((f) => f.startsWith('node-') && f.endsWith('.js'));
    assert.ok(files.length > 0, 'sandbox-modules/ 下应当已有 shim');
    for (const f of files) assert.ok(registered.has(f), `${f} 没有出现在登记表里`);
  });

  it('文件名约定与规范名一致（子路径的 / 变 -）', () => {
    assert.equal(reg.shimFileName('path'), 'node-path.js');
    assert.equal(reg.shimFileName('node:path'), 'node-path.js');
    assert.equal(reg.shimFileName('fs/promises'), 'node-fs-promises.js');
  });
});

// ─────────────────────────────────────────────────────────────
// 仿真模块的装载链路
// ─────────────────────────────────────────────────────────────
describe('仿真模块的装载链路（真实 QuickJS 沙箱）', async () => {
  const { createSandbox } = await import('../sandbox.ts');
  const { hostApi } = await import('../hostApi.ts');

  async function runInSandbox(code: string): Promise<string> {
    const sandbox = await createSandbox(hostApi, { pluginId: '@spc-test/emulation', permissions: [] });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule('@spc-test/emulation', code);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    return logs.join('\n');
  }

  it('插件可 import 仿真模块（裸名与 node: 前缀都认）', async () => {
    const out = await runInSandbox(`
import { join, basename } from 'node:path';
import { EventEmitter } from 'events';
import tty from 'tty';
import constants from 'constants';
const e = new EventEmitter();
let seen = '';
e.on('x', (v) => { seen = v; });
e.emit('x', 'ok');
console.log('PATH ' + join('/a', 'b', '..', 'c'));
console.log('BASE ' + basename('/x/y.txt'));
console.log('EVT ' + seen);
console.log('TTY ' + tty.isatty(1));
console.log('CONST ' + constants.F_OK);
`);
    assert.match(out, /PATH \/a\/c/);
    assert.match(out, /BASE y\.txt/);
    assert.match(out, /EVT ok/);
    assert.match(out, /TTY false/);
    assert.match(out, /CONST 0/);
  });

  it('未登记的 node 内建 → 报错指出"沙箱尚未支持"，而不是让作者以为写错了', async () => {
    await assert.rejects(
      () => runInSandbox(`import { readFileSync } from 'node:fs';\nconsole.log(String(readFileSync));`),
      (err: any) => JSON.stringify(err).includes('沙箱尚未支持') || String(err?.message).includes('沙箱尚未支持'),
    );
  });
});

describe('仿真 node:constants', async () => {
  const shim = await loadShim('node-constants.js');

  it('默认导出与具名导出一致', () => {
    for (const [k, v] of Object.entries(shim.default)) {
      assert.equal(shim[k], v, `${k} 的具名导出与 default 不一致`);
    }
  });

  it('在 Linux 宿主上与 node:constants 逐项一致（其余平台见文件头取向说明）', async () => {
    if (process.platform !== 'linux') return; // 取值取向固定 POSIX/Linux
    const real = await import('node:constants');
    for (const k of ['F_OK', 'R_OK', 'W_OK', 'X_OK', 'O_RDONLY', 'O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_TRUNC', 'O_APPEND', 'COPYFILE_EXCL']) {
      assert.equal((shim as any)[k], (real as any)[k], `${k} 与 Node 不一致`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// node:assert
// ─────────────────────────────────────────────────────────────
describe('仿真 node:assert —— 与 node:assert 对齐', async () => {
  const assertMod = await loadShim('node-assert.js');
  const shim = assertMod.default;
  const nodeAssertMod = await import('node:assert');
  const nodeAssert = nodeAssertMod.default;
  const nodeStrict = (await import('node:assert/strict')).default;

  /** 只比"抛没抛 + 抛的码与算子"——失败**文案**不追求复刻（见 shim 文件头） */
  function outcome(fn: () => unknown): string {
    try {
      fn();
      return 'ok';
    } catch (e: any) {
      return `${e?.code ?? e?.name ?? 'throw'}/${e?.operator ?? ''}`;
    }
  }

  const makeCycle = () => {
    const a: any = { n: 1 };
    a.self = a;
    return a;
  };

  const CASES: [string, (a: any) => unknown, boolean?][] = [
    ['ok(1)', (a) => a.ok(1)],
    ['ok(0)', (a) => a.ok(0)],
    ['ok("")', (a) => a.ok('')],
    ['strictEqual(1,1)', (a) => a.strictEqual(1, 1)],
    ['strictEqual(1,"1")', (a) => a.strictEqual(1, '1')],
    ['strictEqual(NaN,NaN)', (a) => a.strictEqual(NaN, NaN)],
    ['strictEqual(-0,0)', (a) => a.strictEqual(-0, 0)],
    ['notStrictEqual(1,2)', (a) => a.notStrictEqual(1, 2)],
    ['notStrictEqual(1,1)', (a) => a.notStrictEqual(1, 1)],
    ['equal(1,"1")', (a) => a.equal(1, '1')],
    ['equal(1,2)', (a) => a.equal(1, 2)],
    ['notEqual(1,2)', (a) => a.notEqual(1, 2)],
    ['deepStrictEqual(NaN,NaN)', (a) => a.deepStrictEqual(NaN, NaN)],
    ['deepStrictEqual(-0,0)', (a) => a.deepStrictEqual(-0, 0)],
    ['deepStrictEqual(1,"1")', (a) => a.deepStrictEqual(1, '1')],
    ['deepStrictEqual({a:1},{a:1})', (a) => a.deepStrictEqual({ a: 1 }, { a: 1 })],
    ['deepStrictEqual({a:1},{a:1,b:undefined})', (a) => a.deepStrictEqual({ a: 1 }, { a: 1, b: undefined })],
    ['deepStrictEqual({a:{b:[1,2]}},{a:{b:[1,2]}})', (a) => a.deepStrictEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })],
    ['deepStrictEqual([1,2],[1,2])', (a) => a.deepStrictEqual([1, 2], [1, 2])],
    ['deepStrictEqual([1,2],[2,1])', (a) => a.deepStrictEqual([1, 2], [2, 1])],
    ['deepStrictEqual(new Date(0),new Date(0))', (a) => a.deepStrictEqual(new Date(0), new Date(0))],
    ['deepStrictEqual(new Date(0),new Date(1))', (a) => a.deepStrictEqual(new Date(0), new Date(1))],
    ['deepStrictEqual(/a/g,/a/g)', (a) => a.deepStrictEqual(/a/g, /a/g)],
    ['deepStrictEqual(/a/g,/a/i)', (a) => a.deepStrictEqual(/a/g, /a/i)],
    ['deepStrictEqual(new Map([[1,2]]),new Map([[1,2]]))', (a) => a.deepStrictEqual(new Map([[1, 2]]), new Map([[1, 2]]))],
    ['deepStrictEqual(new Set([1]),new Set([1]))', (a) => a.deepStrictEqual(new Set([1]), new Set([1]))],
    ['deepStrictEqual(new Set([1]),new Set([1,2]))', (a) => a.deepStrictEqual(new Set([1]), new Set([1, 2]))],
    ['deepStrictEqual(Uint8Array[1,2],Uint8Array[1,2])', (a) => a.deepStrictEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))],
    ['deepStrictEqual(循环引用,循环引用)', (a) => a.deepStrictEqual(makeCycle(), makeCycle())],
    ['notDeepStrictEqual({a:1},{a:2})', (a) => a.notDeepStrictEqual({ a: 1 }, { a: 2 })],
    ['deepEqual({a:1},{a:"1"})', (a) => a.deepEqual({ a: 1 }, { a: '1' })],
    ['throws(fn,TypeError) 抛出 TypeError', (a) => a.throws(() => { throw new TypeError('x'); }, TypeError)],
    ['throws(fn,RangeError) 但抛的是 TypeError', (a) => a.throws(() => { throw new TypeError('x'); }, RangeError)],
    ['throws(不抛)', (a) => a.throws(() => {})],
    ['throws(fn,正则)', (a) => a.throws(() => { throw new TypeError('boom'); }, /boom/)],
    ['throws(fn,正则不匹配)', (a) => a.throws(() => { throw new TypeError('boom'); }, /nope/)],
    ['doesNotThrow(不抛)', (a) => a.doesNotThrow(() => {})],
    ['doesNotThrow(抛了)', (a) => a.doesNotThrow(() => { throw new Error('x'); })],
    ['ifError(null)', (a) => a.ifError(null)],
    ['ifError(new Error)', (a) => a.ifError(new Error('x'))],
    ['match("abc",/b/)', (a) => a.match('abc', /b/)],
    ['match("abc",/z/)', (a) => a.match('abc', /z/)],
    ['doesNotMatch("abc",/z/)', (a) => a.doesNotMatch('abc', /z/)],
    ['fail()', (a) => a.fail('boom')],
  ];

  it('同一批表达式：抛/不抛与 error.code/operator 逐条一致', () => {
    for (const [label, run] of CASES) {
      assert.equal(outcome(() => run(shim)), outcome(() => run(nodeAssert)), `${label} 不一致`);
    }
  });

  it('assert/strict：宽松方法被严格方法覆盖', () => {
    const strictCases: [string, (a: any) => unknown][] = [
      ['strict.equal(1,"1")', (a) => a.equal(1, '1')],
      ['strict.equal(1,1)', (a) => a.equal(1, 1)],
      ['strict.deepEqual(1,"1")', (a) => a.deepEqual(1, '1')],
      ['strict.deepEqual({a:1},{a:1})', (a) => a.deepEqual({ a: 1 }, { a: 1 })],
      ['strict.notEqual(1,"1")', (a) => a.notEqual(1, '1')],
    ];
    for (const [label, run] of strictCases) {
      assert.equal(outcome(() => run(shim.strict)), outcome(() => run(nodeStrict)), `${label} 不一致`);
    }
  });

  it('AssertionError 的形状（code / operator / actual / expected）', () => {
    for (const a of [shim, nodeAssert]) {
      try {
        a.strictEqual(1, 2);
        assert.fail('应该抛');
      } catch (e: any) {
        assert.equal(e.code, 'ERR_ASSERTION');
        assert.equal(e.operator, 'strictEqual');
        assert.equal(e.actual, 1);
        assert.equal(e.expected, 2);
        assert.equal(e.name, 'AssertionError');
        assert.ok(e instanceof a.AssertionError);
      }
    }
  });

  it('默认导出可直接调用（assert(value)），且**具名导出**齐备', () => {
    assert.equal(typeof shim, 'function');
    assert.throws(() => shim(0), (e: any) => e.code === 'ERR_ASSERTION');
    // 默认导出上挂满成员
    for (const k of ['ok', 'equal', 'strictEqual', 'deepStrictEqual', 'throws', 'rejects', 'ifError', 'match', 'fail', 'AssertionError', 'strict']) {
      assert.ok(shim[k] !== undefined, `默认导出缺少成员 ${k}`);
    }
    // 具名导出也要有：`import { strictEqual } from 'assert'` 在生态里很常见
    for (const k of ['ok', 'equal', 'strictEqual', 'notStrictEqual', 'deepStrictEqual', 'deepEqual', 'throws', 'doesNotThrow', 'rejects', 'doesNotReject', 'ifError', 'match', 'doesNotMatch', 'fail', 'AssertionError']) {
      assert.equal(typeof assertMod[k], typeof (nodeAssertMod as any)[k], `具名导出 ${k} 缺失或类型不符`);
    }
    assert.equal(typeof assertMod.strict, 'function');
  });

  it('rejects / doesNotReject（异步）', async () => {
    await shim.rejects(async () => { throw new TypeError('x'); }, TypeError);
    await assert.rejects(() => shim.rejects(async () => {}), (e: any) => e.code === 'ERR_ASSERTION');
    await shim.doesNotReject(async () => {});
    await assert.rejects(
      () => shim.doesNotReject(async () => { throw new Error('x'); }),
      (e: any) => e.code === 'ERR_ASSERTION',
    );
  });
});

