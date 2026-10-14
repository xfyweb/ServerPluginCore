// 前台控制台的用例：解析（纯函数）+ 挂载后的分发（用假 readline 输入输出，不真开终端）。
// ⚠️ 这里钉的是"我们自己的那部分"：认哪些词、认不认大小写、stop 只走一次、stdin 关了**不停机**。
// 真终端里长什么样，靠人工按一次（和探针同一个道理：TTY 行为本机脚本替不了）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

const { parseConsoleLine, parseInstallArgs, splitConsoleArgs, shouldAttachConsole, attachConsole } = await import(
  '../console.ts'
);
const { t } = await import('../i18n/index.ts');

test('解析：四个命令 + stop 的两个别名，大小写与首尾空白都容忍', () => {
  assert.deepEqual(parseConsoleLine('help'), { kind: 'help' });
  assert.deepEqual(parseConsoleLine('  HELP  '), { kind: 'help' }, '人敲的，不该挑大小写');
  assert.deepEqual(parseConsoleLine('status'), { kind: 'status' });
  assert.deepEqual(parseConsoleLine('list'), { kind: 'list' });
  assert.deepEqual(parseConsoleLine('stop'), { kind: 'stop' });
  assert.deepEqual(parseConsoleLine('exit'), { kind: 'stop' }, 'exit 同义');
  assert.deepEqual(parseConsoleLine('quit'), { kind: 'stop' }, 'quit 同义');
  assert.deepEqual(parseConsoleLine(''), { kind: 'empty' });
  assert.deepEqual(parseConsoleLine('   '), { kind: 'empty' });
  assert.deepEqual(parseConsoleLine('bogus @x/y'), { kind: 'unknown', raw: 'bogus @x/y' }, '不认识的动词照旧报未知');
  // 不接受参数的命令带了参数 ⇒ 明说（**不静默忽略**：`stop now` 被当成 `stop` 就太随便了）
  assert.deepEqual(parseConsoleLine('stop now'), { kind: 'extra', raw: 'stop now' });
  assert.deepEqual(parseConsoleLine('list all'), { kind: 'extra', raw: 'list all' });
  // 敲 `spc …`（管理面命令）要认出来：停机那条告诉他在这儿怎么敲，其余的说清去哪儿敲
  assert.deepEqual(parseConsoleLine('spc daemon stop'), { kind: 'cli', raw: 'spc daemon stop', isStop: true });
  assert.deepEqual(parseConsoleLine('SPC Daemon Stop'), { kind: 'cli', raw: 'SPC Daemon Stop', isStop: true }, '大小写不挑');
  assert.deepEqual(parseConsoleLine('spc plugin list'), { kind: 'cli', raw: 'spc plugin list', isStop: false });
  assert.deepEqual(parseConsoleLine('spcdev check'), { kind: 'cli', raw: 'spcdev check', isStop: false }, '作者工具同样给"去哪儿敲"');
  assert.deepEqual(parseConsoleLine('spc plugin reload @x/y'), { kind: 'cli', raw: 'spc plugin reload @x/y', isStop: false });
});

test('解析：插件生命周期是**扁平**的（`install <目录>`，不带 plugin 命名空间）', () => {
  assert.deepEqual(parseConsoleLine('install ./plugin/demo'), { kind: 'plugin', verb: 'install', args: ['./plugin/demo'] });
  assert.deepEqual(parseConsoleLine('uninstall @a/b'), { kind: 'plugin', verb: 'uninstall', args: ['@a/b'] });
  assert.deepEqual(parseConsoleLine('reload local:default/@a/b'), {
    kind: 'plugin',
    verb: 'reload',
    args: ['local:default/@a/b'],
  });
  assert.deepEqual(parseConsoleLine('ENABLE @a/b'), { kind: 'plugin', verb: 'enable', args: ['@a/b'] }, '大小写不挑');
  assert.deepEqual(parseConsoleLine('disable @a/b'), { kind: 'plugin', verb: 'disable', args: ['@a/b'] });
  // 缺参数 ⇒ 报该动词的用法（不猜）
  assert.deepEqual(parseConsoleLine('install'), { kind: 'usage', verb: 'install', need: 'target' });
  assert.deepEqual(parseConsoleLine('uninstall'), { kind: 'usage', verb: 'uninstall', need: 'ref' });
  // 带空格的路径要能用引号引起来（Windows 上很常见）
  assert.deepEqual(splitConsoleArgs('install "C:\\my plugins\\demo"'), ['install', 'C:\\my plugins\\demo']);
  assert.deepEqual(splitConsoleArgs("install 'a b' --source local:default"), ['install', 'a b', '--source', 'local:default']);
});

