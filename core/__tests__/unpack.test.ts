// 解包器（`core/sources/unpack.ts`）的对抗性用例：**这是不可信输入那一半**，
// 所以每条守则都要有一个"真的能打进来"的样本。
//
// ⚠️ 夹具为什么自己拼字节：**恶意/畸形条目名与属性，用正规库打不出来**（yazl 会先把 `..`/绝对路径挡掉）。
//    所以这里手搓**最小 zip**（store 不压缩，签名齐全）——**生产代码不许这么干**（`AGENTS.md` §2 依赖政策）。
//    另有一条用例走真链路（`spcdev build` → `packPlugin` → `unpackSpc`）证明正常包没问题。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'spc-unpack-'));
process.env.SPC_STATE_DIR = join(TMP, 'state');
process.env.SPC_AUDIT_DIR = join(TMP, 'state', 'audit');

const { SpcError } = await import('../../core/errors.ts');
const { unpackSpc, DEFAULT_UNPACK_LIMITS } = await import('../../core/sources/unpack.ts');

// ---------------- 夹具：手搓最小 zip ----------------

interface CraftEntry {
  /** 条目名（**原样写进字节**，不做任何规整 —— 这正是要测的东西） */
  name: string;
  data?: Buffer;
  /** general purpose bit 0 = 加密 */
  encrypted?: boolean;
  /** external attributes 标成 unix 符号链接（要求 versionMadeBy 的高字节 = 3） */
  symlink?: boolean;
}

/** 拼一个 store（不压缩）zip：本地头 + 数据 + 中央目录 + EOCD */
function craftZip(entries: CraftEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data ?? Buffer.from(`content of ${e.name}`, 'utf8');
    const crc = crc32(data) >>> 0;
    const flags = e.encrypted === true ? 0x0001 : 0;
    // 传统 PKZIP 加密会在数据前加 12 字节头 ⇒ 声明压缩尺寸时要算上，否则先撞"尺寸不符"而不是"加密"
    const compSize = e.encrypted === true ? data.length + 12 : data.length;
    // 本地文件头（30 字节 + 名字）
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date = 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    locals.push(local, name, data);
    // 中央目录条目（46 字节 + 名字）
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // version made by: unix(3) + 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compSize, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(e.symlink === true ? (0xa1ff << 16) >>> 0 : (0o644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

let seq = 0;
/** 把字节写成一个 `.spc` 并给一个**全新的**目标目录（解包要求目标不存在） */
function craft(name: string, entries: CraftEntry[]): { spc: string; dest: string } {
  const spc = join(TMP, `${name}-${seq++}.spc`);
  writeFileSync(spc, craftZip(entries));
  return { spc, dest: join(TMP, `${name}-out-${seq++}`) };
}

async function rejects(fn: () => Promise<unknown>, code: string, extra: (e: InstanceType<typeof SpcError>) => void = () => {}): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof SpcError, `期望 SpcError(${code})，实际 ${String(e)}`);
    assert.equal(e.code, code);
    extra(e);
    return;
  }
  assert.fail(`没有抛 ${code}`);
}

/** 目录里的文件（posix 相对路径） */
function filesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const n of readdirSync(cur)) {
      const abs = join(cur, n);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(dir, abs).split(sep).join(posix.sep));
    }
  };
  walk(dir);
  return out.sort();
}

// ---------------- 正常路径 ----------------

test('正常包：条目按 posix 路径落盘，字节一致，目录条目被跳过', async () => {
  const { spc, dest } = craft('ok', [
    { name: 'web/', data: Buffer.alloc(0) }, // 目录条目：不落盘
    { name: 'manifest.json', data: Buffer.from('{"schema":2}', 'utf8') },
    { name: 'web/app.js', data: Buffer.from('console.log(1)\n', 'utf8') },
  ]);
  const res = await unpackSpc(spc, dest);
  assert.equal(res.entries, 2, '目录条目不计入文件数');
  assert.deepEqual(filesOf(dest), ['manifest.json', 'web/app.js']);
  assert.equal(readFileSync(join(dest, 'manifest.json'), 'utf8'), '{"schema":2}');
  assert.equal(readFileSync(join(dest, 'web', 'app.js'), 'utf8'), 'console.log(1)\n');
});

