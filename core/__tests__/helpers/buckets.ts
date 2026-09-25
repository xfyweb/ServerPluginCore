// 测试夹具：造一个本地桶（⑥a 起"桶"= keyring 里的源条目，安装要落进真桶里）。
//
// ⚠️ 这里**直接走 keyring 存储层**，不经过 `sources/manage.ts` 的 `addSource`：后者会多写一条
// `source.add` 审计，而有些用例在数审计条目（`lifecycle.test.ts` 的 auditEntries）。要验"真实管理路径"
// 的用例（`sources.test.ts` / `reanchor.test.ts` 的桶）故意自己调 `addSource`。
import { anchorOf, keyring, newLocalSource } from '../../sources/keyring';
import { fingerprintOf } from '../../sources/keys';

/** 确保桶存在；给了 `anchorPub` 就绑定/更新作者锚（幂等，可反复调用） */
export function ensureBucket(origin: string, anchorPub?: string): void {
  const kr = keyring();
  kr.ensureBuiltins(); // `local:default` 等内置条目：核心一碰 keyring 就该在
  const cur = kr.get(origin);
  if (cur) {
    if (anchorPub !== undefined) kr.setAnchor(origin, anchorOf(anchorPub));
    return;
  }
  kr.add(newLocalSource(origin, origin, anchorPub === undefined ? undefined : anchorOf(anchorPub)));
}

/**
 * 确保**市场源**条目存在（⑥c 起"显式 `--source` 必须指向真桶/真源" ⇒ 装到市场来源的用例要先把它配上）。
 * `pub` 用测试钥：这些用例验的是安装流，不是市场验签（那属 P4）。
 */
export function ensureMarketSource(origin: string, pub: string): void {
  const kr = keyring();
  kr.ensureBuiltins();
  if (kr.get(origin)) return;
  kr.add({
    origin,
    kind: 'market',
    pub,
    fingerprint: fingerprintOf(pub),
    alias: origin,
    enabled: true,
    addedAt: new Date().toISOString(),
    firstTrust: 'manual',
    suspended: null,
  });
}
