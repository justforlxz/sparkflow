import type { AgentSnapshot } from "@/modules/agent-config/snapshot";

/** 集成用例用的图片 Agent 快照：字段确定，不读数据库。 */
export const AGENT: AgentSnapshot = {
  agentType: "image",
  enabled: true,
  name: "图片提取 Agent",
  gatewayId: "gateway-1",
  protocol: "magpie-mcp",
  baseUrl: "https://example.com",
  modelId: "image-model",
  role: "提取师",
  systemPrompt: "只做提取",
  outputRequirements: "每张原图各出一张",
};
