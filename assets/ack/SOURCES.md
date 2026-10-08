# 鸣谢墙素材出处

本目录是 README「鸣谢」一栏用的项目标识（logo）。**这些标识是各自项目的商标/品牌资产，版权归各自项目所有**，
这里仅用于**标识与致谢**，**不代表任何形式的背书、合作或授权**。若有项目方不希望自己的标识出现在这里，
提 issue 或 PR 删除即可。

| 文件 | 出处 | 格式 / 尺寸 | 用途 |
|---|---|---|---|
| `dsh.svg` | npm全局包 `@deepseek-ai/dsh` 内置 Web 前端 `dist/favicon.svg` | SVG 50×50 | 置顶栏。**自带明暗自适应**（内部用 `prefers-color-scheme` 改填充色）。⚠️ 见下方「DSH」 |
| `node.svg` | nodejs.org 首页左上角的站标（内联 SVG；与 `https://nodejs.org/static/images/logo.svg` 同款） | SVG 267×80 | 自带明暗两套配色。⚠️ **站点靠 Tailwind 类上色，单独成文件时类不生效**（字标会继承根上的 `fill="none"` 而看不见）⇒ 这里补了一段等价 CSS（浅色 `#333333` / 深色 `#fff`，暗色绿取其 `--dm-inline-fill`） |
| `pnpm.svg` | `https://pnpm.io/img/pnpm-no-name-with-frame.svg` | SVG | 官方站点缺省版 |
| `esbuild.svg` | `https://esbuild.github.io/favicon.svg` | SVG 200×200 | 官方站点图标 |
| `tux.svg` | `https://upload.wikimedia.org/wikipedia/commons/3/35/Tux.svg` | SVG | **署名要求**：作者 Larry Ewing、Simon Budig、Garrett LeSage |
| `chromium.svg` | `https://upload.wikimedia.org/wikipedia/commons/2/28/Chromium_Logo.svg` | SVG | Wikimedia 标注为 Public domain（Chromium Authors 的开源开发协议） |
| `mcsmanager.png` | 项目源码 `MCSManager/frontend/src/assets/logo.png` | PNG 350×45 | 仓库内资产（字标，按 26px 高排版） |
| `velocity.png` | `PaperMC/velocitypowered.com` 仓库 `src/assets/img/velocity-blue.png` | PNG 400×400 | 浅色背景版 |
| `velocity-white.png` | 同上 `velocity-white.png` | PNG 400×400 | 深色背景版（README 里用 `<picture>` 切换） |
| `paper.png` | 项目源码 `Paper/paper-server/src/main/resources/logo.png` | PNG 200×200 | 仓库内资产 |
| `astrbot.svg` | 项目源码 `AstrBot/dashboard/public/favicon.svg` | SVG | 仓库内资产 |
| `classisland.svg` | `ClassIsland/ClassIsland` 仓库 `ClassIsland.Desktop/Assets/AppLogo.svg` | SVG 192×192 | 官方 AppLogo。|

## 两个已定的处理

- **DSH（置顶栏）**：采用其 Web 前端的标识。该项目的 `BRAND_GUIDELINES.md` **没有提供官方 logo 素材**，
  且要求"避免以可能引起误解的方式使用官方品牌素材，以免让人以为存在官方背书、合作或授权"——
  因此 README 在鸣谢栏顶部写了明确声明（仅表示参考了按各自协议开放的源代码，不代表背书/合作/授权），
  指引中明确允许的描述性用法（"built on / compatible with"）也在这个范围内。
- **QuickJS**：**没有官方 logo**，因此只放文字链接。已核实三处：`bellard.org/quickjs` 页面无任何图片、
  `quickjs-ng` 仓库只有 favicon（且是另一个项目）、`quickjs-emscripten` 仓库只有示例站点的图标。

## 备选（未采用，需要时按 URL 取回）

| 素材 | 出处 | 为什么没用 |
|---|---|---|
| Tux PNG | `https://www.kernel.org/theme/images/logos/tux.png` | 104×120 位图，比 `tux.svg` 糊；想要"kernel.org 直出"可换回 |
| Node.js 六边形单标 | `https://nodejs.org/static/images/logo-hexagon-card.png` | 只有标记没有字标；字标版（`node.svg`）两种主题下都成立，取了后者 |
