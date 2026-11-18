/**
 * 保存时的绑定校验（docs/prd/03-agent-config.md MUST 4、MUST 5，AC-03-4、AC-03-5）。
 *
 * 纯函数 + 抛 `AppError`：不合法返回 `VALIDATION_FAILED`，并在消息里直接说清哪一条不满足，
 * 界面把这句原文展示给用户。
 */
import { AppError } from "@/lib/errors";
import type { AgentTypeDefinition } from "./constants";
import type { AgentGatewayBinding } from "./readiness";

export interface AgentBindingDraft {
  gatewayId: string | null;
  gatewayModelId: string | null;
  gateways: readonly AgentGatewayBinding[];
}

/** 空串与纯空白都当作「没填」。 */
export function normalizeOptionalText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function assertBindingSavable(
  definition: AgentTypeDefinition,
  draft: AgentBindingDraft,
): void {
  const gatewayId = normalizeOptionalText(draft.gatewayId);
  const modelId = normalizeOptionalText(draft.gatewayModelId);

  const gateway = gatewayId
    ? (draft.gateways.find((candidate) => candidate.id === gatewayId) ?? null)
    : null;

  // 网关存在性先于「模型能否留空」校验：模型留空的图片 Agent 也不许把不存在的网关写进库，
  // 否则外键会拒绝这次写入，接口只能返回 500，而不是 MUST 5 要求的 VALIDATION_FAILED。
  if (gatewayId && !gateway) {
    throw AppError.validationFailed("网关不存在，请重新选择", {
      code: "AGENT_GATEWAY_NOT_FOUND",
      gatewayId,
    });
  }

  if (!modelId) {
    if (definition.modelRequired) {
      throw AppError.validationFailed(`${definition.label}必须绑定一个具体模型`, {
        code: "AGENT_MODEL_REQUIRED",
        agentType: definition.value,
      });
    }
    // 图片 Agent 允许留空：绑了网关就是用网关侧默认图片模型（MUST 3），没绑网关则是未就绪。
    return;
  }

  if (!gateway) {
    throw AppError.validationFailed("选择模型之前先选择网关", {
      code: "AGENT_GATEWAY_REQUIRED",
      agentType: definition.value,
      modelId,
    });
  }

  const model = gateway.models.find((candidate) => candidate.modelId === modelId);
  if (!model) {
    throw AppError.validationFailed(`模型 ${modelId} 不在网关「${gateway.name}」里，请重新选择`, {
      code: "AGENT_MODEL_NOT_IN_GATEWAY",
      gatewayId: gateway.id,
      modelId,
    });
  }

  if (!definition.capabilities.some((capability) => capability === model.capability)) {
    throw AppError.validationFailed(
      `模型 ${modelId} 的能力与${definition.label}不匹配，请重新选择`,
      {
        code: "AGENT_MODEL_CAPABILITY_MISMATCH",
        gatewayId: gateway.id,
        modelId,
        capability: model.capability,
      },
    );
  }
}
