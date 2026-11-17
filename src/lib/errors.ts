/**
 * 统一错误：所有预期内的失败都用 `AppError` 抛出，由 `src/lib/http.ts` 的 `route()` 翻译成响应信封。
 * 顶层错误码固定（见 docs/architecture.md 第 4 节）；业务子码放在 `details.code`。
 */

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "UPSTREAM_FAILED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorDetails = Record<string, unknown>;

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  UPSTREAM_FAILED: 502,
  INTERNAL: 500,
};

export interface AppErrorOptions {
  /** 覆盖默认状态码，例如数据库不可达时用 503。 */
  status?: number;
  /** 业务子码与补充信息，例如 `{ code: "FEATURE_DISABLED", feature: "image-to-image" }`。 */
  details?: ErrorDetails;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.details = options.details;
  }

  static notFound(message = "资源不存在", details?: ErrorDetails): AppError {
    return new AppError("NOT_FOUND", message, { details });
  }

  static unauthorized(message = "需要登录"): AppError {
    return new AppError("UNAUTHORIZED", message);
  }

  static validationFailed(message = "请求参数不合法", details?: ErrorDetails): AppError {
    return new AppError("VALIDATION_FAILED", message, { details });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Next 用异常控制流程（redirect / notFound），包装器必须原样抛出，不能当成 500。 */
export function isNextControlFlowError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}
