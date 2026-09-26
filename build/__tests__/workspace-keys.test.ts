// ⑦a 构建层工具测试：keygen / plugin new / check / permission list + 权限映射表的守卫
//
// 为什么这些用例重要：⑦a 全是**作者第一次接触的东西**（生成密钥、生成插件、自检），
// 它们错了作者会以为"平台有问题"。所以每条都验"真的能用"，而不只是"文件写出来了"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign as edSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkPlugin } from '../check';
import { generateAuthorKey, keyObjectOf, loadAuthorKey, pubOfSeed, saveAuthorKey } from '../keys';
import { listPermissions } from '../permissions';
import { scaffoldPlugin } from '../scaffold';
import { extractApiMap, MIN_EXPECTED_METHODS } from '../extract-api-map';
import { loadApiMap, pointFamily, pointForMethod } from '../apimap';
import { findWorkspaceDir, loadWorkspace, WORKSPACE_DIRNAME } from '../workspace';
import { ed25519Verify } from '../../core/sources/keys';
import { registry } from '../../core/permissions/registry';
import { validateManifest } from '../../sdk/validate';
import { SpcError } from '../../core/errors';

const REPO = join(import.meta.dirname, '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'spc-build-'));

/** 造一个工作区（`.spcdev/` 在 `root/` 下） */
function workspace(name: string): ReturnType<typeof loadWorkspace> {
  const root = join(TMP, name);
  mkdirSync(root, { recursive: true });
  return loadWorkspace(root, { create: true });
}

// ---------------- 权限映射表（守卫）----------------

test('api-permission-map.json 与 core/hostApi.ts 一致（改一处必须重跑生成器）', () => {
  const { methods } = extractApiMap(readFileSync(join(REPO, 'core', 'hostApi.ts'), 'utf8'));
  assert.ok(
    Object.keys(methods).length >= MIN_EXPECTED_METHODS,
    `抽取只拿到 ${Object.keys(methods).length} 个方法（下限 ${MIN_EXPECTED_METHODS}）—— 抽取逻辑被源码格式变更打瞎了`,
  );
  const sorted = Object.fromEntries(Object.keys(methods).sort().map((k) => [k, methods[k]]));
  assert.deepEqual(
    loadApiMap().methods,
    sorted,
    '快照过期：跑 `node node_modules/tsx/dist/cli.mjs build/refresh-api-map.mts`',
  );
});

test('映射表里的每个点都是本机已注册的权限点（否则对账会把作者引到不存在的点上）', () => {
  const points = new Set(Object.values(loadApiMap().methods));
  assert.ok(points.size > 0);
  for (const point of points) {
    assert.ok(registry.get(point), `${point} 不在冻结表里`);
  }
});

test('pointFamily：.data / .host 归一到族（档位由运行期路径决定，静态只对到族）', () => {
  assert.equal(pointFamily('fs.read.data'), 'fs.read');
  assert.equal(pointFamily('fs.read.host'), 'fs.read');
  assert.equal(pointFamily('kv.read'), 'kv.read');
  assert.equal(pointForMethod('fs.write'), 'fs.write.data');
  assert.equal(pointForMethod('plugins.call'), undefined, 'exec/plugins 这类不在这张表里（按声明/模板动态判）');
});

// ---------------- keygen ----------------

test('keygen：生成自洽的一对钥，落到 .spcdev/keys/ 并可载入（含签名往返）', () => {
  const ws = workspace('ws-keygen');
  const key = generateAuthorKey();
  const saved = saveAuthorKey(ws, key);

  assert.ok(existsSync(saved.keyPath) && existsSync(saved.pubPath));
  assert.equal(readFileSync(saved.pubPath, 'utf8').trim(), key.pub, '公钥文件就是裸 base64 公钥');
  assert.equal(saved.fingerprint, key.fingerprint);

  const loaded = loadAuthorKey(saved.keyPath);
  assert.equal(loaded.fingerprint, key.fingerprint);
  assert.equal(pubOfSeed(loaded.seed), loaded.pub, '种子推出来的公钥必须等于文件里的 pub');

  // 真签一次、用 core 的判定方验一次（证明这把钥**能用来签名**，不是只能看）
  const data = Buffer.from('reanchor-me', 'utf8');
  const sig = edSign(null, data, keyObjectOf(loaded)).toString('base64');
  assert.equal(ed25519Verify(loaded.pub, data, sig), true);
});

test('keygen：已有密钥 ⇒ 必须 --force 才覆盖（换钥 = 换身份）', () => {
  const ws = workspace('ws-keygen-force');
  const first = generateAuthorKey();
  saveAuthorKey(ws, first);
  const second = generateAuthorKey();
  assert.throws(
    () => saveAuthorKey(ws, second),
    (e: unknown) => e instanceof SpcError && e.code === 'AUTHOR_KEY_EXISTS',
  );
  assert.equal(loadAuthorKey(ws.keyPath).fingerprint, first.fingerprint, '被拒 ⇒ 原钥不动');

  const saved = saveAuthorKey(ws, second, { force: true });
  assert.equal(saved.overwritten, true);
  assert.equal(loadAuthorKey(ws.keyPath).fingerprint, second.fingerprint);
});

test('keygen：密钥文件不自洽 ⇒ 载入即拒（fail-closed）', () => {
  const ws = workspace('ws-keygen-bad');
  const key = generateAuthorKey();
  saveAuthorKey(ws, key);

  // 把 pub 换成另一把钥的 ⇒ 种子推不出来了
  const other = generateAuthorKey();
  const tampered = { ...key, pub: other.pub };
  writeFileSync(ws.keyPath, JSON.stringify(tampered), 'utf8');
  assert.throws(
    () => loadAuthorKey(ws.keyPath),
    (e: unknown) => e instanceof SpcError && e.code === 'AUTHOR_KEY_INVALID',
  );

  // 指纹对不上也拒
  writeFileSync(ws.keyPath, JSON.stringify({ ...key, fingerprint: other.fingerprint }), 'utf8');
  assert.throws(
    () => loadAuthorKey(ws.keyPath),
    (e: unknown) => e instanceof SpcError && e.code === 'AUTHOR_KEY_INVALID',
  );
});

test('工作区发现：从**子目录**往上找到最近的 .spcdev（近者优先）', () => {
  const ws = workspace('ws-discover');
  const deep = join(ws.root, 'plugin', 'some', 'deep');
  mkdirSync(deep, { recursive: true });
  assert.equal(findWorkspaceDir(deep), ws.dir);
  assert.equal(loadWorkspace(deep).root, ws.root);

  // 插件目录里再放一个 ⇒ 近的那个赢
  const inner = join(ws.root, 'plugin', 'some', WORKSPACE_DIRNAME);
  mkdirSync(inner, { recursive: true });
  assert.equal(findWorkspaceDir(deep), inner);
});
