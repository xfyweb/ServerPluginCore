#!/usr/bin/env node
// `spc`：**管理面**（本机管理员）。仓库根跑一次 `npm link` 后可在任何目录使用。
// 需要 daemon 的命令：status / daemon stop / plugin <除 new 外> / source。`about` 与用法页是本地信息。
// 作者工具在另一个命令 `spcdev`（见 bin/_launch.mjs 的文件头说明为什么分开）。
import { launch } from './_launch.mjs';

launch('admin', 'spc');
