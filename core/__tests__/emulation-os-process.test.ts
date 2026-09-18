// node:os / node:process 仿真的对齐测试
//
// 判卷人有两个：
//   1. **宿主 Node**——凡是我们**声称与 Node 一致**的面（错误码形状、`process.env` 的类型、
//      `nextTick` 的异步性、`write()` 的返回值……）都拿它逐条对；
//   2. **仿真基线**——凡是我们**有意与宿主不同**的面（platform 固定 linux、tmpdir 在数据目录内、
//      身份类抛错）就不跟宿主比，而是断言"基线值本身"，并在这里写明为什么。
//
// 后者才是这份测试的主体：一个"开发机是 Windows、生产是 Linux"的项目里，
// "哪些跟宿主走、哪些固定"必须被钉死，否则插件会在两种机器上走不同分支。
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 审计隔离（本文件会建真沙箱）：AUDIT_DIR 在模块加载时读环境变量，所以先设再动态 import
const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'spc-audit-osproc-'));
process.env.SPC_AUDIT_DIR = AUDIT_DIR;
after(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

const { buildEnvFacts } = await import('../../core/emulated-env.ts');

/** shim 的加载方式与既有对齐测试一致：逐字节拷到临时目录（ESM），再按 file: 导入 */
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'spc-shims-osproc-'));
writeFileSync(join(SHIM_DIR, 'package.json'), '{"type":"module"}\n');
const SHIM_SRC = join(process.cwd(), 'core', 'sandbox-modules');
for (const f of ['node-os.js', 'node-process.js', 'node-events.js', 'node-constants.js']) {
  copyFileSync(join(SHIM_SRC, f), join(SHIM_DIR, f));
}
after(() => rmSync(SHIM_DIR, { recursive: true, force: true }));

const DATA_DIR = mkdtempSync(join(tmpdir(), 'spc-data-'));
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

/**
 * 沙箱里看到的路径一律是 **POSIX 形态**（`\` → `/`）：沙箱路径语义固定 posix，而 Windows 开发机上
 * 数据目录是 `C:\Users\…`。两边不一致就会出错——实测：`tmp` 包拿
 * `path.relative(fs.realpathSync(os.tmpdir()), …)` 一对，反斜杠立刻算出 `../C:\…` 然后自己抛错
 * （见 `core/emulated-env.ts` 与 `_audit/dep-smoke.mts`）。所以断言也按沙箱形态写。
 *
 * ⚠️ **不要补前导 `/`**：那会让宿主侧 `path.resolve('/C:/…')` 解析成 `<cwd>/C:/…` ⇒ `validatePath`
 * 判越界、真实依赖 EACCES（试过，`fast-glob` 的 scandir 立刻炸）。
 */
const SANDBOX_DIR = DATA_DIR.split('\\').join('/');

/** shim 依赖引导层注入的两个全局：环境事实 + 卸载钩子（见 core/sandbox.ts 的 BOOTSTRAP） */
function installSandboxGlobals(): void {
  (globalThis as any).__spcEnv = JSON.stringify(buildEnvFacts(DATA_DIR));
  (globalThis as any).__spcDisposeHooks = [];
}

async function loadShim(file: string): Promise<any> {
  installSandboxGlobals();
  return import(pathToFileURL(join(SHIM_DIR, file)).href);
}

const osShim = await loadShim('node-os.js');
const processShim = await loadShim('node-process.js');
const nodeOs = await import('node:os');
const nodeProcess = await import('node:process');

