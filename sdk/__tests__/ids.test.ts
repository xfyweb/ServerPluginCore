// 插件标识形状的**唯一出处**守卫（`sdk/ids.ts` 的文件头讲了为什么要有那一份）。
//
// 这份用例必须"能红"，三条判别力各自守一件事：
//   ① 只改 schema 不改 `sdk/ids.ts`（或反过来）⇒ 第一组红；
//   ② 谁把规则抄回第二份 ⇒ 最后一组红；
//   ③ 核心 / 记录校验 / 动态权限点对同一个 id 判决不一致（有人绕过常量自己写规则）⇒ 一致那组红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_SEGMENT_CORE, ID_SEGMENT_RE, PLUGIN_ID_PATTERN, PLUGIN_ID_RE } from '../ids.ts';
import { validateManifest } from '../validate.ts';
import { checkAuthorId } from '../../build/workspace.ts';
import { SpcError } from '../../core/errors.ts';
import { callPointOf } from '../../core/permissions/points.ts';
import { validateRecord } from '../../core/plugin/records.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const schema = JSON.parse(
  readFileSync(new URL('../schema/manifest.schema.json', import.meta.url), 'utf8'),
) as {
  properties: {
    id: { pattern: string };
    author: { properties: { id: { pattern: string } } };
    dependencies: { properties: { plugins: { items: { properties: { id: { pattern: string } } } } } };
  };
};

/** 最小合法清单（id 每条替换；其余字段与原有用例的夹具同形） */
const MANIFEST = {
  schema: 2,
  id: '@a/b',
  name: 'X',
  version: { code: 1, name: '0.0.1' },
  runtime: { type: 'quickjs' },
  permissions: [{ name: 'fs.write.data' }],
};

/** 合法记录（id 每条替换）；`dir` 用当前目录而不是写死的 `C:\` / `/` */
const RECORD = {
  id: '@a/b',
  dir: resolve('.'),
  version: { code: 1, name: '0.0.1' },
  enabled: true,
  grants: [] as string[],
  capabilities: [] as string[],
  configPath: 'config/plugins/x.json',
  state: 'installed',
  installedAt: '2026-09-27T00:00:00.000Z',
  lastError: null,
  restartAttempts: 0,
  origin: 'local:default',
  signedBy: null,
  verifiedMeta: null,
};

/** 合法 / 非法完整 id —— 边界都在里面：长度 1 与 63/64、段数、分隔符、字符集 */
const VALID_IDS = ['@a/b', '@alice/hello', '@a1/2b', '@a-b/c_d', '@0/0', `@${'a'.repeat(63)}/${'b'.repeat(63)}`];
const INVALID_IDS = [
  'alice/hello', // 缺 `@`
  '@Alice/hello', // 大写
  '@alice/Hello',
  '@alice', // 缺名字段
  '@alice/', // 名字段为空
  '@/hello', // 作者段为空
  '@alice/hello/x', // 多一段
  '@alice%2Fhello', // 编码过的斜杠（解码后仍是两段，但原串没有 `/`）
  `@${'a'.repeat(64)}/b`, // 作者段 64 字符
  `@a/${'b'.repeat(64)}`, // 名字段 64 字符
  '@alice hello/x', // 空白
  '@alice.x/hello', // `.` 不在字符集里
];

/** 一段的候选（作者 ID / 插件名 / 目录名共用一套字符） */
const VALID_SEGMENTS = ['a', 'alice', 'a1', '2b', 'a-b_c', '0', 'a'.repeat(63)];
const INVALID_SEGMENTS = ['', 'A', '_a', '-a', 'a.b', 'a b', 'a/b', 'a@b', 'é', 'a'.repeat(64)];

test('schema 的 id 规则与 sdk/ids.ts 逐字绑着（只改一边就红）', () => {
  assert.equal(
    schema.properties.id.pattern,
    PLUGIN_ID_PATTERN,
    'manifest.schema.json 的 properties.id.pattern 与 sdk/ids.ts 的 PLUGIN_ID_PATTERN 不是同一个字符串',
  );
  assert.equal(
    schema.properties.dependencies.properties.plugins.items.properties.id.pattern,
    PLUGIN_ID_PATTERN,
    'dependencies.plugins[].id 的 pattern 与 PLUGIN_ID_PATTERN 不是同一个字符串',
  );
  // `author.id` 是 `<作者 ID>@<源域名>`：**第一段**与插件 id 的命名空间同规则（第二段是域名，另一套规则）
  assert.ok(
    schema.properties.author.properties.id.pattern.startsWith(`^${ID_SEGMENT_CORE}@`),
    `author.id 的第一段应与 ID_SEGMENT_CORE 同规则，实际：${schema.properties.author.properties.id.pattern}`,
  );
});

