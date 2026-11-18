/** 文本适配器登记表：网关的 `protocol` → 实现。新增一种形状只加文件并在这里登记。 */
import { anthropicMessagesTextGenerator } from "./anthropic-messages";
import { openAiChatTextGenerator } from "./openai-chat";
import type { TextGenerator } from "./types";

const GENERATORS: Record<string, TextGenerator> = {
  "openai-chat": openAiChatTextGenerator,
  "anthropic-messages": anthropicMessagesTextGenerator,
};

/** 没有对应实现时返回 undefined（文案 Agent 只能用文本类接口形状）。 */
export function findTextGenerator(protocol: string): TextGenerator | undefined {
  return GENERATORS[protocol];
}