describe('仿真 node:os —— 仿真基线 vs 宿主真值', async () => {
  it('行为性事实固定为 Linux/POSIX（不随宿主平台漂移）', () => {
    // 这三条是"插件行为分支"的依据，必须与 path(posix)、constants(Linux) 一致：
    // 宿主是 Windows 时它们**照样**报 Linux——这是有意的，不是 bug。
    assert.equal(osShim.platform(), 'linux');
    assert.equal(osShim.type(), 'Linux');
    assert.equal(osShim.EOL, '\n');
    assert.equal(osShim.devNull, '/dev/null');
    assert.equal(osShim.endianness(), 'LE');
    // 对照：宿主是什么就报什么（用来证明"上面那三条不是碰巧与宿主相同"）
    assert.equal(typeof nodeOs.platform(), 'string');
  });

  it('路径类收敛到插件数据目录内（不是宿主 tmp——那个在 fs 作用域外，一用就 EACCES）', () => {
    assert.equal(osShim.tmpdir(), SANDBOX_DIR + '/tmp');
    assert.equal(osShim.homedir(), SANDBOX_DIR);
    assert.notEqual(osShim.tmpdir(), nodeOs.tmpdir());
  });

  it('容量类给宿主真值（建沙箱时取一次快照），且形状与 Node 一致', () => {
    // 注意：**快照语义**——`freemem`/`loadavg`/`uptime` 每秒都在变，只能比形状与量级，
    // 不能跟"此刻的宿主读数"比相等（那是在测内存抖动，不是在测实现）。
    assert.equal(osShim.availableParallelism(), nodeOs.availableParallelism());
    assert.equal(osShim.totalmem(), nodeOs.totalmem()); // 物理内存总量是稳定的
    assert.equal(typeof osShim.freemem(), 'number');
    assert.ok(osShim.freemem() > 0 && osShim.freemem() <= osShim.totalmem());
    assert.equal(osShim.loadavg().length, 3);
    assert.equal(osShim.loadavg().every((n: number) => typeof n === 'number'), true);
    assert.equal(typeof osShim.uptime(), 'number');
    assert.ok(osShim.availableParallelism() >= 1);
  });

  it('架构类：arch 用宿主真值，machine 换成 uname -m 的叫法', () => {
    assert.equal(osShim.arch(), nodeOs.arch());
    const aliases: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' };
    assert.equal(osShim.machine(), aliases[nodeOs.arch()] ?? nodeOs.arch());
  });

  it('**身份类明确抛错**（不是返回空值——空值会让依赖安静地走另一条路）', () => {
    for (const name of ['hostname', 'networkInterfaces', 'userInfo', 'getPriority', 'setPriority']) {
      assert.equal(typeof osShim[name], 'function', `${name} 应当是函数`);
      assert.throws(
        () => osShim[name](),
        (err: any) => err.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
        `${name} 应当明确抛错`,
      );
      // 逐个都确认过：宿主上它是可用的，所以这是我们**有意**的缺失（不是抄漏了）
      assert.equal(typeof (nodeOs as any)[name], 'function');
    }
  });

  it('`cpus()` 是**混合**的：条数照容量类、身份字段给空值（决策见 node-os.js 文件头）', () => {
    // 为什么不能继续抛错：真实依赖在**模块顶层**就拿它算并发度
    // （`fast-glob/out/settings.js:10` 的 `Math.max(os.cpus().length, 1)`）⇒ 抛错 = 整个包装载失败。
    const list = osShim.cpus();
    assert.equal(Array.isArray(list), true);
    assert.equal(list.length, nodeOs.availableParallelism()); // 与 availableParallelism 同源
    assert.equal(list.length, osShim.availableParallelism());
    // 形状与基线一致：三个键、times 五个计数（真值 `_audit/os-cpus-truth.json`，v22.22.1）
    assert.deepEqual(Object.keys(list[0]), ['model', 'speed', 'times']);
    assert.deepEqual(Object.keys(list[0].times), ['user', 'nice', 'sys', 'idle', 'irq']);
    // 身份字段不给宿主真值（不给型号、也不编造主频）
    for (const entry of list) {
      assert.equal(entry.model, '');
      assert.equal(entry.speed, 0);
      assert.equal(typeof entry.times.user, 'number');
    }
    // 每次调用返回**新**数组与新对象（基线实测 `os.cpus() !== os.cpus()`，条目也不同）
    assert.notEqual(osShim.cpus(), list);
    assert.notEqual(osShim.cpus()[0], list[0]);
  });

  it('os.constants 分四组，且与常量表的值逐项一致（前缀归类不串味）', () => {
    const c = osShim.constants;
    assert.deepEqual(Object.keys(c).sort(), ['dlopen', 'errno', 'priority', 'signals']);
    assert.equal(c.errno.ENOENT, 2);
    assert.equal(c.errno.EACCES, 13);
    assert.equal(c.signals.SIGTERM, 15);
    assert.equal(c.dlopen.RTLD_LAZY, 1);
    assert.equal(c.priority.PRIORITY_NORMAL, 0);
    // 关键：`ENGINE_METHOD_*` 长得像 errno，**不能**混进 errno 组（这是前缀归类的例外）
    assert.equal('ENGINE_METHOD_RSA' in c.errno, false);
    assert.equal(Object.keys(c.errno).every((k) => /^E[A-Z0-9_]+$/.test(k) && !k.startsWith('ENGINE_')), true);
    assert.equal(Object.keys(c.signals).every((k) => k.startsWith('SIG')), true);
    // 冻结：Node 侧也是只读的
    assert.equal(Object.isFrozen(c), true);
  });

  it('release/version：宿主是 Linux 就报内核真值，否则报仿真常数（形状仍是字符串）', () => {
    assert.equal(typeof osShim.release(), 'string');
    assert.equal(typeof osShim.version(), 'string');
    if (process.platform === 'linux') {
      assert.equal(osShim.release(), nodeOs.release());
    } else {
      assert.equal(osShim.release(), '6.12.0');
    }
  });
});

