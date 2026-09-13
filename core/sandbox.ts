import { readFileSync } from 'node:fs';
import { isSuccess, newQuickJSAsyncWASMModule, Scope } from 'quickjs-emscripten';
import { audit, digest, digestParams } from './audit';
import { SpcError, toErrorShape } from './errors';
import { checkPermission } from './permissions/check';
import { registry } from './permissions/registry';

export interface Sandbox {
  runModule(name: string, source: string): Promise<void>;
  dispose(): void;
}

/**
 * @host/api 的模块正文来自真实文件（可评审 / 可高亮 / 可单测），运行时只生成导出清单。
 * 下一阶段的官方模块仿真（node:fs / node:path / …）延用同一模式：一个模块一个文件 + 白名单登记。
 * 打包注意（P5 自包含 bundle）：该文件需随包分发（或构建期以 text loader 内联），
 * 否则运行时会因读不到文件而启动失败。
 */
const HOST_API_SOURCE = readFileSync(new URL('./sandbox-modules/host-api.js', import.meta.url), 'utf8');
const EXPORTS_MARKER = '// __SPC_EXPORTS__';

/**
 * 宿主错误信封：宿主桥**不**用 `vm.throw`（asyncify 下宿主函数抛出的异常会随正常返回值被吞掉，
 * @experimental 路径不可靠），而是把错误当作返回值回传；模块包装层在沙箱内还原成
 * 带 `code` / `params` 的 `Error`。插件因此总能按英文码分支：
 *   catch (e) { if (e.code === 'SYMLINK_DANGLING') { … } }
 */
const HOST_ERROR_KEY = '__spcError';

function hostErrorPayload(code: string, params?: Record<string, string>): string {
  return JSON.stringify({
    [HOST_ERROR_KEY]: params && Object.keys(params).length > 0 ? { code, params } : { code },
  });
}

/** 宿主方法：声明所需权限点 + 实现（权限检查在宿主侧强制，D3） */
export interface HostMethod {
  /** 静态权限点 */
  permission?: string;
  /** 动态解析本次调用所需的权限点（如 exec.run 按模板 ID 解析）；返回 null 表示目标非法 */
  permissionFor?: (args: string[]) => string | null;
  fn: (...args: string[]) => unknown;
}
export type HostApi = Record<string, HostMethod>;

/** 插件沙箱上下文（来自 manifest 声明 + 安装记录的授予） */
export interface SandboxOptions {
  pluginId: string;
  /** manifest.permissions 提取的权限请求（可含通配） */
  permissions: string[];
  /** 管理员逐点授予的权限点（精确；宿主侧唯一真相，见 plugin-signature-design.md §9） */
  grants?: string[];
}

/** 生成 @host/api 的导出清单（模块正文来自 sandbox-modules/host-api.js，按方法组分组） */
function exportLines(apiKeys: string[]): string {
  const groups = new Map<string, string[]>();
  for (const key of apiKeys) {
    const idx = key.indexOf('.');
    const g = idx === -1 ? key : key.slice(0, idx);
    const prop = idx === -1 ? key : key.slice(idx + 1);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(`  ${prop}: __wrap(globalThis.__host[${JSON.stringify(key)}])`);
  }
  return [...groups.entries()]
    .map(([g, props]) => `export const ${g} = {\n${props.join(',\n')}\n};`)
    .join('\n\n');
}

/**
 * 沙箱模块白名单：specifier → 源码。未登记一律拒绝（零环境权力的执行点）。
 * P2 官方模块仿真在此登记：`node:fs` / `node:path` / `node:events` …（各自对应一个真实文件）。
 */
function moduleSource(moduleName: string, apiKeys: string[]): string | null {
  if (moduleName === '@host/api') {
    return HOST_API_SOURCE.replace(EXPORTS_MARKER, exportLines(apiKeys));
  }
  return null;
}

