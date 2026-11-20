/**
 * 图片提取业务层（docs/prd/05-image-generation.md、ADR 0009）：
 * 提示词拼装、一图对一图的串行调用、进度上报、失败分类。
 * 落盘与写库仍由 generation 模块的 runner 负责。
 *
 * 「提取」不是「重绘」：提示词只搬运指定目标，不改结构、不美化（ADR 0009）。
 *
 * 三条边界：
 * 1. 一次任务里原图有 N 张就调 N 次上游，每次只带那一张（MUST 2）；串行、不留固定 sleep（SHOULD）。
 * 2. 单张失败不丢弃其它张：有成品就照常交出，失败原因写进阶段 `error`，任务算 `partial`（MUST 7）。
 * 3. `model` 只取自任务快照；快照里没有就省略，不自造模型名（MUST 5）。
 */
import { getEnv } from "@/lib/env";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
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
import { MagpieImageGenerator } from "./adapters/magpie-mcp";
import { MockImageGenerator } from "./adapters/mock";
import {
  IMAGE_ERROR_CODES,
  type GenerateImageInput,
  type ImageGenerator,
} from "./adapters/types";
import { compressForReferenceImage } from "./compress";
import { describeStageFailure } from "./failure";
import { buildImagePrompt } from "./prompt";
import { DEFAULT_IMAGE_SIZE, findExtractRequirement } from "./styles";

/** 图片 Agent 必须绑在 magpie 的图片 MCP 网关上（docs/prd/02「接口形状」）。 */
export const MAGPIE_IMAGE_PROTOCOL = "magpie-mcp";

/** 一次上游调用的摘要，写入 `generation_stage.meta`（MUST 9：模型名与耗时，不含密钥与图片内容）。 */
export interface ImageCallRecord {
  /** 第几张原图（从 1 开始）。 */
  index: number;
  sourceAssetId: string;
  ms: number;
  ok: boolean;
  errorCode?: string;
}

/** 一张原图失败的原因：同时进 `meta.failures` 与阶段 `error` 的消息里（AC-05-5）。 */
export interface ImageFailure {
  index: number;
  sourceAssetId: string;
  fileName: string;
  code: string;
  message: string;
}

export interface ImageGenerationMeta {
  model: string | null;
  calls: ImageCallRecord[];
  failures: ImageFailure[];
  totalMs: number;
}

export interface ImageGenerationResult {
  images: GeneratedImage[];
  meta: ImageGenerationMeta;
  /** 部分原图失败：阶段仍有产出，但原因要留在阶段 `error` 上（docs/prd/05 MUST 7）。 */
  partialError?: { code: string; message: string };
}

export interface ImageGenerationDeps {
  /** 单测注入：跳过网关密钥查询与真实上游。 */
  generator?: ImageGenerator;
  now?: () => number;
  /** 单测注入：跳过 sharp，直接把原图字节当成 base64 用。 */
  compress?: (bytes: Buffer) => Promise<string>;
}