test('真链路往返：spcdev build → pack → unpack，字节与原产物一致', async () => {
  const { runDevCli } = await import('../../build/cli.ts');
  const { packPlugin } = await import('../../build/pack.ts');
  const { generateAuthorKey, saveAuthorKey } = await import('../../build/keys.ts');
  const { ensureWorkspaceConfig, loadWorkspace, patchWorkspaceConfig } = await import('../../build/workspace.ts');

  const root = join(TMP, 'roundtrip');
  mkdirSync(root, { recursive: true });
  const ws = loadWorkspace(root, { create: true });
  ensureWorkspaceConfig(ws);
  patchWorkspaceConfig(ws, { author: 'std' });
  saveAuthorKey(ws, generateAuthorKey());
  const dir = join(root, 'plugin', 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema: 2,
      id: '@std/demo',
      name: 'Demo',
      version: { code: 1, name: '0.0.1' },
      runtime: { type: 'quickjs', esm: true },
      permissions: [{ name: 'fs.write.data' }],
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'main.ts'), 'export function init() {}\n', 'utf8');
  assert.equal(await runDevCli('build', [dir]), 0);
  const packed = await packPlugin({ distDir: join(dir, 'dist'), file: join(dir, 'demo.spc') });

  const dest = join(TMP, 'roundtrip-out');
  const res = await unpackSpc(packed.file, dest);
  assert.ok(res.entries >= 4, '载荷 + 信封都在');
  for (const name of filesOf(join(dir, 'dist'))) {
    assert.deepEqual(readFileSync(join(dest, name)), readFileSync(join(dir, 'dist', name)), `${name} 要逐字节一致`);
  }
});

// ---------------- 对抗性样本 ----------------

test('zip-slip：`../` 条目 ⇒ 被拦（yauzl 在解析期就拒，理由里带着条目名），且**不留下半个解出来的包**', async () => {
  const { spc, dest } = craft('slip', [{ name: '../escape.txt' }, { name: 'ok.txt' }]);
  await rejects(
    () => unpackSpc(spc, dest),
    'PACKAGE_ARCHIVE_INVALID',
    // ⚠️ 码是笼统的，但**信息不能丢**：reason 里要有 yauzl 的原话（含那个危险条目名），运维才知道该找谁
    (e) => assert.match(e.params.reason, /\.\.\/escape\.txt/),
  );
  assert.ok(!existsSync(dest), '解包失败要清掉整个目标目录（半个包比没有更危险）');
  assert.ok(!existsSync(join(TMP, 'escape.txt')), '当然也不能写到目标目录外面去');
});

test('绝对路径 / 盘符条目 ⇒ 同样被拦，理由里带条目名', async () => {
  for (const name of ['/etc/passwd', 'C:/x.txt']) {
    const { spc, dest } = craft('abs', [{ name }]);
    await rejects(
      () => unpackSpc(spc, dest),
      'PACKAGE_ARCHIVE_INVALID',
      (e) => assert.match(e.params.reason, new RegExp(name.replace(/[/.]/g, '\\$&').replace('\\/', '/'))),
    );
  }
});

test('`.` 段与空段 ⇒ **我们自己的判定**接住（yauzl 会放行这两个）⇒ PATH_OUT_OF_SCOPE 带路径', async () => {
  for (const name of ['./a.txt', 'a//b.txt']) {
    const { spc, dest } = craft('segs', [{ name }]);
    await rejects(
      () => unpackSpc(spc, dest),
      'PATH_OUT_OF_SCOPE',
      (e) => assert.equal(e.params.path, name),
    );
  }
});

test('反斜杠条目：yauzl 会规整成 `/`（`a\\b.txt` 落成 `a/b.txt`）—— 行为钉住，别当漏洞', async () => {
  const { spc, dest } = craft('backslash', [{ name: 'a\\b.txt', data: Buffer.from('hi', 'utf8') }]);
  const res = await unpackSpc(spc, dest);
  assert.equal(res.entries, 1);
  assert.deepEqual(filesOf(dest), ['a/b.txt'], '规整成子目录（Windows 风格打包工具的常见写法）');
  assert.equal(readFileSync(join(dest, 'a', 'b.txt'), 'utf8'), 'hi');
});

