// **契约/核心版本兼容判定**（唯一实现）。
//
// 规则（2026-10-14 定，见 `docs/api-contract.md` §1）：
//   · 插件只声明一处兼容要求：`manifest.compat.minCore`（**核心版本**；没声明 = 不要求）；
//   · 判据 = **核心 major 必须相同 且 核心 ≥ minCore**（等价 `semver.satisfies(core, '>=minCore <major+1')`）。
//     为什么 major 必须相同：major 变化就是契约的**破坏性变更**（删 API / 改调用签名）；而 `coreRange`
//     那种"要求小于某版"的写法没必要 —— major 相同这条已经隐含了上界（维护者 2026-10-14 定）。
//   · 不满足 ⇒ `CONTRACT_MISMATCH`（参数 `{ minCore, core }`），文案给两条出路：升级核心 / 更新插件。
//
// 契约版本（`CONTRACT_VERSION`，semver）与核心版本**同一次发版走**，所以判定只需要核心版本一根轴；
// `lifecycle.version` 里仍然返回 `contract` 供插件做特性判断（它是派生事实，不参与装载判定）。
import { major, lt, valid, validRange, satisfies } from 'semver';
import { VERSION } from '../version';
import { SpcError } from '../errors';


export type CoreCompatVerdict =
  | { ok: true; exempted?: 'not-declared' }
  | { ok: false; reason: 'major-mismatch' | 'too-old' | 'invalid-min-core' };

/**
 * 判定一个插件的 `compat.minCore` 是否被当前核心满足（纯函数：`core` 可注入 ⇒ 可单测）。
 *
 * **没有开发豁免**（2026-10-14 定）：版本就是这棵树的事实（`package.json`），要别的版本就 checkout 过去。
 * `0.0.0` 是一个**正经可比的版本**（未发布/读不到版本时的值）—— 要求更高的插件会被拒，这是对的结果。
 */
export function coreCompat(minCore: string | undefined, core: string = VERSION): CoreCompatVerdict {
  if (minCore === undefined || minCore.trim() === '') return { ok: true, exempted: 'not-declared' };
  const want = minCore.trim();
  if (valid(want) === null || validRange(want) === null) return { ok: false, reason: 'invalid-min-core' };
  if (major(core) !== major(want)) return { ok: false, reason: 'major-mismatch' };
  if (lt(core, want)) return { ok: false, reason: 'too-old' };
  // 双保险：把规则写成它的等价区间形式（将来若改成允许范围声明，这里就是落点）
  return satisfies(core, `>=${want} <${major(want) + 1}.0.0`) ? { ok: true } : { ok: false, reason: 'too-old' };
}

/** 不满足就抛 `CONTRACT_MISMATCH`（参数里带 want/have，便于文案与面板直接说清） */
export function assertCoreCompat(minCore: string | undefined, core: string = VERSION): void {
  const verdict = coreCompat(minCore, core);
  if (!verdict.ok) throw new SpcError('CONTRACT_MISMATCH', { minCore: minCore ?? '', core });
}
