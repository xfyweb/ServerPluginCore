import { isSuccess, newQuickJSAsyncWASMModule, Scope } from 'quickjs-emscripten';
import { audit, digest } from './audit';
import { checkPermission } from './permissions/check';
import { registry, type Tier } from './permissions/registry';

export interface Sandbox {
  runModule(name: string, source: string): Promise<void>;
  dispose(): void;
}

/** 宿主方法：声明所需权限点 + 实现（权限检查在宿主侧强制，D3） */
export interface HostMethod {
  permission: string;
  fn: (...args: string[]) => unknown;
}
export type HostApi = Record<string, HostMethod>;

/** 插件沙箱上下文（来自 manifest + 档位） */
export interface SandboxOptions {
  pluginId: string;
  /** manifest.permissions 提取的权限请求 */
  permissions: string[];
  tier: Tier;
}

/** 生成 @host/api 模块源码：按方法组分组导出（fs.write → fs = { write }） */
function buildModuleSource(apiKeys: string[]): string {
  const groups = new Map<string, string[]>();
  for (const key of apiKeys) {
    const idx = key.indexOf('.');
    const g = idx === -1 ? key : key.slice(0, idx);
    const prop = idx === -1 ? key : key.slice(idx + 1);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(`  ${prop}: globalThis.__host[${JSON.stringify(key)}]`);
  }
  return [...groups.entries()]
    .map(([g, props]) => `export const ${g} = {\n${props.join(',\n')}\n};`)
    .join('\n\n');
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
    if (moduleName !== '@host/api') {
      throw new Error(`[sandbox] module not allowed: ${moduleName}`);
    }
    return buildModuleSource(Object.keys(api));
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

        // ① 权限判定（宿主侧强制 + 审计）
        const check = checkPermission(registry, method.permission, options.permissions, options.tier);
        if (check.decision === 'deny') {
          audit({
            ts: Date.now(),
            pluginId: options.pluginId,
            method: name,
            paramsDigest: digest(JSON.stringify(strings)),
            result: 'denied',
            permission: check,
            durationMs: Date.now() - start,
          });
          // 注意：API 是 vm.throw（@experimental），不存在 throwError
          vm.throw(new Error(`PERMISSION_DENIED: ${method.permission}`));
          return vm.undefined;
        }

        // ② 执行宿主实现
        try {
          const result = method.fn(...strings);
          audit({
            ts: Date.now(),
            pluginId: options.pluginId,
            method: name,
            paramsDigest: digest(JSON.stringify(strings)),
            result: 'ok',
            permission: check,
            durationMs: Date.now() - start,
          });
          return vm.newString(JSON.stringify(result ?? null));
        } catch (err) {
          audit({
            ts: Date.now(),
            pluginId: options.pluginId,
            method: name,
            paramsDigest: digest(JSON.stringify(strings)),
            result: 'error',
            permission: check,
            durationMs: Date.now() - start,
          });
          vm.throw(err instanceof Error ? err : new Error(String(err)));
          return vm.undefined;
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
    async runModule(_name: string, source: string) {
      // import 语句自动走 setModuleLoader；evalCodeAsync 返回 SuccessOrFail<QuickJSHandle>
      const result = await vm.evalCodeAsync(source);
      if (isSuccess(result)) {
        result.value.dispose();
      }
    },
    dispose() {
      scope.dispose(); // 先释放宿主侧 handle
      vm.dispose();
      runtime.dispose();
    },
  };
}
