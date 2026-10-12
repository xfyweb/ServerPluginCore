// ⑦c `spcdev pack`（`docs/build-layer-design.md` §10.6）：把产物目录打成 `.spc`（**标准 zip**）。
//
// 这里的判据分两层，**别混**：
//   · **承诺**：载荷内容（`bundle.js` / `manifest.json`…）与产物目录**逐字节一致**；
//   · **白拿（不是承诺）**：mtime 固定、条目排序 ⇒ 同一份载荷两次打包字节一致。
// 验证走 **yauzl 解回来**（与写入端 yazl 是两条独立路径），不是"再读一遍自己写的字节"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { openPromise, type Entry, type ZipFile } from 'yauzl';

const TMP = mkdtempSync(join(tmpdir(), 'spc-pack-'));
process.env.SPC_STATE_DIR = join(TMP, 'state');
process.env.SPC_AUDIT_DIR = join(TMP, 'state', 'audit');

const { SpcError } = await import('../../core/errors.ts');
const { runDevCli } = await import('../cli.ts');
const { packPlugin } = await import('../pack.ts');
const { generateAuthorKey, saveAuthorKey } = await import('../keys.ts');
const { ensureWorkspaceConfig, loadWorkspace, patchWorkspaceConfig } = await import('../workspace.ts');

// ---------------- 夹具（比 build.test.ts 那份更小：pack 只关心产物目录）----------------

function fixture(name: string): { dir: string; dist: string } {
  const root = join(TMP, name);
  mkdirSync(root, { recursive: true });
  const ws = loadWorkspace(root, { create: true });
  ensureWorkspaceConfig(ws);
  patchWorkspaceConfig(ws, { author: 'std' });
  saveAuthorKey(ws, generateAuthorKey());

  const dir = join(root, 'plugin', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        schema: 2,
        id: `@std/${name}`,
        name: `Fixture ${name}`,
        version: { code: 1, name: '0.0.1' },
        runtime: { type: 'quickjs', esm: true },
        permissions: [{ name: 'fs.write.data' }],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(dir, 'main.ts'), 'export function init() {}\n', 'utf8');
  return { dir, dist: join(dir, 'dist') };
}

/** 跑 `spcdev build` 造出真的产物目录（pack 的前提） */
async function build(dir: string): Promise<void> {
  const code = await runDevCli('build', [dir]);
  assert.equal(code, 0, '夹具构建应当成功');
}

/** 产物目录里的全部文件（posix 相对路径 → 字节） */
function filesOf(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur)) {
      const abs = join(cur, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.set(relative(dir, abs).split(sep).join(posix.sep), readFileSync(abs));
    }
  };
  walk(dir);
  return out;
}

/** 用 yauzl 把 `.spc` 解回来：条目名 → { 字节, mtime, mode } */
async function readSpc(file: string): Promise<Map<string, { bytes: Buffer; mtime: Date; mode: number }>> {
  const zip = await openPromise(file, { lazyEntries: true });
  const out = new Map<string, { bytes: Buffer; mtime: Date; mode: number }>();
  await new Promise<void>((ok, fail) => {
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        try {
          const stream = await zip.openReadStreamPromise(entry);
          const chunks: Buffer[] = [];
          for await (const c of stream) chunks.push(c as Buffer);
          out.set(entry.fileName, {
            bytes: Buffer.concat(chunks),
            mtime: entry.getLastModDate(),
            // zip 的 externalFileAttributes 高 16 位是 unix mode（见 yauzl 的 Entry 注释）
            mode: (entry.externalFileAttributes >>> 16) & 0o777,
          });
          zip.readEntry();
        } catch (e) {
          fail(e as Error);
        }
      })();
    });
    zip.on('end', () => ok());
    zip.on('error', (e: Error) => fail(e));
    zip.readEntry();
  });
  return out;
}

