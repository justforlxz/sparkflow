/**
 * 创建任务时固化的 Agent 配置快照（docs/prd/03-agent-config.md MUST 6，AC-03-9）。
 *
 * 字段逐个写出，不做对象展开：这样网关记录里多出什么（密文、掩码、测试结果）都不会被带进来。
 * 密钥永远不进快照，执行时按 `gatewayId` 现取。
 */
import type { AgentConfigView } from "./view";
import type { AgentGatewayBinding } from "./readiness";

export interface AgentSnapshot {
  agentType: string;
  enabled: boolean;
  name: string;
  gatewayId: string;
  protocol: string;
  baseUrl: string;
  /** 图片 Agent 留空时为 null，执行时省略模型参数（MUST 3）。 */
  modelId: string | null;
  role: string;
  systemPrompt: string;
  outputRequirements: string;
}

export function buildAgentSnapshot(
  view: AgentConfigView,
  gateway: AgentGatewayBinding,
): AgentSnapshot {
  if (!view.gatewayId || view.gatewayId !== gateway.id) {
    throw new Error(`Agent ${view.type} 未绑定网关，不能生成配置快照`);
  }

  return {
    agentType: view.type,
    enabled: view.enabled,
    name: view.name,
    gatewayId: view.gatewayId,
    protocol: gateway.protocol,
    baseUrl: gateway.baseUrl,
    modelId: view.gatewayModelId ?? null,
    role: view.role,
    systemPrompt: view.systemPrompt,
    outputRequirements: view.outputRequirements,
  };
}
