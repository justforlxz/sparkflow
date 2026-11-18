/**
 * 「这个网关被谁引用」的查询点（docs/prd/02-model-gateway.md MUST 3）。
 *
 * 引用方是 Agent 配置（`docs/prd/03-agent-config.md`）。查询实现在 agent-config 模块：
 * 那是它自己的表，由它自己查；本文件只做转接，`service.deleteGateway` 因此不必知道引用方的结构。
 */
import { findAgentReferencesForGateway } from "@/modules/agent-config/references";

export interface GatewayReference {
  /** 引用来源的类别，例如 `agent`，用于界面分类展示。 */
  source: string;
  /** 具体是哪一个，例如「图片创作 Agent」。 */
  name: string;
}

export type GatewayReferenceLookup = (gatewayId: string) => Promise<GatewayReference[]>;

export const findGatewayReferences: GatewayReferenceLookup = (gatewayId) =>
  findAgentReferencesForGateway(gatewayId);
