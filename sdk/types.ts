// Manifest 类型定义（与 sdk/schema/manifest.schema.json 对齐，手写维护）
// 单一事实源是 JSON Schema；本文件仅提供 TS 静态类型。

// 插件类型（中文叫法：能力插件/驱动插件/协作插件/主题包）
//   ability 能力插件（默认）：运行在 QuickJS 沙箱内，挂载管理页面，经 @host/api 调驱动端点
//   driver  驱动插件：运行在核心端（特权），注册权限节点 + API 端点暴露给沙箱并自行鉴权
//   hook    协作插件：核心在流程的决策点上回调它、答复进核心决策（中间件；与 ability 的差别是调用方向相反；P2 不做）
//   theme   主题包：声明式设计令牌 + 资源 + 受限样式，无 JS、无沙箱（v3 由"面板插件"降级而来）
export type PluginType = 'ability' | 'driver' | 'hook' | 'theme';
export type RuntimeType = 'quickjs' | 'node-child';
/** 前端形态：declarative = 核心渲染组件树；iframe = 插件 bundle 在隔离 iframe 内运行 */
export type FrontendMode = 'declarative' | 'iframe';
/** 意图负载形状（核心代理按此校验；资源内容默认不随意图下发） */
export type IntentKind = 'selection' | 'text' | 'enum';

/** 意图负载声明（manifest `intent[]`；见 docs/intent-capture.md §6.2） */
export interface IntentSpec {
  name: string;
  kind: IntentKind;
  /** kind=selection：资源类型 */
  resource?: 'path' | 'session';
  /** kind=selection：可选文件类型 */
  types?: ('file' | 'dir')[];
  /** kind=selection：最多选几个 */
  maxCount?: number;
  /** 负载字节上限（防借意图通道搬运内容） */
  maxBytes?: number;
  /** kind=text：字符串长度上限 */
  maxLength?: number;
  /** kind=enum：允许值 */
  values?: string[];
}

/** 配置字段类型（configSchema 支持的 JSON Schema 子集） */
export type ConfigFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array';

/** 单个配置字段声明 */
export interface ConfigFieldSchema {
  type: ConfigFieldType;
  description?: string;
  /** 缺省值：读取值文件时由宿主补上 */
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** type=array 的元素 schema（简化：只支持对象形式） */
  items?: Record<string, unknown>;
  /** 敏感值：面板掩码显示，日志与审计一律摘要 */
  secret?: boolean;
}

/** 插件配置声明（manifest `configSchema`；见 plugin-lifecycle-design.md §1.6） */
export interface PluginConfigSchema {
  type: 'object';
  description?: string;
  required?: string[];
  additionalProperties?: false;
  properties: Record<string, ConfigFieldSchema>;
}