test('重名条目 ⇒ DUPLICATE_ENTRY（后一个会静默覆盖前一个，必须拦）', async () => {
  const { spc, dest } = craft('dup', [{ name: 'a.txt', data: Buffer.from('one') }, { name: 'a.txt', data: Buffer.from('two') }]);
  await rejects(
    () => unpackSpc(spc, dest),
    'DUPLICATE_ENTRY',
    (e) => assert.equal(e.params.path, 'a.txt'),
  );
});

test('加密条目 ⇒ PACKAGE_ENTRY_UNSUPPORTED（我们不支持带密码的包；这道是我们自己拦的）', async () => {
  const { spc, dest } = craft('enc', [{ name: 'a.txt', encrypted: true }]);
  await rejects(
    () => unpackSpc(spc, dest),
    'PACKAGE_ENTRY_UNSUPPORTED',
    (e) => {
      assert.equal(e.params.path, 'a.txt');
      assert.equal(e.params.kind, 'encrypted');
    },
  );
  assert.ok(!existsSync(dest), '拒了就别留残迹');
});

test('符号链接条目 ⇒ PACKAGE_ENTRY_UNSUPPORTED（否则等于让包自己指到任意路径）', async () => {
  const { spc, dest } = craft('sym', [{ name: 'link', symlink: true }]);
  await rejects(
    () => unpackSpc(spc, dest),
    'PACKAGE_ENTRY_UNSUPPORTED',
    (e) => assert.equal(e.params.kind, 'symlink'),
  );
});

test('限额三条：条目数 / 单条目 / 总量，都是各自的码（fail-closed 而不是截断）', async () => {
  const many = craft('many', [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  await rejects(
    () => unpackSpc(many.spc, many.dest, { ...DEFAULT_UNPACK_LIMITS, maxEntries: 2 }),
    'PACKAGE_TOO_MANY_ENTRIES',
    (e) => assert.equal(e.params.limit, '2'),
  );

  const big = craft('big', [{ name: 'a.bin', data: Buffer.alloc(100, 1) }]);
  await rejects(
    () => unpackSpc(big.spc, big.dest, { ...DEFAULT_UNPACK_LIMITS, maxEntryBytes: 10 }),
    'PACKAGE_ENTRY_TOO_LARGE',
    (e) => {
      assert.equal(e.params.path, 'a.bin');
      assert.equal(e.params.actual, '100');
    },
  );

  const total = craft('total', [{ name: 'a.bin', data: Buffer.alloc(40, 1) }, { name: 'b.bin', data: Buffer.alloc(40, 1) }]);
  await rejects(
    () => unpackSpc(total.spc, total.dest, { ...DEFAULT_UNPACK_LIMITS, maxTotalBytes: 50 }),
    'PACKAGE_TOO_LARGE',
    (e) => assert.equal(e.params.actual, '80'),
  );
});

test('不是 zip / 被截断 ⇒ PACKAGE_ARCHIVE_INVALID（不是抛底层异常给运维看）', async () => {
  const notZip = join(TMP, 'notzip.spc');
  writeFileSync(notZip, '这不是 zip，只是一段文本\n'.repeat(20), 'utf8');
  await rejects(() => unpackSpc(notZip, join(TMP, 'notzip-out')), 'PACKAGE_ARCHIVE_INVALID');

  const { spc, dest } = craft('trunc', [{ name: 'a.txt', data: Buffer.alloc(4096, 7) }]);
  truncateSync(spc, Math.floor(statSync(spc).size / 2)); // 砍掉一半（中央目录没了）
  await rejects(() => unpackSpc(spc, dest), 'PACKAGE_ARCHIVE_INVALID');
});

test('目标目录已存在 ⇒ PACKAGE_DEST_NOT_EMPTY（解包只往**全新**目录里写，不做合并）', async () => {
  const { spc } = craft('dest', [{ name: 'a.txt' }]);
  const dest = join(TMP, 'dest-exists');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, '旧文件.txt'), '别覆盖我', 'utf8');
  await rejects(
    () => unpackSpc(spc, dest),
    'PACKAGE_DEST_NOT_EMPTY',
    (e) => assert.equal(e.params.dir, dest),
  );
  assert.equal(readFileSync(join(dest, '旧文件.txt'), 'utf8'), '别覆盖我', '拒了就一个字节都不该动');
});
