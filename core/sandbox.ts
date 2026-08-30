import { isSuccess, newQuickJSAsyncWASMModule, Scope } from 'quickjs-emscripten';

export interface Sandbox {
  runModule(name: string, source: string): Promise<void>;
  dispose(): void;
}

export async function createSandbox(api: Record<string, unknown>): Promise<Sandbox> {
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
    // 生成 @host/api 模块源码：把宿主方法暴露为具名导出
    return Object.keys(api)
      .map((k) => `export const ${k.replace(/[^A-Za-z0-9_$]/g, '_')} = globalThis.__host[${JSON.stringify(k)}];`)
      .join('\n');
  });

  const vm = runtime.newContext();
  const scope = new Scope(); // 统一管理宿主侧创建的 handle，dispose 时按序释放

  // 注入 __host 全局（宿主调用桥：沙箱内唯一的能力来源）
  const hostObj = scope.manage(vm.newObject());
  for (const [name, fn] of Object.entries(api)) {
    const wrapped = scope.manage(
      vm.newFunction(`host.${name}`, (...args) => {
        try {
          const result = (fn as (...a: unknown[]) => unknown)(
            ...args.map((h) => vm.getString(h)), // spike：仅处理字符串参数
          );
          return vm.newString(JSON.stringify(result ?? null));
        } catch (err) {
          vm.throwError(err instanceof Error ? err.message : String(err));
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
