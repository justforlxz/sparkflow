/**
 * 提取处理器（docs/prd/12 MUST 2）：勾选的原图 × 选中的类别，逐项调一次上游。
 *
 * 边界：
 * 1. 提取粒度 = 原图 × 类别：N 张原图、M 个类别 → 最多 N×M 次调用，`progress.total` 就是 N×M；
 * 2. 单项失败不丢弃其它项：有产出的照常交出，失败项连同原因一起交出去（整体记 partial）；
 * 3. `model` 只取自 Agent 快照；快照里没有就省略，不自造模型名；
 * 4. 落盘与写库不在这里（提取模块的 runner 负责），本文件只交图片与失败清单。
 */
import { logger } from "@/lib/logger";
import { StageError } from "@/lib/job-failure";
import type { ImageGenerator } from "./adapters/types";
import { compressForReferenceImage } from "./compress";
import { describeStageFailure } from "./failure";
import { buildImagePrompt } from "./prompt";
import { resolveImageGenerator } from "./service";
import { DEFAULT_IMAGE_SIZE, findExtractRequirement } from "./styles";
import { IMAGE_ERROR_CODES } from "./adapters/types";
import {
  EXTRACTION_ERROR_CODES,
} from "@/modules/extraction/constants";
import type {
  ExtractedImage,
  ExtractionContext,
  ExtractionFailure,
  ExtractionHandler,
  ExtractionOutcome,
  SourceAssetRef,
} from "@/modules/extraction/types";

export interface ExtractionHandlerDeps {
  /** 单测注入：跳过网关密钥查询与真实上游。 */
  generator?: ImageGenerator;
  /** 单测注入：跳过 sharp，直接把原图字节当成 base64 用。 */
  compress?: (bytes: Buffer) => Promise<string>;
}

function errorCodeOf(error: unknown): string {
  return error instanceof StageError ? error.code : EXTRACTION_ERROR_CODES.jobFailed;
}

/** 按勾选顺序取原图：只处理本次运行勾选的，不处理整个资源夹。 */
function selectedAssets(context: ExtractionContext): SourceAssetRef[] {
  const byId = new Map(context.collection.assets.map((asset) => [asset.id, asset]));
  const selected: SourceAssetRef[] = [];
  for (const assetId of context.sourceAssetIds) {
    const asset = byId.get(assetId);
    // 原图在运行排队期间被解除关联：跳过这一项，不编造占位素材。
    if (asset) selected.push(asset);
  }
  return selected;
}

/**
 * 逐项提取：外层按原图、内层按类别，每次只带那一张原图与那个类别的目标。
 * 每处理完一项写一次进度，界面据此显示「正在提取 第 k/N 项」。
 */
export async function extractImages(
  context: ExtractionContext,
  deps: ExtractionHandlerDeps = {},
): Promise<ExtractionOutcome> {
  const assets = selectedAssets(context);
  const categories = context.categories;
  if (assets.length === 0) {
    throw new StageError(
      EXTRACTION_ERROR_CODES.jobFailed,
      "本次勾选的原图都已经不在资源夹里，无法提取；请重新勾选后发起",
    );
  }
  if (categories.length === 0) {
    throw new StageError(EXTRACTION_ERROR_CODES.jobFailed, "没有选择任何类别，无法提取");
  }

  const generator = deps.generator ?? (await resolveImageGenerator(context.agent));
  const compress = deps.compress ?? compressForReferenceImage;
  // 尺寸取自提取要求的登记表（docs/prd/05 SHOULD）；上游可选，省缺就用它的默认。
  const size = findExtractRequirement(context.requirement)?.size ?? DEFAULT_IMAGE_SIZE;
  const model = context.agent.modelId ?? null;
  const total = assets.length * categories.length;

  const images: ExtractedImage[] = [];
  const failures: ExtractionFailure[] = [];
  let done = 0;

  await context.reportProgress({ done, total });

  for (const [offset, asset] of assets.entries()) {
    for (const category of categories) {
      // 运行被中止（超时、服务停止）时不再继续下一项：否则要等 N×M 次上游超时。
      if (context.signal.aborted) {
        throw new StageError(EXTRACTION_ERROR_CODES.timeout, "提取已中止，停止继续调用");
      }

      const prompt = buildImagePrompt({
        agents: context.agent,
        category,
        extractRequirement: context.requirement,
        extraPrompt: context.extraPrompt,
      });

      try {
        const source = await context.readSourceImage(asset.id);
        const image = await compress(source.bytes);
        const generated = await generator.generate(
          { prompt, image, size, model },
          { signal: context.signal },
        );

        const first = generated[0];
        if (!first) {
          throw new StageError(
            IMAGE_ERROR_CODES.rejected,
            `上游没有返回原图「${asset.fileName}」的提取图`,
          );
        }

        images.push({
          ...first,
          category,
          sourceAssetId: asset.id,
          // 序号用原图位置：同一张原图的多个类别共用同一个序号，界面据此对上来源原图。
          sortOrder: offset + 1,
        });
      } catch (error) {
        if (context.signal.aborted) {
          throw new StageError(EXTRACTION_ERROR_CODES.timeout, "提取已中止，停止继续调用");
        }
        const code = errorCodeOf(error);
        const message = describeStageFailure(error);
        failures.push({
          category,
          sourceAssetId: asset.id,
          fileName: asset.fileName,
          code,
          message,
        });
        // 上游原文已在适配器记过日志；这里补「哪一张、哪个类别、哪个码」，
        // 绝不记 base64 与密钥（docs/prd/05 MUST 9）。
        logger.warn("单项提取失败", {
          sourceAssetId: asset.id,
          category,
          code,
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      done += 1;
      await context.reportProgress({ done, total });
    }
  }

  logger.info("提取调用完成", {
    model,
    total,
    succeeded: images.length,
    failed: failures.length,
  });

  return { images, failures };
}

/**
 * 造一个提取处理器。
 * `deps` 只给单测注入假适配器用；线上用默认参数，按 `GENERATION_ADAPTER` 选适配器。
 */
export function createExtractionHandler(deps: ExtractionHandlerDeps = {}): ExtractionHandler {
  return {
    run: (context) => extractImages(context, deps),
  };
}
