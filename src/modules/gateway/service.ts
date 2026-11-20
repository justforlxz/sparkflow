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
  findGatewayByProtocol,
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
import { MagpieVisionClient } from "./vision";

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

/**
 * 解密网关密钥（MUST 1、MUST 7）：明文只在本进程内用于发请求，不进日志与响应。
 *
 * 解密失败（密文被改、`AUTH_SECRET` 变更）统一抛 `UPSTREAM_FAILED`，
 * 由连接测试翻译成「配置错误」结论、由阶段处理器翻译成阶段错误码，两处不再各写一份。
 */
function decryptGatewayKey(record: GatewayRecord): string {
  try {
    return decryptSecret(record.encryptedApiKey);
  } catch (error) {
    logger.warn("网关密钥无法解密，密钥可能受 AUTH_SECRET 变更影响", { gatewayId: record.id });
    throw new AppError("UPSTREAM_FAILED", "网关密钥无法解密，请到设置页重新填写 API Key", {
      cause: error,
      details: { code: "GATEWAY_KEY_UNREADABLE" },
    });
  }
}

/** 连接测试：真实请求 + 落库最近一次结果（MUST 6、SHOULD）。 */
export async function testGatewayConnection(gatewayId: string): Promise<GatewayTestResponse> {
  const record = await requireGateway(gatewayId);
  const protocol = requireProtocol(record.protocol);

  let apiKey: string;
  try {
    apiKey = decryptGatewayKey(record);
  } catch {
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

/** 阶段执行时拿到的网关调用参数；密钥只在本进程内用于发请求，不写日志、不回响应。 */
export interface GatewayExecutionTarget {
  id: string;
  protocol: GatewayProtocol;
  baseUrl: string;
  apiKey: string;
}

/**
 * 阶段处理器取网关的调用参数（docs/prd/04 MUST 4「运行时只读快照 + 按 gateway_id 取密钥」）。
 *
 * 与连接测试共用同一套解密路径：明文密钥不出本进程，也不进阶段错误或日志。
 * 记录不存在时抛 `NOT_FOUND`，密钥无法解密时抛 `UPSTREAM_FAILED`，由调用方翻译成阶段错误码。
 */
export async function getGatewayExecutionTarget(gatewayId: string): Promise<GatewayExecutionTarget> {
  const record = await requireGateway(gatewayId);


  return {
    id: record.id,
    protocol: requireProtocol(record.protocol),
    baseUrl: record.baseUrl,
    apiKey: decryptGatewayKey(record),
  };
}

/** 图片理解网关的接口形状（docs/prd/02）：它不绑定到某个 Agent，属平台级能力。 */
export const VISION_PROTOCOL = "magpie-vision";

/**
 * 为视觉提取创建客户端（docs/prd/06「视觉提取」）：取最近更新的一条 `magpie-vision` 网关。
 *
 * 没有配置、或密钥读不出来时返回 `null`：调用方按「未包含照片内容」降级，
 * 不得改用文案模型猜图，也不得让整个文案阶段失败。
 */
export async function createVisionClient(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<MagpieVisionClient | null> {
  const record = await findGatewayByProtocol(VISION_PROTOCOL);
  if (!record) return null;

  let apiKey: string;
  try {
    apiKey = decryptGatewayKey(record);
  } catch {
    // 已由 decryptGatewayKey 记过日志；这里按「没有可用的理解网关」处理。
    return null;
  }

  return new MagpieVisionClient({
    baseUrl: record.baseUrl,
    apiKey,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}
