// 桥的传输成本压力测试（二进制通道 vs 字符串通道 vs 沙箱内自算）
//
// 为什么要它：二进制通道的每一个原语都**实测过是拷贝**（不是零拷贝），
// 而我们选它的理由是"一次 memcpy 远比 base64 便宜"。这个理由必须能被量出来，
// 否则：① 无法反驳"干脆走 base64 算了"；② 以后有人把它改成逐字节/二次编码，没人发现。
//
// 用法（需要 tsx 才能 import 仓库里的 .ts）：
//   node node_modules/tsx/dist/cli.mjs tools/bridge-bench.mjs
//   node node_modules/tsx/dist/cli.mjs tools/bridge-bench.mjs --json
//
// ⚠️ 这是**取证工具**，不参与 `pnpm test`：数字随机器变化，不该当门禁。
//    要防回归请看输出末尾的"怎么守"。
import { createSandbox } from '../core/sandbox.ts';

const asJson = process.argv.includes('--json');

// 用已登记的权限点，避免为了跑分去改权限注册表。
// 直接调 `globalThis.__host[...]`（绕过 @host/api 的 __marshal）——这里要量的就是**原始桥**。
const BENCH_API = {
  'bench.ping': { permission: 'bytes.encode', fn: () => 1 },
  // 宿主 → 沙箱：n 字节（binaryResult → 走 newArrayBuffer）
  'bench.source': {
    permission: 'bytes.encode',
    binaryResult: true,
    fn: (n) => new Uint8Array(Number(n)),
  },
  // 沙箱 → 宿主：收字节，只回长度（避免把"再传回去"混进来）
  'bench.sink': { permission: 'bytes.decode', fn: (b) => (typeof b === 'string' ? -1 : b.byteLength) },
  // 宿主 → 沙箱：n 个字符的字符串（对照通道）
  'bench.text': { permission: 'bytes.decode', fn: (n) => 'x'.repeat(Number(n)) },
};

/** 每档载荷的迭代次数：小的多跑几次压噪声，大的少跑几次免得等 */
const PLAN = [
  { label: '0 B（纯调用开销）', bytes: 0, iters: 4000 },
  { label: '1 KB', bytes: 1024, iters: 2000 },
  { label: '64 KB', bytes: 64 * 1024, iters: 400 },
  { label: '1 MB', bytes: 1024 * 1024, iters: 32 },
  { label: '4 MB', bytes: 4 * 1024 * 1024, iters: 8 },
];

const MEDIAN = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function run(label, bytes, iters, body) {
  const sandbox = await createSandbox(BENCH_API, {
    pluginId: '@spc-test/bridge-bench',
    permissions: ['bytes.encode', 'bytes.decode'],
    grants: [],
  });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => void logs.push(a.map(String).join(' '));
  try {
    await sandbox.runModule(
      '@spc-test/bridge-bench',
      `
const H = globalThis.__host;
const ITERS = ${iters};
const BYTES = ${bytes};
const samples = [];
${body}
console.log(JSON.stringify(samples));
`,
    );
  } finally {
    console.log = orig;
    sandbox.dispose();
  }
  const raw = logs.join('\n').trim();
  let samples;
  try {
    samples = JSON.parse(raw);
  } catch {
    throw new Error(`${label} 收集失败：${raw.slice(0, 200)}`);
  }
  const ms = MEDIAN(samples);
  const perCallSec = ms / iters / 1000;
  const mbs = bytes > 0 ? bytes / 1024 / 1024 / perCallSec : 0;
  return { label, bytes, iters, medianMs: ms, perCallMs: ms / iters, mbPerSec: mbs };
}

const results = [];
for (const p of PLAN) {
  const n = p.bytes;
  // 每个方法单独跑一轮（各自一个沙箱），互不干扰；每轮 7 次取样后取中位
  const ping = await run(p.label, 0, p.iters, `
for (let r = 0; r < 7; r++) { const t = Date.now(); for (let i = 0; i < ITERS; i++) H['bench.ping'](); samples.push(Date.now() - t); }`);
  const binOut = await run(p.label, n, p.iters, `
for (let r = 0; r < 7; r++) { const t = Date.now(); for (let i = 0; i < ITERS; i++) H['bench.source'](String(BYTES)); samples.push(Date.now() - t); }`);
  const binIn = await run(p.label, n, p.iters, `
const ab = new Uint8Array(BYTES).buffer;   // 桥的契约：二进制参数必须是 ArrayBuffer
for (let r = 0; r < 7; r++) { const t = Date.now(); for (let i = 0; i < ITERS; i++) H['bench.sink'](ab); samples.push(Date.now() - t); }`);
  const text = await run(p.label, n, p.iters, `
for (let r = 0; r < 7; r++) { const t = Date.now(); for (let i = 0; i < ITERS; i++) H['bench.text'](String(BYTES)); samples.push(Date.now() - t); }`);
  results.push({ size: p.label, bytes: n, ping, binOut, binIn, text });
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

const per = (r) => `${r.perCallMs.toFixed(r.perCallMs >= 0.01 ? 3 : 4)} ms`;
console.log('桥的传输成本（中位数，7 轮取中位）\n');
console.log('载荷'.padEnd(18) + '调用开销'.padEnd(14) + '宿主→沙箱'.padEnd(22) + '沙箱→宿主'.padEnd(22) + '字符串通道（对照）');
console.log('-'.repeat(112));
for (const r of results) {
  const mb = (x) => (x.bytes > 0 ? ` (${x.mbPerSec.toFixed(0)} MB/s)` : '');
  console.log(
    r.size.padEnd(18) +
      per(r.ping).padEnd(14) +
      (per(r.binOut) + mb(r.binOut)).padEnd(22) +
      (per(r.binIn) + mb(r.binIn)).padEnd(22) +
      per(r.text) + mb(r.text),
  );
}
console.log('-'.repeat(112));

const big = results[results.length - 1];
console.log('\n读法：');
console.log(`  · 纯调用开销 ${per(big.ping)} —— 这是"跨界"本身的底价，与载荷无关`);
console.log(`  · 载荷越大，单次成本里"拷贝"占比越高；1 MB 的宿主→沙箱约 ${per(big.binOut)}`);
console.log('  · **若某天这个数是毫秒级的**，说明通道被人改成了逐字节/二次编码——那是回归，不是噪声');
console.log('\n对照（前面已经量过的）：');
console.log('  · 沙箱内纯 JS 逐字节处理：≈2.6 MB/s（1 MB 循环 ≈400 ms）—— 这就是"不代工"的代价');
console.log('  · 所以二进制通道即便每次拷贝，仍比"在沙箱里自己编解码"快两个数量级');
console.log('\n怎么守（时间断言易 flaky，所以不放进 pnpm test）：');
console.log('  1. 本工具留档：数字变了要能解释（换机器、改实现、还是误伤？）');
console.log('  2. 结构上守住"只拷一次"：桥里任何新增的二进制路径都必须走 newArrayBuffer/getArrayBuffer，');
console.log('     不允许在沙箱侧出现逐字节循环（那是 2.6 MB/s 的量级）');
console.log('  3. README/tools 里写明：改动二进制通道后**必须重跑本工具**');
