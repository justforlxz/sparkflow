/**
 * Anthropic Messages 兼容形状（文本）：`POST <baseUrl>/messages`，
 * `x-api-key` + `anthropic-version` 鉴权，系统提示词走顶层 `system` 字段。
 *
 * 版本头复用网关适配器里的常量：同一协议事实只有一处定义。
 */
import { ANTHROPIC_VERSION } from "@/modules/gateway/adapters/anthropic-messages";
import { StageError } from "@/lib/job-failure";
import { ANTHROPIC_MAX_TOKENS, COPY_ERROR_CODES } from "../constants";
import { postTextRequest } from "./http";
import {
  joinUrl,
  type TextGenerationInput,
  type TextGenerationResult,
  type TextGenerator,
  type TextRequest,
} from "./types";

/** 纯函数：请求怎么拼，单测直接断言。 */
export function buildAnthropicMessagesRequest(input: TextGenerationInput): TextRequest {
  return {
    url: joinUrl(input.baseUrl, "/messages"),
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: input.modelId,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    }),
  };
}

/** 取 `content` 里第一个文本块；结构不符按格式异常处理。 */
export function readAnthropicMessagesText(payload: unknown): string {
  const blocks = (payload as { content?: unknown } | null)?.content;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      const entry = block as { type?: unknown; text?: unknown } | null;
      if (entry?.type === "text" && typeof entry.text === "string" && entry.text.trim()) {
        return entry.text;
      }
    }
  }
  throw new StageError(COPY_ERROR_CODES.format, "上游响应里没有文本内容");
}

export const anthropicMessagesTextGenerator: TextGenerator = {
  async generate(input: TextGenerationInput): Promise<TextGenerationResult> {
    const payload = await postTextRequest(buildAnthropicMessagesRequest(input), {
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    return { text: readAnthropicMessagesText(payload) };
  },
};
