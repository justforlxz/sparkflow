/**
 * 异步作业的失败记录与超时执行（提取运行使用）。
 *
 * 作业的失败形状：`code` 可分类、`message` 已脱敏且截断、`at` 是发生时间。
 * 脱敏放在这里而不是交给各适配器：上游消息里可能带 key 或 Authorization 形态，
 * 写库前统一按日志同一套规则处理（docs/prd/05 AC-05-8）。
 */
import { redactText } from "./logger";

/** 错误消息入库前的截断长度，避免把整段上游响应塞进数据库。 */
export const MAX_ERROR_MESSAGE_LENGTH = 1000;

const FALLBACK_MESSAGE = "执行失败";

/** 作业失败的记录形状（写进 `extraction_run.error`）。 */
export interface FailureRecord {
  code: string;
  /** 已脱敏、已截断的可读原因。 */
  message: string;
  at: string;
}

/**
 * 适配器主动分类的失败：`code` 是业务子码（如 `UPSTREAM_AUTH`）。
 * 作业执行器只认这里的 `code`，其余异常统一记成 `JOB_FAILED`。
 */
export class StageError extends Error {
  readonly code: string;
  readonly meta?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { meta?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "StageError";
    this.code = code;
    this.meta = options.meta;
  }
}

function normalizeMessage(message: string): string {
  const redacted = redactText(message).trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);
  return redacted.length > 0 ? redacted : FALLBACK_MESSAGE;
}

/** 执行器自己判定的失败（超时、无处理器、服务重启等）。 */
export function failureRecord(code: string, message: string, at: Date): FailureRecord {
  return { code, message: normalizeMessage(message), at: at.toISOString() };
}

/** 处理器抛出的异常：`StageError` 用它的业务码，其它一律记成 `fallbackCode`。 */
export function failureFrom(error: unknown, at: Date, fallbackCode: string): FailureRecord {
  if (error instanceof StageError) {
    return { code: error.code, message: normalizeMessage(error.message), at: at.toISOString() };
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : FALLBACK_MESSAGE;
  return { code: fallbackCode, message: normalizeMessage(message), at: at.toISOString() };
}

/** 超时不是处理器的错，单独区分以便记超时子码而不是通用失败码。 */
export class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`执行超过 ${Math.round(timeoutMs / 1000)} 秒，已中止`);
    this.name = "JobTimeoutError";
  }
}

/**
 * 带总超时执行一次作业：超时即 abort 正在进行的上游请求，并抛出 `JobTimeoutError`。
 */
export async function runWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new JobTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