test('install 的旗标：与 spc 同名同义；**不认识的旗标一律拒**（fail-closed）', () => {
  assert.deepEqual(parseInstallArgs(['./demo']), {
    target: './demo',
    grants: [],
    acceptKeyChange: false,
    bad: [],
  });
  assert.deepEqual(parseInstallArgs(['./demo', '--source', 'local:b', '--grant', 'fs.read.data', '--grant', 'kv.get', '--accept-key-change']), {
    target: './demo',
    grants: ['fs.read.data', 'kv.get'],
    source: 'local:b',
    acceptKeyChange: true,
    bad: [],
  });
  // 手滑的旗标不许被忽略：忽略了就会按缺省源装错桶 —— 而"装错桶"在身份模型里等于装成了**另一个插件**。
  // 报的是"没被理解的那几个 token"：旗标没消费掉它后面那个值，于是值也落进 `bad`（那更清楚）
  assert.deepEqual(parseInstallArgs(['./demo', '--sorce', 'local:b']).bad, ['--sorce', 'local:b']);
  assert.deepEqual(parseInstallArgs(['./demo', './other']).bad, ['./other'], '多余的普通参数也要报');
});

test('挂不挂：只认 TTY（pm2 / systemd / 重定向一律不挂，连 stdin 都不碰）', () => {
  assert.equal(shouldAttachConsole({ isTTY: true }), true);
  assert.equal(shouldAttachConsole({ isTTY: false }), false, '管道');
  assert.equal(shouldAttachConsole({}), false, '没有 isTTY（被重定向）');
  assert.equal(shouldAttachConsole(undefined), false, 'stdin 都没了');
});

/** 造一个挂了控制台的假终端，返回"敲一行 + 等它处理完"的小工具 */
function fakeConsole(opts: { pluginThrows?: Error } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d: Buffer) => (out += String(d)));
  const calls = { status: 0, list: 0, stop: 0, plugin: [] as string[], show: [] as string[] };
  const rl = attachConsole(
    { input, output },
    {
      status: () => {
        calls.status += 1;
        return ['核心 0.0.0（假）'];
      },
      list: () => {
        calls.list += 1;
        return ['local:default/@std/demo@0.0.1 [running] 已启用'];
      },
      stop: () => {
        calls.stop += 1;
      },
      plugin: async (verb, args) => {
        calls.plugin.push(`${verb} ${args.join(' ')}`.trim());
        if (opts.pluginThrows) throw opts.pluginThrows;
        return [`${verb} 完成：${args.join(' ')}`];
      },
      show: (ref) => {
        calls.show.push(ref);
        return [`详情：${ref}`, '  声明：fs.read.data', '  未授予：exec.template.git.version'];
      },
    },
  );
  const type = async (line: string): Promise<void> => {
    input.write(`${line}\n`);
    await new Promise((r) => setTimeout(r, 30)); // 让 readline + 异步 handler 跑完
  };
  return { rl, type, out: () => out, calls, input };
}

test('挂上后先自报家门；status / list 打到输出上', async () => {
  const c = fakeConsole();
  await c.type('status');
  await c.type('list');
  assert.equal(c.calls.status, 1);
  assert.equal(c.calls.list, 1);
  assert.match(c.out(), /控制台就绪|Console ready/, '挂上就该说一句怎么用');
  assert.match(c.out(), /核心 0\.0\.0（假）/);
  assert.match(c.out(), /@std\/demo@0\.0\.1/);
  // ⚠️ 别用 /^> /m：readline 在 terminal 模式下会在提示符前后发 ANSI 转义（`\x1b[1G\x1b[0J> \x1b[3G`），
  // 提示符并不在行首。数出现次数就够（挂上 + 两条命令 ⇒ 至少 3 个提示符）。
  assert.ok((c.out().match(/> /g) ?? []).length >= 3, `每轮之后要有提示符：${JSON.stringify(c.out())}`);
  c.rl.close();
});

