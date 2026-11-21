/**
 * 图片提取的适配器选择（docs/prd/02「接口形状」、docs/prd/05）。
 *
 * 本文件只负责「这一次提取用哪个出图实现」：真实网关还是 mock。
 * 循环调用、进度上报与失败分类在 `extraction.ts`；落盘与写库在提取模块的 runner。
 */
import { getEnv } from "@/lib/env";
import { isAppError } from "@/lib/errors";
import { StageError } from "@/lib/job-failure";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import {
  getGatewayExecutionTarget,
  type GatewayExecutionTarget,
} from "@/modules/gateway/service";
import { MagpieImageGenerator } from "./adapters/magpie-mcp";
import { MockImageGenerator } from "./adapters/mock";
import { IMAGE_ERROR_CODES, type ImageGenerator } from "./adapters/types";

/** 图片 Agent 必须绑在 magpie 的图片 MCP 网关上（docs/prd/02「接口形状」）。 */
export const MAGPIE_IMAGE_PROTOCOL = "magpie-mcp";

export interface ImageGeneratorConfig {
  adapter: "real" | "mock";
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** 适配器选择只在这里：`extraction.ts` 之外没有第二处。 */
export function createImageGenerator(config: ImageGeneratorConfig): ImageGenerator {
  if (config.adapter === "mock") return new MockImageGenerator();

  return new MagpieImageGenerator({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
  });
}

/**
 * 按 Agent 快照挑出这次提取要用的适配器：
 * 先确认绑的是 magpie 图片 MCP，再按 `gateway_id` 取解密后的密钥（AI 配置里不存密钥）。
 */
export async function resolveImageGenerator(snapshot: AgentSnapshot): Promise<ImageGenerator> {
  if (getEnv().GENERATION_ADAPTER === "mock") {
    return createImageGenerator({ adapter: "mock", baseUrl: "", apiKey: "" });
  }

  if (snapshot.protocol !== MAGPIE_IMAGE_PROTOCOL) {
    throw new StageError(
      IMAGE_ERROR_CODES.rejected,
      "图片 Agent 绑定的网关不是「magpie 图片 MCP」，请到设置页改成该接口形状",
    );
  }

  let target: GatewayExecutionTarget;
  try {
    target = await getGatewayExecutionTarget(snapshot.gatewayId);
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") {
      throw new StageError(
        IMAGE_ERROR_CODES.rejected,
        "图片 Agent 绑定的网关已不存在，请到设置页重新选择网关",
        { cause: error },
      );
    }
    throw new StageError(
      IMAGE_ERROR_CODES.auth,
      "读不到网关密钥，请到设置页重新填写 API Key",
      { cause: error },
    );
  }

  if (target.protocol !== MAGPIE_IMAGE_PROTOCOL) {
    throw new StageError(
      IMAGE_ERROR_CODES.rejected,
      "图片 Agent 绑定的网关不是「magpie 图片 MCP」，请到设置页改成该接口形状",
    );
  }

  return createImageGenerator({
    adapter: "real",
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
  });
}
