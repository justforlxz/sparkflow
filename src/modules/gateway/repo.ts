/** 网关与模型条目的持久化访问。判断逻辑不在这里（见 service.ts）。 */
import { getDb } from "@/lib/db";
import type { ConnectionTestOutcome, ModelCapability } from "./constants";

export interface GatewayRecord {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  encryptedApiKey: string;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  lastTestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  models: GatewayModelRecord[];
}

export interface GatewayModelRecord {
  id: string;
  gatewayId: string;
  modelId: string;
  capability: string;
  createdAt: Date;
}

export interface GatewayModelCandidate {
  gatewayId: string;
  gatewayName: string;
  protocol: string;
  modelId: string;
  capability: string;
}

const GATEWAY_SELECT = {
  id: true,
  name: true,
  protocol: true,
  baseUrl: true,
  encryptedApiKey: true,
  lastTestStatus: true,
  lastTestMessage: true,
  lastTestedAt: true,
  createdAt: true,
  updatedAt: true,
  models: {
    select: { id: true, gatewayId: true, modelId: true, capability: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  },
} as const;

export async function listGateways(): Promise<GatewayRecord[]> {
  return getDb().gateway.findMany({ select: GATEWAY_SELECT, orderBy: { createdAt: "asc" } });
}

export async function findGateway(id: string): Promise<GatewayRecord | null> {
  return getDb().gateway.findUnique({ where: { id }, select: GATEWAY_SELECT });
}

export async function createGatewayRecord(input: {
  name: string;
  protocol: string;
  baseUrl: string;
  encryptedApiKey: string;
}): Promise<GatewayRecord> {
  return getDb().gateway.create({ data: input, select: GATEWAY_SELECT });
}

export async function updateGatewayRecord(
  id: string,
  input: {
    name?: string;
    protocol?: string;
    baseUrl?: string;
    encryptedApiKey?: string;
  },
): Promise<GatewayRecord> {
  return getDb().gateway.update({ where: { id }, data: input, select: GATEWAY_SELECT });
}

export async function deleteGatewayRecord(id: string): Promise<void> {
  await getDb().gateway.delete({ where: { id } });
}

export async function createModelRecord(input: {
  gatewayId: string;
  modelId: string;
  capability: string;
}): Promise<void> {
  await getDb().gatewayModel.create({ data: input });
}

export async function findModelRecord(
  gatewayId: string,
  modelId: string,
): Promise<GatewayModelRecord | null> {
  return getDb().gatewayModel.findUnique({
    where: { gatewayId_modelId: { gatewayId, modelId } },
    select: { id: true, gatewayId: true, modelId: true, capability: true, createdAt: true },
  });
}

/** 返回删除条数：0 表示该网关下没有这个模型。 */
export async function deleteModelRecord(gatewayId: string, modelId: string): Promise<number> {
  const result = await getDb().gatewayModel.deleteMany({ where: { gatewayId, modelId } });
  return result.count;
}

/** Agent 候选用：按能力跨网关筛模型，带上网关名称供界面展示（docs/prd/03 MUST 2）。 */
export async function listModelsByCapability(
  capabilities: readonly ModelCapability[],
): Promise<GatewayModelCandidate[]> {
  const rows = await getDb().gatewayModel.findMany({
    where: { capability: { in: [...capabilities] } },
    select: {
      modelId: true,
      capability: true,
      gatewayId: true,
      gateway: { select: { name: true, protocol: true } },
    },
    orderBy: [{ gateway: { createdAt: "asc" } }, { createdAt: "asc" }],
  });

  return rows.map((row) => ({
    gatewayId: row.gatewayId,
    gatewayName: row.gateway.name,
    protocol: row.gateway.protocol,
    modelId: row.modelId,
    capability: row.capability,
  }));
}

export async function recordTestResult(
  id: string,
  outcome: ConnectionTestOutcome,
  message: string,
  at: Date = new Date(),
): Promise<void> {
  await getDb().gateway.update({
    where: { id },
    data: { lastTestStatus: outcome, lastTestMessage: message, lastTestedAt: at },
  });
}
