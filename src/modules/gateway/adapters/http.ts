/**
 * 适配器共用的 HTTP 层：发一次探测请求，把结果翻译成三类失败之一（MUST 6）。
 * 只由适配器调用，业务层不直接发请求。
 */
import type { ConnectionFailureKind } from "../constants";
import {
  ConnectionTestError,
  type ProbeDeps,
  type ProbeRequest,
  type ProbeResponse,
} from "./types";

export const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/**
 * HTTP 状态码 → 失败类别。
 * 401/403 是鉴权失败；5xx 视为上游暂时不可用（网络类）；其余 4xx 是配置错误（地址或参数不被接受）。
 */
export function classifyStatus(status: number): ConnectionFailureKind | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "network";
  return "config";
}

function describeFetchFailure(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return `请求超时（${Math.round(timeoutMs / 1000)} 秒内没有响应）`;
  }
  return "无法连接到网关（地址不可达或网络不通）";
}

export async function sendProbe(
  request: ProbeRequest,
  deps: ProbeDeps = {},
): Promise<ProbeResponse> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw ConnectionTestError.network(describeFetchFailure(error, timeoutMs), error);
  }

  // 响应体只在适配器判定结构时使用，不写进错误消息，避免回显上游内容。
  const bodyText = await response.text().catch(() => "");
  const kind = classifyStatus(response.status);

  if (kind === "auth") {
    throw ConnectionTestError.auth(`网关返回 ${response.status}：鉴权失败，请检查 API Key`);
  }
  if (kind === "config") {
    throw ConnectionTestError.config(`网关返回 ${response.status}：请求地址或参数不被接受`);
  }
  if (kind === "network") {
    throw ConnectionTestError.network(`网关返回 ${response.status}：服务端暂时不可用`);
  }

  return {
    status: response.status,
    bodyText,
    header: (name: string) => response.headers.get(name),
  };
}
