// 仿真环境身份（os / process 的事实来源）
//
// **为什么单独一个模块**：`node:os` 与 `node:process` 报的不是"这个宿主是什么"，而是
// **沙箱假装自己是什么**。这两者必须一致，且必须与 `path`（固定 posix）、`node-constants.js`
// （固定 Linux 真值）同一个取向——否则插件在开发机（Windows）上走 Windows 分支、
// 到生产（Linux）上走另一条分支，而路径语义始终是 posix，这种"半真半假"最难查。
//
// 取值分三类，规则写死在这里（新增字段时先归类）：
//   1. **行为性事实 → 固定为仿真基线**：`platform` / `EOL` / `devNull` / `endianness`。
//      它们会改变插件的行为分支，必须与 posix 路径、Linux 常量一致，不能随宿主漂移；
//   2. **度量性事实 → 宿主真值**：`arch` / `pid`（以及收敛到数据目录内的路径）。
//      它们不决定"该用哪种语义"，报真话更有用（例如按 `pid` 生成锁文件名）；
//   3. **身份性事实 → 不暴露**（`hostname` / `networkInterfaces` / `userInfo` / `cpus` …）：
//      那是宿主隐私与环境探测面，`node:os` 里对应的调用**明确抛错**，等真需求来了再谈权限点。
//
// 版本号同样是仿真值：依赖常用 `process.versions.node` 做 semver 分支，跟着宿主的 Node 版本走
// 会让同一份插件在不同机器上走不同分支。固定成一个真实存在过的 LTS 版本，行为可预期。
import { readFileSync } from 'node:fs';
import * as nodeOs from 'node:os';
import { join } from 'node:path';

/** 仿真 Node 版本（写进 `process.version` / `process.versions.node`）——固定值，不跟宿主 */
export const EMULATED_NODE_VERSION = '22.22.1';

/** 仿真的平台三元组：与 `path` 的 posix 取向一致（本项目暂不支持 Windows 部署） */
export const EMULATED_PLATFORM = 'linux';
export const EMULATED_EOL = '\n';
export const EMULATED_DEV_NULL = '/dev/null';

/**
 * 沙箱内可见的环境事实（由 `globalThis.__spcEnv` 注入的 JSON 还原）。
 * 加字段前先按文件头的三条归类问一句："它会不会改变插件的行为分支"。
 */
export interface EnvFacts {
  /** 仿真平台（固定 `linux`） */
  platform: string;
  /** 宿主真实架构（度量性事实） */
  arch: string;
  /** 仿真行尾（固定 `\n`） */
  eol: string;
  /** 仿真 Node 版本（固定，见 EMULATED_NODE_VERSION） */
  nodeVersion: string;
  /** 宿主 pid（度量性事实；`proper-lockfile` 一类会把它写进锁文件名） */
  pid: number;
  /** 插件数据目录 —— 同时是 `process.cwd()` 与 `os.homedir()` */
  dataDir: string;
  /** 插件可写的临时目录：`<dataDir>/tmp`（**不是**宿主 tmp：那个在 fs 作用域外，一用就 EACCES） */
  tmpDir: string;
  /** `os.release()`：宿主是 Linux 就报内核真值，否则报仿真常数（见文件头第 1 条） */
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

/** 组装沙箱可见的环境事实（宿主侧调用一次，随沙箱创建注入） */
export function buildEnvFacts(
  dataDir: string,
  host: { platform: string; arch: string; pid: number } = process,
): EnvFacts {
  const isLinux = host.platform === 'linux';
  return {
    platform: EMULATED_PLATFORM,
    arch: host.arch,
    eol: EMULATED_EOL,
    nodeVersion: EMULATED_NODE_VERSION,
    pid: host.pid,
    dataDir,
    tmpDir: join(dataDir, 'tmp'),
    kernelRelease: isLinux ? readKernelField('/proc/sys/kernel/osrelease', FALLBACK_RELEASE) : FALLBACK_RELEASE,
    kernelVersion: isLinux ? readKernelField('/proc/sys/kernel/version', FALLBACK_VERSION) : FALLBACK_VERSION,
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
