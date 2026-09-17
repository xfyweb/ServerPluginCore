// node:fs/promises 仿真 —— **与 `fs.promises` 是同一份实现**（Node 里也是同一个对象）
//
// 为什么单独一个文件而不是让 `fs/promises` 走别名：登记表里 `fs/promises` 与 `fs` 是**两个独立登记名**
// （Node 也把它们当两个入口：`require('fs/promises')` 只有 promise 面，没有 `readFileSync`）。
// 这里只是把 `node-fs.js` 的 `promises` 对象按 Node 的导出面摊平，动作和错误语义一个字都不重复实现。
//
// 内联约束：静态、无占位符、不 import 任何 `node:*`。
import { promises } from './node-fs.js';

export const {
  access,
  appendFile,
  chmod,
  chown,
  constants,
  copyFile,
  cp,
  glob,
  lchmod,
  lchown,
  link,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  writeFile,
} = promises;

// `import fsp from 'node:fs/promises'` 在 Node 上拿到的是 `fs.promises` 本身（WSL 实测：
// `fs.promises === (await import('node:fs/promises')).default`），所以默认导出就是这个对象。
export default promises;
