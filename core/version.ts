// 版本与构建指纹（署名标识，随 release 构建注入）
// BUILD_ID：构建脚本注入（SPC_BUILD_ID 环境变量 / esbuild define），
//           开发环境回退为 dev-<日期>。
export const PROJECT = 'ServerPluginCore';
export const DOMAIN = 'spc.xfyweb.cn';
export const VERSION = '0.0.0';

export const BUILD_ID: string =
  process.env.SPC_BUILD_ID ?? `dev-${new Date().toISOString().slice(0, 10)}`;

/** 品牌行：`ServerPluginCore 0.0.0 (spc.xfyweb.cn) build dev-2026-08-31` */
export const BRAND = `${PROJECT} ${VERSION} (${DOMAIN}) build ${BUILD_ID}`;
