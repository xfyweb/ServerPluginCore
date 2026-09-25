// 沙箱**引导层**：宿主可用、插件不可见的内部函数（跑在 VM 里，不是宿主代码）。
//
// ⚠️ 这是 **guest 代码**：由 `core/sandbox.ts` 读成字符串、在 QuickJS 里求值一次（早于任何插件代码）。
//   它**不进 tsc**（不在宿主 TS 图里），改它必须跑真沙箱用例（`core/__tests__/sandbox.test.ts` 等）。
//
// 为什么是独立文件而不是宿主里的模板字面量（2026-09-25 抽出来的）：
//   ① 可评审/可高亮（与 `sandbox-modules/host-api.js`、27 个 `node-*.js` shim 同一个理由）；
//   ② **根除"模板字面量里写反引号"那一类 bug** —— 注释里一个反引号就会提前终止宿主那个字面量、
//      而报错指向别处（这个坑本仓库踩过 5 次，最近一次就是在本文件里）。
//
// 装了哪些东西：`__spcMakeCtx` / `__spcInvoke` / `__spcInvokeEndpoint` / `__spcTimerInvoke` /
// `__spcDisposeHooks` + `queueMicrotask` 兜底；**为什么这么设计**写在 `core/sandbox.ts` 的调用处注释里。

