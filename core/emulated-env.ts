// 仿真环境身份（os / process 的事实来源）
//
// **为什么单独一个模块**：`node:os` 与 `node:process` 报的不是"这个宿主是什么"，而是
// **沙箱假装自己是什么**。这两者必须一致，且必须与 `path`、`node-constants.js` 同一个取向——
// 否则插件在开发机（Windows）上走 Windows 分支、到生产（Linux）上走另一条分支，
// 而路径语义却是另一套，这种"半真半假"最难查。
//
// **P2-E（模型 B）：仿真平台跟随宿主**。原先固定 `linux`（模型 A），但那会出现
// "沙箱自称 Linux、脚下却是 Windows"——插件的 fs 动作真的落在 `C:\…` 上，
// 路径大小写、分隔符、errno 全是 Windows 的。现在口径统一成：
//   **`platform` / `path` 语义 / `EOL` / `devNull` / `constants` / 沙箱可见路径形态，六者同时跟随宿主，不许半跟。**
// 可用 `SPC_EMULATED_PLATFORM=linux|win32` 覆盖（**只给测试与排障用**：生产上让它跟随宿主，
// 否则又会造出"配了 Linux、实际跑 Windows"这种新坑）。
//
// 取值分三类，规则写死在这里（新增字段时先归类）：
//   1. **行为性事实 → 跟随平台**（跟随宿主平台）：`platform` / `EOL` / `devNull` / 路径语义 / 常量表。
//      它们会改变插件的行为分支，所以必须**一起**跟随——半跟比不跟更难查；
//   2. **度量性事实 → 宿主真值**：`arch` / `pid`（以及收敛到数据目录内的路径）。
//      它们不决定"该用哪种语义"，报真话更有用（例如按 `pid` 生成锁文件名）；
//   3. **身份性事实 → 不暴露**（`hostname` / `networkInterfaces` / `userInfo` / `cpus` 的型号…）：
//      那是宿主隐私与环境探测面，`node:os` 里对应的调用**明确抛错**，等真需求来了再谈权限点。
//
// 版本号仍是**固定仿真值**：依赖常用 `process.versions.node` 做 semver 分支，跟着宿主的 Node 版本走
// 会让同一份插件在不同机器上走不同分支。固定成一个真实存在过的 LTS 版本，行为可预期。
import { readFileSync } from 'node:fs';
import * as nodeOs from 'node:os';
import { join } from 'node:path';

/** 仿真 Node 版本（写进 `process.version` / `process.versions.node`）——固定值，不跟宿主 */
export const EMULATED_NODE_VERSION = '22.22.1';

/** 两种仿真平台（模型 B 下由宿主决定；也可用 `SPC_EMULATED_PLATFORM` 覆盖） */
export type EmulatedPlatform = 'linux' | 'win32';

/** 平台三元组：`platform` / `EOL` / `devNull`——**必须一起选**，不许半跟 */
const PLATFORM_TRAITS: Record<EmulatedPlatform, { eol: string; devNull: string }> = {
  linux: { eol: '\n', devNull: '/dev/null' },
  // 真值来源：Windows v22.22.1 实跑（`tools/truth/data/const-win.json` 的 `facts`）
  win32: { eol: '\r\n', devNull: '\\\\.\\nul' },
};

/** 解析仿真平台：显式覆盖优先，否则跟随宿主；只认 `linux`/`win32` 两个值 */
export function resolveEmulatedPlatform(
  hostPlatform: string,
  override: string | undefined = process.env.SPC_EMULATED_PLATFORM,
): EmulatedPlatform {
  const wanted = override === 'linux' || override === 'win32' ? override : hostPlatform;
  // 宿主是别的平台（darwin/…）时按 posix 系处理：`path` 只有 posix/win32 两套语义
  return wanted === 'win32' ? 'win32' : 'linux';
}

/**
 * 沙箱内可见的环境事实（由 `globalThis.__spcEnv` 注入的 JSON 还原）。
 * 加字段前先按文件头的三条归类问一句："它会不会改变插件的行为分支"。
 */
export interface EnvFacts {
  /** 仿真平台（固定 `linux`） */
  platform: string;
  /** 宿主真实架构（度量性事实） */
  arch: string;
  /** 仿真行尾（linux `\n` / win32 `\r\n`——随仿真平台，见文件头） */
  eol: string;
  /** 空设备路径（linux `/dev/null` / win32 `\\.\nul`——随仿真平台） */
  devNull: string;
  /** 仿真 Node 版本（固定，见 EMULATED_NODE_VERSION） */
  nodeVersion: string;
  /** 宿主 pid（度量性事实；`proper-lockfile` 一类会把它写进锁文件名） */
  pid: number;
  /** 插件数据目录 —— 同时是 `process.cwd()` 与 `os.homedir()` */
  dataDir: string;
  /** 插件可写的临时目录：`<dataDir>/tmp`（**不是**宿主 tmp：那个在 fs 作用域外，一用就 EACCES） */
  tmpDir: string;
  /** `os.release()`：仿真平台与宿主一致就报内核真值，否则报该平台形态的仿真常数（见文件头第 1 条） */
  kernelRelease: string;
  /** `os.version()`：同上策略 */
  kernelVersion: string;
  /**
   * 下面这组是**容量类度量**（给宿主真值，见文件头第 2 条）：它们只影响"开几个并发/够不够内存"这类
   * 决策，不改变语义；而**身份类**信息（hostname / networkInterfaces / userInfo / cpus 的型号）不给，
   * 对应的 `os` 调用明确抛错。
   */
  cpuCount: number;
  totalMem: number;
  freeMem: number;
  uptimeSec: number;
  loadAvg: number[];
}

