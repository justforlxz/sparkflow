/**
 * 绑定是否可用（纯函数，可单测）：docs/prd/03-agent-config.md MUST 3、MUST 4、MUST 8。
 *
 * 把「配置里的绑定」与「库里真实的网关、模型」放在一起判定，得出四种状态：
 * - `ok`：绑定了具体模型，且该模型仍属于这个网关、能力匹配；
 * - `gateway-default`：图片 Agent 的模型留空，用网关侧默认图片模型（MUST 3）；
 * - `unbound`：还没绑定网关；能保存，但不能创建任务（MUST 8）；
 * - `invalid`：绑定已失效（网关不存在、模型被删、能力不匹配），需要重新选择。
 *
 * 这里不看最近的连接测试结果：测试失败可能只是当时的网络问题，PRD 也没有把
 * 「测试通过」列为创建任务的前提。
 */
import type { AgentTypeDefinition } from "./constants";

export type AgentBindingState = "ok" | "gateway-default" | "unbound" | "invalid";

/** 判定只需要网关的这几个字段，不掺入接口展示用的掩码等字段。 */
export interface AgentGatewayBinding {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  models: readonly { modelId: string; capability: string }[];
}

export interface AgentBindingConfig {
  enabled: boolean;
  gatewayId: string | null;
  gatewayModelId: string | null;
}

export interface AgentReadiness {
  /** 能不能拿来做创建任务（= 已启用且绑定可用）。 */
  ready: boolean;
  state: AgentBindingState;
  /** 缺什么：直接写给人看的说法。 */
  issues: string[];
}

export function resolveAgentReadiness(
  definition: AgentTypeDefinition,
  config: AgentBindingConfig,
  gateway: AgentGatewayBinding | null,
): AgentReadiness {
  const issues: string[] = [];
  const modelId = config.gatewayModelId?.trim() || null;

  if (!config.enabled) issues.push("Agent 已停用");

  let state: AgentBindingState;

  if (!config.gatewayId) {
    if (modelId) {
      state = "invalid";
      issues.push("绑定已失效：没有绑定网关，请重新选择");
    } else {
      state = "unbound";
      issues.push("未绑定网关");
    }
  } else if (!gateway) {
    state = "invalid";
    issues.push("绑定已失效：网关不存在，请重新选择");
  } else if (!modelId) {
    // 模型留空：用网关侧的默认图片模型（MUST 3）。
    state = "gateway-default";
  } else {
    const model = gateway.models.find((candidate) => candidate.modelId === modelId);
    if (!model) {
      state = "invalid";
      issues.push("绑定已失效：该网关里没有这个模型，请重新选择");
    } else if (!definition.capabilities.some((capability) => capability === model.capability)) {
      state = "invalid";
      issues.push("绑定已失效：模型能力与这个 Agent 不匹配，请重新选择");
    } else {
      state = "ok";
    }
  }

  const usable = state === "ok" || state === "gateway-default";
  return { ready: usable && config.enabled, state, issues };
}
