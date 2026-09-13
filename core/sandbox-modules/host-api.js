// @host/api 模块源码（沙箱内注入的模块正文）
//
// 为什么是"真实文件 + 占位符"而不是 TypeScript 里拼模板串：
//   1) QuickJS 的模块加载器只接受**源码文本**（quickjs-emscripten 把返回值转成 C 字符串指针，
//      不暴露字节码 / JSModuleDef 级接口），所以"生成"这一步无法避免；
//   2) 但生成的部分可以只剩**导出清单**——本文件的逻辑全部静态可评审、可高亮、可单测；
//   3) 下一阶段的官方模块仿真（node:fs / node:path / …）延用同一模式：一个模块一个真实文件，
//      注册进 core/sandbox.ts 的模块白名单。
//
// 生成方式：core/sandbox.ts 读取本文件，把下方 __SPC_EXPORTS__ 标记替换成实际导出语句。
// 运行环境约束：QuickJS 纯 ES2020 语义——**没有 Node API、没有 require、没有 process**。

/**
 * 桥契约（参数）：允许插件按原生写法传数组/对象——非字符串参数在这里序列化成
 * `__spcJson:<JSON>` 再交给宿主（宿主侧用 core/exec/request.ts 的 decodeBridgeArg 还原）。
 * 字符串原样传递，因此既有调用完全不受影响。
 */
const __JSON_PREFIX = '__spcJson:';
const __marshal = (a) => (typeof a === 'string' ? a : __JSON_PREFIX + JSON.stringify(a === undefined ? null : a));

/**
 * 宿主桥把失败以"回执单"形式回传（JSON 文本 {__spcError:{code,params}}），
 * 这里翻译成带 code / params 的异常抛给插件。
 * 为什么不用 vm.throw：asyncify 模式下宿主函数抛出的异常会随正常返回值被吞掉
 * （@experimental 路径不可靠），所以错误一律走"返回值 + 沙箱内还原"。
 */
const __wrap = (fn) => (...args) => {
  const raw = fn(...args.map(__marshal));
  if (typeof raw === 'string' && raw.indexOf('__spcError') !== -1) {
    let env = null;
    try {
      env = JSON.parse(raw);
    } catch {
      return raw; // 不是信封（普通字符串结果），原样返回
    }
    if (env && env.__spcError) {
      const err = new Error(env.__spcError.code);
      err.code = env.__spcError.code;
      if (env.__spcError.params) err.params = env.__spcError.params;
      throw err;
    }
  }
  return raw;
};

// __SPC_EXPORTS__
