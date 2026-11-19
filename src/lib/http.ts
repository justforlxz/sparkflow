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

/** 驱动层（pg / Node 网络）的套接字错误码：连不上、被对端掐断、超时。 */
const DRIVER_SOCKET_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
]);

/** PostgreSQL 服务端停机/暂不可用的 SQLSTATE：57P01 管理员停机、57P02 崩溃停机、57P03 暂不接受连接。 */
const SQLSTATE_SHUTDOWN_CODES = new Set(["57P01", "57P02", "57P03"]);

/** `@prisma/adapter-pg` 把驱动错误归一成的连接类 kind。 */
const DRIVER_CONNECTION_KINDS = new Set([
  "DatabaseNotReachable",
  "ConnectionClosed",
  "SocketTimeout",
  "TlsConnectionError",
]);

/**
 * 连接被静默掐断时 pg 只给一句消息、没有错误码（实测 `Error("Connection terminated unexpectedly")`），
 * 只能按消息前缀判断。这些字符串来自 pg / pg-pool 与 Prisma 客户端的固定文案。
 */
const CONNECTION_LOST_MESSAGE =
  /^(Connection terminated|Client has encountered a connection error and is not queryable|Client was closed and is not queryable|Can't reach database server)/;

/** 把异常当成普通记录看待；字段是否存在、类型对不对，读的时候再收窄。 */
type ErrorShape = Record<string, unknown>;

function asObject(value: unknown): ErrorShape | null {
  return typeof value === "object" && value !== null ? (value as ErrorShape) : null;
}

/** Prisma 错误码、套接字错误码、SQLSTATE class 08（连接异常）与停机码都算连接不可用。 */
function isConnectionCode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    UPSTREAM_ERROR_CODES.has(value) ||
    DRIVER_SOCKET_ERROR_CODES.has(value) ||
    SQLSTATE_SHUTDOWN_CODES.has(value) ||
    /^08[0-9A-Z]{3}$/.test(value)
  );
}

/** 驱动适配器把原始驱动错误包在 `meta.driverAdapterError.cause` 里（实测 P2010 + 57P01）。 */
function isDriverAdapterConnectionError(error: ErrorShape): boolean {
  const driverAdapterError = asObject(asObject(error.meta)?.driverAdapterError);
  const cause = asObject(driverAdapterError?.cause);
  if (!cause) return false;
  if (isConnectionCode(cause.originalCode) || isConnectionCode(cause.code)) return true;
  return typeof cause.kind === "string" && DRIVER_CONNECTION_KINDS.has(cause.kind);
}

function isUpstreamConnectionError(error: unknown): boolean {
  const shape = asObject(error);
  if (!shape) return false;

  const code = typeof shape.errorCode === "string" ? shape.errorCode : shape.code;
  if (isConnectionCode(code)) return true;

  if (isDriverAdapterConnectionError(shape)) return true;

  return typeof shape.message === "string" && CONNECTION_LOST_MESSAGE.test(shape.message);
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
