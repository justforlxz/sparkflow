/**
 * Anthropic Messages 兼容形状（文本）。端点 `POST <baseUrl>/messages`。
 * 鉴权走 `x-api-key` 头，另需 `anthropic-version`；连接测试同样是一次 `max_tokens: 1` 的最小调用。
 */
import { sendProbe } from "./http";
import { requireModel, type ProbeDeps, type ProbeRequest, type ProbeTarget, type ProtocolAdapter } from "./types";

/** Anthropic Messages 的版本头：固定值，改动意味着协议不兼容。 */
export const ANTHROPIC_VERSION = "2023-06-01";

export function buildAnthropicMessagesRequest(target: ProbeTarget): ProbeRequest {
  const modelId = requireModel(target, "Anthropic Messages 连接测试");
  return {
    url: `${target.baseUrl}/messages`,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": target.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
  };
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  protocol: "anthropic-messages",
  async probe(target: ProbeTarget, deps: ProbeDeps = {}): Promise<string> {
    await sendProbe(buildAnthropicMessagesRequest(target), deps);
    return `Anthropic Messages 接口可用（模型 ${target.modelId}）`;
  },
};
