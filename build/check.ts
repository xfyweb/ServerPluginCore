// `spcdev check`：**不打包**的静态自检（docs/build-layer-design.md §10.5）
//
// 定位：秒级反馈，给编辑器 / CI / 作者自己用。它**不是权威** —— 权威是 `spcdev build` 的两道闸
// （解析期重定向 + 产物断言）与运行期判定。所以凡是静态判不出的，这里一律报 `info` 并写明边界，
// 绝不假装能替它们下结论：
//   · **路径决定的档位**（`fs.read.data` 还是 `fs.read.host` 取决于运行期路径）⇒ 只对到**权限点族**；
//   · `exec.template.*` / `plugins.call.*` / `events.subscribe.*` ⇒ 运行期按模板 / 清单声明 / 管理员授权判；
//   · 依赖闭包能否内联（CJS、可选依赖、动态 require）⇒ `build` 说了算，这里只做"解析得到吗"的粗判。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { isRegistered } from '../core/sandbox-modules/registry';
import { registry } from '../core/permissions/registry';
import { validateManifest } from '../sdk/validate';
import type { Manifest } from '../sdk/types';
import { loadApiMap, pointFamily, pointForMethod } from './apimap';
import { findWorkspaceDir } from './workspace';

export type FindingLevel = 'error' | 'warn' | 'info';

export interface Finding {
  level: FindingLevel;
  /** 机器可读码（CLI 按 `check.<code>` 渲染本地化文案） */
  code: string;
  params: Record<string, string>;
}

export interface CheckResult {
  dir: string;
  ok: boolean;
  findings: Finding[];
  /** 统计（CLI 打印一行摘要用） */
  summary: { files: number; declared: number; inferred: number };
}

/** 扫描时跳过的目录：依赖、产物、版本库、工作区（都不是"作者的源码"） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.spcdev']);
const SOURCE_EXT = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
const BUILTIN_SET = new Set(builtinModules);

const DYNAMIC_PREFIXES = ['exec.template.', 'plugins.call.', 'events.subscribe.'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
      continue;
    }
    if (SOURCE_EXT.some((ext) => entry.name.endsWith(ext))) out.push(join(dir, entry.name));
  }
  return out;
}

interface ScannedImports {
  /** `@host/api` 的成员用法：`fs.write` 这样的方法名（去重、已排序） */
  methods: Set<string>;
  /** 所有 import 的 specifier（去重） */
  specifiers: Set<string>;
  /** 相对导入（本插件内的文件）——不参与"第三方可解析性"判定 */
  localSpecifiers: Set<string>;
}

