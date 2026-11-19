/**
 * 连接测试的执行与结论翻译（docs/prd/02 MUST 6：真实请求，区分网络错误 / 鉴权失败 / 模型不被接受 / 配置错误）。
 * 纯逻辑，可用假 fetch 单测；数据库读写在 service.ts。
 */
import { findAdapter } from "./adapters";
import { ConnectionTestError, type ProbeDeps } from "./adapters/types";
import type { ConnectionTestOutcome, GatewayProtocol } from "./constants";
import { logger } from "@/lib/logger";

export interface ConnectionTestTarget {
  protocol: string;
  baseUrl: string;
  apiKey: string;
  modelId: string | null;
}

export interface ConnectionTestResult {
  outcome: ConnectionTestOutcome;
  ok: boolean;
  message: string;
}

export async function runConnectionTest(
  target: ConnectionTestTarget,
  deps: ProbeDeps = {},
): Promise<ConnectionTestResult> {
  const adapter = findAdapter(target.protocol);
  if (!adapter) {
    return {
      outcome: "config",
      ok: false,
      message: `不支持的接口形状：${target.protocol}`,
    };
  }

  try {
    const message = await adapter.probe(
      { baseUrl: target.baseUrl, apiKey: target.apiKey, modelId: target.modelId },
      deps,
    );
    return { outcome: "ok", ok: true, message };
  } catch (error) {
    if (error instanceof ConnectionTestError) {
      return { outcome: error.kind, ok: false, message: error.message };
    }
    // 未预期错误不把原始信息回给界面（可能带上游响应内容），只落日志。
    logger.error("连接测试失败：未预期的错误", { error });
    return {
      outcome: "config",
      ok: false,
      message: "连接测试失败（未预期的错误，详见服务端日志）",
    };
  }
}

/** 文本协议需要模型；服务层用这个从模型清单里挑。 */
export function pickProbeModelId(
  protocol: GatewayProtocol,
  models: readonly { modelId: string; capability: string }[],
): string | null {
  if (protocol === "magpie-mcp") return null;
  return models.find((model) => model.capability === "text")?.modelId ?? null;
}
