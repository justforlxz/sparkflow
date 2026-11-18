/**
 * Agent 配置业务层：接口与页面只调用这里的函数（docs/prd/03-agent-config.md）。
 *
 * 三条边界：
 * 1. 网关数据由网关模块提供，调用方把 `listGatewayViews()` 的结果传进来；
 *    本模块不查网关的表，网关模块也不查 `agent_config`（AGENTS.md 硬性规则 2）。
 * 2. 快照只导出 MUST 6 列出字段，密钥永远不进快照（AC-03-9）。
 * 3. 创建任务前的就绪校验集中在这里：未就绪一律 `AGENT_NOT_READY` 并说明缺什么（MUST 8）。
 */
import { AppError } from "@/lib/errors";
import { AGENT_TYPES, findAgentType, type AgentTypeDefinition } from "./constants";
import { defaultTextFields } from "./defaults";
import type { AgentGatewayBinding } from "./readiness";
import { buildAgentSnapshot, type AgentSnapshot } from "./snapshot";
import * as repo from "./repo";
import type { UpdateAgentConfigInput } from "./schema";
import { assertBindingSavable, normalizeOptionalText } from "./validation";
import { toAgentView, type AgentConfigView, type AgentModelCandidate } from "./view";

function findGateway(
  gateways: readonly AgentGatewayBinding[],
  gatewayId: string | null,
): AgentGatewayBinding | null {
  if (!gatewayId) return null;
  return gateways.find((gateway) => gateway.id === gatewayId) ?? null;
}

/** 类型只有 image / copy；其它值一律当作不存在。 */
export function requireAgentType(type: string): AgentTypeDefinition {
  const definition = findAgentType(type);
  if (!definition) throw AppError.notFound(`不支持的 Agent 类型：${type}`);
  return definition;
}

/** 两条记录由迁移预置（MUST 1）；缺失说明迁移没跑，属于部署问题，不当成空配置处理。 */
function requireRecord(
  definition: AgentTypeDefinition,
  record: repo.AgentConfigRecord | null | undefined,
): repo.AgentConfigRecord {
  if (!record) {
    throw new AppError(
      "INTERNAL",
      `Agent 配置缺失：${definition.label}（${definition.value}），请确认数据库迁移已应用`,
    );
  }
  return record;
}

export async function listAgentViews(
  gateways: readonly AgentGatewayBinding[],
): Promise<AgentConfigView[]> {
  const records = new Map((await repo.listAgentConfigs()).map((record) => [record.type, record]));

  return AGENT_TYPES.map((definition) => {
    const record = requireRecord(definition, records.get(definition.value));
    return toAgentView(definition, record, findGateway(gateways, record.gatewayId));
  });
}

export async function getAgentView(
  type: string,
  gateways: readonly AgentGatewayBinding[],
): Promise<AgentConfigView> {
  const definition = requireAgentType(type);
  const record = requireRecord(definition, await repo.findAgentConfig(definition.value));
  return toAgentView(definition, record, findGateway(gateways, record.gatewayId));
}

/** 更新配置。绑定校验基于「合并后的结果」，不只看本次提交的字段。 */
export async function updateAgent(
  type: string,
  input: UpdateAgentConfigInput,
  gateways: readonly AgentGatewayBinding[],
): Promise<AgentConfigView> {
  const definition = requireAgentType(type);
  const current = requireRecord(definition, await repo.findAgentConfig(definition.value));

  const gatewayId = normalizeOptionalText(
    input.gatewayId !== undefined ? input.gatewayId : current.gatewayId,
  );
  const gatewayModelId = normalizeOptionalText(
    input.gatewayModelId !== undefined ? input.gatewayModelId : current.gatewayModelId,
  );
  // 绑定规则只在本次请求要写绑定时校验（MUST 4、MUST 5）。
  // 只改名称/提示词时不动绑定：迁移预置的文案 Agent 本来就是未绑定状态，
  // 不该因为「还没选模型」就连提示词都改不了；它仍然不可用于创建任务（MUST 8）。
  if (input.gatewayId !== undefined || input.gatewayModelId !== undefined) {
    assertBindingSavable(definition, { gatewayId, gatewayModelId, gateways });
  }

  const record = await repo.updateAgentConfigRecord(definition.value, {
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.outputRequirements !== undefined ? { outputRequirements: input.outputRequirements } : {}),
    gatewayId,
    gatewayModelId,
  });

  return toAgentView(definition, record, findGateway(gateways, record.gatewayId));
}

/** 恢复默认：只重置名称、角色说明、系统提示词与输出要求，模型绑定与启用状态不动（MUST 7）。 */
export async function resetAgent(
  type: string,
  gateways: readonly AgentGatewayBinding[],
): Promise<AgentConfigView> {
  const definition = requireAgentType(type);
  requireRecord(definition, await repo.findAgentConfig(definition.value));

  const record = await repo.updateAgentConfigRecord(definition.value, defaultTextFields(definition.value));
  return toAgentView(definition, record, findGateway(gateways, record.gatewayId));
}

/** 该 Agent 可选的模型：按能力过滤后跨网关列出（MUST 2、MUST NOT 2）。 */
export function listModelCandidates(
  type: string,
  gateways: readonly AgentGatewayBinding[],
): AgentModelCandidate[] {
  const definition = requireAgentType(type);

  return gateways.flatMap((gateway) =>
    gateway.models
      .filter((model) => definition.capabilities.some((capability) => capability === model.capability))
      .map((model) => ({
        gatewayId: gateway.id,
        modelId: model.modelId,
        capability: model.capability,
      })),
  );
}

/**
 * 创建任务前的就绪校验（MUST 8）：任一 Agent 停用或未就绪就拒绝，
 * `details.agents` 里逐条说明缺什么；调用方不应在此之前写入任何任务记录。
 * N5 创建任务时直接复用这里，不要另写一份就绪判断。
 */
export async function requireReadyAgentViews(
  gateways: readonly AgentGatewayBinding[],
): Promise<AgentConfigView[]> {
  const views = await listAgentViews(gateways);
  const notReady = views.filter((view) => !view.ready);
  if (notReady.length === 0) return views;

  const summary = notReady.map((view) => `${view.label}（${view.issues.join("；")}）`).join("，");
  throw new AppError("CONFLICT", `Agent 未就绪，不能创建任务：${summary}`, {
    details: {
      code: "AGENT_NOT_READY",
      agents: notReady.map((view) => ({
        type: view.type,
        name: view.label,
        issues: view.issues,
      })),
    },
  });
}

/** 给创建任务使用：先就绪校验，再返回两份配置快照（MUST 6）；N5 接入时复用这里。 */
export async function requireAgentSnapshots(
  gateways: readonly AgentGatewayBinding[],
): Promise<AgentSnapshot[]> {
  const views = await requireReadyAgentViews(gateways);

  return views.map((view) => {
    const gateway = findGateway(gateways, view.gatewayId);
    if (!gateway) {
      throw new AppError("INTERNAL", `Agent ${view.label} 的就绪状态与网关数据不一致`);
    }
    return buildAgentSnapshot(view, gateway);
  });
}
