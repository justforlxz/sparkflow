/**
 * OpenAI Chat 兼容形状（文本）。端点 `POST <baseUrl>/chat/completions`。
 * 连接测试用一次最小 chat 调用（`max_tokens: 1`）验证鉴权（docs/prd/02 SHOULD）。
 */
import { sendProbe } from "./http";
import { requireModel, type ProbeDeps, type ProbeRequest, type ProbeTarget, type ProtocolAdapter } from "./types";

/** 纯函数：请求怎么拼，单测直接断言。 */
export function buildOpenAiChatRequest(target: ProbeTarget): ProbeRequest {
  const modelId = requireModel(target, "OpenAI Chat 连接测试");
  return {
    url: `${target.baseUrl}/chat/completions`,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
  };
}

export const openAiChatAdapter: ProtocolAdapter = {
  protocol: "openai-chat",
  async probe(target: ProbeTarget, deps: ProbeDeps = {}): Promise<string> {
    const request = buildOpenAiChatRequest(target);
    await sendProbe(request, deps);
    return `OpenAI Chat 接口可用（模型 ${target.modelId}）`;
  },
};
