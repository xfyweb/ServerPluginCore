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
    endpoints?: {
      path: string;
      permission?: string;
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
       * **来源**（身份的另一半，见 docs/events-and-hooks-design.md §3.2）：省略 = **同源简写**
       * （取依赖方自己的来源）。跨源依赖必须写明 —— `(origin, id)` 才是身份，同名不同来源是**两个插件**。
       */
      origin?: string;
      version?: string;
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