test('help 打出可用命令；未知命令给出路；空行什么都不做', async () => {
  const c = fakeConsole();
  await c.type('help');
  await c.type('bogus');
  await c.type('');
  assert.match(c.out(), /status/);
  assert.match(c.out(), /未知命令|Unknown command/, '未知命令要说清楚');
  assert.match(c.out(), /bogus/, '并且带上用户敲的那一串');
  assert.equal(c.calls.stop, 0, '空行/未知命令绝不停机');
  c.rl.close();
});

test('stop 只走一次：停机途中再敲什么都不理会（同一次停机不重入）', async () => {
  const c = fakeConsole();
  await c.type('stop');
  await c.type('stop');
  await c.type('status');
  assert.equal(c.calls.stop, 1, '第二次 stop 不该再调');
  assert.equal(c.calls.status, 0, '已经在停机了，不再处理新命令');
  assert.match(c.out(), /收到 stop|stop received/);
  c.rl.close();
});

test('敲 `spc …` 时给的是"怎么办"，不是"未知命令"（且不会顺手把核心停掉）', async () => {
  const c = fakeConsole();
  await c.type('spc plugin list');
  await c.type('spc daemon stop');
  assert.match(c.out(), /另一个终端|another terminal/, '管理面命令要说清去哪儿敲');
  assert.match(c.out(), /spc plugin list/, '并且原样回显他敲的那条');
  assert.match(c.out(), /直接输入 stop|Type stop here/, '`spc daemon stop` 要告诉他在控制台里敲 stop');
  assert.equal(c.calls.stop, 0, '**提示不等于执行**：这里绝不能替他停机');
  c.rl.close();
});

test('生命周期命令：串行执行、按序打结果；失败按 CLI 同一套渲染（不另造说法）', async () => {
  const c = fakeConsole();
  await c.type('install ./demo --source local:b');
  await c.type('reload @a/b');
  assert.deepEqual(c.calls.plugin, ['install ./demo --source local:b', 'reload @a/b'], '顺序必须与敲的顺序一致');
  assert.match(c.out(), /install 完成：\.\/demo --source local:b/);
  assert.match(c.out(), /reload 完成：@a\/b/);

  const bad = fakeConsole({ pluginThrows: new Error('装不进去：磁盘满了') });
  await bad.type('install ./demo');
  assert.match(bad.out(), /装不进去：磁盘满了/, '失败要把原因打出来（走 renderThrown 那条渲染）');
  assert.doesNotMatch(bad.out(), /undefined/, '渲染里不许出现 undefined');
  bad.rl.close();
  c.rl.close();
});

test('缺参数时打的是该动词的用法（不猜、不执行）', async () => {
  const c = fakeConsole();
  await c.type('install');
  await c.type('uninstall');
  assert.deepEqual(c.calls.plugin, [], '缺参数绝不能真去调 manager');
  assert.match(c.out(), /用法：install/);
  assert.match(c.out(), /用法：uninstall/);
  c.rl.close();
});

test('show：查单个插件的详情（权限点就在这里看）；缺参数或参数多了都按用法处理', async () => {
  const c = fakeConsole();
  await c.type('show @a/b');
  assert.deepEqual(c.calls.show, ['@a/b']);
  assert.match(c.out(), /详情：@a\/b/);
  assert.match(c.out(), /声明：fs\.read\.data/, '"声明"要能看到');
  assert.match(c.out(), /未授予：exec\.template\.git\.version/, '"未授予"要能看到');
  await c.type('show');
  await c.type('show a b');
  assert.equal(c.calls.show.length, 1, '参数不对绝不真去查');
  assert.match(c.out(), /用法：show/);
  c.rl.close();
});

test('stdin 关闭 = 终端没了：只摘控制台，**不停机**', async () => {
  const c = fakeConsole();
  c.input.end();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.calls.stop, 0, '关个终端不该把核心停掉');
  assert.match(c.out(), /控制台摘除|console detached/);
});

