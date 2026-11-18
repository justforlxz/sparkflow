/**
 * 图片创作业务层（docs/prd/05-image-generation.md）：
 * 提示词拼装、分批调用、适配器选择、失败分类。落盘与写库仍由 generation 模块的 runner 负责。
 *
 * 三条边界：
 * 1. 批次大小固定 `min(4, 剩余张数)`（MUST 2），不认识上游的一次能画几张以外的任何约定。
 * 2. `model` 只取自任务快照；快照里没有就省略，不自造模型名（MUST 5）。
 * 3. 本版本不接收参考图；图生图入口先过功能开关（MUST NOT + AC-05-7）。
 */
import { getEnv } from "@/lib/env";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { requireEnabled } from "@/modules/feature-flags/service";
import {
  StageError,
  type GeneratedImage,
  type StageContext,
} from "@/modules/generation/types";
import { STAGE_ERROR_CODES } from "@/modules/generation/constants";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import {
  getGatewayExecutionTarget,
  type GatewayExecutionTarget,
} from "@/modules/gateway/service";
import { MagpieMcpImageGenerator } from "./adapters/magpie-mcp";
import { MockImageGenerator } from "./adapters/mock";
import {
  IMAGE_ERROR_CODES,
  type GenerateImageInput,
  type ImageGenerator,
} from "./adapters/types";
import { buildImagePrompt } from "./prompt";
import { DEFAULT_IMAGE_SIZE, findVisualStyle } from "./styles";

/** 上游一次最多画 4 张（docs/prd/05 MUST 2）。 */
export const MAX_IMAGES_PER_BATCH = 4;

/** 图片 Agent 必须绑在图片 MCP 网关上（docs/prd/02「接口形状」）。 */
export const MAGPIE_IMAGE_PROTOCOL = "magpie-mcp";

/** 每次上游调用的摘要，写入 `generation_stage.meta`（docs/prd/05「阶段元信息」）。 */
export interface ImageBatchRecord {
  n: number;
  ms: number;
  ok: boolean;
  errorCode?: string;
}

export interface ImageGenerationMeta {
  model: string | null;
  batches: ImageBatchRecord[];
  totalMs: number;
}

export interface ImageGenerationResult {
  images: GeneratedImage[];
  meta: ImageGenerationMeta;
}

export interface ImageGenerationDeps {
  /** 单测注入：跳过网关密钥查询与真实上游。 */
  generator?: ImageGenerator;
  now?: () => number;
}

export interface ImageGeneratorConfig {
  adapter: "real" | "mock";
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** 适配器选择只在这里：`service.ts` 与 `stages/index.ts` 之外没有第二处。 */
export function createImageGenerator(config: ImageGeneratorConfig): ImageGenerator {
  if (config.adapter === "mock") return new MockImageGenerator();

  return new MagpieMcpImageGenerator({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
  });
}

/**
 * 按任务快照挑出这次出图要用的适配器：
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

function errorCodeOf(error: unknown): string {
  return error instanceof StageError ? error.code : STAGE_ERROR_CODES.stageFailed;
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "上游返回了未知错误";
}

/**
 * 按批次出图（MUST 2、MUST 7）：
 *
 * - 每批 `n = min(4, 剩余张数)`，要 9 张就是 4 + 4 + 1 三次；
 * - 任何一批失败或张数不足，整个阶段按失败处理（docs/prd/04 MUST 3：生图失败不创建结果），
 *   失败消息与 `meta` 如实写明已取回几张、第几批出了什么问题；
 * - 成功时返回全部图片与调用摘要，落盘由 runner 完成。
 */
export async function generateImages(
  context: StageContext,
  deps: ImageGenerationDeps = {},
): Promise<ImageGenerationResult> {
  const snapshot = context.agents.image;
  const requested = context.params.imageCount;
  const now = deps.now ?? Date.now;

  const generator = deps.generator ?? (await resolveImageGenerator(snapshot));

  const style = findVisualStyle(context.params.visualStyle);
  const prompt = buildImagePrompt({
    agents: snapshot,
    visualStyle: context.params.visualStyle,
    extraPrompt: context.params.extraPrompt,
  });
  const baseInput = {
    prompt,
    size: style?.size ?? DEFAULT_IMAGE_SIZE,
    quality: null,
    model: snapshot.modelId ?? null,
  } satisfies Omit<GenerateImageInput, "n">;

  const startedAt = now();
  const batches: ImageBatchRecord[] = [];
  const images: GeneratedImage[] = [];
  let remaining = requested;

  while (remaining > 0) {
    const n = Math.min(MAX_IMAGES_PER_BATCH, remaining);
    const batchStartedAt = now();

    try {
      const batch = await generator.generate({ ...baseInput, n }, { signal: context.signal });
      const ms = now() - batchStartedAt;

      if (batch.length < n) {
        batches.push({
          n,
          ms,
          ok: false,
          errorCode: IMAGE_ERROR_CODES.rejected,
        });
        const meta: ImageGenerationMeta = {
          model: baseInput.model,
          batches,
          totalMs: now() - startedAt,
        };
        throw new StageError(
          IMAGE_ERROR_CODES.rejected,
          `第 ${batches.length} 批（${n} 张）只返回 ${batch.length} 张图片。` +
            `已取回 ${images.length}/${requested} 张，阶段未产出结果`,
          { meta: { ...meta } },
        );
      }

      images.push(...batch.slice(0, n));
      batches.push({ n, ms, ok: true });
      remaining -= n;
    } catch (error) {
      if (error instanceof StageError && error.meta) throw error;

      const ms = now() - batchStartedAt;
      const errorCode = errorCodeOf(error);
      batches.push({ n, ms, ok: false, errorCode });
      const meta: ImageGenerationMeta = {
        model: baseInput.model,
        batches,
        totalMs: now() - startedAt,
      };

      throw new StageError(
        errorCode,
        `第 ${batches.length} 批（${n} 张）失败：${reasonOf(error)}。` +
          `已取回 ${images.length}/${requested} 张，阶段未产出结果`,
        { meta: { ...meta }, cause: error },
      );
    }
  }

  const meta: ImageGenerationMeta = {
    model: baseInput.model,
    batches,
    totalMs: now() - startedAt,
  };
  // 调用摘要进日志（MUST 8）：只有模型名、张数与耗时，没有密钥与请求头。
  logger.info("生图阶段上游调用完成", meta);

  return { images, meta };
}

export interface ReferenceImageInput {
  /** 按原图重绘的说明文字。 */
  prompt: string;
  n: number;
  /** 参考图（本版本一律不接收）。 */
  referenceImages: string[];
}

/**
 * 图生图入口（docs/prd/05「本版本的范围边界」、AC-05-7）：
 * 先过功能开关，再明确拒绝。参考图永远不会交给出图适配器 —— 本版本的适配器也不接收参考图。
 */
export async function generateWithReferenceImages(input: ReferenceImageInput): Promise<never> {
  await requireEnabled("image-to-image");

  throw new StageError(
    IMAGE_ERROR_CODES.featureDisabled,
    `图生图在本版本未实现（收到 ${input.referenceImages.length} 张参考图）`,
  );
}
