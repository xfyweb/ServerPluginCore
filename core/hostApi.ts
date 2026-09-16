// 宿主 API（第一版：方法级权限点声明；权限检查与审计在 sandbox 包装层强制）
// fs 走路径收敛（interface-audit-exec-fs.md F1–F7）；exec 只走模板注册表（E1–E10，无自由命令）
//
// P1.5 起改为**工厂**：宿主 API 的实现依赖"是哪个插件在调"（数据目录、可发布 topic、定时器回填），
// 所以不能再是一个模块级单例。装载器用 `buildHostApi(hostCtx)` 为每个插件造一份；
// `hostApi`（模块级默认实例）只留给单测与独立探测，装载路径不得使用。
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { SpcError, toErrorShape } from './errors';
import { assertInodeMatch, validatePath } from './fs/safe-path';
import type { HostApi, HostArg, SandboxBridge } from './sandbox';
import { ensureDir } from './config';
import { VERSION } from './version';

import './exec/install'; // 副作用：注册内置模板 + 其权限点
import { decodeBridgeArg, matchExecTemplate, resolveExecRequest } from './exec/request';
import { permissionPointOf } from './exec/templates';
import { runTemplate } from './exec/run';

/** 单文件读写上限（F4 放大攻击防护） */
const MAX_FILE_BYTES = 64 * 1024 * 1024; // 64MB：写入上限
/**
 * 读取上限（**比写入小得多**）：读到的内容会变成沙箱内的 JS 字符串，
 * 而沙箱堆只有 32 MiB（四层限额）——给插件读一个 64MB 文件只会把 VM 撑爆，
 * 报出来的是 PLUGIN_MEMORY_LIMIT（误导）。所以在宿主侧就按"能安全进 VM"的尺寸拒绝。
 */
const MAX_READ_BYTES = 1024 * 1024; // 1MB
const MAX_LIST_ENTRIES = 1000;
const MAX_KV_KEYS = 1000;
const MAX_KV_VALUE_BYTES = 256 * 1024;
const KV_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;

/**
 * 编码名 —— **以宿主 Node 为准**（`Buffer.isEncoding`），不自己维护清单。
 * Node 支持哪些编码、别名怎么归一化（`ucs2`/`ucs-2`/`utf16le`、`binary`/`latin1`…）
 * 都直接问宿主，两边才不会漂移（module-emulation-design §1「Node 是契约宗主」）。
 *
 * 抛的是**平台契约码** `ENCODING_UNKNOWN`；`node:buffer` 仿真层负责把它翻译成
 * Node 的 `ERR_UNKNOWN_ENCODING`（§7 的 errno 映射模式：对内是我们的码，对外像 Node）。
 */
function assertEncoding(enc: HostArg | undefined): BufferEncoding {
  const name = enc === undefined ? 'utf8' : String(enc);
  if (!Buffer.isEncoding(name)) throw new SpcError('ENCODING_UNKNOWN', { encoding: name });
  return name as BufferEncoding;
}

