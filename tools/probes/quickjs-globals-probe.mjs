// 一次性探针：QuickJS（quickjs-emscripten）里到底有哪些全局能力——决定 util 仿真能做到哪一步
import { getQuickJS } from 'quickjs-emscripten';

const qjs = await getQuickJS();
const vm = qjs.newContext();
const code = `
const names = ['TextEncoder','TextDecoder','Proxy','Reflect','Symbol','Map','Set','WeakMap','WeakSet',
  'ArrayBuffer','SharedArrayBuffer','DataView','Promise','BigInt','structuredClone','queueMicrotask',
  'DOMException','URL','URLSearchParams','atob','btoa','performance','process','Buffer','globalThis',
  'Float16Array','BigInt64Array','AggregateError','FinalizationRegistry','WeakRef','escape','unescape'];
const out = {};
for (const n of names) out[n] = typeof globalThis[n];
// 类型化数组的方法面
out['Uint8Array.prototype.toHex'] = typeof Uint8Array.prototype.toHex;
out['Uint8Array.fromBase64'] = typeof Uint8Array.fromBase64;
out['Array.prototype.at'] = typeof Array.prototype.at;
out['Object.hasOwn'] = typeof Object.hasOwn;
out['String.prototype.replaceAll'] = typeof String.prototype.replaceAll;
out['Array.prototype.toSorted'] = typeof Array.prototype.toSorted;
out['Error.captureStackTrace'] = typeof Error.captureStackTrace;
out['Object.groupBy'] = typeof Object.groupBy;
// Proxy 可用性实测（不只是 typeof）
try { const p = new Proxy({}, { get: () => 42 }); out['proxyWorks'] = p.anything; } catch (e) { out['proxyWorks'] = 'THROW:' + e.message; }
// 判断"是不是 Proxy"有没有可用的判据
try {
  const p = new Proxy({}, {});
  out['proxyToString'] = Object.prototype.toString.call(p);
  out['proxyIsArray'] = Array.isArray(p);
} catch (e) { out['proxyToString'] = 'THROW'; }
out['toStringTagCall'] = Object.prototype.toString.call(new Map());
out['genToString'] = Object.prototype.toString.call((function*(){})());
out['argsToString'] = Object.prototype.toString.call((function(){ return arguments; })());
out['symKeyOfPolyfill'] = typeof Symbol.keyFor;
out['hasOwnSymbol'] = typeof Symbol.for;
out['globalThis.__host'] = typeof globalThis.__host;
JSON.stringify(out);
`;
const res = vm.evalCode(code);
if (res.error) {
  console.log('EVAL ERROR', JSON.stringify(vm.dump(res.error)));
} else {
  console.log(JSON.stringify(JSON.parse(vm.dump(res.value)), null, 1));
}
vm.dispose();
