// 构建层：把插件源码打成**单文件 ESM**（docs/build-layer-design.md §3–§5）
//
// **两道闸**（§5）——为什么需要两道，是实测出来的，不是推理：
//   第一道（解析期重定向）：已登记内建 → 内联宿主的仿真源码；未登记内建 → 构建失败（"沙箱尚未支持 X"）。
//     没有它，`platform: node` 会把内建 externalize 成 `__require("fs")` 留在产物里 —— 而沙箱里**没有 require**，
//     即便模块登记了也跑不起来（§7 结论 1）。
//   第二道（产物断言）：esbuild 对**解析不到的东西**会静默降级成运行期兜底调用，**连 warning 都不给**
//     （§7 结论 2 的 v2 修正：未登记内建其实被第一道闸拦得住，真正只能靠第二道闸的是"解析不到的非内建"与"动态 require"）。
//
// ⚠️ 两条硬约束（都由用例守着）：
//   ① esbuild 配置里**永远不出现 `.node` loader**（§7 结论 4）：原生模块的"必失败"是**配置的产物**——
//      一旦有人为了让它过而配上 loader，它会被内联成二进制数据、构建静默通过；
//   ② 已登记内建必须**内联**（不能标 external）：实测 external 对 CJS 形态无效（CJS-in-ESM 无法提升成 import，
//      退化成 3 处运行期欠条），见 `tools/gate-probe.mjs` 的 ② 组。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Metafile, type Plugin } from 'esbuild';
import { SpcError } from '../core/errors';
import { normalizeSpecifier, sandboxModule, shimFileName } from '../core/sandbox-modules/registry';

/** 仿真模块源码目录：与沙箱 loader 读的是**同一批文件**（`core/sandbox.ts` 的 `shimSourceForFile`） */
const SHIM_DIR = fileURLToPath(new URL('../core/sandbox-modules/', import.meta.url));

/**
 * 宿主注入的能力桥：沙箱在求值插件模块前已把它放好（`core/sandbox.ts` 的 `moduleSource`）。
 * 构建层只负责**保留**这个 import（标 external），它的正文是运行时按本次装配的方法组动态生成的。
 */
const HOST_API = '@host/api';

/** 未登记内建报错的标记前缀：`onResolve` 返回的 error 文案由 `classify()` 认回来，归到专门的错误码 */
const UNSUPPORTED_PREFIX = '沙箱尚未支持 ';

/**
 * 欠条的第二个信号：esbuild 的运行期兜底 helper 正文里有这句话。
 * 判据用**调用点**（见 `scanArtifact`），这句只作为交叉验证——两个信号不一致就失败，别信单一文案。
 */
const DEBT_MARKER = 'Dynamic require of ';

const SHIM_NAMESPACE = 'spc-shim';
const STUB_NAMESPACE = 'spc-stub';

/** 内建名单（裸名与 `node:` 前缀两种写法都算）——用于把"解析不到"区分为"沙箱尚未支持"还是"依赖没装" */
const BUILTINS = new Set<string>();
for (const name of builtinModules) {
  BUILTINS.add(name);
  BUILTINS.add(`node:${name}`);
}

export interface BundleInput {
  /** 插件目录（清单与源码所在；esbuild 的 `absWorkingDir`） */
  dir: string;
  /** 入口文件（相对 `dir`，来自清单的 `entry`，缺省 `main.ts`） */
  entry: string;
}

export interface BundleOutput {
  /** 产物源码（单文件 ESM 文本） */
  code: string;
  /** 产物字节数 */
  bytes: number;
  /** **已登记内建的使用清单**（规范名、去重升序）——写进清单供审查（§2） */
  builtins: string[];
  /**
   * 被换成"模块不可用" stub 的 specifier：它们**解析不到**且不是内建。
   * 按 Node 的行为留成运行期 `MODULE_NOT_FOUND`（于是 CJS 包的 try/catch 可选依赖照常工作，§8-5），
   * 但**要打给作者看**——"构建成功"不等于"没问题"。
   */
  stubbed: string[];
  /** esbuild 的 metafile（`facts.ts` 用它算真实闭包与逐包体积） */
  metafile: Metafile;
}

interface EsbuildMessage {
  text: string;
  location?: { file?: string; line?: number; column?: number } | null;
}