/** 扫一个文件的 import 面与 `@host/api` 成员用法（正则级：够用且快；权威仍看 `build`） */
function scanFile(file: string, acc: ScannedImports): void {
  const src = readFileSync(file, 'utf8');
  const specifiers = [...src.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of specifiers) {
    acc.specifiers.add(spec);
    if (spec.startsWith('.')) acc.localSpecifiers.add(spec);
  }

  // `import { fs, kv as store } from '@host/api'` —— 记下**本文件里的别名 → 原始组名**
  const groups = new Map<string, string>();
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@host\/api['"]/g)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      if (part === '') continue;
      const [name, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
      groups.set(alias ?? name, name);
    }
  }
  // 成员用法：`<别名>.<方法名>`；`fs['write']` 这类写法静态看不到（归入"判不出"）
  for (const [alias, group] of groups) {
    const re = new RegExp(`\\b${alias}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
    for (const m of src.matchAll(re)) acc.methods.add(`${group}.${m[1]}`);
  }
}

/** 该 specifier 是不是 Node 内建（`node:x` 或裸名内建） */
function isBuiltinSpecifier(spec: string): boolean {
  return spec.startsWith('node:') || BUILTIN_SET.has(spec);
}

/**
 * 检查一支插件目录。
 * @param dir 插件目录（含 `manifest.json`）
 */
export function checkPlugin(dir: string): CheckResult {
  const findings: Finding[] = [];
  const push = (level: FindingLevel, code: string, params: Record<string, string> = {}): void => {
    findings.push({ level, code, params });
  };

  // ① 清单
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    push('error', 'MANIFEST_MISSING', { file: manifestPath });
    return { dir, ok: false, findings, summary: { files: 0, declared: 0, inferred: 0 } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    push('error', 'MANIFEST_MALFORMED', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return { dir, ok: false, findings, summary: { files: 0, declared: 0, inferred: 0 } };
  }
  const validated = validateManifest(raw);
  if (!validated.ok) {
    for (const detail of validated.errors) push('error', 'MANIFEST_INVALID', { detail });
    return { dir, ok: false, findings, summary: { files: 0, declared: 0, inferred: 0 } };
  }
  const manifest = raw as Manifest;
  if (manifest.type === 'driver' || manifest.type === 'hook') {
    // 类型本身合法（构建器照做），但这版核心装不进来 —— 提示一句，别让作者白忙
    push('warn', 'TYPE_NOT_LOADABLE', { type: String(manifest.type) });
  }

  // ② 入口
  const entry = typeof manifest.entry === 'string' && manifest.entry !== '' ? manifest.entry : 'main.ts';
  if (!existsSync(join(dir, entry))) push('error', 'ENTRY_MISSING', { entry });

  // ③ 源码扫描（入口 + 同目录下的其它源码文件 —— 助手模块里的用法也要算）
  const files = walk(dir);
  const scanned: ScannedImports = { methods: new Set(), specifiers: new Set(), localSpecifiers: new Set() };
  for (const file of files) {
    try {
      scanFile(file, scanned);
    } catch (err) {
      push('warn', 'SOURCE_UNREADABLE', {
        file: relative(dir, file).split(sep).join('/'),
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ④ 权限点：清单里声明的分三类 —— 冻结表里存在的 / 动态族（判不出）/ 查不到的（错）
  const declared = (manifest.permissions ?? []).map((p) => p.name);
  const declaredStatic: string[] = [];
  for (const point of declared) {
    if (DYNAMIC_PREFIXES.some((prefix) => point.startsWith(prefix))) {
      push('info', 'POINT_DYNAMIC', { point });
      continue;
    }
    if (!registry.get(point)) {
      push('error', 'POINT_UNKNOWN', { point });
      continue;
    }
    declaredStatic.push(point);
  }

  // ⑤ 权限点对账（两向都报；只在**族**这一层比，见文件头）
  const map = loadApiMap();
  const inferred = new Set<string>();
  for (const method of [...scanned.methods].sort()) {
    const point = pointForMethod(method, map);
    if (point === undefined) {
      push('info', 'METHOD_UNMAPPED', { method });
      continue;
    }
    inferred.add(point);
  }
  const declaredFamilies = new Set(declaredStatic.map(pointFamily));
  const usedFamilies = new Set([...inferred].map(pointFamily));
  const missing = [...usedFamilies].filter((f) => !declaredFamilies.has(f)).sort();
  if (missing.length > 0) {
    push('error', 'POINT_NOT_DECLARED', {
      families: missing.join(', '),
      // 精确到方法，作者才好照着改清单
      methods: [...scanned.methods]
        .filter((m) => {
          const p = pointForMethod(m, map);
          return p !== undefined && missing.includes(pointFamily(p));
        })
        .sort()
        .join(', '),
    });
  }
  const unused = [...declaredFamilies].filter((f) => !usedFamilies.has(f)).sort();
  if (unused.length > 0) push('warn', 'POINT_UNUSED', { families: unused.join(', ') });

  // ⑥ 导入面：内建是否已仿真 / 第三方是否解析得到（解析得到的才谈"声明了没有"）
  const require = createRequire(join(dir, 'package.json'));
  const resolved = new Set<string>();
  for (const spec of [...scanned.specifiers].sort()) {
    if (scanned.localSpecifiers.has(spec)) continue;
    if (spec === '@host/api' || spec === '@spc/sdk') continue;
    if (isBuiltinSpecifier(spec)) {
      if (!isRegistered(spec)) push('error', 'BUILTIN_NOT_EMULATED', { spec });
      continue;
    }
    try {
      require.resolve(spec);
      resolved.add(spec);
    } catch {
      push('error', 'DEPENDENCY_UNRESOLVED', { spec });
    }
  }
  const declaredNpm = new Set((manifest.dependencies?.npm ?? []).map((d) => d.name));
  for (const spec of [...resolved].sort()) {
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!declaredNpm.has(pkg) && !declaredNpm.has(spec)) push('warn', 'NPM_NOT_DECLARED', { spec, pkg });
  }

  // ⑦ 工作区：没有 `.spcdev/` ⇒ `build` / `pack` 还没法签名（不是错误，只是下一步该敲什么）
  if (findWorkspaceDir(dir) === undefined) push('info', 'WORKSPACE_MISSING', { dir });

  return {
    dir,
    ok: findings.every((f) => f.level !== 'error'),
    findings,
    summary: { files: files.length, declared: declared.length, inferred: inferred.size },
  };
}