describe('仿真 node:process —— 只读事实与明确的边界', async () => {
  it('platform/arch 与 os 同一口径（同一份事实，不该两处各说各话）', () => {
    assert.equal(processShim.platform, 'linux');
    assert.equal(processShim.arch, nodeOs.arch());
    assert.equal(processShim.platform, osShim.platform());
  });

  it('version/versions 是**固定仿真值**，且不编造没有的实现', () => {
    assert.equal(processShim.version, 'v22.22.1');
    assert.equal(processShim.versions.node, '22.22.1');
    // `v8`/`openssl` 这些报了就等于承诺了不存在的实现——只报我们真有的
    assert.deepEqual(Object.keys(processShim.versions).sort(), ['node', 'spc']);
    assert.equal(Object.isFrozen(processShim.versions), true);
  });

  it('env 是冻结的空对象（宿主 env 可能含凭据，不做任何透传）', () => {
    assert.deepEqual(Object.keys(processShim.env), []);
    assert.equal(Object.isFrozen(processShim.env), true);
    assert.equal(processShim.env.PATH, undefined);
    // 普通对象（不是 null 原型）：`process.env.hasOwnProperty(...)` 这类写法不该炸
    assert.equal(typeof processShim.env.hasOwnProperty, 'function');
  });

  it('cwd 收敛到数据目录；argv/execPath/pid 形状与 Node 一致', () => {
    assert.equal(processShim.cwd(), SANDBOX_DIR);
    assert.deepEqual([...processShim.argv], ['node', 'plugin.js']);
    assert.equal(processShim.execPath, 'node');
    assert.equal(processShim.pid, process.pid); // 度量性事实：宿主真值
    assert.equal(typeof processShim.pid, 'number');
  });

  it('nextTick 是**异步**的（同步调用点不能直接跑回调），且透传参数', async () => {
    const seen: string[] = [];
    processShim.nextTick((a: string, b: string) => seen.push(`${a}${b}`), 'x', 'y');
    assert.deepEqual(seen, [], 'nextTick 不该同步执行');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(seen, ['xy']);
    // 宿主 Node 同样是异步的（这条不比对顺序细节，只比对"是否同步"这个可观测性质）
    const nodeSeen: string[] = [];
    nodeProcess.nextTick(() => nodeSeen.push('t'));
    assert.deepEqual(nodeSeen, []);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(nodeSeen, ['t']);
  });

  it('stdout/stderr：写到插件日志，isTTY 恒 false（与 node:tty 的 isatty 一致）', () => {
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    console.warn = (...a: unknown[]) => void logs.push('W:' + a.map(String).join(' '));
    console.error = (...a: unknown[]) => void logs.push('E:' + a.map(String).join(' '));
    try {
      assert.equal(processShim.stdout.write('hello\n'), true); // Node 的 write 返回"要不要背压"
      assert.equal(processShim.stderr.write('oops\n'), true);
      let cbCalled = false;
      processShim.stdout.write('with-cb', () => {
        cbCalled = true;
      });
      assert.equal(cbCalled, true, '回调应当被调用（形状对齐 Node）');
      processShim.emitWarning('careful', 'DeprecationWarning');
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    }
    assert.deepEqual(logs, ['hello', 'E:oops', 'with-cb', 'W:DeprecationWarning: careful']);
    assert.equal(processShim.stdout.isTTY, false);
    assert.equal(processShim.stderr.fd, 2);
  });

  it('**不做的东西明确抛错**（exit/kill/hrtime/组身份/权限变更…），而不是静默 no-op', () => {
    const unsupported = [
      'exit', 'abort', 'kill', 'chdir', 'hrtime', 'uptime', 'memoryUsage', 'cpuUsage',
      'resourceUsage', 'umask', 'binding', 'dlopen', 'getgroups', 'setuid', 'setgid',
      'setUncaughtExceptionCaptureCallback',
    ];
    for (const name of unsupported) {
      assert.equal(typeof processShim[name], 'function', `${name} 应当是函数`);
      assert.throws(
        () => processShim[name](),
        (err: any) => err.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
        `${name} 应当明确抛错`,
      );
    }
  });

  it('身份类 uid/gid 返回**固定仿真事实 1000**（不是抛错，也不是宿主真值）', () => {
    // 为什么是 1000：Linux 上 `process.getuid` 是**函数**，于是
    // `!process.getuid || process.getuid() !== 0`（write-file-atomic 的 root 探测）会去**调用**它；
    // 抛错等于让包在探测环境这一步就死。给"非 root 的固定值"是诚实的仿真事实：
    // 插件在沙箱里确实只碰得到自己的数据目录。**不能给宿主 uid**（泄露身份 + 随部署漂移）。
    for (const name of ['getuid', 'geteuid', 'getgid', 'getegid']) {
      assert.equal(typeof processShim[name], 'function', `${name} 应当是函数`);
      assert.equal(processShim[name](), 1000, `${name}() 应当恒为 1000`);
      assert.equal(processShim.default[name](), 1000);
    }
    // 基线核对：Linux/node v22.22.1 上这四个都存在；Windows 宿主上**属性不存在**
    // （`internal/bootstrap/node.js:214` 的 implementsPosixCredentials 门），
    // 我们统一给"Linux 基线"的答案 ⇒ 与 `path` 恒 posix 同一取向。
    assert.equal(typeof (nodeProcess as any).getuid, process.platform === 'linux' ? 'function' : 'undefined');
  });

  it('**信号事件注册即抛错**（不留"永不触发的监听器"——那是 events 那轮吃过的亏）', () => {
    for (const method of ['on', 'once', 'addListener', 'prependListener']) {
      assert.throws(
        () => processShim[method]('SIGINT', () => {}),
        (err: any) => err.code === 'ERR_NOT_SUPPORTED_IN_SANDBOX',
        `${method}('SIGINT') 应当抛错`,
      );
    }
    // 但普通事件照常可注册（`process` 在 Node 里就是 EventEmitter 实例）。
    // 注意用 `processShim.default`（对象面）：解构出来的原型方法丢了 `this`，Node 的
    // CJS 互操作也是这样——`import { listenerCount } from 'node:process'` 在 Node 上同样不能裸调。
    const proc = processShim.default;
    assert.equal(typeof proc.on('custom', () => {}), 'object');
    assert.equal(proc.listenerCount('custom'), 1);
    proc.removeAllListeners('custom');
  });

  it("核心在卸载前发一次 `'exit'`（唯一由核心主动触发的事件）", () => {
    const proc = processShim.default;
    const hooks: Array<() => void> = (globalThis as any).__spcDisposeHooks;
    assert.ok(hooks.length >= 1, '应当登记了卸载钩子');
    const seen: unknown[] = [];
    proc.on('exit', (code: unknown) => seen.push(code));
    // 模拟 core/sandbox.ts 的 dispose()：VM 还活着时调用登记的钩子
    for (const hook of hooks.splice(0)) hook();
    assert.deepEqual(seen, [0], "'exit' 应当带上 exitCode 发一次");
    // 第二次不该再发（钩子已被摘走，与 __spcRunDisposeHooks 的语义一致）
    for (const hook of hooks) hook();
    assert.equal(seen.length, 1);
  });
});
