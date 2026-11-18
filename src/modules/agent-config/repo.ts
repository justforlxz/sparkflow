/** 两份 Agent 配置的持久化访问。判断逻辑不在这里（见 readiness.ts / validation.ts）。 */
import { getDb } from "@/lib/db";

export interface AgentConfigRecord {
  type: string;
  enabled: boolean;
  name: string;
  gatewayId: string | null;
  gatewayModelId: string | null;
  role: string;
  systemPrompt: string;
  outputRequirements: string;
  updatedAt: Date;
}

const AGENT_SELECT = {
  type: true,
  enabled: true,
  name: true,
  gatewayId: true,
  gatewayModelId: true,
  role: true,
  systemPrompt: true,
  outputRequirements: true,
  updatedAt: true,
} as const;

export async function listAgentConfigs(): Promise<AgentConfigRecord[]> {
  return getDb().agentConfig.findMany({ select: AGENT_SELECT, orderBy: { type: "asc" } });
}

export async function findAgentConfig(type: string): Promise<AgentConfigRecord | null> {
  return getDb().agentConfig.findUnique({ where: { type }, select: AGENT_SELECT });
}

export interface AgentConfigUpdate {
  enabled?: boolean;
  name?: string;
  gatewayId?: string | null;
  gatewayModelId?: string | null;
  role?: string;
  systemPrompt?: string;
  outputRequirements?: string;
}

export async function updateAgentConfigRecord(
  type: string,
  input: AgentConfigUpdate,
): Promise<AgentConfigRecord> {
  return getDb().agentConfig.update({ where: { type }, data: input, select: AGENT_SELECT });
}

/** 网关删除前的引用查询：哪些 Agent 绑定了这个网关（docs/prd/02 MUST 3）。 */
export async function listAgentConfigsByGateway(gatewayId: string): Promise<AgentConfigRecord[]> {
  return getDb().agentConfig.findMany({
    where: { gatewayId },
    select: AGENT_SELECT,
    orderBy: { type: "asc" },
  });
}