/** 桥送来的字节是 `Uint8Array`；包一层 Buffer **视图**（不拷贝）好直接复用 Node 的解码器 */
function asBuffer(value: HostArg): Buffer {
  if (typeof value === 'string') {
    throw new SpcError('INVALID_ARGS', { reason: 'expected-bytes', got: 'string' });
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * 文本参数必须**真的是字符串**。
 * 用 `String(value)` 兜底会把"类型传错"变成**静默错值**——例如 `byteLength(new Uint8Array([1,2,3]))`
 * 会去数字符串 `"1,2,3"` 的长度（5），而 Node 的 `Buffer.byteLength` 对同一个输入给 3。
 * 静默算错比响亮报错危险得多，所以这里一律拒绝。
 */
function asText(value: HostArg | undefined): string {
  if (typeof value !== 'string') {
    throw new SpcError('INVALID_ARGS', { reason: 'expected-string', got: typeof value });
  }
  return value;
}

/** 宿主 API 的每插件上下文（由装载器提供） */
export interface PluginHostContext {
  pluginId: string;
  /** 插件数据目录：fs 作用域、kv 落盘位置（宿主创建并保证存在） */
  dataDir: string;
  /** manifest 声明可发布的 topic（未声明即拒） */
  declaredTopics?: Iterable<string>;
  /** 定时器回填桥（由 core/sandbox.ts 在创建后写入） */
  bridge?: SandboxBridge;
}

/**
 * 相对路径按数据目录解析（插件写 `fs.read('a.txt')` 时的心智模型就是"我的目录"）。
 * **已经是绝对路径的原样传下去**：Windows 上 `/x` 这类"当前盘符根"形式也是绝对路径，
 * 若在这里先 `resolve`，错误信息回报的就是宿主规范化后的路径，插件作者会认不出来。
 * 让路径收敛（safe-path）去报它自己实际收到的那个路径。
 */
function resolvePluginPath(dataDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(dataDir, p);
}

/**
 * 为 `fs.write` 补建缺失的父目录 —— **仅当最近的已存在祖先的 realpath 落在数据目录内**。
 *
 * 为什么要它：没有这一步，插件就写不了 `backups/2026-09-18/x.tar`（validatePath 的 F6 会报
 * PARENT_MISSING），而"按日期分目录"是最基本的使用方式。而又不能无条件 mkdir：
 * F6 的本意是"父目录也可能是逃逸通道"，所以这里先确认祖先真实路径在数据目录内，建完**再走一遍
 * 完整校验**（软链逐级检查、inode 预检一个都不少）。
 */
function ensureParentInsideDataDir(target: string, dataDir: string): void {
  const root = realpathSync(dataDir);
  const parent = dirname(target);
  let probe = parent;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) throw new SpcError('PARENT_MISSING', { path: parent });
    probe = up;
  }
  const real = realpathSync(probe);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (real !== root && !real.startsWith(prefix)) {
    throw new SpcError('PARENT_ESCAPE', { path: parent });
  }
  mkdirSync(parent, { recursive: true });
}