async function rejects(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof SpcError, `期望 SpcError(${code})，实际 ${String(e)}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`没有抛 ${code}`);
}

// ---------------- 用例 ----------------

test('打包：条目与产物目录逐条一致（含信封），mtime/mode 固定，条目名是 posix 相对路径', async () => {
  const f = fixture('pack-ok');
  await build(f.dir);

  const res = await packPlugin({ distDir: f.dist, file: join(f.dir, 'out.spc') });
  const dist = filesOf(f.dist);
  assert.equal(res.entries, dist.size, '信封也随包');
  assert.ok(existsSync(res.file));

  const zip = await readSpc(res.file);
  assert.deepEqual([...zip.keys()].sort(), [...dist.keys()].sort(), '条目集合 == 产物目录里的文件');
  for (const [path, bytes] of dist) {
    assert.deepEqual(zip.get(path)?.bytes, bytes, `${path} 的字节要与产物一致（承诺只管载荷内容）`);
  }
  assert.ok([...zip.keys()].includes('plugin.meta.json'), '信封在包里');
  assert.ok([...zip.keys()].includes('plugin.author.sig'), '签名在包里');
  assert.ok(
    [...zip.keys()].every((p) => !p.startsWith('/') && !p.includes('..') && !p.includes('\\')),
    '条目名必须是 posix 相对路径（不许绝对路径 / 反斜杠 / 上跳）',
  );
  // 白拿的两条：mtime 与 mode 固定（**不是**承诺，见文件头）
  const mtimes = new Set([...zip.values()].map((e) => e.mtime.toISOString()));
  assert.deepEqual([...mtimes], ['1980-01-01T00:00:00.000Z'], `mtime 要固定：${[...mtimes].join(',')}`);
  assert.ok([...zip.values()].every((e) => e.mode === 0o644), 'mode 固定 0644');
  assert.ok([...zip.keys()].length === dist.size);
});

test('同一份载荷打两次包：字节一致（白拿的性质 —— 容器字节本来不在承诺内）', async () => {
  const f = fixture('pack-twice');
  await build(f.dir);
  const a = await packPlugin({ distDir: f.dist, file: join(f.dir, 'a.spc') });
  const b = await packPlugin({ distDir: f.dist, file: join(f.dir, 'b.spc') });
  assert.equal(a.bytes, b.bytes);
  assert.deepEqual(readFileSync(a.file), readFileSync(b.file));
});

test('没构建就打包 ⇒ PACK_DIST_MISSING（先说清"先跑 build"）', async () => {
  const f = fixture('pack-nodist');
  await rejects(() => packPlugin({ distDir: f.dist, file: join(f.dir, 'x.spc') }), 'PACK_DIST_MISSING');
});

test('信封缺了 ⇒ PACK_ENVELOPE_MISSING（签名不在就不是一个能装的包）', async () => {
  const f = fixture('pack-noenvelope');
  await build(f.dir);
  rmSync(join(f.dist, 'plugin.author.sig'));
  await rejects(() => packPlugin({ distDir: f.dist, file: join(f.dir, 'x.spc') }), 'PACK_ENVELOPE_MISSING');
});

test('build 之后手改了产物 ⇒ PACK_ENVELOPE_MISMATCH（签名与内容已经对不上）', async () => {
  const f = fixture('pack-tampered');
  await build(f.dir);
  appendFileSync(join(f.dist, 'bundle.js'), '\n// 手改的一行\n');
  await rejects(() => packPlugin({ distDir: f.dist, file: join(f.dir, 'x.spc') }), 'PACK_ENVELOPE_MISMATCH');
});

test('退出码：PACK_* 是一族门禁失败（3），与一般失败分开 —— CI 才分得清', async () => {
  const f = fixture('pack-exit');
  // 没构建 ⇒ pack 走门禁路径
  const code = await runDevCli('pack', [f.dir]);
  assert.equal(code, 3, 'PACK_* 应当映射成退出码 3（与 BUILD_* 同档）');
});