export async function createSandbox(api: HostApi, options: SandboxOptions): Promise<Sandbox> {
  // asyncify 变体：宿主 API 可返回 Promise（exec/网络必须异步，见设计结论）
  // 注：quickjs-emscripten@0.32.0 的 asyncify newRuntime 释放顺序有 bug（deleteRuntime 先于
  // QTS_FreeRuntime），上游 Issue #261（justjake/quickjs-emscripten，OPEN）已确认：
  // https://github.com/justjake/quickjs-emscripten/issues/261
  // 本地通过 pnpm patch（patches/quickjs-emscripten-core.patch）修复，回归测试见
  // scripts/verify-quickjs-patch.mjs（pnpm verify:sandbox）
  const QuickJS = await newQuickJSAsyncWASMModule();
  const runtime = QuickJS.newRuntime();

  // ESM 加载器（v0.32 API）：loader 返回模块"源码字符串"
  // 白名单外模块一律拒绝——零环境权力的执行点
  runtime.setModuleLoader((moduleName: string): string => {
    const src = moduleSource(moduleName, Object.keys(api));
    if (src === null) {
      throw new Error(`[sandbox] module not allowed: ${moduleName}`);
    }
    return src;
  });

  const vm = runtime.newContext();
  const scope = new Scope(); // 统一管理宿主侧创建的 handle，dispose 时按序释放

  // 注入 __host 全局（宿主调用桥：沙箱内唯一的能力来源）
  const hostObj = scope.manage(vm.newObject());
  for (const [name, method] of Object.entries(api)) {
    const wrapped = scope.manage(
      vm.newFunction(`host.${name}`, (...args) => {
        const start = Date.now();
        const strings = args.map((h) => vm.getString(h)); // spike：仅处理字符串参数
        const callDigest = digest(JSON.stringify(strings));

        // ① 解析本次调用的权限点（动态点如 exec.run 由模板 ID / 原生写法匹配决定）
        //    解析失败（如 exec 匹配不到模板）由方法自己抛 SpcError：只做**结构匹配**，
        //    参数校验留到权限通过之后（避免未授权插件拿参数校验结果做探测）。
        let requested: string;
        try {
          const resolved = method.permissionFor ? method.permissionFor(strings) : method.permission;
          if (!resolved) throw new SpcError('PERMISSION_DENIED', { permission: '(unresolved)' });
          requested = resolved;
        } catch (err) {
          const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
          audit({
            ts: Date.now(),
            pluginId: options.pluginId,
            method: name,
            target: typeof strings[0] === 'string' ? strings[0] : undefined,
            paramsDigest: callDigest,
            result: 'denied',
            permission: { decision: 'deny', code: shape.code, paramsDigest: digestParams(shape.params) },
            durationMs: Date.now() - start,
          });
          return vm.newString(hostErrorPayload(shape.code, shape.params));
        }

        // ② 权限判定（宿主侧强制 + 审计）；判定只记码与参数摘要，不记本地化文本
        const check = checkPermission(registry, requested, options.permissions, options.grants ?? []);
        if (check.decision === 'deny') {
          audit({
            ts: Date.now(),
            pluginId: options.pluginId,
            method: name,
            target: requested,
            paramsDigest: callDigest,
            result: 'denied',
            permission: {
              decision: 'deny',
              code: check.code,
              paramsDigest: digestParams(check.params),
            },
            durationMs: Date.now() - start,
          });
          return vm.newString(
            hostErrorPayload('PERMISSION_DENIED', {
              permission: requested,
              reason: check.code,
            }),
          );
        }

        // ③ 执行宿主实现
        try {
          const result = method.fn(...strings);
          const serialized = JSON.stringify(result ?? null);
          audit({
            ts: Date.now(),
            pluginId: options.pluginId,
            method: name,
            target: requested,
            paramsDigest: callDigest,
            result: 'ok',
            permission: {
              decision: 'allow',
              code: check.code,
              paramsDigest: digestParams(check.params),
            },
            resultBytes: Buffer.byteLength(serialized),
            durationMs: Date.now() - start,
          });
          return vm.newString(serialized);
        } catch (err) {
          // 宿主错误 → 英文码 + 参数摘要入审计；插件面拿到 code/params（未分类错误记 INTERNAL）
          const shape = toErrorShape(err) ?? { code: 'INTERNAL' };
          audit({
            ts: Date.now(),
            pluginId: options.pluginId,
            method: name,
            target: requested,
            paramsDigest: callDigest,
            result: 'error',
            permission: {
              decision: 'allow',
              code: check.code,
              paramsDigest: digestParams(check.params),
            },
            error: { code: shape.code, paramsDigest: digestParams(shape.params) },
            durationMs: Date.now() - start,
          });
          return vm.newString(hostErrorPayload(shape.code, shape.params));
        }
      }),
    );
    vm.setProp(hostObj, name, wrapped);
  }
  vm.setProp(vm.global, '__host', hostObj);

  // 注入最小 console（QuickJS 沙箱默认无 console）
  const consoleObj = scope.manage(vm.newObject());
  for (const level of ['log', 'error', 'warn', 'info'] as const) {
    const fn = scope.manage(
      vm.newFunction(`console.${level}`, (...args) => {
        console[level](...args.map((h) => vm.getString(h)));
        return vm.undefined;
      }),
    );
    vm.setProp(consoleObj, level, fn);
  }
  vm.setProp(vm.global, 'console', consoleObj);

  return {
    async runModule(name: string, source: string) {
      // import 语句自动走 setModuleLoader；evalCodeAsync 返回 SuccessOrFail<QuickJSHandle>
      const started = Date.now();
      const result = await vm.evalCodeAsync(source);
      if (isSuccess(result)) {
        result.value.dispose();
        return;
      }

      // 失败：先把错误内容取出来，**再释放 handle**。
      // 漏释放会让该 JS 对象常驻，runtime 释放时命中 QuickJS 断言
      // （JS_FreeRuntime: assert(list_empty(&rt->gc_obj_list))）→ 整个进程 Aborted。
      let dumped: unknown;
      try {
        dumped = vm.dump(result.error);
      } catch {
        dumped = undefined;
      } finally {
        result.error.dispose();
      }

      const info = (dumped && typeof dumped === 'object' ? dumped : {}) as {
        code?: unknown;
        message?: unknown;
      };
      const cause = typeof info.code === 'string' ? info.code : 'PLUGIN_ERROR';
      const message = typeof info.message === 'string' ? info.message : String(dumped);

      // 判定为插件代码缺陷：终止本次加载 + 记账（是否禁用该插件由上层策略决定，核心不崩）
      audit({
        ts: Date.now(),
        pluginId: options.pluginId,
        method: 'lifecycle.load',
        paramsDigest: digest(name),
        result: 'error',
        error: { code: 'PLUGIN_LOAD_FAILED', paramsDigest: digestParams({ cause }) },
        durationMs: Date.now() - started,
      });
      throw new SpcError('PLUGIN_LOAD_FAILED', {
        pluginId: options.pluginId,
        cause,
        message,
      });
    },
    dispose() {
      scope.dispose(); // 先释放宿主侧 handle
      vm.dispose();
      runtime.dispose();
    },
  };
}
