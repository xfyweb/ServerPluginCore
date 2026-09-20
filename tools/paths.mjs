// 仓库内工具的公共路径常量。
//
// 为什么需要它：这些工具原先住在工作区外的 `_audit/` 里，路径全是写死的本机绝对路径
// （`D:/git-repo/...`）。搬进仓库后必须改成**跟着仓库走**，否则别人克隆下来还是跑不了。
//
// 约定：
//   · 仓库内的东西 ⇒ 由本文件（`tools/paths.mjs`）自己推出，任何人克隆都能用；
//   · 仓库外的东西（判卷人二进制、依赖调查目录）⇒ 允许用环境变量覆盖，默认按工作区布局猜。
// ⚠️ 导出名的命名避让：调用方很可能自己就有 `SHIMS` / `SURVEY` 之类的局部变量
// （实测 `dep-smoke.mts` 就有一个 `const SHIMS` 映射表）⇒ 这里一律用能自解释的长名。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));      // <repo>/tools

/** 仓库根（`tools/` 的上一级）。 */
export const REPO_ROOT = resolve(HERE, '..');

/** 仿真模块目录（`core/sandbox-modules`）—— 生成器要写回这里。 */
export const SANDBOX_MODULES = join(REPO_ROOT, 'core', 'sandbox-modules');

/** 真值数据目录（`tools/truth/data`）—— 所有 `*-truth.json` 的存放处。 */
export const TRUTH_DATA = join(HERE, 'truth', 'data');

/** 冒烟工具产出的 bundle 目录（**生成物，已 gitignore**）。 */
export const SMOKE_BUNDLES = join(HERE, 'smoke', 'bundles');

/**
 * 依赖调查目录（`_deps-survey`）—— **仓库外**，由 `tools/README.md` 里的步骤自行创建。
 * 默认按"仓库的兄弟目录"猜，可用 `SPC_SURVEY_DIR` 覆盖（`tools/dep-survey.mjs` 也认这个变量）。
 */
export const SURVEY_DIR = process.env.SPC_SURVEY_DIR ?? resolve(REPO_ROOT, '..', '_deps-survey');

/**
 * Windows 判卷人（官方 node v22.22.1 解压出来的 `node.exe`）—— **仓库外**，需自行下载。
 * 默认按工作区布局猜，可用 `SPC_JUDGE_NODE` 覆盖。
 */
export const JUDGE_NODE =
  process.env.SPC_JUDGE_NODE ?? resolve(REPO_ROOT, '..', '_tools', 'node-v22.22.1-win-x64', 'node.exe');

/** 把本地路径转成 `file://` URL（动态 import 用）。 */
export const fileUrl = (p) => pathToFileURL(p).href;
