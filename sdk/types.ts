// Manifest 类型定义（与 sdk/schema/manifest.schema.json 对齐，手写维护）
// 单一事实源是 JSON Schema；本文件仅提供 TS 静态类型。

// 插件类型（中文叫法：面板插件/能力插件/驱动插件/协作插件）
//   panel   面板插件：构建 Web 壳与页面、提供组件库，其他插件挂载页面；内置可卸载，不算普通插件
//   ability 能力插件（默认）：运行在 QuickJS 沙箱内，挂载管理页面，经 @host/api 调驱动端点
//   driver  驱动插件：运行在核心端（特权），注册权限节点 + API 端点暴露给沙箱并自行鉴权
//   hook    协作插件：钩子触发逻辑，参与核心事件生命周期并干预/修改（位置/权限设计中）
export type PluginType = 'ability' | 'panel' | 'driver' | 'hook';
export type RuntimeType = 'quickjs' | 'node-child';
export type DependencyTier = 'whitelist' | 'user-opt-in';

export interface Manifest {
  /** schema 版本，必须为 2 */
  schema: 2;
  /** 插件类型，缺省视为 ability（能力插件） */
  type?: PluginType;
  /** 命名空间 id：official:<name> / thirdparty:<name> */
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
    name?: string;
    homepage?: string;
  };
  description?: string;
  /** 构建源入口，缺省 main.ts */
  entry?: string;
  runtime: {
    type: RuntimeType;
    /** ESM-only 硬约束，必须为 true */
    esm?: true;
  };
  /** 权限请求：无默认放行，必须显式声明 */
  permissions: {
    name: string;
    reason?: string;
  }[];
  exports?: {
    webApis?: {
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
    npm?: {
      name: string;
      version: string;
      tier: DependencyTier;
    }[];
    plugins?: {
      id: string;
      version?: string;
    }[];
  };
  /** P4 签名落地前可选；存在时必须完整 */
  signature?: {
    algorithm: 'ed25519';
    keyId: string;
    digest: string;
    sig: string;
  };
}

/** 校验结果 */
export interface ManifestValidationResult {
  ok: boolean;
  /** 字段路径 + 错误消息，供 CLI/UI 展示 */
  errors: string[];
}
