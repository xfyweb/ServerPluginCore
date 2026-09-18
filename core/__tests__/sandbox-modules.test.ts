// 仿真模块：**对齐测试**
//
// 判卷人是 Node 自己：同一个输入，喂给真模块与 shim，比输出。
// 这样正确性不靠记忆、也不需要人判——Node 说什么就是什么。
//
// 加载方式：读**文件内容**再按 data: URL 求值，而不是 import 路径。理由：
//   · 沙箱 loader 服务的就是这份源码文本，构建层内联的也是这份字节——测的就是**真实产物**
//   · 不需要给项目开 `allowJs`（shim 是 .js，TS 不做类型检查，但我们比的是**值**）
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import * as nodeOs from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// 审计写**隔离目录**：`AUDIT_DIR` 在 audit.ts 模块加载时读环境变量，而本文件对
// sandbox/hostApi 都是动态 import（在 describe 回调里），所以在这里设就来得及。
// 不隔离的话，跑一次测试就往仓库的 `.spc/audit/audit.jsonl` 追加——实测已涨到 100+MB。
const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-modules-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;
after(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

/**
 * shim 的临时加载目录：**逐字节拷**一份 `node-*.js`，再按 `file:` 导入。
 *
 * 为什么要拷而不是就地 `data:` URL 求值：shim 之间可以互相 import
 * （`node-assert-strict.js` → `./node-assert.js`），而 data: URL 里**相对引用无法解析**。
 * 拷贝保证测的仍是产物字节；`package.json` 只为让 `.js` 按 ESM 解析（本仓库没有 `"type": "module"`）。
 */
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-shims-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
const SHIM_SRC_DIR = fileURLToPath(new URL('../sandbox-modules/', import.meta.url));
for (const f of readdirSync(SHIM_SRC_DIR)) {
  if (f.startsWith('node-') && f.endsWith('.js')) copyFileSync(join(SHIM_SRC_DIR, f), join(SHIM_DIR, f));
}
after(() => rmSync(SHIM_DIR, { recursive: true, force: true }));

/** 按文件内容加载 shim（返回 any：我们要比的是运行时值，不是类型） */
async function loadShim(fileName: string): Promise<any> {
  return import(pathToFileURL(join(SHIM_DIR, fileName)).href);
}

/**
 * 同上，但**绕开 ESM 模块缓存**：同一个 shim 在不同全局（如不同的 `__spcEnv`）下重新求值。
 * 用递增 query 串实现——同一路径 + 同一 query 仍是同一个模块实例。
 */
let freshSeq = 0;
async function loadShimFresh(fileName: string): Promise<any> {
  freshSeq += 1;
  return import(`${pathToFileURL(join(SHIM_DIR, fileName)).href}?fresh=${freshSeq}`);
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

  it('C9：toNamespacedPath 在 posix 下是恒等（与 Node 一致）', () => {
    for (const p of ['', '/', '/a/b', 'a/b', '.', '//x']) {
      assert.equal(shim.toNamespacedPath(p), (node as any).toNamespacedPath(p), `toNamespacedPath(${p})`);
    }
  });

  // A4：`relative` 走的是 `resolve`，所以**继承虚拟根兜底**——有意差异，用测试钉住而不是留给下一个人猜
  it('relative 的相对参数按**虚拟根**解析（与 Node 的 cwd 语义不同），绝对-绝对与 Node 一致', () => {
    // 沙箱里没有"当前工作目录"：相对参数先按 '/' 解析（否则结果会随宿主 cwd 变，插件根本没法推理）
    assert.equal(shim.relative('a', '/b'), '../b');
    assert.equal(shim.relative('a/b', '/a/c'), '../c');
    assert.equal(shim.relative('/x', '/x/y/z'), 'y/z');
    // 两个都是绝对路径时不经过虚拟根 → 必须与 Node 逐字相同
    for (const [f, t] of [
      ['/a/b', '/a/c'],
      ['/a/b/c', '/a'],
      ['/', '/a/b'],
      ['/a/b', '/a/b'],
    ]) {
      assert.equal(shim.relative(f, t), node.relative(f, t), `relative(${f}, ${t}) 不一致`);
    }
  });

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
      // ext **不带点**时 Node 会自动补点 —— 少了它就会拼出 `btxt` 这种错误路径且不报错
      { name: 'b', ext: 'txt' },
      { ext: 'txt' },
      { ext: '.txt' },
      { name: 'b', ext: 'a.b' },
      { dir: '/a', name: 'b', ext: 'txt' },
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

  it('resolve（含绝对段的用例与 Node 逐条一致）', () => {
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

  it('相对路径按**沙箱 cwd（数据目录）**兜底——不能是虚拟根 `/`（真实依赖会撞 EACCES）', async () => {
    // 来历：`mkdirp/dist/mjs/path-arg.js` 就是 `path = resolve(path)`。用虚拟根时
    // `resolve('out/a')` = `/out/a`，交给 fs 就是作用域外 → EACCES（`_audit/dep-smoke.mts` 实测）。
    // 现在与 `process.cwd()`、fs 的相对路径解析同源 = `__spcEnv.dataDir`。
    const prev = (globalThis as any).__spcEnv;
    try {
      (globalThis as any).__spcEnv = JSON.stringify({ dataDir: '/srv/data/plugins/demo' });
      // 换了全局要重新 load：shim 把 cwd 缓存在模块作用域里（这样热路径不必每次 JSON.parse）
      const fresh = await loadShimFresh('node-path.js');
      assert.equal(fresh.resolve('a.txt'), '/srv/data/plugins/demo/a.txt');
      assert.equal(fresh.resolve('out', 'a', '..', 'b'), '/srv/data/plugins/demo/out/b');
      // 有绝对段时绝对段说了算（与 Node 语义一致，不受 cwd 影响）
      assert.equal(fresh.resolve('/x', 'a'), '/x/a');
      // Windows 形态的数据目录：分隔符统一成 `/`（POSIX 的 dirname/join/.. 才 work），
      // **且盘符路径算绝对**——这条曾经是"已知边界"（isAbsolute 给 false），但它会让
      // `resolve('C:/…/tree')` 把 cwd 再拼一次（`C:/…/C:/…/tree`）⇒ 真实依赖（fast-glob 拿
      // `path.resolve(task.base)` 当 glob base）算出错误 base、**一个条目都匹配不到且不报错**。
      // 实测：`_audit/diag-fastglob.mts`。所以现在认盘符（Linux 部署上这条分支不触发）。
      (globalThis as any).__spcEnv = JSON.stringify({ dataDir: 'D:\\spc\\data' });
      const winFresh = await loadShimFresh('node-path.js');
      assert.equal(winFresh.resolve('a'), 'D:/spc/data/a');
      assert.equal(winFresh.resolve('D:/spc/data/a'), 'D:/spc/data/a'); // 幂等：不再拼 cwd
      assert.equal(winFresh.dirname(winFresh.resolve('a')), 'D:/spc/data');
      assert.equal(winFresh.isAbsolute(winFresh.resolve('a')), true);
    } finally {
      if (prev === undefined) delete (globalThis as any).__spcEnv;
      else (globalThis as any).__spcEnv = prev;
    }
    // 拿不到环境事实（宿主 realm 单测）时回退 `/`，不抛错
    delete (globalThis as any).__spcEnv;
    const fallback = await loadShimFresh('node-path.js');
    assert.equal(fallback.resolve('a.txt'), '/a.txt');
  });

  it('常量与 win32 的处置', () => {
    // 默认导出 = **跟随仿真平台**那一套（P2-E / 模型 B）。这个测试文件没注入 `__spcEnv`，
    // 所以回退到 linux/posix（与 `node-constants.js` 的回退同源）。
    assert.equal(shim.sep, '/');
    assert.equal(shim.delimiter, ':');
    // posix 自指（与 Node 一致：`path.posix.posix === path.posix`）；default 与 posix 同体
    assert.equal(shim.posix.posix, shim.posix);
    assert.equal(shim.default, shim.posix);
    assert.equal(shim.default.sep, node.sep);
    // `path.win32` 是**真实现**（不再是"明确抛错"的占位）：两条自指关系与 Node 一致
    assert.equal(shim.win32.win32, shim.win32);
    assert.equal(shim.win32.posix, shim.posix);
    assert.equal(shim.win32.sep, '\\');
    assert.equal(shim.win32.join('a', 'b'), 'a\\b');
    // win32 与 posix 是**两套**语义，别把默认导出当成 win32
    assert.equal(shim.posix.join('a', 'b'), 'a/b');
  });

  it('`path.win32` 的真语义有一条**本地判卷人**：与真 Windows node 的差分脚本', () => {
    // 这里只钉几个"最容易被顺手改坏"的点；完整差分（366 组）在
    // `_audit/path-win32-diff.mjs`（判卷人 = `_tools/node-v22.22.1-win-x64/node.exe`）
    assert.equal(shim.win32.resolve('C:/x/../y'), 'C:\\y');
    assert.equal(shim.win32.normalize('C:/a//b/./c/'), 'C:\\a\\b\\c\\');
    assert.equal(shim.win32.isAbsolute('C:a'), false); // 盘符**相对**路径不是绝对
    assert.equal(shim.win32.isAbsolute('C:/a'), true);
    assert.equal(shim.win32.dirname('C:\\a\\b'), 'C:\\a');
    assert.equal(shim.win32.relative('C:\\a\\b', 'C:\\a\\b\\c'), 'c');
    assert.deepEqual(shim.win32.parse('C:\\a\\b.txt'), {
      root: 'C:\\', dir: 'C:\\a', base: 'b.txt', ext: '.txt', name: 'b',
    });
    // 保留设备名（`CON` 这类）在 join 里有"跳过 normalize"的特判
    assert.equal(shim.win32.join('CON', 'x'), 'CON\\x');
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
    // C5 回归：这条用例的名字一直说"改静态值仍生效"，但**从来没改过静态值**——
    // 于是"构造时快照了 defaultMaxListeners"的错误实现照样能过。现在真的改，并比 Node。
    const mine = shim.EventEmitter;
    const theirs = nodeEvents.EventEmitter;
    const prevMine = mine.defaultMaxListeners;
    const prevTheirs = theirs.defaultMaxListeners;
    try {
      const builtBefore = new mine();
      const nodeBuiltBefore = new theirs();
      mine.defaultMaxListeners = 3;
      theirs.defaultMaxListeners = 3;
      // 构造**之后**才改的静态值也必须生效（惰性继承，不是构造时快照）
      assert.equal(builtBefore.getMaxListeners(), 3);
      assert.equal(builtBefore.getMaxListeners(), nodeBuiltBefore.getMaxListeners());

      // 显式 setMaxListeners 之后不再跟随静态值
      const pinned = new mine();
      pinned.setMaxListeners(9);
      mine.defaultMaxListeners = 5;
      theirs.defaultMaxListeners = 5;
      assert.equal(pinned.getMaxListeners(), 9);
      assert.equal(new mine().getMaxListeners(), new theirs().getMaxListeners());

      // 非法值两边都拒（Node 抛 ERR_OUT_OF_RANGE）
      assert.throws(() => {
        mine.defaultMaxListeners = -1;
      }, (err: any) => err.code === 'ERR_OUT_OF_RANGE');
      assert.throws(() => {
        theirs.defaultMaxListeners = -1;
      }, (err: any) => err.code === 'ERR_OUT_OF_RANGE');
    } finally {
      mine.defaultMaxListeners = prevMine;
      theirs.defaultMaxListeners = prevTheirs;
    }
  });

  // ── A14–A18：这些语义**不是"某个方法返回什么"**，逐方法断言抓不住，只能整段剧本比 ──
  //
  // 判卷人仍是 Node：同一段剧本分别跑 shim 与宿主实现，比可观测签名（含抛错的码）。
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const sigOf = async (fn: () => unknown): Promise<string> => {
    try {
      return String(await fn());
    } catch (err: any) {
      return `THROW:${err?.code ?? err?.name}:${err?.message}`;
    }
  };

  const SEMANTIC_CASES: [string, (m: any) => unknown][] = [
    // A18：函数式构造器（ES5 继承）与可枚举的原型方法
    ['A18 EventEmitter.call(this) 可用', (m) => {
      function Foo(this: any) {
        m.default.call(this);
      }
      Foo.prototype = Object.create(m.default.prototype);
      const f = new (Foo as any)();
      let seen = '';
      f.on('x', (v: string) => {
        seen = v;
      });
      f.emit('x', 'ok');
      return `${seen}/${f instanceof m.default}`;
    }],
    ['A18 原型方法可枚举（与 Node 的普通赋值一致）', (m) => {
      const keys = Object.keys(m.default.prototype);
      return ['on', 'emit', 'once', 'removeListener'].map((k) => `${k}=${keys.includes(k)}`).join(',');
    }],
    ['A18 二次 init 不丢监听器', (m) => {
      const e = new m.default();
      e.on('x', () => {});
      m.init.call(e);
      return `count=${e.listenerCount('x')}`;
    }],
    ['A18 _eventsCount 维护', (m) => {
      const e = new m.default();
      const f = () => {};
      e.on('x', f);
      e.on('y', () => {});
      e.removeListener('x', f);
      return `count=${e._eventsCount}`;
    }],

    // A14：元事件
    ['A14 newListener 在加入**之前**触发（且带原函数）', (m) => {
      const e = new m.default();
      const log: string[] = [];
      e.on('newListener', (type: unknown, fn: any) =>
        log.push(`nl:${String(type)}:${fn.name}:${e.listenerCount(type as string)}`));
      function handler() {}
      e.on('x', handler);
      return log.join('|') + ` after=${e.listenerCount('x')}`;
    }],
    ['A14 once 的 newListener 收到**原函数**', (m) => {
      const e = new m.default();
      const log: string[] = [];
      e.on('newListener', (type: unknown, fn: any) => log.push(`${String(type)}:${fn.name}`));
      function handler() {}
      e.once('x', handler);
      return log.join('|');
    }],
    ['A14 removeListener 在移除**之后**触发', (m) => {
      const e = new m.default();
      const log: string[] = [];
      e.on('removeListener', (type: unknown, fn: any) =>
        log.push(`rl:${String(type)}:${fn.name}:${e.listenerCount(type as string)}`));
      function handler() {}
      e.on('x', handler);
      e.removeListener('x', handler);
      return log.join('|');
    }],
    ['A14 移除不存在的监听器不发元事件', (m) => {
      const e = new m.default();
      let n = 0;
      e.on('removeListener', () => n++);
      e.removeListener('x', () => {});
      return `n=${n}`;
    }],
    ['A14 once 自动摘除也发 removeListener', (m) => {
      const e = new m.default();
      const log: string[] = [];
      e.on('removeListener', (type: unknown, fn: any) => log.push(`${String(type)}:${fn.name}`));
      function handler() {}
      e.once('x', handler);
      e.emit('x');
      return `${log.join('|')} count=${e.listenerCount('x')}`;
    }],
    ['A14 removeAllListeners() 逐个发 removeListener', (m) => {
      const e = new m.default();
      const log: string[] = [];
      e.on('a', function fa() {});
      e.on('b', function fb() {});
      e.on('removeListener', (type: unknown, fn: any) => log.push(`${String(type)}:${fn.name}`));
      e.removeAllListeners();
      return log.sort().join('|');
    }],

    // A15：errorMonitor 是**旁路**
    ['A15 errorMonitor 无 error 监听时也收到（且仍然抛）', (m) => {
      const e = new m.default();
      const log: string[] = [];
      e.on(m.errorMonitor, (err: Error) => log.push('mon:' + err.message));
      let thrown = 'none';
      try {
        e.emit('error', new Error('boom'));
      } catch (err: any) {
        thrown = err.message;
      }
      return `${log.join('|')} thrown=${thrown}`;
    }],
    ['A15 errorMonitor 先于 error 监听器触发', (m) => {
      const e = new m.default();
      const log: string[] = [];
      e.on(m.errorMonitor, () => log.push('mon'));
      e.on('error', () => log.push('handler'));
      e.emit('error', new Error('x'));
      return log.join('|');
    }],

    // A16：captureRejections
    ['A16 async 监听器的 rejection 送到 error', async (m) => {
      const e = new m.default({ captureRejections: true });
      const log: string[] = [];
      e.on('error', (err: Error) => log.push('err:' + err.message));
      e.on('x', async () => {
        throw new Error('async-boom');
      });
      e.emit('x');
      await tick();
      await tick();
      return log.join('|');
    }],
    ['A16 rejection 钩子（Symbol.for(nodejs.rejection)）优先', async (m) => {
      const e = new m.default({ captureRejections: true });
      const log: string[] = [];
      e[Symbol.for('nodejs.rejection')] = (err: Error, type: string) => log.push(`rej:${type}:${err.message}`);
      e.on('error', () => log.push('err')); // 不该走到这里
      e.on('x', async () => {
        throw new Error('boom');
      });
      e.emit('x');
      await tick();
      await tick();
      return log.join('|');
    }],
    ['A16 静态 captureRejections 只影响新实例；实例上没有该属性', async (m) => {
      const prev = m.default.captureRejections;
      try {
        m.default.captureRejections = true;
        const e = new m.default();
        const log: string[] = [];
        e.on('error', (err: Error) => log.push('err:' + err.message));
        e.on('x', async () => {
          throw new Error('boom');
        });
        e.emit('x');
        await tick();
        await tick();
        return `${log.join('|')} instance=${e.captureRejections}`;
      } finally {
        m.default.captureRejections = prev;
      }
    }],
    ['A16 同步监听器抛错不被捕获机制吞掉', (m) => {
      const e = new m.default({ captureRejections: true });
      e.on('x', () => {
        throw new Error('sync-boom');
      });
      try {
        e.emit('x');
        return 'no-throw';
      } catch (err: any) {
        return err.message;
      }
    }],

    // A17：静态 on() 迭代器
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
    ['A17 error 让挂起的 next() 拒绝（不再永久挂起）', async (m) => {
      const e = new m.default();
      const it = m.on(e, 'x');
      const pending = it.next().then(
        () => 'resolved',
        (err: Error) => 'rejected:' + err.message,
      );
      e.emit('error', new Error('boom'));
      return pending;
    }],
    ['A17 throw() 让挂起的 next() 拒绝；非 Error 参数报错', async (m) => {
      const e = new m.default();
      const it = m.on(e, 'x');
      const pending = it.next().then(
        () => 'resolved',
        (err: Error) => 'rejected:' + err.message,
      );
      it.throw(new Error('manual'));
      const after = await pending;
      const it2 = m.on(e, 'y');
      let bad = 'no-throw';
      try {
        it2.throw('nope');
      } catch (err: any) {
        bad = 'throw:' + err.code;
      }
      await it2.return();
      return `${after}|${bad}`;
    }],
    ['A17 on(emitter,"error") 不额外注册 error 监听', async (m) => {
      const e = new m.default();
      const it = m.on(e, 'error');
      const n = e.listenerCount('error');
      await it.return();
      return `count=${n}`;
    }],
    ['既有 removeAllListeners(undefined) 只删该事件', (m) => {
      const e = new m.default();
      e.on(undefined, () => {});
      e.on('a', () => {});
      e.removeAllListeners(undefined);
      return `undef=${e.listenerCount(undefined)} a=${e.listenerCount('a')}`;
    }],
  ];

  it('A14–A18 语义：同一段剧本与宿主 Node 逐条一致', async () => {
    for (const [label, run] of SEMANTIC_CASES) {
      const mine = await sigOf(() => run(shim));
      const theirs = await sigOf(() => run(nodeEvents));
      assert.equal(mine, theirs, label);
    }
  });

  it('`removeAllListeners(undefined)` 只删名为 undefined 的事件，**不是全清**', () => {
    // 真实形态是 `e.removeAllListeners(opts.event)`，opts.event 可能恰好是 undefined。
    // 用"判 undefined"实现的话会把**所有**监听器静默拆掉（破坏性且难查）。
    for (const EE of [shim.EventEmitter, nodeEvents.EventEmitter]) {
      const e = new EE();
      e.on('a', () => {});
      e.on('b', () => {});
      e.removeAllListeners(undefined);
      assert.equal(e.listenerCount('a'), 1, `${EE.name}: 'a' 的监听器不该被清`);
      assert.equal(e.listenerCount('b'), 1);
      e.removeAllListeners(); // 无参才是全清
      assert.equal(e.listenerCount('a'), 0);
      assert.equal(e.listenerCount('b'), 0);
    }
  });

  it('`listenerCount(type, null)` 与不传等价（Node 用 `listener != null`）', () => {
    for (const EE of [shim.EventEmitter, nodeEvents.EventEmitter]) {
      const e = new EE();
      const f = () => {};
      e.on('x', f);
      e.on('x', f);
      assert.equal(e.listenerCount('x', null), 2);
      assert.equal(e.listenerCount('x', undefined), 2);
    }
  });

  // C9：零散缺口（审计期间靠随机剧本覆盖过，但仓库里没有会红的用例）
  it('C9：`__proto__` 作事件名是普通键（不污染原型）', () => {
    for (const EE of [shim.EventEmitter, nodeEvents.EventEmitter]) {
      const e = new EE();
      let seen = 0;
      e.on('__proto__', () => seen++);
      assert.equal(e.listenerCount('__proto__'), 1, EE.name);
      assert.equal(e.emit('__proto__'), true);
      assert.equal(seen, 1);
      // `_events` 是无原型对象，写 `__proto__` 不会改掉它（也不是 setter）
      assert.equal(Object.getPrototypeOf(e), EE.prototype);
      assert.deepEqual(e.eventNames(), ['__proto__']);
    }
  });

  it('C9：prependOnceListener 的位置与一次性都对', () => {
    for (const EE of [shim.EventEmitter, nodeEvents.EventEmitter]) {
      const e = new EE();
      const log: string[] = [];
      e.on('x', () => log.push('on1'));
      e.prependOnceListener('x', () => log.push('ponce'));
      e.prependListener('x', () => log.push('p'));
      e.emit('x');
      e.emit('x');
      assert.deepEqual(log, ['p', 'ponce', 'on1', 'p', 'on1'], EE.name);
    }
  });

  it("`emit('error')` 无监听器：非 Error 值包成 ERR_UNHANDLED_ERROR（带 context）", () => {
    for (const EE of [shim.EventEmitter, nodeEvents.EventEmitter]) {
      // Error 实例原样抛出（不包装）
      const boom = new Error('boom');
      assert.throws(
        () => new EE().emit('error', boom),
        (e: any) => e === boom,
      );
      // 非 Error 值：Node 包成带 code 与 context 的 Error
      for (const value of ['str', undefined]) {
        try {
          new EE().emit('error', value);
          assert.fail('应当抛');
        } catch (e: any) {
          assert.equal(e.code, 'ERR_UNHANDLED_ERROR', `${EE.name}: code 不符`);
          assert.equal(e.context, value, `${EE.name}: context 不符`);
        }
      }
    }
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
    // 第二批登记了 fs/fs/promises/url、第三批登记了 stream 一族；**未登记**的例子要用
    // 设计上永不登记的模块（这条断言已经随排期失效过两次：`node:fs`、`node:stream`）
    for (const spec of ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'node:url', 'url',
      'stream', 'node:stream', 'stream/promises', 'querystring', 'worker_threads']) {
      assert.equal(reg.isRegistered(spec), true, `${spec} 应当已登记`);
    }
    assert.equal(reg.isRegistered('node:child_process'), false, 'child_process 是永不登记的能力面');
    assert.equal(reg.isRegistered('node:http'), false, 'http 是永不登记的能力面');
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

  it('文件名约定与规范名一致（子路径的 / 变 -，**下划线原样保留**）', () => {
    assert.equal(reg.shimFileName('path'), 'node-path.js');
    assert.equal(reg.shimFileName('node:path'), 'node-path.js');
    // 连字符只来自**路径分隔符**的替换
    assert.equal(reg.shimFileName('fs/promises'), 'node-fs-promises.js');
    assert.equal(reg.shimFileName('util/types'), 'node-util-types.js');
    // 下划线是规范名的一部分，**不能**被换成连字符（`string_decoder` 是 Node 的真实模块名）
    assert.equal(reg.shimFileName('string_decoder'), 'node-string_decoder.js');
    assert.equal(reg.shimFileName('node:string_decoder'), 'node-string_decoder.js');
  });

  /**
   * 命名约定的**另一半**：哪些文件名算 shim 文件（加载器服务"shim 之间的相对 import"时用它）。
   * 两处一旦漂移，症状是"文件名按约定写了、加载器却不服务它"。
   * 曾经这里只认 `[a-z0-9-]`，`node-string_decoder.js` 因此过不了（没有 shim import 它所以没炸，
   * 但 `stream` 那批一定会——`node-stream.js` 要用 StringDecoder）。
   */
  it('**每个真实的 node-*.js 都必须过加载器的文件名判据**（含下划线那种）', () => {
    const registered = [...new Set(reg.SANDBOX_MODULES.map((m) => reg.shimFileName(m.canonical)))];
    // 反例先钉住：连字符形状曾是唯一被接受的形状
    assert.equal(reg.isShimFileName('node-string_decoder.js'), true, '下划线文件名必须被认');
    assert.equal(reg.isShimFileName('node-string-decoder.js'), true);
    assert.equal(reg.isShimFileName('node-fs-promises.js'), true);
    // 越界形状一律不认（加载器只拿基名拼路径，这里是它的安全边界）
    for (const bad of ['../node-fs.js', 'node-fs.js/../x', 'node-FS.js', 'node-.js', 'nodefs.js', 'node-fs.mjs', 'fs.js']) {
      assert.equal(reg.isShimFileName(bad), false, `${bad} 不该被当作 shim 文件名`);
    }
    // 真实文件逐个过判据（这条是"注册表 ↔ 加载器"不漂移的守门人）
    const files = readdirSync(DIR).filter((f) => f.startsWith('node-') && f.endsWith('.js'));
    assert.ok(files.length > 0);
    for (const f of files) {
      assert.equal(reg.isShimFileName(f), true, `${f} 是真实 shim 文件，却过不了加载器的形状判据`);
      assert.ok(registered.includes(f), `${f} 是真实 shim 文件，却不在登记表里`);
    }
  });

  // B1 回归：这几个子路径入口**在 Node 里真实存在**，缺了会让依赖在装载期就失败
  it('子路径入口齐全：assert/strict、path/posix、path/win32', () => {
    for (const spec of ['node:assert/strict', 'assert/strict', 'node:path/posix', 'path/posix', 'node:path/win32', 'path/win32']) {
      assert.equal(reg.isRegistered(spec), true, `${spec} 应当已登记`);
    }
    // 文件名约定：**`path/posix` 不再是 `path` 的别名**（P2-E）——它必须固定 POSIX 语义，
    // 而 `node:path` 的导出跟随仿真平台（Windows 上给 `\`）。ESM 模块不知道自己被哪个 specifier
    // 引入，所以共用一份实现就没法区分"谁在问"。
    assert.equal(reg.shimFileName('path/posix'), 'node-path-posix.js');
    assert.equal(reg.shimFileName('path/win32'), 'node-path-win32.js');
    assert.equal(reg.shimFileName('path'), 'node-path.js');
    assert.equal(reg.shimFileName('assert/strict'), 'node-assert-strict.js');
  });
});

// ─────────────────────────────────────────────────────────────
// assert/strict 与 path/win32（B1 的子路径入口）
// ─────────────────────────────────────────────────────────────
describe('仿真 node:assert/strict —— 与 node:assert/strict 对齐', async () => {
  const shim = await loadShim('node-assert-strict.js');
  const nodeStrict: any = (await import('node:assert/strict')).default;

  it('默认导出**可调用**（Node 里 `assert/strict` 本身就是函数）', () => {
    assert.equal(typeof shim.default, 'function');
    assert.equal(typeof nodeStrict, 'function');
    assert.doesNotThrow(() => shim.default(true));
    assert.throws(() => shim.default(false), (e: any) => e.name === 'AssertionError');
  });

  it('四个宽松名字指向**严格**实现（比 Node 弱就是静默漏判）', () => {
    for (const [loose, strict] of [
      ['equal', 'strictEqual'],
      ['notEqual', 'notStrictEqual'],
      ['deepEqual', 'deepStrictEqual'],
      ['notDeepEqual', 'notDeepStrictEqual'],
    ]) {
      assert.equal(shim[loose], shim[strict], `${loose} 应当就是 ${strict}`);
      assert.equal(nodeStrict[loose], nodeStrict[strict], `Node 的 ${loose} 是 ${strict}`);
    }
    // 判别力：宽松 equal 放过的 `1 == '1'`，strict 必须拒
    assert.throws(() => shim.equal(1, '1'), (e: any) => e.name === 'AssertionError');
    assert.throws(() => nodeStrict.equal(1, '1'), (e: any) => e.name === 'AssertionError');
  });

  it('导出面：不自造名字，未实现的 Node 名字显式列出来（不假装有）', () => {
    const ours = Object.keys(shim).filter((k) => k !== 'default');
    const nodeNames = new Set(Object.keys(nodeStrict));
    for (const k of ours) assert.ok(nodeNames.has(k), `shim 导出了 Node 没有的 ${k}`);
    const missing = [...nodeNames].filter((k) => k !== 'default' && !ours.includes(k)).sort();
    // 这三个属于更宽的 assert 面（P2 补），列出来是为了"缺了就是缺了"，而不是让人以为齐了
    assert.deepEqual(missing, ['Assert', 'CallTracker', 'partialDeepStrictEqual']);
  });
});

describe('仿真 node:path/win32 —— 真实现（P2-E）', async () => {
  const shim = await loadShim('node-path-win32.js');
  const nodeWin32: any = (await import('node:path')).win32;

  it('sep / delimiter 与 Node 的 win32 一致', () => {
    assert.equal(shim.sep, nodeWin32.sep);
    assert.equal(shim.delimiter, nodeWin32.delimiter);
  });

  it('方法**真的能用**，并且与 Node 的 win32 在可移植用例上逐条一致', async () => {
    // ⚠️ 这条用例以前断言的是"每个方法都抛 ERR_NOT_SUPPORTED_IN_SANDBOX"（模型 A 的占位）。
    // P2-E 换成模型 B 之后 win32 必须有真语义，所以改成**与宿主 Node 的 win32 比**。
    // 注意：`node:path.win32` 在**任何**平台上都可用（它是纯算法），所以这里在 Linux CI 上也有判卷人。
    // cwd 相关的用例不在这里比（我们与宿主的 cwd 不同），那部分交给 `_audit/path-win32-diff.mjs`。
    const portable: Array<[string, unknown[]]> = [
      ['normalize', ['C:/a//b/./c/']],
      ['normalize', ['C:\\a\\..\\..\\b']],
      ['normalize', ['\\\\server\\share\\a\\..']],
      ['normalize', ['CON']],
      ['normalize', ['a:C:']],
      ['isAbsolute', ['C:/a']],
      ['isAbsolute', ['C:a']],
      ['isAbsolute', ['\\\\server\\share']],
      ['join', ['a/b', 'c\\d']],
      ['join', ['//server', 'share']],
      ['join', ['CON', 'x']],
      ['relative', ['C:\\a\\b', 'C:\\a\\b\\c']],
      ['relative', ['C:\\a', 'C:\\a\\b\\c']],
      ['relative', ['C:\\a\\b\\c', 'C:\\a']],
      ['relative', ['C:\\A\\B', 'c:\\a\\b\\c']],
      ['dirname', ['C:\\a\\b.txt']],
      ['dirname', ['\\\\server\\share\\a\\b']],
      ['basename', ['C:\\a\\b.txt', '.txt']],
      ['basename', ['C:\\a\\b\\']],
      ['extname', ['C:\\a\\b.tar.gz']],
      ['extname', ['C:.txt']],
      ['parse', ['C:\\a\\b.txt']],
      ['parse', ['\\\\server\\share\\a\\b.txt']],
      ['format', [{ dir: 'C:\\a', name: 'b', ext: 'txt' }]],
    ];
    for (const [m, args] of portable) {
      assert.equal(typeof shim[m], 'function', `${m} 应当是函数`);
      assert.deepEqual(
        (shim[m] as any)(...args),
        nodeWin32[m](...args),
        `win32.${m}(${args.map((a) => JSON.stringify(a)).join(', ')}) 与 Node 不一致`,
      );
    }
    // 命名导出与默认导出是同一个对象上的同一批函数
    assert.equal(shim.join, shim.default.join);
    // ⚠️ 这里**不**断言 `shim.default === pathShim.win32`：测试是"逐文件考到临时目录再 import"，
    // `node-path-win32.js` 与 `node-path.js` 各自的 `getWin32()` 会各自建一个对象（同一实现、两个壳）。
    // 真沙箱里 `node:path` 与 `node:path/win32` 都解析到 `node-path.js` 同一模块实例 ⇒ 那里是同一个对象。
  });
});

// ─────────────────────────────────────────────────────────────
// 桥的二进制通道 + @host/api bytes 组
// ─────────────────────────────────────────────────────────────
describe('桥的二进制通道（@host/api bytes 组）', async () => {
  const { createSandbox } = await import('../sandbox.ts');
  const { hostApi } = await import('../hostApi.ts');

  /** 跑一段插件代码并回收 console 输出（二进制不便直接回传，用日志带出来） */
  async function runInSandbox(code: string): Promise<string> {
    const sandbox = await createSandbox(hostApi, {
      pluginId: '@spc-test/bytes',
      permissions: ['bytes.encode', 'bytes.decode'],
      grants: [],
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule('@spc-test/bytes', code);
    } finally {
      console.log = orig;
      sandbox.dispose();
    }
    return logs.join('\n');
  }

  const SAMPLE = 'héllo→世界';

  /**
   * C7 回归：这里原来用 `assert.match(out, new RegExp('B64 …'))` 做**子串**匹配 ——
   * 两个毛病：① 输出尾部带垃圾也能过；② base64 里的 `+` / `/` 是正则元字符，
   * 某些输入下**正确输出反而不匹配**。现在改成"按行解析 + 逐值相等"。
   */
  it('utf8 编码：字节数 / hex / base64 与宿主 Node 逐项一致', async () => {
    const out = await runInSandbox(`
import { bytes } from '@host/api';
const b = bytes.fromString(${JSON.stringify(SAMPLE)}, 'utf8');
console.log('LEN ' + b.length + ' ' + bytes.byteLength(${JSON.stringify(SAMPLE)}, 'utf8'));
console.log('HEX ' + bytes.toString(b, 'hex'));
console.log('B64 ' + bytes.toString(b, 'base64'));
console.log('BACK ' + bytes.toString(b, 'utf8'));
`);
    const expected = Buffer.from(SAMPLE, 'utf8');
    const field = (name: string): string => {
      const line = out.split('\n').find((l) => l.startsWith(name + ' '));
      assert.ok(line, `输出里没有 ${name} 行：${out}`);
      return line.slice(name.length + 1);
    };
    assert.equal(field('LEN'), `${expected.length} ${expected.length}`);
    assert.equal(field('HEX'), expected.toString('hex'));
    assert.equal(field('B64'), expected.toString('base64'));
    assert.equal(field('BACK'), SAMPLE);
  });

  /**
   * C6 回归：原来只比 `'Ab9'` 的**往返**——纯 ASCII 且往返自洽，于是"完全忽略 encoding"
   * 的实现照样通过。判别力来自**字节长度**：同一个 `'Ab9'` 在 ucs2 下是 6 字节、
   * base64 下 2 字节、hex 下 1 字节……忽略 encoding 就全变成 3 字节。
   */
  it('编码别名：字节长度与往返都与宿主 Node 一致（忽略 encoding 会立刻露馅）', async () => {
    // 别名的**有效集合**由宿主 Node 说了算（`Buffer.isEncoding`）：例如 `utf-16-le` 在
    // 这一版 Node 上是未知编码，那 shim 也必须拒——两边用同一把尺子，不靠记忆。
    const candidates = ['utf8', 'utf-8', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'utf-16-le', 'latin1', 'binary', 'ascii', 'base64', 'base64url', 'hex'];
    const valid = candidates.filter((e) => Buffer.isEncoding(e));
    const invalid = candidates.filter((e) => !Buffer.isEncoding(e));
    const out = await runInSandbox(`
import { bytes } from '@host/api';
const text = 'Ab9';
const r = [];
for (const e of ${JSON.stringify(candidates)}) {
  try {
    const b = bytes.fromString(text, e);
    r.push(e + '=' + b.length + ':' + bytes.toString(b, e));
  } catch (err) { r.push(e + '!' + err.code); }
}
console.log(r.join('|'));
`);
    const mine = out.trim().split('|');
    assert.equal(mine.length, candidates.length, `别名数量对不上：${out}`);
    const at = (e: string): string => mine[candidates.indexOf(e)];

    valid.forEach((e) => {
      const buf = Buffer.from('Ab9', e as BufferEncoding);
      assert.equal(at(e), `${e}=${buf.length}:${buf.toString(e as BufferEncoding)}`, `编码 ${e} 与 Node 不一致`);
    });
    // 反方向同样重要：Node 拒的我们必须也拒（否则"靠 String() 兜底"的实现会静默接受任何名字）
    invalid.forEach((e) => {
      assert.equal(at(e), `${e}!ENCODING_UNKNOWN`, `编码 ${e}：Node 拒了，我们也该拒`);
    });
    // 别名等价关系本身也是契约（映射写错时"长度"未必看得出来）
    const value = (e: string): string => at(e).split(':')[1];
    assert.equal(value('utf8'), value('utf-8'));
    assert.equal(value('ucs2'), value('utf16le'));
    assert.equal(value('ucs-2'), value('utf16le'));
    assert.equal(value('latin1'), value('binary'));
  });

  it('未知编码 → ENCODING_UNKNOWN（与 Node 的 ERR_UNKNOWN_ENCODING 同一个位置拦）', async () => {
    const out = await runInSandbox(`
import { bytes } from '@host/api';
let code = 'NO-THROW';
try { bytes.fromString('x', 'nope'); } catch (e) { code = e.code; }
console.log('CODE ' + code);
`);
    assert.equal(out.trim(), 'CODE ENCODING_UNKNOWN');
    // 宿主 Node 也在同一位置拒（只是码不同：Node 是 ERR_UNKNOWN_ENCODING）
    assert.throws(() => Buffer.from('x', 'nope' as BufferEncoding), /Unknown encoding|unknown encoding/i);
  });

  it('**非法 UTF-8 字节的解码与 Node 同一套语义**（畸形输入才是重点）', async () => {
    // 这是对齐测试的核心价值：自己实现 utf8 最容易在"非法序列怎么替换"上偏，
    // 而走宿主就"本来一样"，不必复刻规则。
    // 用的字节是 WTF-8 编码的孤立代理项（ED A0 80）——Node 在这里逐字节判非法、吐 3 个 U+FFFD。
    const bad = [0x61, 0xed, 0xa0, 0x80, 0x62];
    const out = await runInSandbox(`
import { bytes } from '@host/api';
const bad = new Uint8Array(${JSON.stringify(bad)});
const s = bytes.toString(bad, 'utf8');
console.log('DEC ' + s);
console.log('REENC ' + bytes.toString(bytes.fromString(s, 'utf8'), 'hex'));
`);
    const field = (name: string): string => {
      const line = out.split('\n').find((l) => l.startsWith(name + ' '));
      assert.ok(line, `输出里没有 ${name} 行：${out}`);
      return line.slice(name.length + 1);
    };
    const decoded = Buffer.from(bad).toString('utf8');
    assert.equal(field('DEC'), decoded);
    assert.equal(field('REENC'), Buffer.from(decoded, 'utf8').toString('hex'));
  });

  it('**已知的桥属性（记录在案，不是待修 bug）**：字符串参数过桥按 UTF-8 走', async () => {
    // 桥的字符串通道是 UTF-8（JS_ToCString）：孤立代理项被编成 WTF-8 三字节，
    // 宿主解码时逐字节判非法 → **3 个** U+FFFD；而 Node 直接编码字符串时只给 1 个。
    // 现实影响很小：只有把字符串从代理对中间切开才会产生孤立代理项，那本就是调用方的 bug。
    // 这条测试是"守门"：哪天桥换成 UTF-16 传递，它会红，提醒把注释与文档一起改。
    const out = await runInSandbox(`
import { bytes } from '@host/api';
console.log('HEX ' + bytes.toString(bytes.fromString('a\\uD800b', 'utf8'), 'hex'));
`);
    const mine = /HEX ([0-9a-f]+)/.exec(out)?.[1];
    assert.ok(mine, `没拿到 HEX 行：${out}`);
    // C8 回归：不把**宿主 Node 的字节**写死（Node 改语义时不该让我们变红），
    // 而是断言"两者必须不同"——相同就说明这条已知属性已不成立
    const nodeHex = Buffer.from('a\uD800b', 'utf8').toString('hex');
    assert.notEqual(mine, nodeHex, '桥与宿主 Node 的行为不该相同（见本用例注释）');
    // 我们这边是"3 个 U+FFFD"：这是我们自己的行为，写死它才是对的
    assert.equal(mine, '61efbfbdefbfbdefbfbd62');
  });

  it('**非字符串文本参数要被拒**（而不是 `String()` 后静默算错）', async () => {
    // `byteLength(new Uint8Array([1,2,3]))` 曾经去数字符串 `"1,2,3"` 的长度（5）——静默错值。
    // 校验在**沙箱侧包装器**里做（`__marshal` 之后宿主就看不到原值了），错误码用 Node 形状。
    const out = await runInSandbox(`
import { bytes } from '@host/api';
const cases = [
  () => bytes.byteLength(new Uint8Array([1, 2, 3])),
  () => bytes.fromString({}),
  () => bytes.fromString(null),
  () => bytes.fromString('x', 123),
];
const r = [];
for (const f of cases) { try { f(); r.push('NO-THROW'); } catch (e) { r.push(e.code); } }
console.log(r.join(','));
`);
    assert.match(out, /ERR_INVALID_ARG_TYPE,ERR_INVALID_ARG_TYPE,ERR_INVALID_ARG_TYPE,ERR_INVALID_ARG_TYPE/);
  });

  it('未知编码 → 抛错，码是宿主契约码 ENCODING_UNKNOWN', async () => {
    const out = await runInSandbox(`
import { bytes } from '@host/api';
try { bytes.fromString('x', 'nope'); console.log('NO-THROW'); }
catch (e) { console.log('CAUGHT ' + e.code); }
`);
    assert.match(out, /CAUGHT ENCODING_UNKNOWN/);
  });

  it('字节 → 字符串：Uint8Array / ArrayBuffer / 带 offset 的视图都要正确', async () => {
    const out = await runInSandbox(`
import { bytes } from '@host/api';
const u8 = new Uint8Array([104, 105]);            // 'hi'
console.log('U8 ' + bytes.toString(u8, 'utf8'));
console.log('AB ' + bytes.toString(u8.buffer, 'utf8'));
// 带 offset 的视图：桥必须只取该区间，不能把整块 buffer 送过去
const big = new Uint8Array([0, 104, 105, 0]);
console.log('VIEW ' + bytes.toString(big.subarray(1, 3), 'utf8'));
`);
    assert.match(out, /U8 hi/);
    assert.match(out, /AB hi/);
    assert.match(out, /VIEW hi/);
  });

  /**
   * C2 回归：这条守门曾经**守的不是它声称的东西**——`grants: []` 让两边都只拿到
   * 60 字节的 `PERMISSION_DENIED` 信封，而且插件**不看返回值**，于是"二进制通道更快"
   * 实际比的是两条错误路径。现在：真的授予权限 + 断言载荷**确实过了桥**（尺寸对得上）。
   */
  it('**成本回归守门**：二进制通道必须显著快于字符串通道（且载荷真的过了桥）', async () => {
    // 为什么用**相对比较**而不是绝对阈值：
    //   ① 绝对毫秒数随机器波动，容易 flaky；
    //   ② 实测"跨界底价"≈0.2ms/次，**小载荷下两条通道测不出差别**（都被底价盖住）；
    //   ③ 而"二进制比字符串快多少倍"是**架构性质**——把二进制改走 base64/字符串，
    //      这个比值会从 ~20x 塌到 1x 附近。这是最省事又不容易误报的守门方式。
    //
    // 实测（同机）：1 MB 宿主→沙箱 二进制 ≈0.84ms / 字符串 ≈19ms ⇒ ~22x；4 MB ⇒ ~34x。
    // 这里留足余量只要求 5x——真正要抓的是"塌到 1x"那种结构性回归。
    const { createSandbox } = await import('../sandbox.ts');
    const N = 1024 * 1024;

    async function measure(method: string, binaryResult: boolean): Promise<{ ms: number; size: number }> {
      const api = {
        [method]: binaryResult
          ? { permission: 'bytes.encode', binaryResult: true, fn: () => new Uint8Array(N) }
          : { permission: 'bytes.encode', fn: () => 'x'.repeat(N) },
      };
      const sandbox = await createSandbox(api, {
        pluginId: '@spc-test/bridge-cost',
        permissions: ['bytes.encode'],
        grants: ['bytes.encode'], // **必须授予**：否则两侧都只是错误信封，测的就不是通道了
      });
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
      try {
        await sandbox.runModule(
          '@spc-test/bridge-cost',
          `
const H = globalThis.__host;
const s = [];
let size = -1;
// 取值不必多：这条守的是"塌到 1x"的结构性回归，5x 的余量下精度够用，跑太久不值
for (let r = 0; r < 3; r++) {
  const t = Date.now();
  for (let i = 0; i < 4; i++) {
    const v = H[${JSON.stringify(method)}]();
    // 尺寸断言是这条守门的**前提**：拿到错误信封时"更快"毫无意义
    size = v && v.byteLength !== undefined ? v.byteLength : typeof v === 'string' ? v.length : -1;
  }
  s.push(Date.now() - t);
}
console.log(JSON.stringify({ s: s, size: size }));
`,
        );
      } finally {
        console.log = orig;
        sandbox.dispose();
      }
      const out = JSON.parse(logs.join('\n').trim()) as { s: number[]; size: number };
      return { ms: [...out.s].sort((a, b) => a - b)[Math.floor(out.s.length / 2)], size: out.size };
    }

    const bin = await measure('bridgecost.bin', true);
    const str = await measure('bridgecost.str', false);
    // 前提：1 MB 真的过了桥（不是 60 字节的错误信封）
    assert.equal(bin.size, N, '二进制侧没拿到完整载荷——权限或桥路走错了');
    // 字符串通道走的是 JSON 信封（`"…"` 会多两个引号），所以是 ≥ N
    assert.ok(str.size >= N && str.size <= N + 8, `字符串侧载荷尺寸异常：${str.size}`);
    assert.ok(
      str.ms >= bin.ms * 5,
      `二进制 ${bin.ms}ms vs 字符串 ${str.ms}ms（比值 ${(str.ms / bin.ms).toFixed(1)}x < 5x）——` +
        '二进制通道可能被改成走字符串/base64 了，见 tools/bridge-bench.mjs',
    );
  });

  /**
   * C3：二进制通道的**失败与越权分支**曾经零覆盖（S-6/S-7 也因此没有回归）。
   * 这四条的分支各不相同，且后两条是审计不变量的现场：
   *   ① 参数不是 ArrayBuffer → 桥的二进制读取失败（**参数读取失败也必须留痕** = S-7）
   *   ② 宿主实现声明了 binaryResult 却返回字符串（宿主侧缺陷，必须响亮报错而不是静默零字节）
   *   ③ 已声明未授予 → 越权（审计记**权限点**）
   *   ④ 权限点解析失败 → 审计**不得落明文 target**（S-6：`strings[0]` 完全由插件控制）
   */
  it('C3 二进制通道的失败/越权四分支（含 S-6/S-7 审计不变量）', async () => {
    const { createSandbox } = await import('../sandbox.ts');
    const PLUGIN = '@spc-test/bridge-fail';
    const api = {
      'bridgefail.ok': {
        permission: 'bytes.encode',
        binaryResult: true,
        fn: () => new Uint8Array([1, 2, 3]),
      },
      'bridgefail.notbytes': { permission: 'bytes.encode', binaryResult: true, fn: () => 'oops' },
      'bridgefail.unresolved': { permissionFor: () => null, fn: () => 'never' },
      // 越权那条要挑**会真的被拒**的点：v4 起 `bytes.*` 是 `self/auto`（**免声明免授予**），
      // 拿它测不出拒绝分支。所以这里挂一个 `host` + `explicit` 的合成点（形态同 `exec.template.*`，
      // 但不依赖机器上装了什么）——它在下面 register 进注册表。
      'bridgefail.notdeclared': { permission: 'test.bridge.host', fn: () => 'never' },
    };
    // 合成 host 点：注册一次（注册表是全局的，重复名会抛 ⇒ 已存在就跳过）
    const { registry: liveRegistry } = await import('../permissions/registry.ts');
    if (!liveRegistry.get('test.bridge.host')) {
      liveRegistry.register({
        name: 'test.bridge.host',
        group: 'test',
        description: '合成 host/explicit 点（测试用）：形态同 exec.template.*',
        scope: 'host',
        grant: 'explicit',
        confidentiality: 'sensitive',
        executionLevel: 'medium',
      });
    }
    const sandbox = await createSandbox(api, {
      pluginId: PLUGIN,
      permissions: ['bytes.encode'], // 故意**不声明**那个 host 点 ⇒ 走到 NOT_DECLARED
      grants: [],
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await sandbox.runModule(
        PLUGIN,
        `
const H = globalThis.__host;
// 直调 __host 会**绕过** @host/api 的还原层（那层把错误信封变成 throw），
// 所以这里自己解信封——测的正是**桥**的四个分支本身（包装层另有测试）
const sig = (name, ...args) => {
  let raw;
  try { raw = H[name](...args); }
  catch (e) { return 'SANDBOX-THROW:' + e.message; }
  if (typeof raw !== 'string') return 'NO-ERROR';
  const info = JSON.parse(raw).__spcError;
  if (!info) return 'NO-ERROR';
  return info.code + ':' + ((info.params && (info.params.reason || info.params.permission)) || '');
};
console.log([
  'arg=' + sig('bridgefail.ok', {}),          // 普通对象 → 不是 ArrayBuffer
  'result=' + sig('bridgefail.notbytes'),     // 宿主声明 binaryResult 却返回字符串
  'denied=' + sig('bridgefail.notdeclared'),  // 用了没声明的权限点
  'unresolved=' + sig('bridgefail.unresolved', 'C:/secret-dir/token-abc123'), // 明文参数由插件控制
].join('|'));
`,
      );
    } finally {
      console.log = orig;
      sandbox.dispose();
    }

    assert.equal(
      logs.join('\n').trim(),
      [
        'arg=INVALID_ARGS:binary-arg-not-arraybuffer',
        'result=INVALID_ARGS:binary-result-not-bytes',
        // 越权的信封里 `reason` 比 `permission` 更具体（NOT_DECLARED / NOT_GRANTED），
        // 这里取的是 reason，所以断言里看到的是它
        'denied=PERMISSION_DENIED:NOT_DECLARED',
        'unresolved=PERMISSION_DENIED:(unresolved)',
      ].join('|'),
    );

    // ── 审计不变量 ──
    const entries = readFileSync(join(AUDIT_DIR, 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, any>)
      .filter((e) => e.pluginId === PLUGIN);
    const pick = (method: string, result: string) =>
      entries.find((e) => e.method === method && e.result === result);

    // S-7：参数读取失败**必须**落审计（原先这条分支完全绕过 audit()）
    const argFail = pick('bridgefail.ok', 'error');
    assert.ok(argFail, '二进制参数读取失败没有落审计');
    assert.equal(argFail.error.code, 'INVALID_ARGS');

    const badResult = pick('bridgefail.notbytes', 'error');
    assert.ok(badResult, 'binaryResult 返回非字节没有落审计');
    assert.equal(badResult.error.code, 'INVALID_ARGS');

    // 越权：审计里记的是**权限点**（可复盘、非明文参数）
    const denied = pick('bridgefail.notdeclared', 'denied');
    assert.ok(denied, '越权没有落审计');
    assert.equal(denied.target, 'test.bridge.host');
    assert.equal(denied.permission.decision, 'deny');

    // S-6：权限点解析失败那一支**不得**写明文 target，改用 paramsDigest 关联。
    // 上面特意带了一个"像凭据"的实参——旧实现会把 `strings[0]` 原样写进 target
    // （明文永久落盘），所以这条断言是有判别力的，不是"恰好 undefined"。
    const unresolved = pick('bridgefail.unresolved', 'denied');
    assert.ok(unresolved, '权限点解析失败没有落审计');
    assert.equal(unresolved.target, undefined, '解析失败那一支不该写 target');
    assert.ok(unresolved.paramsDigest, '应当留下 paramsDigest 供复盘关联');
    assert.ok(
      !JSON.stringify(unresolved).includes('token-abc123'),
      '审计里出现了明文参数（应由 paramsDigest 替代）',
    );
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
    // 具名导出的 `join` **跟随仿真平台**（P2-E）：win32 上 `join('/a','b','..','c')` = `\a\c`
    // （前导分隔符是根）。这条以前写死 POSIX 形态，模型 B 之后必须按平台断言。
    const sandboxSep = process.platform === 'win32' ? '\\' : '/';
    assert.equal(
      out.split('\n')[0],
      'PATH ' + sandboxSep + 'a' + sandboxSep + 'c',
      `实际输出：${JSON.stringify(out)}`,
    );
    assert.match(out, /BASE y\.txt/);
    assert.match(out, /EVT ok/);
    assert.match(out, /TTY false/);
    assert.match(out, /CONST 0/);
  });

  // B1 回归：子路径入口在**沙箱里**也要能装载（登记表 + loader + shim 的相对 import 三者都得对）
  it('子路径入口在沙箱里可装载：path/posix、path/win32、assert/strict', async () => {
    const out = await runInSandbox(`
import { join as posixJoin } from 'node:path/posix';
import win32 from 'node:path/win32';
import strict from 'node:assert/strict';
console.log('POSIX ' + posixJoin('/a', 'b'));
// P2-E：win32 是**真实现**（模型 B）——不再抛错，而是给出 win32 语义的结果
console.log('WIN32 ' + win32.join('/a', 'b') + ' ' + win32.sep);
try { strict.equal(1, '1'); console.log('STRICT weak'); } catch (e) { console.log('STRICT ' + e.name); }
strict.equal(1, 1);
console.log('STRICT-OK');
`);
    assert.match(out, /POSIX \/a\/b/);
    // win32 语义：`join('/a','b')` 的前导分隔符是**根**，于是结果是 `\a\b`
    // （与 `node:path.win32.join('/a','b') === '\\a\\b'` 一致）
    assert.match(out, /WIN32 \\a\\b \\/);
    // 关键：strict 的 equal 必须是严格版（宽松版会走到 'STRICT weak'）
    assert.match(out, /STRICT AssertionError/);
    assert.match(out, /STRICT-OK/);
  });

  it('未登记的 node 内建 → 报错指出"沙箱尚未支持"，而不是让作者以为写错了', async () => {
    // 样本要挑**设计上永不登记**的模块：这条用例已经随排期推进失效过两次
    // （`node:fs` → 第二批登记；`node:stream` → 第三批 P2-D 登记）。
    // `node:child_process` 属于"一律拒绝的能力面"（设计 §9/§3.1），不会再被登记。
    await assert.rejects(
      () => runInSandbox(`import { spawn } from 'node:child_process';\nconsole.log(String(spawn));`),
      (err: any) => JSON.stringify(err).includes('沙箱尚未支持') || String(err?.message).includes('沙箱尚未支持'),
    );
  });

  /**
   * C4：`assert` 是**唯一没在真沙箱里跑过**的 shim（其余都在上面那条里 import 过）。
   *
   * 顺带钉住"零环境权力"这条不变量——注意它说的是**能力**，不是"没有 Node 全局"：
   * `process` / `Buffer` / `global` **现在有**（装的是仿真模块本身，见 core/sandbox.ts 的 GLOBALS_PRELUDE），
   * 因为真实依赖用的是**裸全局**（`mkdirp` 读 `process.platform`、`properties` 读 `process.platform`
   * 决定 EOL），没有它们这些包在装载期就 ReferenceError。
   * 但拿到的仍是**仿真值**：`platform` 固定 linux、`env` 冻结为空、`exit`/`kill` 抛错、
   * 没有宿主身份；真正不许有的是 `require`（动态 require 会让构建层的静态闸失效）。
   */
  it('C4：assert 在真沙箱里可用；Node 全局是**仿真件**，而 require 仍然不存在', async () => {
    const out = await runInSandbox(`
import assert from 'node:assert';
import { strictEqual } from 'node:assert';
assert(true);
strictEqual(1, 1);
let thrown = 'none';
try { assert(false, 'boom'); } catch (e) { thrown = e.name + ':' + e.code; }
console.log('ASSERT ' + thrown);
console.log('ENV ' + [typeof process, typeof require, typeof Buffer, typeof globalThis.__host].join(','));
console.log('PROC ' + process.platform + '/' + Object.keys(process.env).length + '/' + process.version);
let exitCode = 'NO-THROW';
try { process.exit(0); } catch (e) { exitCode = e.code; }
console.log('EXIT ' + exitCode);
    // Buffer.from('hi') 会走宿主编解码 → 需要插件声明 bytes.encode（这个沙箱什么权限都没声明，
    // 所以这里只用纯沙箱内的部分：alloc / isBuffer 不跨界）
    console.log('BUF ' + Buffer.alloc(2).length + '/' + (Buffer.isBuffer(Buffer.alloc(1)) ? 'yes' : 'no'));
console.log('GLOBAL ' + (global === globalThis) + '/' + (typeof URL) + '/' + (typeof TextEncoder));
`);
    const lines = out.split('\n');
    assert.equal(lines[0], 'ASSERT AssertionError:ERR_ASSERTION');
    // 零环境权力：`require` 必须 undefined；process/Buffer 是**仿真件**（不是宿主对象），桥在
    assert.equal(lines[1], 'ENV object,undefined,function,object');
    // 仿真值：platform **跟随宿主**（P2-E / 模型 B：win32 宿主上就是 win32）、
    // env 是冻结空对象、版本是固定基线
    assert.equal(lines[2], 'PROC ' + process.platform + '/0/v22.22.1');
    // 退出权不给插件（`process.exit` 明确抛错）
    assert.equal(lines[3], 'EXIT ERR_NOT_SUPPORTED_IN_SANDBOX');
    assert.equal(lines[4], 'BUF 2/yes');
    // `global` 别名与 Node 的标准全局（QuickJS 自己没有 URL/TextEncoder，由仿真模块补）
    assert.equal(lines[5], 'GLOBAL true/function/function');
  });

  /**
   * P2-B：`os` / `process` 的事实来自**引导层注入的 `__spcEnv`**。
   * 这条必须走真沙箱——差分测试是自己塞全局的，证明不了宿主侧真的做了注入。
   */
  it('P2-B：os / process 在真沙箱里可装载，且事实由引导层注入', async () => {
    const out = await runInSandbox(`
import os from 'node:os';
import process from 'node:process';
console.log('OS ' + os.platform() + '/' + os.EOL.length + '/' + os.homedir().length);
console.log('PROC ' + process.platform + '/' + process.version + '/' + process.cwd().length);
console.log('TMPINSIDE ' + (os.tmpdir().startsWith(os.homedir()) ? 'yes' : 'no'));
// cpus 是**混合**的（2026-09-18 决策）：条数是容量类（给），身份字段给空值（不给宿主真值）
console.log('CPUS ' + os.cpus().length + '/' + os.cpus()[0].model + '/' + os.cpus()[0].speed);
`);
    const [osLine, procLine, tmpLine, cpus] = out.split('\n');
    // platform 与 EOL **跟随宿主**（P2-E / 模型 B）：linux 上 `\n`（长度 1）、win32 上 `\r\n`（长度 2）
    assert.equal(osLine, 'OS ' + process.platform + '/' + nodeOs.EOL.length + '/28');
    assert.equal(procLine, 'PROC ' + process.platform + '/v22.22.1/28'); // 版本是固定仿真值
    assert.equal(tmpLine, 'TMPINSIDE yes'); // tmpdir 必须落在数据目录内（fs 作用域里）
    assert.equal(cpus, 'CPUS ' + nodeOs.availableParallelism() + '//0'); // 条数=容量类真值；身份字段空
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

  it('**两张平台表都在，且按 `__spcEnv.platform` 选**（P2-E 模型 B，离线可跑）', async () => {
    // 判据取 Windows v22.22.1 的真值（`_audit/const-win.json`）——**不依赖判卷人在场**：
    // 那几个值是编译期定的，写死在用例里正好当"表没被改坏"的守门人。
    const prev = (globalThis as any).__spcEnv;
    try {
      // ⚠️ `loadShimFresh` 只是"换个 URL 重新 import"，**不注入全局**——`__spcEnv` 得自己设。
      // 扁平表的具名导出是 `win.WSAEACCES`；分组在 `win.osConstants.errno` 上（Node 同形）。
      (globalThis as any).__spcEnv = JSON.stringify({ platform: 'win32', dataDir: '/d' });
      const win = await loadShimFresh('node-constants.js');
      assert.ok(win.osConstants && win.osConstants.errno, 'win32 表应当有 errno 分组');
      (globalThis as any).__spcEnv = JSON.stringify({ platform: 'linux', dataDir: '/d' });
      const lin = await loadShimFresh('node-constants.js');
      assert.ok(lin.osConstants && lin.osConstants.errno, 'linux 表应当有 errno 分组');

      // ① 键集不同（这是"必须整表分"而不是"几个值不同"的硬证据）
      assert.equal(win.WSAEACCES, 10013, 'win32 errno 有 54 个 WSA* 键');
      assert.equal(lin.WSAEACCES, undefined, 'linux 没有 WSA*');
      assert.equal(lin.O_NOFOLLOW, 131072, 'linux 有 O_* 一族');
      assert.equal(win.O_NOFOLLOW, undefined, 'win32 没有 O_NOFOLLOW');
      assert.equal(win.SIGBREAK, 21, 'win32 有 SIGBREAK');
      assert.equal(lin.SIGUSR1, 10, 'linux 有 SIGUSR1');

      // ② 同名键的值不同（49 个）
      assert.equal(win.EADDRINUSE, 100);
      assert.equal(lin.EADDRINUSE, 98);
      assert.equal(win.EAGAIN, 11, 'EAGAIN 两边都是 11（不是所有键都不同）');
      assert.equal(lin.EAGAIN, 11);

      // ③ **形状**不同：win32 没有 `os.constants.dlopen` 这一组
      assert.equal(Object.keys(win.osConstants.dlopen).length, 0);
      assert.equal(Object.keys(lin.osConstants.dlopen).length, 5);
      assert.equal(win.osConstants.errno.ENOENT, 2);
      assert.equal(lin.osConstants.errno.ENOENT, 2);

      // ④ 平台事实（`EOL`/`devNull`/分隔符）也跟着平台
      assert.equal(win.PLATFORM_FACTS.win32.eol, '\r\n');
      assert.equal(win.PLATFORM_FACTS.win32.devNull, '\\\\.\\nul');
      assert.equal(win.PLATFORM_FACTS.win32.sep, '\\');
      assert.equal(win.PLATFORM_FACTS.linux.eol, '\n');
      assert.equal(win.PLATFORM_FACTS.linux.devNull, '/dev/null');
    } finally {
      if (prev === undefined) delete (globalThis as any).__spcEnv;
      else (globalThis as any).__spcEnv = prev;
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
  // A6/A7 用的构造器与助手：两个"自有属性完全相同"的不同类、以及带自定义原型的对象
  class Foo {
    x = 1;
  }
  class Bar {
    x = 1;
  }
  const withProto = (proto: object) => Object.assign(Object.create(proto), { a: 1 });

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
    // 缺参：漏写一个参数必须报 ERR_MISSING_ARGS —— 否则 `notXxx(x)` 会**静默通过**（断言失效）
    ['equal(1) 缺参', (a) => a.equal(1)],
    ['strictEqual(1) 缺参', (a) => a.strictEqual(1)],
    ['notEqual(1) 缺参', (a) => a.notEqual(1)],
    ['notStrictEqual(1) 缺参', (a) => a.notStrictEqual(1)],
    ['deepEqual(1) 缺参', (a) => a.deepEqual(1)],
    ['deepStrictEqual(1) 缺参', (a) => a.deepStrictEqual(1)],
    ['notDeepEqual(1) 缺参', (a) => a.notDeepEqual(1)],
    ['notDeepStrictEqual(1) 缺参', (a) => a.notDeepStrictEqual(1)],
    // NaN 是特例：`equal(NaN,NaN)` 通过、`notEqual(NaN,NaN)` 失败（与 `==` 的直觉相反）
    ['equal(NaN,NaN)', (a) => a.equal(NaN, NaN)],
    ['notEqual(NaN,NaN)', (a) => a.notEqual(NaN, NaN)],
    ['equal(NaN,1)', (a) => a.equal(NaN, 1)],
    // doesNotThrow 的错误**不匹配时必须重抛原错误** —— 吞掉它等于把真实故障藏起来
    ['doesNotThrow(fn,TypeError) 抛 RangeError', (a) => a.doesNotThrow(() => { throw new RangeError('x'); }, TypeError)],
    ['doesNotThrow(fn,/boom/) 抛 nope', (a) => a.doesNotThrow(() => { throw new Error('nope'); }, /boom/)],
    ['doesNotThrow(fn,TypeError) 不抛', (a) => a.doesNotThrow(() => {}, TypeError)],
    ['doesNotThrow(fn) 抛错', (a) => a.doesNotThrow(() => { throw new Error('x'); })],
    // 字符串第二参是 message（`throws(fn, 'should throw')` 是常见写法）
    ['throws(fn,"msg") 字符串当 message', (a) => a.throws(() => { throw new Error('x'); }, 'should throw')],
    ['throws(fn,()=>1) 校验函数须严格 true', (a) => a.throws(() => { throw new Error('x'); }, () => 1)],
    ['throws(fn,()=>true)', (a) => a.throws(() => { throw new Error('x'); }, () => true)],
    // message 传 Error → 原样抛出那个 Error（不是包成 AssertionError）
    ['fail(new Error)', (a) => a.fail(new Error('orig'))],
    ['strictEqual(1,2,new Error)', (a) => a.strictEqual(1, 2, new Error('custom'))],
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

    // ── A6：不该判等的（曾经"自有可枚举键都是空的"就判等，或提前 return 漏掉附加属性）──
    ['A6 WeakMap vs WeakMap', (a) => a.deepStrictEqual(new WeakMap(), new WeakMap())],
    ['A6 WeakSet vs WeakSet', (a) => a.deepStrictEqual(new WeakSet(), new WeakSet())],
    ['A6 Promise vs Promise', (a) => a.deepStrictEqual(Promise.resolve(1), Promise.resolve(1))],
    ['A6 同名不同函数', (a) => a.deepStrictEqual(function f() {}, function f() {})],
    ['A6 箭头函数 vs 普通函数', (a) => a.deepStrictEqual(() => 1, function () { return 1; })],
    ['A6 同引用函数是相等的', (a) => a.deepStrictEqual(Math.max, Math.max)],
    ['A6 Error 多一个自有属性', (a) => a.deepStrictEqual(Object.assign(new Error('x'), { extra: 1 }), new Error('x'))],
    ['A6 Error 的 cause 不同', (a) => a.deepStrictEqual(
      Object.assign(new Error('x'), { cause: new Error('a') }),
      Object.assign(new Error('x'), { cause: new Error('b') }),
    )],
    ['A6 Error 的 cause 存在性不同', (a) => a.deepStrictEqual(new Error('x'), new Error('x', { cause: undefined }))],
    ['A6 TypedArray 附加属性', (a) => {
      const x: any = new Uint8Array([1, 2]);
      const y = new Uint8Array([1, 2]);
      x.tag = 1;
      return a.deepStrictEqual(x, y);
    }],
    ['A6 数组附加属性', (a) => a.deepStrictEqual(Object.assign([1], { tag: 1 }), [1])],
    ['A6 稀疏数组 vs undefined 元素', (a) => a.deepStrictEqual([1, , 3], [1, undefined, 3])],
    ['A6 Map 的键是对象', (a) => a.deepStrictEqual(new Map([[{ k: 1 }, 1]]), new Map([[{ k: 1 }, 1]]))],
    ['A6 宽松 [1] vs ["1"]', (a) => a.deepEqual([1], ['1'])],
    ['A6 宽松 Date vs 0', (a) => a.deepEqual(new Date(0), 0)],
    ['A6 宽松 true vs 1', (a) => a.deepEqual(true, 1)],
    ['A6 宽松 null vs undefined', (a) => a.deepEqual(null, undefined)],
    ['A6 notDeepStrictEqual 反向也一致', (a) => a.notDeepStrictEqual(new WeakMap(), new WeakMap())],

    // ── A7：该判等的（严格模式先比 constructor，只有它是 undefined 才退回比原型）──
    ['A7 自定义原型但同形', (a) => a.deepStrictEqual(withProto({ z: 9 }), { a: 1 })],
    ['A7 Object.create(null) vs {}', (a) => a.deepStrictEqual(Object.create(null), {})],
    ['A7 两个不同类的实例', (a) => a.deepStrictEqual(new Foo(), new Bar())],
    ['A7 同类实例', (a) => a.deepStrictEqual(new Foo(), new Foo())],
    ['A7 类实例 vs 同形字面量', (a) => a.deepStrictEqual(new Foo(), { x: 1 })],
    ['A7 两个 null 原型对象', (a) => a.deepStrictEqual(
      Object.assign(Object.create(null), { a: 1 }),
      Object.assign(Object.create(null), { a: 1 }),
    )],
    ['A7 boxed Number vs 原始值', (a) => a.deepStrictEqual(new Number(1), 1)],
    ['A7 两个 boxed Number', (a) => a.deepStrictEqual(new Number(1), new Number(1))],
    ['A7 不同 Error 子类', (a) => a.deepStrictEqual(new TypeError('x'), new RangeError('x'))],

    // 主干：这次重写了深比较内核，主干行为必须一字不差
    ['主干 Date 无效时间互等', (a) => a.deepStrictEqual(new Date(NaN), new Date(NaN))],
    ['主干 RegExp lastIndex 是状态', (a) => {
      const x = /a/g;
      const y = /a/g;
      x.lastIndex = 2;
      return a.deepStrictEqual(x, y);
    }],
    ['主干 Uint8Array vs Int8Array', (a) => a.deepStrictEqual(new Uint8Array([1, 2]), new Int8Array([1, 2]))],
    ['主干 Set 顺序无关', (a) => a.deepStrictEqual(new Set([1, 2]), new Set([2, 1]))],
    ['主干 symbol 值不同', (a) => a.deepStrictEqual({ s: Symbol('a') }, { s: Symbol('a') })],
    ['主干 symbol 键在严格模式参与比较', (a) => {
      const s = Symbol('s');
      return a.deepStrictEqual({ [s]: 1 }, { [s]: 1 });
    }],
  ];

  it('同一批表达式：抛/不抛与 error.code/operator 逐条一致', () => {
    for (const [label, run] of CASES) {
      assert.equal(outcome(() => run(shim)), outcome(() => run(nodeAssert)), `${label} 不一致`);
    }
  });

  it('`ok` 的 actual 是**原值**（`ok(0)` → 0，不是 false）', () => {
    // 靠 `err.actual` 分支的调用方要能分清"值是 0/''/null"与"值缺席"
    for (const a of [shim, nodeAssert]) {
      for (const value of [0, '', null, undefined, false]) {
        try {
          a.ok(value);
          assert.fail('应当抛 AssertionError');
        } catch (e: any) {
          assert.equal(e.actual, value, `ok(${String(value)}) 的 actual 不一致`);
        }
      }
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

  it('C9：`new AssertionError()` 无参/错类型参数与 Node 同码（Node 是**抛**，不是容忍）', () => {
    for (const a of [shim, nodeAssert]) {
      assert.throws(() => new a.AssertionError(), (e: any) => e.code === 'ERR_INVALID_ARG_TYPE', a.name);
      assert.throws(() => new a.AssertionError('nope'), (e: any) => e.code === 'ERR_INVALID_ARG_TYPE', a.name);
      const err = new a.AssertionError({ message: 'x', actual: 1, expected: 2, operator: '===' });
      assert.equal(err.code, 'ERR_ASSERTION');
      assert.equal(err.message, 'x');
      assert.equal(err.actual, 1);
      assert.equal(err.generatedMessage, false);
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

