/**
 * 响应信封与路由包装器（docs/architecture.md 第 4 节）。
 * 成功 `{ ok: true, data }`；失败 `{ ok: false, error: { code, message, details? } }`。
 * 路由里不手写错误 JSON：抛 `AppError`（或让 zod 抛错），由 `route()` 翻译。
 */
import { ZodError } from "zod";
import { AppError, isAppError, isNextControlFlowError, type ErrorCode, type ErrorDetails } from "./errors";
import { logger } from "./logger";

export interface ApiSuccessBody<T> {
  ok: true;
  data: T;
}

export interface ApiFailureBody {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetails;
  };
}

export function okResponse<T>(data: T, status = 200): Response {
  const body: ApiSuccessBody<T> = { ok: true, data };
  return Response.json(body, { status });
}

export function failureResponse(
  code: ErrorCode,
  message: string,
  status: number,
  details?: ErrorDetails,
): Response {
  const body: ApiFailureBody = { ok: false, error: { code, message, details } };
  return Response.json(body, { status });
}

/** Prisma 的连接类错误码：数据库不可达属于上游不可用，不是 500。 */
const UPSTREAM_ERROR_CODES = new Set([
  "P1000",
  "P1001",
  "P1002",
  "P1003",
  "P1008",
  "P1010",
  "P1017",
]);

function isUpstreamConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { errorCode?: unknown; code?: unknown };
  const code = typeof candidate.errorCode === "string" ? candidate.errorCode : candidate.code;
  return typeof code === "string" && UPSTREAM_ERROR_CODES.has(code);
}

export function errorToResponse(error: unknown): Response {
  if (isAppError(error)) {
    if (error.status >= 500) {
      logger.error("请求处理失败", { code: error.code, error });
    }
    return failureResponse(error.code, error.message, error.status, error.details);
  }

  if (error instanceof ZodError) {
    return failureResponse("VALIDATION_FAILED", "请求参数不合法", 400, {
      issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }

  // redirect() / notFound() 用异常控制流程，必须继续向上抛。
  if (isNextControlFlowError(error)) throw error;

  if (isUpstreamConnectionError(error)) {
    logger.error("上游不可用：数据库连接失败", { error });
    return failureResponse("UPSTREAM_FAILED", "数据库不可达，请稍后重试", 503);
  }

  logger.error("未处理的异常", { error });
  return failureResponse("INTERNAL", "服务器内部错误", 500);
}

export type RouteHandler<Context = unknown> = (
  request: Request,
  context: Context,
) => Promise<Response> | Response;

export function route<Context = unknown>(handler: RouteHandler<Context>): RouteHandler<Context> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      return errorToResponse(error);
    }
  };
}

/** 读取 JSON 请求体；格式错误也算参数校验失败，不落到 500。 */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw AppError.validationFailed("请求体必须是合法的 JSON");
  }
}
