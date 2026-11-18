/**
 * OpenAI Chat 兼容形状（文本）：`POST <baseUrl>/chat/completions`，`Authorization: Bearer`。
 *
 * 请求形状与 `src/modules/gateway/adapters/openai-chat.ts` 的连接测试一致，只是把
 * 「最小 ping 调用」换成真正的文案生成；不引入 SDK，直接用 fetch。
 */
import { StageError } from "@/modules/generation/types";
import { COPY_ERROR_CODES } from "../constants";
import { postTextRequest } from "./http";
import {
  joinUrl,
  type TextGenerationInput,
  type TextGenerationResult,
  type TextGenerator,
  type TextRequest,
} from "./types";

/** 纯函数：请求怎么拼，单测直接断言。 */
export function buildOpenAiChatRequest(input: TextGenerationInput): TextRequest {
  return {
    url: joinUrl(input.baseUrl, "/chat/completions"),
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.modelId,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
  };
}

/** 取第一条回包的 `message.content`；结构不符按格式异常处理。 */
export function readOpenAiChatText(payload: unknown): string {
  const choices = (payload as { choices?: unknown } | null)?.choices;
  const message = Array.isArray(choices)
    ? (choices[0] as { message?: { content?: unknown } } | undefined)?.message
    : undefined;
  const content = message?.content;

  if (typeof content !== "string" || content.trim().length === 0) {
    throw new StageError(COPY_ERROR_CODES.format, "上游响应里没有文本内容");
  }
  return content;
}

export const openAiChatTextGenerator: TextGenerator = {
  async generate(input: TextGenerationInput): Promise<TextGenerationResult> {
    const payload = await postTextRequest(buildOpenAiChatRequest(input), {
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    return { text: readOpenAiChatText(payload) };
  },
};
