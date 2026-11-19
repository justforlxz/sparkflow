/**
 * 网关的对外形状：接口与页面只见到这一层。
 * 这里没有 `encryptedApiKey`，也没有解密后的明文 —— 密钥只有掩码与 `hasApiKey`（MUST 1）。
 */
import { describeSecret } from "@/lib/crypto";
import {
  CONNECTION_FAILURE_LABELS,
  type ConnectionFailureKind,
  type ConnectionTestOutcome,
} from "./constants";
import type { GatewayModelRecord, GatewayRecord } from "./repo";
import type { GatewayReference } from "./references";

export interface GatewayModelView {
  id: string;
  modelId: string;
  capability: string;
}

export interface ConnectionTestView {
  outcome: ConnectionTestOutcome;
  ok: boolean;
  /** 失败类别的说法（网络错误 / 鉴权失败 / 模型不可用 / 配置错误），成功时为 null。 */
  failureLabel: string | null;
  message: string;
  testedAt: string | null;
}

export interface GatewayView {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  /** 密钥掩码，例如 `••••a1b2`。 */
  apiKeyMask: string;
  hasApiKey: boolean;
  models: GatewayModelView[];
  /** 被哪些 Agent 引用；被引用的网关不能删除。 */
  references: GatewayReference[];
  lastTest: ConnectionTestView | null;
}

function failureLabelOf(outcome: ConnectionTestOutcome): string | null {
  if (outcome === "ok") return null;
  return CONNECTION_FAILURE_LABELS[outcome as ConnectionFailureKind] ?? null;
}

function toModelView(model: GatewayModelRecord): GatewayModelView {
  return { id: model.id, modelId: model.modelId, capability: model.capability };
}

export function toGatewayView(
  record: GatewayRecord,
  references: GatewayReference[] = [],
): GatewayView {
  const secret = describeSecret(record.encryptedApiKey);
  const outcome = (record.lastTestStatus ?? null) as ConnectionTestOutcome | null;

  return {
    id: record.id,
    name: record.name,
    protocol: record.protocol,
    baseUrl: record.baseUrl,
    apiKeyMask: secret.mask,
    hasApiKey: secret.hasApiKey,
    models: record.models.map(toModelView),
    references,
    lastTest:
      outcome && record.lastTestMessage
        ? {
            outcome,
            ok: outcome === "ok",
            failureLabel: failureLabelOf(outcome),
            message: record.lastTestMessage,
            testedAt: record.lastTestedAt ? record.lastTestedAt.toISOString() : null,
          }
        : null,
  };
}