/** 宿主不是 Linux 时用的仿真内核串（形状照 Linux 的 `uname -r` / `uname -v`） */
const FALLBACK_RELEASE = '6.12.0';
const FALLBACK_VERSION = '#1 SMP PREEMPT_DYNAMIC';

/** 仿真成 win32 时的内核串形态（真值取自 Windows v22.22.1 实跑：`10.0.26100` / Windows 版本名） */
const WIN_FALLBACK_RELEASE = '10.0.26100';
const WIN_FALLBACK_VERSION = 'Windows Server 2025 Datacenter';

/** 组装沙箱可见的环境事实（宿主侧调用一次，随沙箱创建注入） */
export function buildEnvFacts(
  dataDir: string,
  host: { platform: string; arch: string; pid: number } = process,
): EnvFacts {
  const platform = resolveEmulatedPlatform(host.platform);
  const isWin = platform === 'win32';
  const samePlatform = host.platform === platform;
  // ── 沙箱可见路径形态：**按仿真平台选**（P2-E）──
  //
  // linux：`\` → `/`（POSIX 那套字符串算法只认 `/`）。不统一的话，凡是"把沙箱路径喂回沙箱 path 函数"
  // 的地方都会错位——实测：`tmp` 包对 `os.tmpdir()` 调 `path.relative(tmpdir, resolved)`，
  // 反斜杠让它算出 `../C:\…`，然后自己抛 "template option must be relative to …"。
  //
  // win32：**保持宿主的原生形态**。理由：`path.win32.resolve` 两种分隔符都认、但**输出是 `\`**——
  // "沙箱可见形态"必须与"沙箱 path 的输出"同形，否则 `path.resolve(x) === x` 这种幂等假设不成立
  // （本轮踩过：`resolve('C:/…')` 曾拼出 `C:/C:/…`，`fast-glob` **一个条目都匹配不到且不报错**）。
  //
  // ⚠️ **不要补前导 `/`**（试过、错了）：`/C:/Users/…` 在宿主上被 `path.resolve` 解析成
  // `<cwd>/C:/Users/…`（Windows 上盘符前的 `/` 被当成当前盘）⇒ `validatePath` 判越界、EACCES。
  const normalized = isWin
    ? dataDir.split('/').join('\\')
    : dataDir.indexOf('\\') === -1 ? dataDir : dataDir.split('\\').join('/');
  const sep = isWin ? '\\' : '/';
  return {
    platform,
    arch: host.arch,
    eol: PLATFORM_TRAITS[platform].eol,
    devNull: PLATFORM_TRAITS[platform].devNull,
    nodeVersion: EMULATED_NODE_VERSION,
    pid: host.pid,
    dataDir: normalized,
    // ⚠️ 这里**不能用 `node:path.join`**：它按**宿主**平台拼，与仿真平台可能不一致
    // （实测：Windows 宿主上它把刚统一好的 `/` 又还原成 `\`，`tmp` 包的 `path.relative` 立刻错位）。
    // 手工拼 + 按仿真平台选分隔符。
    tmpDir: (normalized.endsWith(sep) ? normalized : normalized + sep) + 'tmp',
    // 内核串：仿真平台与宿主平台**一致**时给宿主真值，否则给该平台形态的固定串
    // （形状对、不泄露宿主内核；Linux 侧沿用既有行为，一字未改）
    kernelRelease: samePlatform && isWin
      ? String(safe(() => nodeOs.release(), WIN_FALLBACK_RELEASE))
      : samePlatform
        ? readKernelField('/proc/sys/kernel/osrelease', FALLBACK_RELEASE)
        : (isWin ? WIN_FALLBACK_RELEASE : FALLBACK_RELEASE),
    kernelVersion: samePlatform && isWin
      ? String(safe(() => nodeOs.version(), WIN_FALLBACK_VERSION))
      : samePlatform
        ? readKernelField('/proc/sys/kernel/version', FALLBACK_VERSION)
        : (isWin ? WIN_FALLBACK_VERSION : FALLBACK_VERSION),
    cpuCount: safe(() => nodeOs.availableParallelism(), 1),
    totalMem: safe(() => nodeOs.totalmem(), 0),
    freeMem: safe(() => nodeOs.freemem(), 0),
    uptimeSec: safe(() => nodeOs.uptime(), 0),
    loadAvg: safe(() => nodeOs.loadavg(), [0, 0, 0]),
  };
}

/** 宿主读数失败就退回给定默认值：环境事实拿不到不该让沙箱建不起来 */
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * 读内核串（仅 Linux 存在）。
 * 读不到就退回仿真常数——**环境事实拿不到不该让沙箱建不起来**，而且这两个值只影响日志文案。
 */
function readKernelField(path: string, fallback: string): string {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text.length > 0 ? text : fallback;
  } catch {
    return fallback;
  }
}