/** 把 esbuild 的报错归类成契约错误码（`logLevel: 'silent'` ⇒ 文案由我们自己给，不透传） */
function classify(err: unknown, dir: string): SpcError {
  const list = (err as { errors?: EsbuildMessage[] } | null)?.errors;
  if (!Array.isArray(list) || list.length === 0) {
    return new SpcError('BUILD_FAILED', {
      reason: 'esbuild',
      detail: String((err as Error | null)?.message ?? err).slice(0, 300),
    });
  }
  const where = (m: EsbuildMessage): string => {
    const file = m.location?.file;
    if (!file) return '-'; // 占位符必须**总有值**：`t()` 不会擦掉没提供的 `{x}`，缺了就会印出字面量
    // ⚠️ esbuild 给的文件名是**相对 `absWorkingDir`** 的（实测），只有少数情形才是绝对路径 ⇒ 别无条件 relative()，
    // 那会把相对路径按**进程 cwd** 再解析一次，指到仓库里去
    const rel = isAbsolute(file) ? relative(dir, file) : file;
    // 作者看自己的树：相对插件目录，不出现别人机器上的绝对路径
    return `${rel.split('\\').join('/')}:${m.location?.line ?? '?'}`;
  };
  for (const m of list) {
    if (m.text.startsWith(UNSUPPORTED_PREFIX)) {
      return new SpcError('BUILD_BUILTIN_UNSUPPORTED', {
        specifier: m.text.slice(UNSUPPORTED_PREFIX.length).trim(),
        where: where(m),
      });
    }
    if (/No loader is configured for "\.node"/.test(m.text)) {
      return new SpcError('BUILD_NATIVE_MODULE', { where: where(m) });
    }
    const unresolved = /Could not resolve "([^"]+)"/.exec(m.text);
    if (unresolved) {
      const spec = unresolved[1];
      return BUILTINS.has(spec)
        ? new SpcError('BUILD_BUILTIN_UNSUPPORTED', { specifier: spec, where: where(m) })
        : new SpcError('BUILD_DEP_UNRESOLVED', { specifier: spec, where: where(m) });
    }
  }
  return new SpcError('BUILD_FAILED', { reason: 'esbuild', detail: list[0].text.slice(0, 300) });
}

/** 入口必须是**文件**（目录也叫"存在"，但那不是入口） */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 读仿真源码（登记表说登记了却没有文件 = 仓库自己的 bug，按 BUILD_FAILED 报，别甩锅给作者） */
function shimSource(canonical: string): string {
  const file = join(SHIM_DIR, shimFileName(canonical));
  if (!existsSync(file)) {
    throw new SpcError('BUILD_FAILED', { reason: 'shim-missing', detail: shimFileName(canonical) });
  }
  return readFileSync(file, 'utf8');
}

/**
 * 第一道闸 + 可选 stub。
 *
 * `stubs` 是**第一遍**扫出来的"解析不到的非内建 specifier"：第二遍把它们换成抛 `MODULE_NOT_FOUND` 的模块
 * （`docs/build-layer-design.md` §9-1 的 (a) 方案：用 esbuild 自己的解析结果，不另做一套可解析性判定）。
 */
function gates(opts: { stubs: string[]; builtins: Set<string> }): Plugin {
  const stubSet = new Set(opts.stubs);
  return {
    name: 'spc-gates',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === HOST_API) return { path: args.path, external: true };
        const canonical = normalizeSpecifier(args.path);
        if (sandboxModule(args.path)) {
          opts.builtins.add(canonical);
          // 走 namespace + onLoad 而不是直接给文件路径：`resolveDir` 让 shim 之间的相对 import（`./node-buffer.js`）
          // 按**仿真目录**解析（同 `tools/smoke/dep-smoke.mts` 的既有做法）
          return { path: canonical, namespace: SHIM_NAMESPACE };
        }
        if (stubSet.has(args.path)) return { path: args.path, namespace: STUB_NAMESPACE };
        if (BUILTINS.has(canonical)) return { errors: [{ text: `${UNSUPPORTED_PREFIX}${args.path}` }] };
        return undefined; // 第三方包：正常解析 + 内联
      });
      b.onLoad({ filter: /.*/, namespace: SHIM_NAMESPACE }, (args) => ({
        contents: shimSource(args.path),
        loader: 'js',
        resolveDir: SHIM_DIR,
      }));
      b.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, (args) => ({
        // 与 Node 一致：**取用时**才炸，且码是 MODULE_NOT_FOUND（CJS 包的 try/catch 因此照常工作）
        contents: `const e = new Error("Cannot find module '${args.path}'"); e.code = 'MODULE_NOT_FOUND'; throw e;`,
        loader: 'js',
      }));
    },
  };
}

