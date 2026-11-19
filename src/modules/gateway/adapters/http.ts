/**
 * 适配器共用的 HTTP 层：发一次探测请求，把结果翻译成四类失败之一（MUST 6、MKACG-903）。
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
 * 上游的状态码与响应体 → 失败类别。
 * 401/403 是鉴权失败；5xx 视为上游暂时不可用（网络类）；其余 4xx 默认是配置错误（地址或参数不被接受）。
 * 400/404 另看一眼响应体：在说模型（不存在、不支持）时归入模型类，这时要改的是模型 ID 而不是地址。
 */
export function classifyResponse(status: number, bodyText: string): ConnectionFailureKind | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "network";
  if ((status === 400 || status === 404) && mentionsModel(bodyText)) return "model";
  return "config";
}

/**
 * 响应体是否在说「模型」。
 * 只认独立成词的 `model`：上游的端点清单会写 `/v1beta/models/*`，把 `models` 当成模型，
 * 就会把「Base URL 多写一段路径」的 404 判成模型错误，正是这次要修的反面。
 * 下划线、连字符、斜杠一律当分隔符，`model_not_found`、`model_id`、`provider/model` 都能命中。
 * 正文只在这里参与判定，任何情况下都不回显给用户。
 */
export function mentionsModel(bodyText: string): boolean {
  return bodyText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .includes("model");
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
  const kind = classifyResponse(response.status, bodyText);

  if (kind === "auth") {
    throw ConnectionTestError.auth(`网关返回 ${response.status}：鉴权失败，请检查 API Key`);
  }
  if (kind === "model") {
    throw ConnectionTestError.model(
      `网关返回 ${response.status}：模型不被网关接受，请检查模型 ID 是否存在于该网关`,
    );
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