test('完整 id 的判决处处一致：清单校验 / 记录校验 / 动态权限点', () => {
  // 先确认夹具本身是合法的 —— 否则下面的判决全都会被夹具的问题带偏
  assert.deepEqual(validateRecord({ ...RECORD }), [], '记录夹具应当本来就合法');
  assert.equal(validateManifest({ ...MANIFEST }).ok, true, '清单夹具应当本来就合法');

  for (const id of [...VALID_IDS, ...INVALID_IDS]) {
    const want = PLUGIN_ID_RE.test(id);

    // ① schema（ajv）
    const m = validateManifest({ ...MANIFEST, id });
    assert.equal(m.ok, want, `清单校验对 ${id} 的判决应为 ${want}：${m.errors.join('; ')}`);

    // ② 装载记录（core/plugin/records.ts）：只看 id 那一条
    const errors = validateRecord({ ...RECORD, id });
    assert.equal(
      errors.some((e) => e.startsWith('id:')),
      !want,
      `记录校验对 ${id} 的判决应为 ${want}：${errors.join('; ')}`,
    );

    // ③ 动态权限点（core/permissions/points.ts 的 assertRef）：引用形状不对就抛
    let accepted: boolean;
    try {
      callPointOf(`local:default/${id}`, '/api/x');
      accepted = true;
    } catch (e) {
      assert.ok(
        e instanceof SpcError && e.code === 'PERMISSION_POINT_INVALID',
        `动态点对 ${id} 抛了预料之外的错：${String(e)}`,
      );
      accepted = false;
    }
    assert.equal(accepted, want, `动态权限点对 ${id} 的判决应为 ${want}`);
  }
});

test('一段的规则与整串同规则：作者 ID 校验按它判，两个位置都认', () => {
  for (const seg of [...VALID_SEGMENTS, ...INVALID_SEGMENTS]) {
    const want = ID_SEGMENT_RE.test(seg);
    assert.equal(checkAuthorId(seg), want ? seg : null, `checkAuthorId(${JSON.stringify(seg)})`);
    assert.equal(
      PLUGIN_ID_RE.test(`@${seg}/x`),
      want,
      `${JSON.stringify(seg)} 作为作者段时与 ID_SEGMENT_RE 判决不一致`,
    );
    assert.equal(
      PLUGIN_ID_RE.test(`@x/${seg}`),
      want,
      `${JSON.stringify(seg)} 作为名字段时与 ID_SEGMENT_RE 判决不一致`,
    );
  }
});

// 抄一份的指纹：规则尾部的**长度上限 62**（左花括号 + `0,` + 右花括号那种写法，中间允许有空格）
// —— 代码里再出现它就是又抄了一份。**连本文件的注释也不写字面量**：例外一开，守卫就守不住了。
const COPY_MARKER = /\{0,\s*62\}/;
/** 唯一允许写着这个形状的代码文件（schema 是 JSON，不在扫描范围内，由上面第一组绑着） */
const ALLOWED = new Set(['sdk/ids.ts']);
/** 不扫的目录（**任意深度**）：依赖、版本库、运行期状态、产物、开发期密钥 */
const SKIP_ANY_DEPTH = new Set(['node_modules', '.git', '.spc', '.spcdev', 'dist', 'coverage']);
/**
 * 只在**仓库根**才不扫的目录：`plugin/` 里是**作者的**插件源码，不是我们的。
 * ⚠️ 它**不能**按名字在任意深度跳 —— `core/plugin/` 里就有这条规则的用户（`records.ts`），
 * 按名字跳会把它们一起跳过，而守卫照样绿。这个洞是**变异自证**抓出来的（把规则抄回 `records.ts` 时，
 * 第一版扫描没报），所以下面还钉了一条"必须覆盖到已知用户"。
 */
const SKIP_ROOT_ONLY = new Set(['plugin']);

/** 扫描**必须**覆盖到的已知用户：漏掉任何一个，守卫就会静默失效 */
const MUST_SCAN = [
  'build/scaffold.ts',
  'build/workspace.ts',
  'core/exec/templates.ts',
  'core/permissions/points.ts',
  'core/plugin/records.ts',
  'core/sources/verify.ts',
];
const CODE_EXT = /\.(?:[cm]?[jt]s|tsx)$/;

function walk(dir: string, out: string[], atRoot = false): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_ANY_DEPTH.has(entry.name)) continue;
      if (atRoot && SKIP_ROOT_ONLY.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (CODE_EXT.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

test('代码里只有一处写着这个形状（谁抄回第二份就红）', () => {
  const files: string[] = [];
  walk(ROOT, files, true);
  assert.ok(files.length > 50, `扫描面太小（${files.length} 个文件），路径可能算错了：${ROOT}`);

  const seen = new Set(files.map((f) => relative(ROOT, f).split(sep).join('/')));
  for (const rel of MUST_SCAN) {
    assert.ok(seen.has(rel), `扫描没覆盖 ${rel} —— 跳目录的规则太宽了`);
  }

  const copies: string[] = [];
  for (const rel of seen) {
    if (ALLOWED.has(rel)) continue;
    if (COPY_MARKER.test(readFileSync(join(ROOT, rel), 'utf8'))) copies.push(rel);
  }
  assert.deepEqual(copies, [], `这些文件又抄了一份 id 规则（请改用 sdk/ids.ts 的常量）：${copies.join(', ')}`);
});