export interface Manifest {
  /** schema 版本，必须为 2 */
  schema: 2;
  /** 插件类型，缺省视为 ability（能力插件） */
  type?: PluginType;
  /** 发布者命名空间 id：`@<username>/<name>`（市场内唯一；跨市场靠完整引用 `<origin>/@<username>/<name>` 消歧） */
  id: string;
  name: string;
  version: {
    /** 程序化比较用，整数递增 */
    code: number;
    /** 展示用 semver */
    name: string;
  };
  /** 核心版本兼容（minCore 必填） */
  compat?: {
    minCore: string;
    targetCore?: string;
  };
  author?: {
    /** 作者 ID：`<username>@<源域名>`（可选；填写时须与 id 命名空间、源域名一致） */
    id?: string;
    name?: string;
    homepage?: string;
  };
  description?: string;
  /** 构建源入口，缺省 main.ts */
  entry?: string;
  /** 前端形态（P3）：declarative = 核心渲染组件树；iframe = 插件 bundle 在隔离 iframe 内运行 */
  frontend?: {
    mode: FrontendMode;
  };
  /** 意图负载声明（P3）：插件可从核心前端收到的用户输入形状（核心代理按此校验） */
  intent?: IntentSpec[];
  /**
   * 插件配置声明（JSON Schema 子集：type=object + properties）。
   * 宿主据此校验值文件、补默认值，并把**只读快照**注入 `ctx.config`；面板在 P3 据此渲染表单。
   * 字段可标 `secret: true`（面板掩码、日志与审计摘要）。
   */
  configSchema?: PluginConfigSchema;
  /** 主题包入口（仅 type=theme；此时 runtime / permissions 不适用，见 schema 的条件校验） */
  theme?: string;
  runtime: {
    type: RuntimeType;
    /** ESM-only 硬约束，必须为 true */
    esm?: true;
  };
  /**
   * 权限请求：无默认放行，必须显式声明（type=theme 时不需要）。
   *
   * 两种写法（schema 的 `pattern` 是语法闸，判定时还有一道语义闸「点名必须已被某个插件登记」）：
   * - **静态点** `<group>.<action>[.<scope>]`，如 `fs.write.data`、`exec.template.nginx.reload`；
   * - **动态点**（由别人的能力派生，跨插件引用一律带**完整引用**，见 docs/events-and-hooks-design.md §3.4）：
   *   - `plugins.call.<origin>/@user/name.<path>` —— 调那个插件的某个端点；
   *   - `events.subscribe.<origin>/@user/name.<topic>` —— 订阅那个插件发布的某个事件。
   *   两者都**不接受 `*`**：通配声明 = 把对方**将来**新增的端点/订阅一次性全授了。
   */
  permissions: {
    name: string;
    reason?: string;
  }[];
  exports?: {
    /**
     * 对外端点。**实现方式**：入口模块导出 `endpoints` 映射 ——
     * `export const endpoints = { '/api/x/run': (ctx, paramsJson, bytes) => jsonText }`；
     * 宿主**装载时逐条核对**"清单声明的 path ⟺ 映射里真有这个键"，对不上即
     * `PLUGIN_EXPORT_INVALID`（kind=endpoint-handler）——声明与实现因此是可检查的不变式，
     * 写错路径当场报错，不会拖到第一次被调用。处理器返回 **JSON 文本**（`undefined`/`null` 视作 `null`）。
     */
    endpoints?: {
      path: string;
      permission?: string;
      /**
       * **谁能调这个端点**，缺省 `["panel"]`（fail-closed：不声明就不能被插件调用）。
       * - `'panel'`：核心 HTTP 网关（P3）；
       * - `'plugins'`：其他插件经 `plugins.call(句柄, path, …)` 调用 —— 只有声明了它，
       *   调用方的跨插件调用才可能成立（`docs/events-and-hooks-design.md` §3.7 门槛三）。
       */
      callable?: ('panel' | 'plugins')[];
    }[];
    routes?: {
      path: string;
      title: string;
      icon?: string;
      order?: number;
    }[];
    events?: {
      publish?: {
        topic: string;
        /** 事件保密等级：public/sensitive/secret */
        classification: 'public' | 'sensitive' | 'secret';
      }[];
      subscribe?: {
        topic: string;
        /** notify 只读通知 / arbitrate 裁决修改（协作插件 hook 语义） */
        mode: 'notify' | 'arbitrate';
      }[];
    };
  };
  dependencies?: {
    /**
     * npm 依赖**声明**。构建期由构建器解析真实闭包并做能力检查（能带 / 不能带）。
     * **没有信任分级**（无 `tier`）：勾选拦不住已经内联进 bundle 的依赖，分级又建立在
     * 不可信的声明之上——整套已退化为构建期能力检查（ADR-005 §7 v2）。
     */
    npm?: {
      name: string;
      version: string;
    }[];
    plugins?: {
      id: string;
      /**
       * **包内别名 = 调用句柄**（`plugins.call('backup', '/api/…')` 里的那个 `'backup'`）。
       * 没写就用 `id`。**同一清单里句柄必须唯一**（`as ?? id` 逐条比；重名就必须给每条写 `as`）——
       * 歧义在清单校验期挡掉，代码里因此永远无歧义。
       *
       * ⚠️ 为什么代码里**不写完整引用**：本地源的名字是"装机的人"起的标签，作者签名时不可能知道它；
       * 写进代码就等于"换一次桶，所有调用方全部重建"。宿主在装载时把句柄**锚定解析**成实际引用、
       * 生成带源的点名（§3.7）。
       */
      as?: string;
      /**
       * **调用面的请求**：我要调它的哪些端点（`path` 列表）。
       * 它替代了 `permissions[]` 里那条带源的动态点名 —— **声明不带源（写在被签名的包里）、授权带源**
       * （管理员批准的是"这个具体的插件"，点名 `plugins.call.<实际引用>.<path>`）。
       */
      call?: string[];
      /**
       * **来源**：写法按**目标**分（docs/events-and-hooks-design.md §3.5 的四格表）——
       * - 目标在**市场**：**必填**（市场域名是发布时就知道的稳定标识）；
       * - 目标在**本地源**：**省略** ⇒ 在本地源范围内按 `author.pub + id` **唯一匹配**
       *   （本地桶名是装机的人起的标签，作者不可能知道它 ⇒ 写死桶名的声明本来就不自足）；
       *   写明 `local:<名字>` 则精确匹配该桶；
       * - **市场包不许依赖本地源**（本地源不存在于别人的机器上）。
       */
      origin?: string;
      version?: string;
      /**
       * **作者公钥**（v4，必填）：`id` 与 `author.id` 都不唯一（同一把 `@a/x` 在两个源就是两个插件），
       * 所以**唯一性来自 `origin`、同一性来自公钥**。宿主用它在安装期核对被依赖方的作者身份
       * （拿名册里的记忆比；绝不比包内自述）。`fingerprint` 可选，写了必须与 `pub` 自洽。
       */
      author: {
        /** base64 裸 32 字节 Ed25519 公钥 */
        pub: string;
        /** `sha256:` + 裸公钥的 sha256（展示/审计用；判定比公钥） */
        fingerprint?: string;
      };
    }[];
  };
}
// v2：manifest 里没有签名块——签名属于交付信封（plugin.meta.json + plugin.meta.sig），
// 见 docs/plugin-signature-design.md §2–§3。

/** 校验结果 */
export interface ManifestValidationResult {
  ok: boolean;
  /** 字段路径 + 错误消息，供 CLI/UI 展示 */
  errors: string[];
}