(function () {
  function freeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      var keys = Object.keys(o);
      for (var i = 0; i < keys.length; i++) freeze(o[keys[i]]);
    }
    return o;
  }
  globalThis.__spcMakeCtx = function (factsJson, logger) {
    var facts = JSON.parse(factsJson);
    facts.logger = logger;
    return freeze(facts);
  };
  globalThis.__spcInvoke = function (fn, ctx) {
    var state = { status: 'scheduled', error: null };
    // ⚠️ 插件钩子必须在**一个 job 里**被调起，**不能**在这里同步调 fn(ctx)。
    // 为什么（实测换来的）：宿主方法声明 async 时，guest 那次调用会在 asyncify 里**挂起**
    // （宿主 Promise 没落地 ⇒ WASM 栈 unwind）。而"驱动挂起"的 rewind 只有 MaybeAsync 那条入口
    // （executePendingJobsAsync）做得来：同步入口（QTS_Call，宿主调 vm.callFunction 走的就是它）
    // 下，unwind 会把宿主与 guest 的同步关系**打断**——宿主拿到的是已 unwind 的返回值（不是这次调用的
    // 结果），而 guest 稍后在微任务里自己跑完，两边对不上账。实测现象：钩子拿不到值、状态停在 async，
    // 且 dispose 时命中 QuickJS 的 GC 断言（JS_FreeRuntime 的 assert(list_empty(&rt->gc_obj_list))）Abort。
    // 放进 job 之后，一切都发生在**泵**的那一次 executePendingJobsAsync() 里 —— 挂起、rewind、
    // 续体都归它管。所以泵也必须用异步那条（core/plugin/limits.ts 的 pumpJobsAsync）。
    Promise.resolve().then(function () {
      try {
        var r = fn(ctx);
        if (r && typeof r.then === 'function') {
          state.status = 'async';
          r.then(
            function () { state.status = 'done'; },
            function (e) { state.status = 'error'; state.error = e === undefined ? { message: 'rejected' } : e; }
          );
        } else {
          state.status = 'done';
        }
      } catch (e) {
        state.status = 'error';
        state.error = e === undefined ? { message: 'thrown' } : e;
      }
    });
    return state;
  };
  // 端点处理器（跨插件调用的被调方）与钩子共用同一套"排进 job + 归一化状态"，多两件事：
  //   ① **要能把返回值带出来**（钩子不需要）—— 只接受字符串（JSON 文本），别的类型当场报错，
  //      因为桥只能过字符串，静默 JSON 化一个对象会让调用方拿到它没预期的形状；
  //   ② 参数是 (ctx, paramsJson, bytes)，bytes 以 Uint8Array 交出（宿主给的是 ArrayBuffer）。
  // 同样必须排在 job 里：处理器里 await 宿主方法会挂起（理由见上面 __spcInvoke 的注释）。
  globalThis.__spcInvokeEndpoint = function (fn, ctx, paramsJson, bytesAb) {
    var state = { status: 'scheduled', error: null, value: undefined };
    Promise.resolve().then(function () {
      function done(r) {
        if (r === undefined || r === null) { state.value = 'null'; state.status = 'done'; return; }
        if (typeof r !== 'string') {
          // 报错文案说清"发生了什么"：处理器返回了什么类型、契约要求什么。
          // 带上 code/params 是为了让宿主侧归类成 **PLUGIN_CALL_BAD_RESULT**（与"返回的不是合法 JSON"
          // 同一个码、reason 不同）—— 否则它会退化成一个笼统的 PLUGIN_CALL_FAILED，作者查不出原因。
          // ⚠️ 本函数体是**模板字面量**：注释与字符串里都不许出现反引号（会提前终止它，报错还指向别处）。
          var e = new Error('endpoint handler must return a JSON string (got ' + (typeof r) + ')');
          e.code = 'PLUGIN_CALL_BAD_RESULT';
          e.params = { reason: 'result-not-text' };
          throw e;
        }
        state.value = r;
        state.status = 'done';
      }
      try {
        var r = fn(ctx, paramsJson, bytesAb === undefined || bytesAb === null ? undefined : new Uint8Array(bytesAb));
        if (r && typeof r.then === 'function') {
          state.status = 'async';
          r.then(done, function (e) { state.status = 'error'; state.error = e === undefined ? { message: 'rejected' } : e; });
        } else {
          done(r);
        }
      } catch (e) {
        state.status = 'error';
        state.error = e === undefined ? { message: 'thrown' } : e;
      }
    });
    return state;
  };
  // 定时器回调注册表由**引导层**拥有（@host/api 只往里登记）。
  // 为什么不在模块里定义 __spcTimerInvoke：模块是 runModule 时才求值的，而宿主在
  // createSandbox 时就要抓住这个函数句柄——那时模块还不存在，抓到的会是 undefined。
  globalThis.__spcTimerCallbacks = new Map();
  globalThis.__spcTimerInvoke = function (id, ctx) {
    var fn = globalThis.__spcTimerCallbacks.get(String(id));
    if (typeof fn !== 'function') {
      return { status: 'error', error: { message: 'TIMER_HANDLER_MISSING' } };
    }
    return globalThis.__spcInvoke(fn, ctx);
  };
  // 卸载钩子：仿真模块在**沙箱销毁前**登记清理动作（目前只有 node:process 用它发 'exit'）。
  // 放在引导层而不是模块里：宿主 dispose() 时要能在 VM 还活着的时候调用它。
  globalThis.__spcDisposeHooks = [];
  globalThis.__spcRunDisposeHooks = function () {
    var hooks = globalThis.__spcDisposeHooks;
    globalThis.__spcDisposeHooks = [];
    for (var i = 0; i < hooks.length; i++) {
      try { hooks[i](); } catch (e) { /* 清理失败不影响释放流程 */ }
    }
  };
  // QuickJS **没有** queueMicrotask（实测：TextEncoder/TextDecoder/queueMicrotask/structuredClone 全无，
  // 见 tools/probes/quickjs-globals-probe.mjs），而仿真模块要用它（process.nextTick、events 的 rejection 路由）。
  // 补的是**标准全局**，不是能力——它只能把回调推迟到微任务，拿不到任何宿主资源。
  // 为什么必须在引导层补而不是各 shim 自己写：shim 是会被构建层内联进插件产物的静态文件，
  // 它们跑在沙箱里，必须能假定这个标准全局存在。
  if (typeof globalThis.queueMicrotask !== 'function') {
    globalThis.queueMicrotask = function (fn) {
      Promise.resolve().then(fn);
    };
  }
  // setImmediate：**壳子**——用微任务实现，语义差一档（见设计 §9.2）。
  // 为什么还是要有：真实依赖在**模块顶层**就用它起步（@nodelib/fs.walk/out/readers/async.js:26，
  // fast-glob 的流式/异步读目录都走它）⇒ 不补就是"整个包装载失败"。
  // 为什么只给微任务：真正"下一轮宏任务"的语义要么靠宿主定时器（那是一个**能力点**：
  // 插件能主动占用宿主调度 ⇒ 要权限 + 上限 + 审计），要么靠 QuickJS 的 job 队列
  // （我们已经在用，但那是"微任务"）。微任务版对"把起步推迟一拍"的用法完全够，且与
  // process.nextTick（同样是微任务）保持同源。**不提供 setTimeout**：那才是真正的宏任务能力面。
  var immediateSeq = 0;
  var cancelledImmediates = new Set();
  if (typeof globalThis.setImmediate !== 'function') {
    globalThis.setImmediate = function (fn) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (typeof fn !== 'function') {
        throw new TypeError('The "callback" argument must be of type function');
      }
      var id = ++immediateSeq;
      queueMicrotask(function () {
        if (cancelledImmediates.has(id)) return; // 真的尊重 clearImmediate，不做假壳子
        fn.apply(null, args);
      });
      return {
        _id: id,
        ref: function () { return this; },
        unref: function () { return this; },
        hasRef: function () { return true; },
        refresh: function () { return this; },
      };
    };
    globalThis.clearImmediate = function (handle) {
      if (handle && typeof handle === 'object' && typeof handle._id === 'number') {
        cancelledImmediates.add(handle._id);
      }
    };
  }
})();
