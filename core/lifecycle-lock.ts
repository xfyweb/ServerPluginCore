// **启动锁**：同一个状态目录只允许一个核心进程 —— **正常形态与维护模式共用这一把**。
//
// 为什么必须有它：正常形态靠端口互斥（第二个撞 `EADDRINUSE`），而**维护模式不绑端口** ——
// 没有这把锁，它就能与正在运行的 daemon 并存，两个进程同时写 `plugins.json` / `keyring.json` /
// 审计目录 / 插件安装目录（全是"读-改-写"）⇒ 丢更新 + 审计交错。
//
// 判活用 `process.kill(pid, 0)`：`ESRCH` = 进程没了（锁是陈旧的，接管）· `EPERM` = 活着（换个用户也算活着）。
// 崩溃会留下锁文件 —— 靠判活收拾，不靠"记得删"。
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './config';

export interface LifecycleLockInfo {
  pid: number;
  mode: 'normal' | 'maintenance';
  startedAt: number;
}

export type AcquireResult =
  | { ok: true; info: LifecycleLockInfo; tookOver: boolean; path: string }
  | { ok: false; holder: LifecycleLockInfo | null; path: string };

export function lockPath(): string {
  return join(stateDir(), 'daemon.lock');
}

/** 进程还在不在（`EPERM` 也算活着：存在但没权限给它发信号） */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/** 读锁内容（读不出/形状不对 ⇒ `null`，调用方按"锁不可信"处理） */
export function readLock(path: string = lockPath()): LifecycleLockInfo | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LifecycleLockInfo>;
    if (typeof raw.pid !== 'number' || (raw.mode !== 'normal' && raw.mode !== 'maintenance')) return null;
    return { pid: raw.pid, mode: raw.mode, startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0 };
  } catch {
    return null;
  }
}

/**
 * 取锁。`wx` 是**原子**创建（存在即 `EEXIST`）⇒ 不需要"先判存在再写"那种有竞态的写法。
 * 陈旧锁（持锁进程已不在，或文件读不出来）⇒ 删掉重取一次，成功则 `tookOver: true`。
 */
export function acquireLifecycleLock(
  mode: LifecycleLockInfo['mode'],
  path: string = lockPath(),
): AcquireResult {
  const info: LifecycleLockInfo = { pid: process.pid, mode, startedAt: Date.now() };
  // 状态目录可能还没建（取锁是启动路径上的第一件事）⇒ 自己保证父目录存在，别把 ENOENT 甩给调用方
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      return { ok: true, info, tookOver: attempt > 0, path };
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      const holder = readLock(path);
      if (holder !== null && alive(holder.pid)) return { ok: false, holder, path };
      // 陈旧锁（或内容不可信）⇒ 清掉再来一次；清不掉（并发抢）就落到下一轮的判活
      try {
        unlinkSync(path);
      } catch {
        /* 别人删了：下一轮 openSync 会再判一次 */
      }
    }
  }
  return { ok: false, holder: readLock(path), path };
}

/** 放锁：**只删自己那一把**（pid 不符就不动），停机路径调它 */
export function releaseLifecycleLock(path: string = lockPath()): void {
  const holder = readLock(path);
  if (holder === null || holder.pid !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {
    /* 已经没了 */
  }
}
