/**
 * 浏览器侧调用 `/api` 的小工具：所有请求都走统一响应信封（docs/architecture.md 第 4 节），
 * 失败时把 `error.message` 抛出来，界面直接展示。
 */
export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  // `FormData` 的 `content-type` 必须由浏览器自己写（要带 boundary），手写 JSON 头会把上传打坏。
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  const response = await fetch(url, {
    ...init,
    headers: isFormData
      ? { ...(init.headers ?? {}) }
      : { "content-type": "application/json", ...(init.headers ?? {}) },
  });

  const body = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !body?.ok) {
    throw new ApiError(
      body?.error?.code ?? "INTERNAL",
      body?.error?.message ?? `请求失败（${response.status}）`,
      body?.error?.details,
    );
  }
  return body.data as T;
}
