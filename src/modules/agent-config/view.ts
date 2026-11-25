/**
 * Agent 配置的对外形状：接口与页面只见到这一层。
 * 这里没有任何密钥字段 —— 配置本身不含密钥，密钥按 `gatewayId` 在执行时从网关取。
 */
import type { AgentTypeDefinition } from "./constants";
import {
  resolveAgentReadiness,
  type AgentBindingState,
  type AgentGatewayBinding,
} from "./readiness";
import type { AgentConfigRecord } from "./repo";

export interface AgentConfigView {
  type: string;
  label: string;
  description: string;
  enabled: boolean;
  name: string;
  gatewayId: string | null;
  gatewayName: string | null;
  gatewayModelId: string | null;
  protocol: string | null;
  baseUrl: string | null;
  role: string;
  systemPrompt: string;
  outputRequirements: string;
  /** 模型留空时界面上的说法，来自模块常量（AC-03-3）。 */
  emptyModelLabel: string;
  /** 绑定状态；`gateway-default` 表示「使用网关默认图片模型」。 */
  state: AgentBindingState;
  /** 能否用于创建任务（已启用且绑定可用）。 */
  ready: boolean;
  /** 还缺什么，直接展示给用户。 */
  issues: string[];
  updatedAt: string;
}

/** `GET /api/agents/models?type=` 的候选项：带上网关，界面可据此按网关过滤。 */
export interface AgentModelCandidate {
  gatewayId: string;
  modelId: string;
  capability: string;
}

export function toAgentView(
  definition: AgentTypeDefinition,
  record: AgentConfigRecord,
  gateway: AgentGatewayBinding | null,
): AgentConfigView {
  const readiness = resolveAgentReadiness(definition, record, gateway);

  return {
    type: definition.value,
    label: definition.label,
    description: definition.description,
    enabled: record.enabled,
    name: record.name,
    gatewayId: record.gatewayId,
    gatewayName: gateway?.name ?? null,
    gatewayModelId: record.gatewayModelId,
    protocol: gateway?.protocol ?? null,
    baseUrl: gateway?.baseUrl ?? null,
    role: record.role,
    systemPrompt: record.systemPrompt,
    outputRequirements: record.outputRequirements,
    emptyModelLabel: definition.emptyModelLabel,
    state: readiness.state,
    ready: readiness.ready,
    issues: readiness.issues,
    updatedAt: record.updatedAt.toISOString(),
  };
}