/** kv：每个插件一个 <dataDir>/kv.json（懒加载 + 变更即落盘） */
function createKvStore(dataDir: string) {
  const file = join(dataDir, 'kv.json');
  let cache: Record<string, unknown> | undefined;

  const read = (): Record<string, unknown> => {
    if (cache) return cache;
    if (!existsSync(file)) {
      cache = {};
      return cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new SpcError('KV_INVALID', {
        path: file,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const values = (parsed as { values?: unknown } | null)?.values;
    cache = values && typeof values === 'object' && !Array.isArray(values)
      ? (values as Record<string, unknown>)
      : {};
    return cache;
  };

  const flush = (): void => {
    ensureDir(dataDir);
    writeFileSync(file, JSON.stringify({ kvSchema: 1, values: read() }, null, 2) + '\n', 'utf8');
  };

  return { read, flush };
}

function assertKvKey(key: string): void {
  if (!KV_KEY_PATTERN.test(key)) {
    throw new SpcError('KV_KEY_INVALID', { key });
  }
}

/**
 * 造一份绑定到具体插件的宿主 API。
 * 权限点全部是**静态声明**（除 exec.run 的动态模板点）——方法内部的路径收敛/参数校验
 * 发生在权限通过之后，未授权的插件拿不到校验结果做探测。
 */
export function buildHostApi(ctx: PluginHostContext): HostApi {
  const kv = createKvStore(ctx.dataDir);
  const topics = new Set<string>(ctx.declaredTopics ?? []);

  return {
    // ---- fs：作用域 = 插件数据目录（路径收敛复用 safe-path 的 F1–F7）----
    'fs.write': {
      permission: 'fs.write.data',
      fn: (path: string, content: string) => {
        const requested = resolvePluginPath(ctx.dataDir, path);
        let resolved;
        try {
          resolved = validatePath(requested, [ctx.dataDir]);
        } catch (err) {
          // 只对"父目录不存在"这一种情况补建目录（且必须确实在自己的数据目录内），
          // 其余一律原样抛出——不把安全性错误悄悄降级成"帮你建一下"。
          if (toErrorShape(err)?.code !== 'PARENT_MISSING') throw err;
          ensureParentInsideDataDir(requested, ctx.dataDir);
          resolved = validatePath(requested, [ctx.dataDir]);
        }
        const { path: safe, expected } = resolved;

        // 大小限制（F4）：内容长度 + 目标文件现有大小
        const bytes = Buffer.byteLength(content);
        if (bytes > MAX_FILE_BYTES) {
          throw new SpcError('FILE_TOO_LARGE', { bytes: String(bytes), limit: String(MAX_FILE_BYTES) });
        }
        if (existsSync(safe) && statSync(safe).size > MAX_FILE_BYTES) {
          throw new SpcError('TARGET_TOO_LARGE', { path: safe, limit: String(MAX_FILE_BYTES) });
        }

        // 打开 + inode 比对（F5 TOCTOU）+ 写入
        const fd = openSync(safe, 'w');
        try {
          if (expected) {
            const st = fstatSync(fd);
            assertInodeMatch({ dev: st.dev, ino: st.ino }, expected);
          }
          writeFileSync(fd, content, 'utf8');
        } finally {
          closeSync(fd);
        }
        return { ok: true, path: safe, bytes };
      },
    },

    'fs.read': {
      permission: 'fs.read.data',
      fn: (path: string) => {
        const { path: safe } = validatePath(resolvePluginPath(ctx.dataDir, path), [ctx.dataDir]);
        const st = statSync(safe);
        if (!st.isFile()) {
          throw new SpcError('NOT_A_FILE', { path: safe });
        }
        if (st.size > MAX_READ_BYTES) {
          throw new SpcError('FILE_TOO_LARGE', { bytes: String(st.size), limit: String(MAX_READ_BYTES) });
        }
        const content = readFileSync(safe, 'utf8');
        return { path: safe, content, bytes: Buffer.byteLength(content) };
      },
    },

    'fs.list': {
      permission: 'fs.read.data',
      fn: (path: string) => {
        const { path: safe } = validatePath(resolvePluginPath(ctx.dataDir, path), [ctx.dataDir]);
        const st = statSync(safe);
        if (!st.isDirectory()) {
          throw new SpcError('NOT_A_DIRECTORY', { path: safe });
        }
        const entries = readdirSync(safe, { withFileTypes: true });
        const truncated = entries.length > MAX_LIST_ENTRIES;
        return {
          path: safe,
          truncated,
          entries: entries.slice(0, MAX_LIST_ENTRIES).map((e) => {
            const full = join(safe, e.name);
            let size = 0;
            try {
              size = statSync(full).size;
            } catch {
              size = 0; // 竞态/权限：大小未知按 0 报，不让列目录整体失败
            }
            return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size };
          }),
        };
      },
    },

    'fs.stat': {
      permission: 'fs.read.data',
      fn: (path: string) => {
        const { path: safe } = validatePath(resolvePluginPath(ctx.dataDir, path), [ctx.dataDir]);
        const st = statSync(safe);
        return {
          path: safe,
          size: st.size,
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          mtimeMs: st.mtimeMs,
        };
      },
    },

    // ---- kv：插件作用域存储 ----
    'kv.get': {
      permission: 'kv.read',
      fn: (key: string) => {
        assertKvKey(key);
        const values = kv.read();
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      },
    },
    'kv.set': {
      permission: 'kv.write',
      fn: (key: string, valueJson: string) => {
        assertKvKey(key);
        const values = kv.read();
        if (!Object.prototype.hasOwnProperty.call(values, key) && Object.keys(values).length >= MAX_KV_KEYS) {
          throw new SpcError('KV_LIMIT_EXCEEDED', { limit: String(MAX_KV_KEYS) });
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(valueJson);
        } catch (err) {
          throw new SpcError('KV_VALUE_INVALID', {
            key,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        const bytes = Buffer.byteLength(valueJson);
        if (bytes > MAX_KV_VALUE_BYTES) {
          throw new SpcError('KV_VALUE_TOO_LARGE', { key, bytes: String(bytes), limit: String(MAX_KV_VALUE_BYTES) });
        }
        values[key] = decoded;
        kv.flush();
        return { ok: true, key, bytes };
      },
    },
    'kv.delete': {
      permission: 'kv.write',
      fn: (key: string) => {
        assertKvKey(key);
        const values = kv.read();
        const existed = Object.prototype.hasOwnProperty.call(values, key);
        if (existed) {
          delete values[key];
          kv.flush();
        }
        return { ok: true, key, existed };
      },
    },
    'kv.keys': {
      permission: 'kv.read',
      fn: () => kv.read() && Object.keys(kv.read()).sort(),
    },

    // ---- timers：宿主侧调度（转发到 sandbox 回填的定时器宿主）----
    'timers.every': {
      permission: 'timers.schedule',
      fn: (intervalMs: string, callbackId: string) => {
        const host = ctx.bridge?.timers;
        if (!host) throw new SpcError('TIMER_UNAVAILABLE', { pluginId: ctx.pluginId });
        return host.every(Number(intervalMs), callbackId);
      },
    },
    'timers.clear': {
      permission: 'timers.schedule',
      fn: (timerId: string) => {
        const host = ctx.bridge?.timers;
        if (!host) throw new SpcError('TIMER_UNAVAILABLE', { pluginId: ctx.pluginId });
        return { ok: host.clear(timerId) };
      },
    },

    // ---- events：发布（总线本体 P2；P1.5 只做"声明内 + 可审计"的登记式发布）----
    'events.publish': {
      permission: 'events.publish',
      fn: (topic: string, payload: string) => {
        if (!topics.has(topic)) {
          throw new SpcError('EVENT_TOPIC_NOT_DECLARED', { topic, pluginId: ctx.pluginId });
        }
        const decoded = decodeBridgeArg(payload);
        return { ok: true, topic, bytes: Buffer.byteLength(JSON.stringify(decoded ?? null)) };
      },
    },

    // ---- lifecycle：插件 → 宿主的契约协商与心跳 ----
    'lifecycle.version': {
      permission: 'lifecycle.version',
      fn: () => ({ core: VERSION, api: 1, pluginId: ctx.pluginId }),
    },
    'lifecycle.health': {
      permission: 'lifecycle.health',
      fn: () => ({ ok: true, pluginId: ctx.pluginId, at: Date.now() }),
    },

    // ---- bytes：**宿主代工的编解码**（utf8 / latin1 / ascii / base64 / base64url / hex / utf16le）----
    //
    // 为什么放宿主而不是沙箱内实现（module-emulation-design §3.2）：
    //   · QuickJS **没有 TextEncoder/TextDecoder**，沙箱内只能逐字节手写（实测 ≈2.6 MB/s）；
    //   · 更要紧的是**保真**——交给宿主就是交给 Node，畸形输入（孤立代理项、非法 base64）
    //     的语义天然一致，不需要我们复刻，也不会在边角上漂移。
    // 沙箱侧的字节仍存在本地（Uint8Array 子类），只有**编解码整块**过桥（每方向一次拷贝）。
    'bytes.fromString': {
      permission: 'bytes.encode',
      binaryResult: true,
      fn: (text: HostArg, encoding?: HostArg) => Buffer.from(asText(text), assertEncoding(encoding)),
    },
    'bytes.toString': {
      permission: 'bytes.decode',
      fn: (data: HostArg, encoding?: HostArg) => asBuffer(data).toString(assertEncoding(encoding)),
    },
    'bytes.byteLength': {
      permission: 'bytes.encode',
      fn: (text: HostArg, encoding?: HostArg) => Buffer.byteLength(asText(text), assertEncoding(encoding)),
    },

    // ---- exec：**只能调用已注册模板**（没有自由命令）。两种写法都接受：----
    //   ① 模板 ID：exec.run('core:git.status', { repo: '/srv/demo' })
    //   ② 原生写法：exec.run('git -C /srv/demo status --porcelain=v1 --branch')
    //      —— 原生写法只用于**匹配模板**，执行的仍是模板的 argv；匹配不到直接拒（core/exec/request.ts）
    // 权限点由匹配到的模板决定：`exec.template.<action>.<op>`，scope=host ⇒ 必须管理员逐点授予
    'exec.run': {
      permissionFor: (args) => {
        const def = matchExecTemplate(args);
        if (!def) {
          // 此处只做结构匹配，不做参数校验（参数校验在权限通过之后）
          throw new SpcError('TEMPLATE_NOT_FOUND', { reason: 'no-matching-template' });
        }
        return permissionPointOf(def.id);
      },
      fn: (...args: string[]) => {
        const req = resolveExecRequest(args);
        if (!req.ok) {
          throw new SpcError(req.code, req.params ?? {});
        }
        return runTemplate(req.def, req.params);
      },
    },
  };
}

/**
 * 模块级默认实例：**仅供单测与独立探测**（没有真正的插件上下文，数据目录落在状态目录下）。
 * 装载器必须用 `buildHostApi(hostCtx)`——否则所有插件会共享同一个数据目录。
 */
export const hostApi: HostApi = buildHostApi({
  pluginId: '@spc/standalone',
  dataDir: join(resolve(process.cwd(), '.spc'), 'data', 'plugins', 'spc__standalone'),
});