export interface ImageGeneratorConfig {
  adapter: "real" | "mock";
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** 适配器选择只在这里：`service.ts` 之外没有第二处。 */
export function createImageGenerator(config: ImageGeneratorConfig): ImageGenerator {
  if (config.adapter === "mock") return new MockImageGenerator();

  return new MagpieImageGenerator({
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

/** 「第 2 张原图（b.png）失败：原因」——界面据此点名缺的是哪一张，不回显上游原文。 */
function describeFailure(failure: ImageFailure): string {
  return `第 ${failure.index} 张原图（${failure.fileName}）失败：${failure.message}`;
}

/** 部分成功时的阶段错误消息：点名失败的原图，并说明保留了几张（AC-05-5）。 */
export function describePartialFailure(
  failures: readonly ImageFailure[],
  total: number,
  kept: number,
): string {
  return `${failures.map(describeFailure).join("；")}。已保留 ${kept}/${total} 张成品`;
}

/**
 * 一图对一图（MUST 2、MUST 7）：
 *
 * - 按原图顺序逐张调用，每次只带那一张，期望回一张；
 * - 每处理完一张写一次进度（`{ done, total }`），界面据此显示「正在生图 第 k/N 张」；
 * - 单张失败只记下来，继续下一张；一张都没成功才把整阶段判失败（docs/prd/04 MUST 3）；
 * - `sort_order` 用原图序号，第 2 张失败时保留 1 与 3（AC-05-5）。
 */
export async function generateImages(
  context: StageContext,
  deps: ImageGenerationDeps = {},
): Promise<ImageGenerationResult> {
  const snapshot = context.agents.image;
  const assets = context.collection.assets;
  const now = deps.now ?? Date.now;
  const compress = deps.compress ?? compressForReferenceImage;

  if (assets.length === 0) {
    throw new StageError(IMAGE_ERROR_CODES.rejected, "资源夹里没有原始图片，无法提取素材图");
  }

  // 提取目标在创建任务时就固化进快照；这里读快照，不读资源夹的当前值（全局规则 3）。
  // ADR 0009 之前的旧任务没有这一项：如实拒绝并指向「重新生成」，不拿空目标去调上游。
  const extractTarget = context.agents.extractTarget?.trim();
  if (!extractTarget) {
    throw new StageError(
      IMAGE_ERROR_CODES.rejected,
      "该任务创建时没有提取目标，无法提取；请先在资源夹里填写「提取目标」，再用「重新生成」重新发起",
    );
  }

  const generator = deps.generator ?? (await resolveImageGenerator(snapshot));

  const prompt = buildImagePrompt({
    agents: snapshot,
    extractTarget,
    extractRequirement: context.params.extractRequirement,
    extraPrompt: context.params.extraPrompt,
  });
  // 尺寸取自提取要求的登记表（docs/prd/05 SHOULD）；上游可选，省缺就用它的默认。
  const size = findExtractRequirement(context.params.extractRequirement)?.size ?? DEFAULT_IMAGE_SIZE;
  const model = snapshot.modelId ?? null;
  const total = assets.length;

  const startedAt = now();
  const calls: ImageCallRecord[] = [];
  const failures: ImageFailure[] = [];
  const images: GeneratedImage[] = [];

  const buildMeta = (): ImageGenerationMeta => ({
    model,
    calls,
    failures,
    totalMs: now() - startedAt,
  });

  await context.reportProgress({ done: 0, total });

  for (const [offset, asset] of assets.entries()) {
    const index = offset + 1;

    // 阶段被中止（超时、服务停止）时不再继续下一张：否则要等 N 次上游超时。
    if (context.signal.aborted) {
      throw new StageError(STAGE_ERROR_CODES.timeout, "阶段已中止，停止继续提取", {
        meta: { ...buildMeta() },
      });
    }

    const callStartedAt = now();
    try {
      const source = await context.readSourceImage(asset.id);
      const image = await compress(source.bytes);
      const generated = await generator.generate(
        { prompt, image, size, model } satisfies GenerateImageInput,
        { signal: context.signal },
      );

      const first = generated[0];
      if (!first) {
        throw new StageError(
          IMAGE_ERROR_CODES.rejected,
          `上游没有返回第 ${index} 张原图的提取图`,
        );
      }

      images.push({ ...first, sortOrder: index, sourceAssetId: asset.id });
      calls.push({ index, sourceAssetId: asset.id, ms: now() - callStartedAt, ok: true });
    } catch (error) {
      if (context.signal.aborted) {
        throw new StageError(STAGE_ERROR_CODES.timeout, "阶段已中止，停止继续提取", {
          meta: { ...buildMeta() },
        });
      }

      const code = errorCodeOf(error);
      const message = describeStageFailure(error);
      failures.push({ index, sourceAssetId: asset.id, fileName: asset.fileName, code, message });
      calls.push({
        index,
        sourceAssetId: asset.id,
        ms: now() - callStartedAt,
        ok: false,
        errorCode: code,
      });
      // 上游原文已在适配器记过日志；这里补「哪一张、哪个码」与这条异常的原始说明（脱敏由 logger 负责），
      // 绝不记 base64 与密钥（MUST 9）。内部异常（TypeError 等）的英文原文只在这一行出现。
      logger.warn("原图提取失败", {
        index,
        sourceAssetId: asset.id,
        code,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    await context.reportProgress({ done: index, total });
  }

  const meta = buildMeta();

  if (images.length === 0) {
    throw new StageError(
      failures[0]?.code ?? IMAGE_ERROR_CODES.rejected,
      `全部 ${total} 张原图都未提取出素材图：${failures.map(describeFailure).join("；")}，阶段未产出结果`,
      { meta: { ...meta } },
    );
  }

  // 调用摘要进日志（MUST 9）：只有模型名、张数与耗时，没有密钥与图片内容。
  logger.info("生图阶段上游调用完成", {
    model,
    total,
    succeeded: images.length,
    failed: failures.length,
    totalMs: meta.totalMs,
  });

  if (failures.length === 0) return { images, meta };

  return {
    images,
    meta,
    partialError: {
      code: IMAGE_ERROR_CODES.partial,
      message: describePartialFailure(failures, total, images.length),
    },
  };
}

