/** 适配器登记表：protocol → 实现。新增一种接口形状只加文件并在这里登记。 */
import type { GatewayProtocol } from "../constants";
import { anthropicMessagesAdapter } from "./anthropic-messages";
import { magpieMcpAdapter } from "./magpie-mcp";
import { openAiChatAdapter } from "./openai-chat";
import type { ProtocolAdapter } from "./types";

const ADAPTERS: Record<GatewayProtocol, ProtocolAdapter> = {
  "openai-chat": openAiChatAdapter,
  "anthropic-messages": anthropicMessagesAdapter,
  "magpie-mcp": magpieMcpAdapter,
};

export function findAdapter(protocol: string): ProtocolAdapter | undefined {
  return ADAPTERS[protocol as GatewayProtocol];
}
