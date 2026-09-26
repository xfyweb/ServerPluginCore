// 从 `core/hostApi.ts` 抽「宿主方法 → 权限点」的映射。
//
// 为什么要抽而不是手抄：那张表的**权威在 `core/hostApi.ts`**（运行期真的按它判权限），
// 手抄一份必然漂移，而漂移的后果是"构建期说没问题、运行期 PERMISSION_DENIED"——最难查的一类错。
// 抽取结果落成快照 `build/api-permission-map.json`（`refresh-api-map.mts` 生成），
// 守卫用例 `build/__tests__/apimap.test.ts` 用**同一个函数**重抽一遍比对 ⇒ 表一变，用例当场红。
//
// 形状（`core/hostApi.ts` 的返回对象，方法名**含点**）：
//     'fs.write': {
//       permission: 'fs.write.data',
export interface ApiMapExtraction {
  /** 宿主方法名（`fs.write` / `plugins.call` …）→ 权限点 */
  methods: Record<string, string>;
}

/** 方法键：`'fs.write': {`（顶层返回对象里的条目；⚠️ 名字里含点，别用 `\w` 卡） */
const KEY_RE = /^\s*'([A-Za-z][A-Za-z0-9_.]*)':\s*\{\s*$/;
/** 紧随其后的权限点声明 */
const PERM_RE = /^\s*permission:\s*'([^']+)'\s*,?\s*$/;

/** 抽取（纯函数：输入是 `hostApi.ts` 的源码文本） */
export function extractApiMap(source: string): ApiMapExtraction {
  const methods: Record<string, string> = {};
  let pending: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const key = KEY_RE.exec(line);
    if (key) {
      pending = key[1];
      continue;
    }
    const perm = PERM_RE.exec(line);
    if (perm && pending !== undefined) {
      methods[pending] = perm[1];
      pending = undefined;
    }
  }
  return { methods };
}

/**
 * 抽取结果的**下限体检**：低于它就说明抽取逻辑被源码格式变更打瞎了
 * （不是"表变小了"）⇒ 生成器宁可失败也不要写出一张半空的表。
 */
export const MIN_EXPECTED_METHODS = 60;
