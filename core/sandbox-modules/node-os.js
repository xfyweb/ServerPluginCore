// node:os 仿真——**沙箱假装自己是什么**，不是"这个宿主是什么"
//
// 取值分三类，规则在 core/emulated-env.ts 的文件头（那里是唯一出处，这里只消费）：
//   · 行为性事实固定为仿真基线（platform/EOL/devNull/endianness）——必须与 posix 路径、
//     Linux 常量表同一取向，**不能随宿主平台漂移**：否则插件在 Windows 开发机上走 win32 分支、
//     到 Linux 生产上走另一条分支，而 `path` 始终是 posix，这种半真半假最难查；
//   · 容量类度量给宿主真值（cpuCount/totalmem/freemem/uptime/loadavg）——它们只影响"开几个并发"；
//   · **身份类信息一律不给**：`cpus()` / `hostname()` / `networkInterfaces()` / `userInfo()`
//     明确抛错。理由不是"做不到"，是它们属于宿主隐私与环境探测面；要有就等一个权限点，
//     而不是让每个插件随手拿到。抛错而不是返回空值，是本项目一贯的 fail-closed 取向
//     （空值会让依赖安静地走进另一条路，那比报错难查得多）。
//
// 内联约束：静态、无占位符；能力/事实只能运行时从 `globalThis` 取（这里取 `__spcEnv`）。
import constantsTable from './node-constants.js';

const FACTS = JSON.parse(globalThis.__spcEnv);
if (!FACTS || typeof FACTS !== 'object') {
  // 建沙箱时没注入环境事实 = 宿主侧接线漏了。响亮报错，不要退化成"随便给个默认值"。
  const err = new Error('sandbox env facts missing (globalThis.__spcEnv)');
  err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
  throw err;
}

/** Node 的 `process.arch` 名字 → `uname -m` 名字（只列有区别的；没有映射就用原名） */
const MACHINE_ALIASES = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' };

/** 明确不做的调用：报错要能让人一眼看出"是沙箱没支持"，而不是"我参数写错了" */
function unsupported(name, why) {
  const fn = function () {
    const err = new Error('os.' + name + ' is not supported in the sandbox (' + why + ')');
    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
    throw err;
  };
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

/** 身份类：不暴露宿主环境信息 */
const IDENTITY_WHY = 'host identity is not exposed to plugins';

export function platform() {
  return FACTS.platform;
}
export function arch() {
  return FACTS.arch;
}
export function type() {
  return 'Linux'; // 与 platform 同一取向：仿真基线是 Linux/POSIX
}
export function release() {
  return FACTS.kernelRelease;
}
export function version() {
  return FACTS.kernelVersion;
}
export function endianness() {
  return 'LE';
}
export function machine() {
  // 架构属于"度量性事实"（见文件头第 2 条）：报宿主真值，只是要换成 `uname -m` 的叫法
  return MACHINE_ALIASES[FACTS.arch] ?? FACTS.arch;
}
export function tmpdir() {
  // **不是**宿主 tmp：那个路径在 fs 作用域（数据目录）之外，插件一用就 EACCES——返回它等于挖坑
  return FACTS.tmpDir;
}
export function homedir() {
  return FACTS.dataDir;
}
export function availableParallelism() {
  return FACTS.cpuCount;
}
export function totalmem() {
  return FACTS.totalMem;
}
export function freemem() {
  return FACTS.freeMem;
}
export function uptime() {
  return FACTS.uptimeSec;
}
export function loadavg() {
  return FACTS.loadAvg.slice();
}

export const cpus = /* @__PURE__ */ unsupported('cpus', IDENTITY_WHY);
export const hostname = /* @__PURE__ */ unsupported('hostname', IDENTITY_WHY);
export const networkInterfaces = /* @__PURE__ */ unsupported('networkInterfaces', IDENTITY_WHY);
export const userInfo = /* @__PURE__ */ unsupported('userInfo', IDENTITY_WHY);
export const getPriority = /* @__PURE__ */ unsupported('getPriority', 'process priority is a host capability');
export const setPriority = /* @__PURE__ */ unsupported('setPriority', 'process priority is a host capability');

export const EOL = FACTS.eol;
export const devNull = '/dev/null';

/**
 * `os.constants`：直接复用 `node-constants.js` 的 Linux 真值表（按前缀分回四组）。
 *
 * 为什么要排除 `ENGINE_*`：那张表是**扁平合并**的（Node 的 `constants` 就是合并的），
 * 而 `ENGINE_METHOD_*` 也长得像 errno（`^E[A-Z0-9_]+$`）——不排除就会把 OpenSSL 的
 * 引擎位混进 errno 里。这是"前缀归类"必须写死例外的地方。
 */
function groupOf(pattern, exclude) {
  const out = {};
  for (const key of Object.keys(constantsTable)) {
    if (!pattern.test(key)) continue;
    if (exclude && exclude.test(key)) continue;
    out[key] = constantsTable[key];
  }
  return out;
}

export const constants = Object.freeze({
  dlopen: groupOf(/^RTLD_/),
  errno: groupOf(/^E[A-Z0-9_]+$/, /^ENGINE_/),
  priority: groupOf(/^PRIORITY_/),
  signals: groupOf(/^SIG/),
});

export default {
  platform,
  arch,
  type,
  release,
  version,
  endianness,
  machine,
  tmpdir,
  homedir,
  availableParallelism,
  totalmem,
  freemem,
  uptime,
  loadavg,
  cpus,
  hostname,
  networkInterfaces,
  userInfo,
  getPriority,
  setPriority,
  EOL,
  devNull,
  constants,
};
