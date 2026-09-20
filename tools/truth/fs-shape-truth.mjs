// fs 形状细节的第二轮真值采集（WSL node v22.22.1）
//   用法：wsl -e node /mnt/d/git-repo/_audit/tools/truth/fs-shape-truth.mjs
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, statSync, lstatSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'spc-shape-'));
const sub = join(dir, 'sub');
mkdirSync(sub);
writeFileSync(join(sub, 'a.txt'), 'hello');
symlinkSync('a.txt', join(sub, 'link.txt'));

const shape = (fn) => {
  try {
    const v = fn();
    return { ok: true, value: v, type: typeof v };
  } catch (e) {
    return { ok: false, name: e.name, code: e.code, errno: e.errno, syscall: e.syscall, message: e.message };
  }
};

const out = {};
const prev = process.cwd();
process.chdir(sub); // 相对路径场景
const rel = readdirSync('.', { withFileTypes: true });
const abs = readdirSync(sub, { withFileTypes: true });
const pick = (arr, n) => arr.find((d) => d.name === n);
out.dirent = {
  relParentPath: pick(rel, 'a.txt')?.parentPath,
  absParentPath: pick(abs, 'a.txt')?.parentPath,
  pathAlias: pick(abs, 'a.txt')?.path,
  ownKeys: Object.keys(pick(abs, 'a.txt')),
  protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(pick(abs, 'a.txt'))),
  linkIsSymlink: pick(abs, 'link.txt')?.isSymbolicLink(),
  dirIsDir: pick(abs, 'sub')?.isDirectory(),
  nameIsGetterOrOwn: Object.getOwnPropertyDescriptor(pick(abs, 'a.txt'), 'name') ? 'own' : 'proto',
};
out.stats = {
  ownKeys: Object.keys(statSync(join(sub, 'a.txt'))),
  hasToJSON: typeof statSync(join(sub, 'a.txt')).toJSON,
  toJSONValue: shape(() => statSync(join(sub, 'a.txt')).toJSON()),
  protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(statSync(join(sub, 'a.txt')))).slice(0, 30),
  linkMode: lstatSync(join(sub, 'link.txt')).mode.toString(8),
  fileMode: statSync(join(sub, 'a.txt')).mode.toString(8),
  dirMode: statSync(sub).mode.toString(8),
  bigintMode: shape(() => typeof statSync(join(sub, 'a.txt'), { bigint: true }).mode),
};
process.chdir(prev);

out.messages = {
  writeFile_badFlag: shape(() => fs.writeFileSync(join(dir, 'w.txt'), 'x', { flag: 'zzz' })),
  writeFile_badEncoding: shape(() => fs.writeFileSync(join(dir, 'w.txt'), 'x', { encoding: 'zzz' })),
  readFile_bufferEncoding: shape(() => fs.readFileSync(join(sub, 'a.txt'), { encoding: 'buffer' })),
  access_badMode: shape(() => fs.accessSync(join(sub, 'a.txt'), '4')),
  access_badModeNull: shape(() => fs.accessSync(join(sub, 'a.txt'), null)),
  readFile_noArgs: shape(() => fs.readFileSync()),
  readFile_numberPath: shape(() => fs.readFileSync(123)),
  mkdir_recursive_fileExists: shape(() => fs.mkdirSync(join(sub, 'a.txt'), { recursive: true })),
  mkdir_recursive_fileNoRec: shape(() => fs.mkdirSync(join(sub, 'a.txt'))),
  readdir_buffer: { value: readdirSync(sub, 'buffer').map((b) => Buffer.isBuffer(b)), type: typeof readdirSync(sub, 'buffer')[0] },
  readdir_withFileTypes_buffer: shape(() => readdirSync(sub, { withFileTypes: true, encoding: 'buffer' })),
  stat_throwIfNoEntry: shape(() => statSync(join(sub, 'nope'), { throwIfNoEntry: false })),
  stat_badOptions: shape(() => statSync(join(sub, 'a.txt'), 'zzz')),
  rm_file_noOpts: shape(() => { writeFileSync(join(dir, 'del.txt'), 'x'); return fs.rmSync(join(dir, 'del.txt')); }),
  rm_dir_empty_noOpts: shape(() => { mkdirSync(join(dir, 'empty')); return fs.rmSync(join(dir, 'empty')); }),
  rmdir_file: shape(() => { writeFileSync(join(dir, 'f2.txt'), 'x'); return fs.rmdirSync(join(dir, 'f2.txt')); }),
  unlink_dir: shape(() => fs.unlinkSync(sub)),
  existsSync_undefined: shape(() => fs.existsSync(undefined)),
  realpathSyncNative: typeof fs.realpathSync.native,
  readdirSync_recursiveShape: shape(() => readdirSync(dir, { recursive: true })),
  copyFile_modeObject: shape(() => fs.copyFileSync(join(sub, 'a.txt'), join(dir, 'c.txt'), { mode: 1 })),
  copyFile_modeNumber: shape(() => fs.copyFileSync(join(sub, 'a.txt'), join(dir, 'c2.txt'), 0)),
};
// require 在 ESM 里：用 createRequire 才对，这里补一次
out.fsp_default = (() => {
  const ns = fs.promises;
  return { hasDefault: 'default' in ns, keyCount: Object.keys(ns).length, hasConstants: 'constants' in ns };
})();
out.promisesIdentity = fs.promises === (await import('node:fs/promises')).default ? 'same-as-default' : 'differs';

rmSync(dir, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out, null, 2));
