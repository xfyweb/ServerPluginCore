// 宿主错误契约：机器可读的英文码 + 结构化参数（i18n 渲染只发生在边界层：CLI / 面板）
// 分层原则见 core/i18n/index.ts：
//   内部层 → 只产出 { code, params }；HTTP / 审计 / 插件面 → 只流通英文码；
//   CLI → tError() 渲染；面板 → 自行请求 locale 文件渲染。
// 码是契约：一旦发布不得改名，只增不改（新增码需补 locales）。

/** 宿主错误形状（跨层传递的最小集合） */
export interface SpcErrorShape {
  code: string;
  params?: Record<string, string>;
}

/** 宿主错误基类：安全内部层（fs / permissions / hostApi）抛出的错误都应继承它 */
export class SpcError extends Error implements SpcErrorShape {
  readonly code: string;
  readonly params: Record<string, string>;

  constructor(code: string, params: Record<string, string> = {}) {
    super(code); // message 兜底 = 英文码：未翻译场景也不会是空话
    this.name = 'SpcError';
    this.code = code;
    this.params = params;
  }
}

/** 从任意错误里提取机器可读形状（非 SpcError 返回 null，由调用方决定兜底码） */
export function toErrorShape(err: unknown): SpcErrorShape | null {
  if (err instanceof SpcError) return { code: err.code, params: err.params };
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      const params = (err as { params?: unknown }).params;
      return {
        code,
        params:
          typeof params === 'object' && params !== null
            ? (params as Record<string, string>)
            : undefined,
      };
    }
  }
  return null;
}
