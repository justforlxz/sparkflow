/**
 * 「这个网关被谁引用」的查询点（docs/prd/02-model-gateway.md MUST 3）。
 *
 * 引用方是 Agent 配置（`docs/prd/03-agent-config.md`），属于下一个节点（N4）的表。
 * 本节点按契约先把查询点留在这里：N4 实现时只改这一处，`service.deleteGateway` 不动。
 * 在没有引用方的阶段，删除网关不会被拦截。
 */
export interface GatewayReference {
  /** 引用来源的类别，例如 `agent`，用于界面分类展示。 */
  source: string;
  /** 具体是哪一个，例如「图片创作 Agent」。 */
  name: string;
}

export type GatewayReferenceLookup = (gatewayId: string) => Promise<GatewayReference[]>;

export const findGatewayReferences: GatewayReferenceLookup = async () => [];
