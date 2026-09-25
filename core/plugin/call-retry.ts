// 跨插件调用投递时的**有界重试**（docs/events-and-hooks-design.md §3.7 的失败语义）
//
// 为什么单独一个文件、而不是写在 manager 的投递链里：这段是**策略**（重试几次、等多久、什么时候放弃），
// 而策略必须能被判别性地测出来 —— 真实环境里"对端正忙"只能由对端自己的定时器/监视回调制造，
// 写成集成用例就成了时序赌博（本轮实测：那种用例要么挂 200ms 不可控，要么根本造不出窗口）。
// 于是把它抽成纯函数：入参是一个"调一次"的回调，出参是"结果 + 试了几次 + 等了多少"。
//
// 四条决定（设计里定的，别改）：
//   · **只对忙重试**（`PLUGIN_BUSY`）：崩溃/卸载/拒绝/超时都不重试 —— 反复去叫一个坏掉的插件没有意义；
//   · **有界**：最多 3 次尝试（**含首次**）⇒ 第 2、3 次前各等 50 / 100 ms；
//   · **总计封顶 350ms**：任何情况下不许把调用方的阶段预算耗在"等对方空闲"上；
//   · **不排队**：放弃就是放弃，失败往上抛（顺序等待会让调用方预算被对方吃掉，且"谁先谁后"不可解释）。
import { toErrorShape } from '../errors';

/**
 * 重试间隔表（毫秒）：第 N 次尝试失败后等 `delaysMs[N-1]` 再试。
 *
 * ⚠️ **口径**（设计 §3.7 写的是"最多 3 次尝试、间隔 50 / 100 / 200 ms、总计 ≤ 350 ms"）：
 * "3 次尝试"是**含首次**的口径 ⇒ 只有 2 次重试 ⇒ 用得到前两个间隔（等待 50+100=150ms）。
 * 表里那个 200ms 与 `CALL_RETRY_WAIT_CAP_MS` 是**上限口径**：真要放宽尝试数时才会用到，
 * 届时不必再改文档（本文件与 §3.7 的措辞已对齐）。
 * 选"3 次尝试"这一读法而不是"3 次重试"：调用方的阶段预算更安全（最多被吃掉 150ms）。
 */
export const CALL_RETRY_DELAYS_MS: readonly number[] = [50, 100];

/** 重试等待的硬顶（与设计一致） */
export const CALL_RETRY_WAIT_CAP_MS = 350;

/** 一次投递的结果 + 这次投递的账（两个数都要进审计：调用方看到的"成功"背后可能等了很久） */
export interface RetryOutcome<T> {
  value: T;
  /** 实际尝试次数（1 = 一次就通） */
  attempts: number;
  /** 重试累计等待的墙钟（毫秒） */
  waitedMs: number;
}

export interface BusyRetryOptions {
  /** 现在时刻（测试可注入；缺省 `Date.now`） */
  now?: () => number;
  /** 整体截止时刻（毫秒时间戳）：等待后若已越过它就不再重试 */
  deadline?: number;
  /** 睡多久（测试可注入；缺省真睡） */
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
  waitCapMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 调 `attempt`，只在 `PLUGIN_BUSY` 时重试。
 *
 * @returns 成功时的 `{ value, attempts, waitedMs }`
 * @throws 最后一次的原错误（忙到用尽重试时就是那个 `PLUGIN_BUSY`；其它错误第一次就抛）
 */
export async function withBusyRetry<T>(
  attempt: (attemptNo: number) => Promise<T>,
  opts: BusyRetryOptions = {},
): Promise<RetryOutcome<T>> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const delays = opts.delaysMs ?? CALL_RETRY_DELAYS_MS;
  const waitCap = opts.waitCapMs ?? CALL_RETRY_WAIT_CAP_MS;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;

  let attempts = 0;
  let waitedMs = 0;
  for (;;) {
    attempts += 1;
    try {
      return { value: await attempt(attempts), attempts, waitedMs };
    } catch (err) {
      const delay = delays[attempts - 1];
      const busy = toErrorShape(err)?.code === 'PLUGIN_BUSY';
      if (!busy || delay === undefined || waitedMs + delay > waitCap || now() + delay >= deadline) {
        throw err;
      }
      await sleep(delay);
      waitedMs += delay;
    }
  }
}
