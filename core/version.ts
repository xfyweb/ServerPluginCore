// 版本与构建指纹（署名标识，随 release 构建注入）
// BUILD_ID：构建脚本注入（SPC_BUILD_ID 环境变量 / esbuild define），
//           开发环境回退为 dev-<日期>。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { major } from 'semver';

export const PROJECT = 'ServerPluginCore';
export const DOMAIN = 'spc.xfyweb.cn';

/**
 * **核心版本**：读仓库根的 `package.json` —— 它是**树的事实**（2026-10-14 定）。
 *
 * 三条规矩：
 *   · **不设环境变量**：要观察另一个版本的行为就 `git checkout` 到那个版本，不靠开关假装；
 *   · 发布产物由**构建期内联**（esbuild define，与 `BUILD_ID` 同一套）—— 产物里没有这一步读取；
 *   · 读不到就退 `0.0.0`：含义是"核心没有版本"，于是要求更高的插件会被**拒装**（fail-closed，见 `compat.ts`）。
 */
function readCoreVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION: string = readCoreVersion();

/**
 * **契约版本**（宿主 API 面的版本，semver）：**只在 API 面变化时 +1**。
 *
 * 为什么要有它、以及它跟核心版本的关系（2026-10-14 定）：核心版本与契约版本**总是同一次发版走**
 * （不存在"核心发了一个没有实现的契约版本"）；唯一的错位是"某次发版只动前端/无关部分"——
 * 那时契约版本不变，而它只是**派生事实**，无副作用。
 * 因此：**插件只声明 `manifest.compat.minCore`（核心版本）**，契约版本由核心发布、可供运行时探测与诊断。
 * 破坏性变更（删 API / 改调用签名）⇒ major +1 并归零；新增 API ⇒ minor +1；修 API ⇒ patch +1。
 *
 * ⚠️ 它是**源码事实**，不由发版脚本注入：改它必须同时改 `docs/api-contract.md` 的 changelog。
 */
export const CONTRACT_VERSION = '1.0.0';

/**
 * 契约的**主版本**：老插件读的 `lifecycle.version().api` 就是它。
 * 保留这个字段是"只增不改"——新插件一律读 `contract`（semver）。
 */
export const CONTRACT_API = major(CONTRACT_VERSION);

export const BUILD_ID: string =
  process.env.SPC_BUILD_ID ?? `dev-${new Date().toISOString().slice(0, 10)}`;

/** 品牌行：`ServerPluginCore 0.0.0 (spc.xfyweb.cn) build dev-2026-08-31` */
export const BRAND = `${PROJECT} ${VERSION} (${DOMAIN}) build ${BUILD_ID}`;
