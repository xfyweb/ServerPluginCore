// 产物事实（docs/build-layer-design.md §2、§4）：**构建器算出来的**东西写进清单，让作者声明变成可校验的
//
// 三条事实（关键：都不是作者声明的 —— ADR-005 §6「事实来源是构建器，不是 manifest 里的手写字段」）：
//   ① `dependencies.npm[].resolved` —— 真实解析到的版本（不是清单里写的区间）；
//   ② 真实依赖闭包 + 逐包体积 —— 透明与归因：管理员一眼看到"这插件里有哪几坨第三方代码、各占多少"；
//   ③ 已登记内建的使用清单 —— 审查面：用到了哪些宿主仿真模块。
//
// ⚠️ **对账的边界**（写清楚，免得它看起来比实际更强）：
//   · **传递依赖不算不一致**：声明 `debug` 而闭包里还有 `ms`，那是正常的 —— 闭包清单本身就是透明面，
//     不是"只能有声明过的东西"的白名单；
//   · **版本只在声明是"精确版本"时判**（`1.2.3` 这种）。区间（`^1.2.3` / `3.x` / `>=1`）要 semver 解析器，
//     而 `build-layer-design.md` §9-3 那条（版本解析要不要上 lockfile）**还没定**，本项目也不引依赖
//     ⇒ 区间**记录但不判**，并在构建输出里点明"未核"，绝不让它静默通过。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Metafile } from 'esbuild';

/** 闭包里的一个第三方包（`bytes` = 它在**产物里**占的字节，不是磁盘上的大小） */
export interface ClosureEntry {
  name: string;
  version: string;
  bytes: number;
}

/** 写进清单的产物事实（`manifest.json` 的根级 `build`） */
export interface BuildFacts {
  closure: ClosureEntry[];
  builtins: string[];
  bytes: number;
}

/** 清单里作者声明的一条 npm 依赖 */
export interface DeclaredDep {
  name: string;
  version: string;
  resolved?: string;
}

/** 版本取不到时的占位（**不是**"版本是 0"；对账时按"未核"处理） */
export const UNKNOWN_VERSION = '[未标版本]';

/** 精确版本（可判等）；其它一切（`^`/`~`/`>=`/`x`/`*`/区间）都算区间 */
export function isExactVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v.trim());
}

/**
 * 从 metafile 里认出第三方包。
 *
 * 体积取 `outputs[].inputs[].bytesInOutput`（**产物里占的字节**）：实测 esbuild 0.28.2 的
 * `inputs[path]` 上**没有** `bytesInOutput`（那里只有源码 `bytes`），逐输入的产物体积挂在 `outputs` 下面。
 *
 * 包名取**最后一个** `node_modules` 段之后的段：pnpm 的真实布局是
 * `node_modules/.pnpm/<name>@<ver>/node_modules/<name>/…`（esbuild 解析的是 realpath），
 * 只认第一个 `node_modules` 会把包名认成 `.pnpm`。
 */
export function closureOf(metafile: Metafile, dir: string): ClosureEntry[] {
  const per = new Map<string, { version: string; bytes: number }>();
  for (const out of Object.values(metafile.outputs)) {
    for (const [rawPath, info] of Object.entries(out.inputs)) {
      const rel = rawPath.split('\\').join('/');
      const pkgDir = packageDirOf(rel);
      if (pkgDir === null) continue;
      const name = pkgDir.slice(pkgDir.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const add = typeof info.bytesInOutput === 'number' ? info.bytesInOutput : 0;
      const cur = per.get(name);
      if (cur) cur.bytes += add;
      else per.set(name, { version: readVersion(join(dir, pkgDir)), bytes: add });
    }
  }
  return [...per]
    .map(([name, v]) => ({ name, version: v.version, bytes: v.bytes }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `node_modules/…` 里某个文件所属的**包目录**（相对路径）；不在 node_modules 里返回 null */
function packageDirOf(rel: string): string | null {
  const segs = rel.split('/');
  let last = -1;
  for (let i = 0; i < segs.length; i++) if (segs[i] === 'node_modules') last = i;
  if (last < 0) return null;
  const first = segs[last + 1];
  if (first === undefined) return null;
  const end = first.startsWith('@') ? last + 3 : last + 2; // 作用域包占两段
  if (end > segs.length) return null;
  return segs.slice(0, end).join('/');
}

/** 读包自己的 `package.json` 里的版本（读不到就给占位，**不编**一个版本出来） */
function readVersion(pkgAbsDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(pkgAbsDir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

export interface Reconcile {
  /** 声明名 → 真实版本（用来回填清单里的 `resolved`） */
  resolved: Map<string, string>;
  /** 声明了但**没被打进闭包**（装了没用 / 名字写错）⇒ 构建失败 */
  unused: string[];
  /** 声明是精确版本、与真实版本不符 ⇒ 构建失败 */
  versionMismatch: { name: string; declared: string; resolved: string }[];
  /** 声明是区间 ⇒ 记录但**不判**（见文件头） */
  uncheckedRange: { name: string; declared: string; resolved: string }[];
  /** 闭包里有、声明里没有的（传递依赖）—— 不算失败，进清单供审查 */
  transitive: string[];
  /** 闭包里版本取不到的包 */
  unknownVersion: string[];
}

/** 作者声明 ⟷ 真实闭包 对账（规则见文件头；只返回结果，判不判失败由调用方决定） */
export function reconcile(declared: readonly DeclaredDep[], closure: readonly ClosureEntry[]): Reconcile {
  const byName = new Map(closure.map((c) => [c.name, c]));
  const out: Reconcile = {
    resolved: new Map(),
    unused: [],
    versionMismatch: [],
    uncheckedRange: [],
    transitive: [],
    unknownVersion: closure.filter((c) => c.version === UNKNOWN_VERSION).map((c) => c.name),
  };
  const declaredNames = new Set<string>();
  for (const dep of declared) {
    declaredNames.add(dep.name);
    const hit = byName.get(dep.name);
    if (!hit) {
      out.unused.push(dep.name);
      continue;
    }
    out.resolved.set(dep.name, hit.version);
    if (hit.version === UNKNOWN_VERSION) continue; // 取不到真实版本 ⇒ 无从判定，按"未核"处理
    if (isExactVersion(dep.version)) {
      if (dep.version.trim() !== hit.version) {
        out.versionMismatch.push({ name: dep.name, declared: dep.version.trim(), resolved: hit.version });
      }
    } else {
      out.uncheckedRange.push({ name: dep.name, declared: dep.version, resolved: hit.version });
    }
  }
  out.transitive = closure.filter((c) => !declaredNames.has(c.name)).map((c) => c.name);
  return out;
}
