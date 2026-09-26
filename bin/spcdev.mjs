#!/usr/bin/env node
// `spcdev`：**插件作者工具**（keygen / new / check / build / pack / watch / permission）。
// 全程本地、不需要 daemon；但**需要这份仓库**（类型声明、构建器、esbuild 都在仓库里）。
//
//   cd <ServerPluginCore> && npm link      # 一次性 ⇒ 之后任何目录都能用 spc / spcdev
//   spcdev keygen                          # 作者密钥 → .spcdev/keys/
//   spcdev new demo --publisher std        # 脚手架 → plugin/demo/
//   spcdev check .                         # 自检（清单 / 权限点对账 / 导入面）
import { launch } from './_launch.mjs';

launch('dev', 'spcdev');
