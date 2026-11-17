/**
 * 网关业务层：接口与页面只调用这里的函数（docs/prd/02-model-gateway.md）。
 *
 * 三条边界必须守住：
 * 1. 明文密钥不出本层：写入时加密，读取时只给掩码（`view.ts`）。
 * 2. 编辑时密钥留空 = 保留原密钥，不因空字段清空（MUST 2）。
 * 3. 被 Agent 引用的网关不能删（MUST 3），引用查询点见 `references.ts`。
 */
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { pickProbeModelId, runConnectionTest, type ConnectionTestResult } from "./connection";
import {
  findProtocol,
  type GatewayProtocol,
  type ModelCapability,
} from "./constants";
import { findGatewayReferences, type GatewayReferenceLookup } from "./references";
import {
  createGatewayRecord,
  createModelRecord,
  deleteGatewayRecord,
  deleteModelRecord,
  findGateway,
  findModelRecord,
  listGateways,
  listModelsByCapability,
  recordTestResult,
  updateGatewayRecord,
  type GatewayModelCandidate,
  type GatewayRecord,
} from "./repo";
import type {
  CreateGatewayInput,
  CreateGatewayModelInput,
  UpdateGatewayInput,
} from "./schema";
import { toGatewayView, type GatewayView } from "./view";

function requireProtocol(protocol: string): GatewayProtocol {
  const definition = findProtocol(protocol);
  if (!definition) {
    throw AppError.validationFailed(`不支持的接口形状：${protocol}`, { protocol });
  }
  return definition.value as GatewayProtocol;
}

async function requireGateway(id: string): Promise<GatewayRecord> {
  const record = await findGateway(id);
  if (!record) throw AppError.notFound("网关不存在");
  return record;
}

async function toViewWithReferences(
  record: GatewayRecord,
  lookup: GatewayReferenceLookup,
): Promise<GatewayView> {
  return toGatewayView(record, await lookup(record.id));
}

export async function listGatewayViews(
  lookup: GatewayReferenceLookup = findGatewayReferences,
): Promise<GatewayView[]> {
  const records = await listGateways();
  return Promise.all(records.map((record) => toViewWithReferences(record, lookup)));
}

export async function getGatewayView(
  id: string,
  lookup: GatewayReferenceLookup = findGatewayReferences,
): Promise<GatewayView> {
  return toViewWithReferences(await requireGateway(id), lookup);
}

export async function createGateway(input: CreateGatewayInput): Promise<GatewayView> {
  requireProtocol(input.protocol);
  const record = await createGatewayRecord({
    name: input.name,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    encryptedApiKey: encryptSecret(input.apiKey),
  });
  return toGatewayView(record);
}

/**
 * 密钥字段省略或为空串都表示「保留原密钥」（MUST 2）。
 * 返回形状与列表一致，带上引用情况 —— 界面编辑保存后不该暂时以为网关未被引用。
 */
export async function updateGateway(
  id: string,
  input: UpdateGatewayInput,
  lookup: GatewayReferenceLookup = findGatewayReferences,
): Promise<GatewayView> {
  await requireGateway(id);
  if (input.protocol !== undefined) requireProtocol(input.protocol);

  const apiKey = input.apiKey?.trim();
  const record = await updateGatewayRecord(id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(apiKey ? { encryptedApiKey: encryptSecret(apiKey) } : {}),
  });
  return toViewWithReferences(record, lookup);
}

/**
 * 删除网关：被 Agent 引用时返回 409 并指出引用方（MUST 3、AC-02-4）。
 * 模型条目随外键级联删除（MUST 4）。
 * `lookup` 默认是 `references.findGatewayReferences`；N4 实现引用查询后自动生效，这里不改。
 */
export async function deleteGateway(
  id: string,
  lookup: GatewayReferenceLookup = findGatewayReferences,
): Promise<void> {
  const record = await requireGateway(id);
  const references = await lookup(record.id);

  if (references.length > 0) {
    const names = references.map((reference) => reference.name).join("、");
    throw new AppError("CONFLICT", `网关正被 ${names} 使用，请先解除绑定`, {
      details: { code: "GATEWAY_IN_USE", references },
    });
  }

  await deleteGatewayRecord(record.id);
}

export async function addGatewayModel(
  gatewayId: string,
  input: CreateGatewayModelInput,
): Promise<GatewayView> {
  await requireGateway(gatewayId);

  const existing = await findModelRecord(gatewayId, input.modelId);
  if (existing) {
    throw new AppError("CONFLICT", "该网关下已经有同名模型", {
      details: { code: "MODEL_EXISTS", modelId: input.modelId },
    });
  }

  await createModelRecord({
    gatewayId,
    modelId: input.modelId,
    capability: input.capability,
  });
  return getGatewayView(gatewayId);
}

export async function removeGatewayModel(
  gatewayId: string,
  modelId: string,
): Promise<GatewayView> {
  await requireGateway(gatewayId);
  const removed = await deleteModelRecord(gatewayId, modelId);
  if (removed === 0) throw AppError.notFound("模型不存在");
  return getGatewayView(gatewayId);
}

export interface GatewayTestResponse {
  gatewayId: string;
  result: ConnectionTestResult;
  lastTestedAt: string;
}

/** 连接测试：真实请求 + 落库最近一次结果（MUST 6、SHOULD）。 */
export async function testGatewayConnection(gatewayId: string): Promise<GatewayTestResponse> {
  const record = await requireGateway(gatewayId);
  const protocol = requireProtocol(record.protocol);

  let apiKey: string;
  try {
    apiKey = decryptSecret(record.encryptedApiKey);
  } catch (error) {
    logger.warn("网关密钥无法解密，连接测试无法进行", { error, gatewayId });
    const at = new Date();
    await recordTestResult(record.id, "config", "密钥无法解密，请重新填写 API Key", at);
    return {
      gatewayId: record.id,
      result: { outcome: "config", ok: false, message: "密钥无法解密，请重新填写 API Key" },
      lastTestedAt: at.toISOString(),
    };
  }

  const result = await runConnectionTest({
    protocol,
    baseUrl: record.baseUrl,
    apiKey,
    modelId: pickProbeModelId(protocol, record.models),
  });

  const testedAt = new Date();
  await recordTestResult(record.id, result.outcome, result.message, testedAt);

  return { gatewayId: record.id, result, lastTestedAt: testedAt.toISOString() };
}

/** Agent 候选：按能力跨网关筛（docs/prd/03 MUST 2，AC-02-5）。 */
export async function listCandidateModels(
  capability: ModelCapability,
): Promise<GatewayModelCandidate[]> {
  return listModelsByCapability([capability]);
}
