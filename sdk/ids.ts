// 插件标识的形状：**代码侧的唯一出处**。
//
// `sdk/schema/manifest.schema.json` 里有同一形状的**契约镜像**（那份 JSON 得能被 ajv 与市场单独读走，
// 所以字符必须真的写在里面）—— 两边由 `sdk/__tests__/ids.test.ts` 逐字绑着：schema 改了而这里没改，用例先红。
//
// 为什么要有这份文件：这条规则原本在 **7 处**手抄 —— schema 的 `id` 与 `dependencies.plugins[].id`、
// `build/scaffold.ts`、`build/workspace.ts`、`core/sources/verify.ts`、`core/plugin/records.ts`、
// `core/permissions/points.ts`，以及 `core/exec/templates.ts` 里嵌在模板 ID（`<owner>:<action>.<op>`）中间的那一份。
// 逐字一致只是当时的巧合，而代价不对称：谁给 schema 放宽一个字符（比如允许大写），作者工具会继续按旧规则拒人、
// 核心会放行，**没有任何东西会报错** —— 而"这个包能不能装进去"是已发布的契约。
//
// ⚠️ 形状是**外部契约**：改这里等于改契约（只增不改）。原来那句「改一处必须三处一起改」的注释可以退休了。

/** id 的**一段**（作者 ID / 插件名 / 目录名共用）：字母数字开头，其余 `[a-z0-9_-]`，总长 1–63 */
export const ID_SEGMENT_CORE = '[a-z0-9][a-z0-9_-]{0,62}';

/**
 * 完整 id 的**主体**（不含两端锚点）：`@<作者 ID>/<名字>`。
 * 要把它拼进别的模式时用这个（先例：`core/exec/templates.ts` 的模板 ID）。
 */
export const PLUGIN_ID_CORE = `@${ID_SEGMENT_CORE}/${ID_SEGMENT_CORE}`;

/** 整串匹配用的模式串 —— 与 schema 的 `pattern` **逐字相同**（别只改一边，用例会红） */
export const ID_SEGMENT_PATTERN = `^${ID_SEGMENT_CORE}$`;
export const PLUGIN_ID_PATTERN = `^${PLUGIN_ID_CORE}$`;

/**
 * 编译好的正则。⚠️ **不加 `g` / `y` 旗标**：带 `lastIndex` 的正则在多次 `.test()` 之间是**有状态**的
 * （同一个 id 第二次就被判成非法），而这里的用法遍布装载校验、权限派生与记录校验。
 */
export const ID_SEGMENT_RE = new RegExp(ID_SEGMENT_PATTERN);
export const PLUGIN_ID_RE = new RegExp(PLUGIN_ID_PATTERN);
