/**
 * 「这个网关被哪个 Agent 引用」的查询实现（docs/prd/02-model-gateway.md MUST 3）。
 *
 * 网关模块的 `references.ts` 只是查询点，真正的数据在这里：`agent_config` 是本模块的表，
 * 由本模块自己查，网关模块不直接读它（AGENTS.md 硬性规则 2）。
 */
import { findAgentType } from "./constants";
import { listAgentConfigsByGateway } from "./repo";

export interface AgentReference {
  /** 引用来源类别，网关区块按它分类展示。 */
  source: string;
  name: string;
}

export async function findAgentReferencesForGateway(gatewayId: string): Promise<AgentReference[]> {
  const records = await listAgentConfigsByGateway(gatewayId);
  return records.map((record) => ({
    source: "agent",
    name: findAgentType(record.type)?.label ?? record.type,
  }));
}
