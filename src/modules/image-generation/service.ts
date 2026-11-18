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
  /** 这一批**要求**的张数：默认 `min(4, 剩余)`；上游拒绝一次多张之后降为 1。 */
  n: number;
  /** 上游这一批**实际**返回并采用的张数；失败的批次为 0。 */
  received: number;
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
 * - 上游一次给不满 n 张时，按**实际拿到的张数**继续要剩余的（真实网关的图片模型多数一次只出 1 张）；
 *   上游明确拒绝 n > 1 时，本阶段降到每批 1 张，不把「一次画不了 4 张」当成业务失败；
 * - 一张都没返回、或上游报错（超时 / 鉴权 / 格式 / 其它拒绝），整个阶段按失败处理
 *   （docs/prd/04 MUST 3：生图失败不创建结果），消息与 `meta` 如实写明已取回几张、第几批出了什么问题；
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
  // 本阶段实际可用的批次大小：默认 4；上游明确拒绝一次多张时降到 1，之后不再回升。
  let batchSize = MAX_IMAGES_PER_BATCH;

  const buildMeta = (): ImageGenerationMeta => ({
    model: baseInput.model,
    batches,
    totalMs: now() - startedAt,
  });

  /**
   * 发一次上游请求并记账。三种结果：
   * - 返回图片（可能不足 n 张）：照单收下，由调用方按实际张数继续要；
   * - 上游拒绝 n > 1：返回 "retry-with-single"，调用方把这一批降到 1 张再要一次；
   * - 其他失败，或一张都没返回：直接抛阶段错误（docs/prd/04 MUST 3）。
   */
  const callBatch = async (n: number): Promise<GeneratedImage[] | "retry-with-single"> => {
    const batchStartedAt = now();

    try {
      const batch = await generator.generate({ ...baseInput, n }, { signal: context.signal });
      const ms = now() - batchStartedAt;
      const kept = batch.slice(0, n);
      const record: ImageBatchRecord = { n, received: kept.length, ms, ok: kept.length > 0 };
      if (kept.length === 0) record.errorCode = IMAGE_ERROR_CODES.rejected;
      batches.push(record);

      if (kept.length === 0) {
        throw new StageError(
          IMAGE_ERROR_CODES.rejected,
          `第 ${batches.length} 批（${n} 张）上游没有返回图片。` +
            `已取回 ${images.length}/${requested} 张，阶段未产出结果`,
          { meta: { ...buildMeta() } },
        );
      }

      return kept;
    } catch (error) {
      // 上面那条「一张都没返回」已经带 meta，原样上抛，不再重复记一批。
      if (error instanceof StageError && error.meta) throw error;

      const ms = now() - batchStartedAt;
      const errorCode = errorCodeOf(error);
      batches.push({ n, received: 0, ms, ok: false, errorCode });

      // 真实网关的图片模型多数一次只出 1 张，有的还直接拒绝 n > 1（400 invalid n）：
      // 这是上游的出图粒度不同，不是业务失败，把这一批降到 1 张再要一次。
      if (n > 1 && errorCode === IMAGE_ERROR_CODES.rejected) return "retry-with-single";

      throw new StageError(
        errorCode,
        `第 ${batches.length} 批（${n} 张）失败：${reasonOf(error)}。` +
          `已取回 ${images.length}/${requested} 张，阶段未产出结果`,
        { meta: { ...buildMeta() }, cause: error },
      );
    }
  };

  while (remaining > 0) {
    let outcome = await callBatch(Math.min(batchSize, remaining));

    if (outcome === "retry-with-single") {
      batchSize = 1;
      outcome = await callBatch(1);
    }

    if (outcome === "retry-with-single") {
      // n = 1 不会再走降级分支；留一处兜底，避免把「没降级」当成产出。
      throw new StageError(STAGE_ERROR_CODES.stageFailed, "生图阶段无法确定批次结果", {
        meta: { ...buildMeta() },
      });
    }

    images.push(...outcome);
    remaining -= outcome.length;
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
