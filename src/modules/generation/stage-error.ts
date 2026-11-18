/**
 * 阶段失败的记录形状（docs/prd/04 MUST 5）：`code` 可分类、`message` 已脱敏且截断、`at` 是发生时间。
 *
 * 脱敏放在这里而不是交给各阶段处理器：上游消息里可能带 key 或 Authorization 形态，
 * runner 是写库前最后一道关，统一按日志同一套规则处理（docs/prd/05 AC-05-8）。
 */
import { redactText } from "@/lib/logger";
import { MAX_ERROR_MESSAGE_LENGTH, STAGE_ERROR_CODES } from "./constants";
import { StageError, type StageErrorRecord } from "./types";

const FALLBACK_MESSAGE = "阶段执行失败";

function normalizeMessage(message: string): string {
  const redacted = redactText(message).trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);
  return redacted.length > 0 ? redacted : FALLBACK_MESSAGE;
}

/** runner 自己判定的失败（超时、无处理器、服务重启等）。 */
export function stageErrorRecord(code: string, message: string, at: Date): StageErrorRecord {
  return { code, message: normalizeMessage(message), at: at.toISOString() };
}

/** 处理器抛出的异常：`StageError` 用它的业务码，其它一律记成 `STAGE_FAILED`。 */
export function stageErrorFrom(error: unknown, at: Date): StageErrorRecord {
  if (error instanceof StageError) {
    return { code: error.code, message: normalizeMessage(error.message), at: at.toISOString() };
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : FALLBACK_MESSAGE;
  return {
    code: STAGE_ERROR_CODES.stageFailed,
    message: normalizeMessage(message),
    at: at.toISOString(),
  };
}
