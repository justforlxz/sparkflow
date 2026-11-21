/**
 * 文本请求的 HTTP 层：发一次 POST，把结果翻译成 `COPY_*` 失败码（docs/prd/06「失败分类」）。
 *
 * 只由适配器调用。响应体只在判定结构时使用，**不回显**上游内容，错误消息里也不出现密钥。
 */
import { logger } from "@/lib/logger";
import { StageError } from "@/lib/job-failure";
import { COPY_ERROR_CODES, DEFAULT_COPY_TIMEOUT_MS } from "../constants";
import type { TextRequest } from "./types";

export interface TextHttpDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** 非 2xx 的正文不需要解析：主动丢弃，别占着连接。丢弃失败也不影响已判定的失败码。 */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** 发请求并解析 JSON 回包；状态码、超时、网络、JSON 结构四类失败各自有码。 */
export async function postTextRequest(
  request: TextRequest,
  deps: TextHttpDeps = {},
): Promise<unknown> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_COPY_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, timeoutSignal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal,
    });
  } catch (error) {
    if (isAbort(error)) {
      throw new StageError(
        COPY_ERROR_CODES.timeout,
        `文本模型在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`,
        { cause: error },
      );
    }
    throw new StageError(COPY_ERROR_CODES.rejected, "无法连接文本模型网关（地址不可达或网络不通）", {
      cause: error,
    });
  }

  if (response.status === 401 || response.status === 403) {
    discardBody(response);
    throw new StageError(
      COPY_ERROR_CODES.auth,
      `上游返回 ${response.status}：鉴权失败，请检查网关的 API Key`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    logger.warn("文本模型请求失败", { status: response.status });
    discardBody(response);
    // 5xx 是上游暂时不可用，其余 4xx 是这次请求不被接受；两者都归 COPY_REJECTED。
    throw new StageError(
      COPY_ERROR_CODES.rejected,
      response.status >= 500
        ? `上游返回 ${response.status}：文本模型服务暂时不可用`
        : `上游返回 ${response.status}：请求被拒绝（地址或参数不被接受）`,
    );
  }

  // 正文读取也受同一个超时信号约束：读取被中止时必须记 COPY_TIMEOUT，
  // 不能吞成空串再被 JSON.parse 判成「不是 JSON」（AC-06-5 的失败分类在读取路径上也成立）。
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    if (isAbort(error)) {
      throw new StageError(
        COPY_ERROR_CODES.timeout,
        `文本模型在 ${Math.round(timeoutMs / 1000)} 秒内没有把响应读完`,
        { cause: error },
      );
    }
    throw new StageError(COPY_ERROR_CODES.rejected, "读取文本模型响应失败", { cause: error });
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new StageError(COPY_ERROR_CODES.format, "上游返回的不是 JSON");
  }
}
