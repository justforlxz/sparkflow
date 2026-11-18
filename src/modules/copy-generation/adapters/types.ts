/**
 * 文本适配器契约（docs/prd/06-copy-generation.md「范围」）：业务代码只依赖 `TextGenerator`。
 *
 * 一种接口形状一个实现，按网关的 `protocol` 选择；新增形状只加文件并在 `index.ts` 登记。
 * 适配器只负责发请求、取回文本，失败时抛带 `COPY_*` 码的 `StageError`；
 * 解析与字段校验在 `parse.ts`。
 */
/** 适配器只在「调上游」这一层；失败码由 `http.ts` 统一抛 `StageError`。 */

export interface TextGenerationInput {
  /** 已归一化（无尾部 `/`）的 Base URL，取自任务快照。 */
  baseUrl: string;
  /** 解密后的明文密钥，只在本进程内发请求用，不写日志、不回响应。 */
  apiKey: string;
  modelId: string;
  system: string;
  user: string;
  timeoutMs?: number;
  /** 任务被中止（超时、服务停止）时尽快放弃请求。 */
  signal?: AbortSignal;
  /** 单测注入假 fetch；线上用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export interface TextGenerationResult {
  text: string;
}

export interface TextGenerator {
  generate(input: TextGenerationInput): Promise<TextGenerationResult>;
}

/** 适配器共用的请求形状：URL、头、请求体三样，纯函数产出便于单测断言。 */
export interface TextRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}


/** Base URL 的尾部斜杠统一去掉，避免拼出 `//chat/completions`。 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