/** 第二道闸的判据（实测见产物形态：**定义**的参数为空、**调用点**的参数非空） */
export function scanArtifact(code: string): {
  /** 运行期 require 的**调用点**（欠条） */
  calls: string[];
  /** 其中参数是字面量的那些 specifier */
  literals: string[];
  /** 非字面量调用的**表达式**（`require(变量)`：stub 不了，直接失败） */
  dynamicArgs: string[];
  /** 是否存在非字面量调用 */
  dynamic: boolean;
  /** esbuild 兜底 helper 的文案是否出现（第二信号，与调用点交叉验证） */
  marker: boolean;
} {
  const calls = [...code.matchAll(/__require\s*\(([^)]*)\)/g)]
    .map((m) => m[1].trim())
    .filter((arg) => arg.length > 0); // ← 定义是 `function __require() {`（参数为空），只有调用点才有参数
  const literal = (arg: string): boolean => /^["'][^"']*["']$/.test(arg);
  const dynamicArgs = calls.filter((a) => !literal(a));
  return {
    calls,
    literals: calls.filter(literal).map((a) => a.slice(1, -1)),
    dynamicArgs,
    dynamic: dynamicArgs.length > 0,
    marker: code.includes(DEBT_MARKER),
  };
}

/** 打一份插件源码（两遍：先看有没有欠条，有就带 stub 重建） */
export async function bundlePlugin(input: BundleInput): Promise<BundleOutput> {
  const entryPath = join(input.dir, input.entry);
  // 入口必须是**文件**（目录也叫"存在"，但那不是入口）
  if (!isFile(entryPath)) throw new SpcError('BUILD_ENTRY_MISSING', { entry: input.entry });

  const builtins = new Set<string>();
  const run = async (stubs: string[]): Promise<{ code: string; metafile: Metafile }> => {
    const result = await build({
      entryPoints: [entryPath],
      bundle: true,
      format: 'esm', // ESM-only 硬约束（ADR-005 §4）
      platform: 'node', // ★ 安全决策而非风格：只有它把"引用"留在产物里，才**可扫描**（§3）
      target: 'es2022',
      write: false,
      logLevel: 'silent', // 错误自己归类成契约错误码，不透传 esbuild 文案
      absWorkingDir: input.dir,
      metafile: true,
      plugins: [gates({ stubs, builtins })],
      // ⛔ 这里**永远不出现** `loader: { '.node': … }`：见文件头第 ① 条硬约束
    });
    const out = result.outputFiles?.[0];
    if (!out) throw new SpcError('BUILD_FAILED', { reason: 'no-output' });
    return { code: out.text, metafile: result.metafile };
  };

  let first: { code: string; metafile: Metafile };
  try {
    first = await run([]);
  } catch (err) {
    throw classify(err, input.dir);
  }

  const pass1 = scanArtifact(first.code);
  // 动态 require：stub 也救不了（不知道要 stub 什么），必须失败（§8-6）
  if (pass1.dynamic) {
    throw new SpcError('BUILD_ARTIFACT_DEBT', { specifier: pass1.dynamicArgs[0].slice(0, 120) });
  }

  let final = first;
  let stubbed: string[] = [];
  if (pass1.literals.length > 0) {
    // 有字面量欠条 ⇒ 第二遍：把它们换成"模块不可用"的 stub（§9-1(a)，§8-5）
    stubbed = [...new Set(pass1.literals)].sort();
    try {
      final = await run(stubbed);
    } catch (err) {
      throw classify(err, input.dir);
    }
  }

  const pass2 = scanArtifact(final.code);
  if (pass2.dynamic) {
    throw new SpcError('BUILD_ARTIFACT_DEBT', { specifier: pass2.dynamicArgs[0].slice(0, 120) });
  }
  if (pass2.calls.length > 0) {
    throw new SpcError('BUILD_ARTIFACT_DEBT', { specifier: pass2.calls[0].slice(0, 120) });
  }
  if (pass2.marker) {
    // 走到这里调用点已经是 0：两个信号本该一致（实测：干净产物里那句文案**不出现**）。
    // 不一致说明 esbuild 换了兜底 helper 的形态 ⇒ fail-closed，别让"闸门以为干净"变成默认
    throw new SpcError('BUILD_ARTIFACT_UNEXPECTED', { detail: 'marker-without-call' });
  }

  return {
    code: final.code,
    bytes: Buffer.byteLength(final.code, 'utf8'),
    builtins: [...builtins].sort(),
    stubbed,
    metafile: final.metafile,
  };
}
