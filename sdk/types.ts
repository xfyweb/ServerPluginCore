// Manifest 类型定义（与 sdk/schema/manifest.schema.json 对齐，手写维护）
// 单一事实源是 JSON Schema；本文件仅提供 TS 静态类型。

export type PluginType = 'ability' | 'panel' | 'driver' | 'hook';
export type RuntimeType = 'quickjs' | 'node-child';
export type DependencyTier = 'whitelist' | 'user-opt-in';

export interface Manifest {
  /** schema 版本，必须为 2 */
  schema: 2;
  /** 插件类别，缺省视为 ability */
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
      publish?: string[];
      subscribe?: string[];
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
