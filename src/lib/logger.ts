/**
 * 日志：只输出 JSON 行，便于容器日志采集。
 * 所有值在写出前脱敏：敏感字段整体替换，文本里的 `sk-...` 与 `Bearer ...` 也替换。
 */

export type LogLevel = "info" | "warn" | "error";

export const REDACTED = "[REDACTED]";

/** 字段名命中即整体脱敏。`apiKey` / `api_key` / `authorization` / `cookie` 等都覆盖。 */
const SENSITIVE_FIELD = /(api[-_]?key|^key$|token|secret|password|authorization|cookie)/i;

/** 文本里出现的凭据形态。 */
const SENSITIVE_TEXT = [/\bsk-[A-Za-z0-9_-]{4,}/g, /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi];

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;

export function redactText(text: string): string {
  return SENSITIVE_TEXT.reduce((result, pattern) => result.replace(pattern, REDACTED), text);
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_FIELD.test(key) ? REDACTED : redactValue(entry, depth + 1);
  }
  return result;
}

export interface LogRecord {
  time: string;
  level: LogLevel;
  message: string;
  meta?: unknown;
}

export function formatLogLine(
  level: LogLevel,
  message: string,
  meta?: unknown,
  time: string = new Date().toISOString(),
): string {
  const record: LogRecord = { time, level, message: redactText(message) };
  if (meta !== undefined) record.meta = redactValue(meta);
  return JSON.stringify(record);
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  const line = formatLogLine(level, message, meta);
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

export const logger = {
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
};