test('文案键是真的存在且没有 markdown（终端不渲染）', () => {
  for (const key of ['console.attached', 'console.help', 'console.status', 'console.stopping', 'console.detached']) {
    const text = t(key);
    assert.notEqual(text, key, `${key} 必须有文案`);
    assert.doesNotMatch(text, /\*\*|`/, `${key} 不该含 markdown`);
  }
});

// ---------------- 提示符 vs 异步输出（2026-10-14 的实测 bug） ----------------
//
// 维护者原话：「CLI 操作可能导致控制台小箭头被吃」—— 插件日志走的是**同进程**的 `console.*`
// （沙箱与 manager 都在调），而 readline 不知道别人也在写 stdout：它写了 `> `，别人的行从光标处接上去，
// 提示符就被冲掉了（功能没坏，只是看不见）。
//
// 夹具：直接把假的 output 标成 TTY（真实终端才有 isTTY=true）—— 假流默认不是 TTY，
// 那种情况**故意**不写控制序列（别污染管道/文件）。

/** 造一个"像终端"的假控制台：output 标 TTY，能拿到原始输出 */
function ttyConsole() {
  const input = new PassThrough();
  const output = new PassThrough();
  (output as unknown as { isTTY: boolean }).isTTY = true;
  let out = '';
  output.on('data', (d: Buffer) => (out += String(d)));
  const rl = attachConsole(
    { input, output },
    {
      status: () => {
        // 命令**进行中**打一行（此时提示符不在屏幕上）—— 用来钉"不该乱让位"
        console.log('命令进行中的输出');
        return ['核心 0.0.0（假）'];
      },
      list: () => [],
      stop: () => {},
      plugin: async () => [],
      show: () => [],
    },
  );
  const type = async (line: string): Promise<void> => {
    input.write(`${line}\n`);
    await new Promise((r) => setTimeout(r, 30));
  };
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
  return { rl, type, tick, out: () => out };
}

test('异步输出（插件日志走 console.*）不会吃掉提示符：让位 → 写 → 补回来', async () => {
  const c = ttyConsole();
  await c.tick();
  const before = c.out().length;

  // 模拟"提示符正等着输入时，插件日志来了"
  console.log('[local:default/@a/b] 插件日志一行');
  await c.tick();

  const chunk = c.out().slice(before);
  assert.match(chunk, /\x1b\[2K/, '先清掉提示符那一行（否则日志会接在 "> " 后面）');
  assert.match(chunk, /\x1b\[1G/, '回到行首');
  assert.match(chunk, /\[local:default\/@a\/b\] 插件日志一行/, '日志照打');
  assert.match(chunk, /> $|> \x1b/, '写完要把提示符补回来（维护者看到的就是它不见了）');
  c.rl.close();
});

test('命令进行中的输出**不**乱让位：插件连刷十几行也不会各补一个提示符', async () => {
  const c = ttyConsole();
  await c.tick();
  await c.type('status'); // handler 里会 console.log 一行（此时提示符不在屏幕上）
  const text = c.out();
  assert.match(text, /命令进行中的输出/);
  assert.ok(
    !text.includes('\x1b[2K'),
    `命令进行中不该出现"清行"控制序列（否则一次 reload 的十几行日志会刷出十几个提示符）：${JSON.stringify(text)}`,
  );
  c.rl.close();
});

test('非终端的输出不写控制序列（管道/文件别被污染）', async () => {
  const input = new PassThrough();
  const output = new PassThrough(); // 故意不设 isTTY
  let out = '';
  output.on('data', (d: Buffer) => (out += String(d)));
  const rl = attachConsole(
    { input, output },
    { status: () => [], list: () => [], stop: () => {}, plugin: async () => [], show: () => [] },
  );
  await new Promise((r) => setTimeout(r, 30));
  console.log('这行不该带控制序列');
  await new Promise((r) => setTimeout(r, 30));
  assert.match(out, /这行不该带控制序列/);
  assert.ok(!out.includes('\x1b[2K'), '非 TTY 不写清行序列');
  rl.close();
});

test('控制台摘掉之后，console.* 原样还回去（不再被接管）', async () => {
  const c = ttyConsole();
  await c.tick();
  c.rl.close();
  await c.tick();
  const before = console.log;
  console.log('摘掉之后的一行');
  assert.equal(console.log, before, 'console.log 应当已经还原成原函数');
});
