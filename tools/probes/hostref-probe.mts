// 验证 v2：HostRef 的身份语义 + 生命周期（用 Scope 管句柄，避免 FreeRuntime 断言）
// 用法（从仓库根）：node node_modules/tsx/dist/cli.mjs tools/probes/hostref-probe.mts
import { newQuickJSAsyncWASMModule, Scope } from 'quickjs-emscripten';

const mod = await newQuickJSAsyncWASMModule();
const rt = mod.newRuntime();
const vm = rt.newContext();
const scope = new Scope();

/** 宿主侧"真对象"表：模拟 crypto.Hash 这类有状态对象（key = HostRef id） */
const hostObjects = new Map<number, any>();
/** 宿主必须持有 HostRef 实例，才能在收尾时 dispose（证明"句柄生命周期"是真的要管） */
const refs: any[] = [];

const mkHash = (alg: string) => ({
  alg,
  chunks: 0,
  bytes: 0,
  update(b: Uint8Array) {
    this.chunks += 1;
    this.bytes += b.byteLength;
    return this; // 链式
  },
  digest() {
    return `${this.alg}:${this.chunks}chunks/${this.bytes}B`;
  },
});

const newHash = vm.newFunction('newHash', (algHandle) => {
  const alg = vm.getString(algHandle);
  const ref = vm.newHostRef(mkHash(alg));
  refs.push(ref);
  hostObjects.set(ref.id, ref.value);
  return ref.handle;
});
vm.setProp(vm.global, '__newHash', scope.manage(newHash));

const hashUpdate = vm.newFunction('hashUpdate', (refHandle, bytesHandle) => {
  const ref = vm.toHostRef(refHandle);
  if (ref === undefined) return vm.newString('NOT-A-HOSTREF');
  const bytes = vm.getArrayBuffer(bytesHandle, { mode: 'copy' });
  const value = ref.value as any;
  // 关键：宿主拿到的**就是**当初那个对象（身份没丢）
  const same = hostObjects.get(ref.id) === value;
  const out = value.update(new Uint8Array(bytes.value));
  bytes.dispose();
  return vm.newString(`${same ? 'same' : 'DIFFERENT'}:${out.chunks}`);
});
vm.setProp(vm.global, '__hashUpdate', scope.manage(hashUpdate));

const hashDigest = vm.newFunction('hashDigest', (refHandle) => {
  const ref = vm.toHostRef(refHandle);
  return vm.newString(ref === undefined ? 'NOT-A-HOSTREF' : (ref.value as any).digest());
});
vm.setProp(vm.global, '__hashDigest', scope.manage(hashDigest));

const res = vm.evalCode(`
  const a = __newHash('sha256');
  const b = __newHash('md5');
  const identity = (a === a) && (a !== b);          // 沙箱里的身份
  const u1 = __hashUpdate(a, new Uint8Array([1,2,3]).buffer);
  const u2 = __hashUpdate(a, new Uint8Array([4,5]).buffer);   // 同一次 hash 的第二次 update
  const u3 = __hashUpdate(b, new Uint8Array([9]).buffer);     // 另一个对象，互不串味
  JSON.stringify({ identity, u1, u2, u3, da: __hashDigest(a), db: __hashDigest(b), kind: typeof a });
`);
const dumped = res.error ? { error: vm.dump(res.error) } : { value: vm.dump(res.value) };
console.log('沙箱内观察：', JSON.stringify(dumped));
console.log('宿主侧对象表：', JSON.stringify([...hostObjects.entries()].map(([id, o]) => [id, o.digest()])));
console.log('宿主持有的 HostRef 实例数：', refs.length, '（收尾要逐个 dispose，否则 FreeRuntime 断言）');

if (res.value) res.value.dispose();
if (res.error) res.error.dispose();
for (const r of refs) r.dispose();
scope.dispose();
vm.dispose();
rt.dispose();
console.log('✓ 干净收尾（没有 FreeRuntime 断言）');
