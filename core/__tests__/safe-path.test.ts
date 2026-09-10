// 路径收敛测试（interface-audit-exec-fs.md F1–F7）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, fstatSync, mkdtempSync, mkdirSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertInodeMatch, PathError, validatePath } from '../fs/safe-path';
import { parse, sep } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'spc-path-'));
const outside = mkdtempSync(join(tmpdir(), 'spc-outside-'));
const ROOTS = [root];

/**
 * 软链能力探测：POSIX 恒可用；Windows 需开发者模式或管理员权限（否则 EPERM）。
 * 按能力而非平台决定跳过——能建软链就真跑这些用例（曾经按 win32 一刀切，掩盖了两个 bug）。
 */
const canSymlink = (() => {
  try {
    const probe = mkdtempSync(join(tmpdir(), 'spc-symlink-probe-'));
    symlinkSync(join(probe, 'missing-target'), join(probe, 'link'));
    rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();
const symlinkCase = { skip: canSymlink ? false : '当前环境无法创建符号链接（Windows 需开发者模式/管理员）' };

test.before(() => {
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'existing.txt'), 'hello');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

// F1：路径穿越
test('F1: 相对穿越 ../ 被拒', () => {
  assert.throws(() => validatePath(join(root, 'sub', '..', '..', '..', 'etc', 'passwd'), ROOTS), PathError);
});

test('F1: 绝对路径越界被拒', () => {
  assert.throws(() => validatePath('/etc/passwd', ROOTS), PathError);
  assert.throws(() => validatePath(join(outside, 'secret.txt'), ROOTS), PathError);
});

// F2：符号链接逃逸
test('F2: 软链指向作用域外被拒', symlinkCase, () => {
  symlinkSync(join(outside, 'secret.txt'), join(root, 'evil-link'));
  assert.throws(() => validatePath(join(root, 'evil-link'), ROOTS), PathError);
});

// F3：特殊路径黑名单
test('F3: /dev /proc /sys 被拒', () => {
  assert.throws(() => validatePath('/dev/null', ROOTS), PathError);
  assert.throws(() => validatePath('/proc/self/status', ROOTS), PathError);
  assert.throws(() => validatePath('/sys/kernel', ROOTS), PathError);
});

// F4：大小限制（hostApi 层验证，这里是单元级存在性确认）
test('F4: 大文件标记存在（hostApi 层限制）', () => {
  // hostApi 的 MAX_FILE_BYTES 限制在 core/hostApi.ts，此处验证 safe-path 不阻塞正常小文件
  const v = validatePath(join(root, 'existing.txt'), ROOTS);
  assert.equal(v.path, join(root, 'existing.txt'));
});

// F5：inode 预检与比对
test('F5: 已存在文件预检 inode，打开后比对一致', () => {
  const v = validatePath(join(root, 'existing.txt'), ROOTS);
  assert.ok(v.expected, '应返回预检 inode');
  const fd = openSync(v.path, 'r');
  try {
    const st = fstatSync(fd);
    assert.doesNotThrow(() => assertInodeMatch({ dev: st.dev, ino: st.ino }, v.expected!));
  } finally {
    closeSync(fd);
  }
});

test('F5: inode 不匹配 → TOCTOU 拦截', () => {
  assert.throws(() => assertInodeMatch({ dev: 1, ino: 1 }, { dev: 2, ino: 2 }), PathError);
});

// F6：新文件父目录逃逸
test('F6: 新文件父目录越界被拒', () => {
  assert.throws(() => validatePath(join(root, 'sub', '..', '..', 'new.txt'), ROOTS), PathError);
  assert.throws(() => validatePath(join(outside, 'new.txt'), ROOTS), PathError);
});

// 正常路径
test('正常: 作用域内新文件（父目录校验通过）', () => {
  const v = validatePath(join(root, 'sub', 'data.txt'), ROOTS);
  assert.equal(v.path, join(root, 'sub', 'data.txt'));
  assert.equal(v.expected, null);
});

test('正常: 作用域内已存在文件', () => {
  const v = validatePath(join(root, 'existing.txt'), ROOTS);
  assert.equal(v.path, join(root, 'existing.txt'));
  assert.ok(v.expected);
});


// ---- 同事 review 补充场景 ----

// 1. 多级符号链接：link1 -> a -> outside（逐级 lstat 应解析完整链）
test('F2: 多级软链指向外部被拒', symlinkCase, () => {
  symlinkSync(join(root, 'a'), join(root, 'link1'), 'file');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'a'), 'file');
  assert.throws(() => validatePath(join(root, 'link1'), ROOTS), PathError);
});

// 2. 父目录为符号链接的新文件（指向外部已存在目录）
test('F6: 新文件的父目录是软链指向外部', symlinkCase, () => {
  mkdirSync(join(outside, 'sub'), { recursive: true });
  symlinkSync(join(outside, 'sub'), join(root, 'linkdir'), 'dir');
  assert.throws(() => validatePath(join(root, 'linkdir', 'new.txt'), ROOTS), PathError);
});

// 2a. 悬空软链（目标不存在）作为最终段：必须 fail-closed。
// 回归：Windows 上逐级扫描曾被跳过 → 悬空软链被当作"新文件"放行，写入会落到作用域外。
test('F2: 悬空软链作为最终段被拒（fail-closed，非放行/非裸 ENOENT）', symlinkCase, () => {
  symlinkSync(join(outside, 'created-later.txt'), join(root, 'sub', 'dangling'), 'file');
  assert.throws(
    () => validatePath(join(root, 'sub', 'dangling'), ROOTS),
    { name: 'PathError', code: 'SYMLINK_DANGLING' },
  );
});

// 2b. 悬空软链作为父目录，同样 fail-closed
test('F6: 悬空软链作为父目录被拒', symlinkCase, () => {
  symlinkSync(join(outside, 'no-such-dir'), join(root, 'dangling-dir'), 'dir');
  assert.throws(
    () => validatePath(join(root, 'dangling-dir', 'new.txt'), ROOTS),
    { name: 'PathError', code: 'SYMLINK_DANGLING' },
  );
});

// 2c. 作用域根自身在作用域内（曾经被自己的白名单拒绝）
test('作用域根自身可访问（根也在白名单内）', () => {
  const v = validatePath(root, ROOTS);
  assert.equal(v.path, root);
});

// 3. 中间目录不存在：明确 PathError（不冒泡裸 ENOENT）
test('中间目录不存在：明确报错（非裸 ENOENT）', () => {
  assert.throws(() => validatePath(join(root, 'nonexist', 'sub', 'file.txt'), ROOTS), PathError);
});

// 4. 边界路径：连续斜杠、结尾斜杠（join 规范化后应正常）
test('边界路径: 连续斜杠', () => {
  const v = validatePath(join(root, 'sub//file.txt'), ROOTS);
  assert.equal(v.path, join(root, 'sub', 'file.txt'));
});

test('边界路径: 结尾斜杠', () => {
  const v = validatePath(join(root, 'sub/'), ROOTS);
  assert.equal(v.path, join(root, 'sub'));
});

// 5. root 配置为 / （根目录特判，白名单不应失效）
test('root=盘根时白名单仍生效（resolve("/")+sep 的 "//" bug 已修）', () => {
  // 跨平台取当前盘根：'/'（POSIX）或 'C:\\'（Windows）
  const rootDir = parse(tmpdir()).root; // tmpdir 所在盘根，与待测路径同盘
  const tmpFile = join(tmpdir(), 'spc-root-root-check.txt');
  const v = validatePath(tmpFile, [rootDir]);
  assert.equal(v.path, tmpFile);
});

// 6. assertInodeMatch(null)：运行时防御（不崩溃）
test('assertInodeMatch(null)：明确报错而非崩溃', () => {
  assert.throws(() => assertInodeMatch({ dev: 1, ino: 1 }, null), PathError);
});

// 7. 相对路径逃逸（resolve 后越界）
test('相对路径 resolve 后越界被拒', () => {
  // 相对路径会相对 cwd resolve；构造一个必然越界的相对路径（../../ 多层）
  assert.throws(() => validatePath('../../../../etc/passwd', ROOTS), PathError);
});
