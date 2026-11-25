/**
 * 提取处理器（docs/prd/12 MUST 2、MUST 2b / 2c / 2d、ADR 0011）：
 * 勾选的原图 × 选中的类别，逐项**先判定再提取**。
 *
 * 边界：
 * 1. 提取粒度 = 原图 × 类别：N 张原图、M 个类别 → 最多 N×M 个条目，`progress.total` 就是 N×M；
 * 2. **两段式**：每个条目先调视觉模型判定「这张图里有没有这个目标」，判定不存在就记 `skipped`
 *    并保存模型原话，**不发起图生图**（MUST NOT 跳过判定直接提取，会产生幻觉素材）；
 * 3. 单项失败不丢弃其它项：有产出的照常交出，失败项连同原因一起交出去（整体记 partial）；
 * 4. `model` 只取自 Agent 快照；快照里没有就省略，不自造模型名；
 * 5. 输出比例跟随原图（`deriveExtractionSize`），不再固定 1024×1536；
 * 6. 图生图前先向视觉模型要一句材质描述，作为 `Material:` 段拼进提示词；拿不到就跳过该段、
 *    **不阻断**提取（MKACG-1000、AC-PROMPT-3）；
 * 7. 落盘与写库不在这里（提取模块的 runner 负责），本文件只交图片、跳过项与失败清单。
 */
import { logger } from "@/lib/logger";
import { StageError } from "@/lib/job-failure";
import type { VisionAnalyzer } from "@/modules/gateway/vision";
import type { ImageGenerator } from "./adapters/types";
import { compressForReferenceImage, readImageDimensions } from "./compress";
import { describeStageFailure } from "./failure";
import { buildMaterialPrompt, parseMaterialDescription } from "./material";
import { buildImagePrompt } from "./prompt";
import { resolveImageGenerator, resolveVisionAnalyzer } from "./service";
import { buildExistencePrompt, deriveExtractionSize, parseExistenceVerdict } from "./vision-judgment";
import { IMAGE_ERROR_CODES } from "./adapters/types";
import { EXTRACTION_ERROR_CODES, LIBRARY_COPY } from "@/modules/extraction/constants";
import type {
  ExtractedImage,
  ExtractionContext,
  ExtractionFailure,
  ExtractionHandler,
  ExtractionOutcome,
  ExtractionSkip,
  SourceAssetRef,
} from "@/modules/extraction/types";

export interface ExtractionHandlerDeps {
  /** 单测注入：跳过网关密钥查询与真实上游。 */
  generator?: ImageGenerator;
  /**
   * 单测注入：两段式判定用的视觉客户端。`null` 表示没有可用的理解网关。
   * 不传时按 `GENERATION_ADAPTER` 现取（mock 模式给脚本化的假实现）。
   */
  vision?: VisionAnalyzer | null;
  /** 单测注入：跳过 sharp，直接把原图字节当成 base64 用。 */
  compress?: (bytes: Buffer) => Promise<string>;
  /** 单测注入：跳过 sharp，直接给出原图像素尺寸。 */
  readSize?: (bytes: Buffer) => Promise<{ width: number; height: number }>;
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
 * 第一段：问视觉模型「这张图里有没有这个目标」。
 *
 * 没有理解网关、上游报错、回复里没有「存在 / 不存在」的结论，都按失败处理 ——
 * 猜一个结论的代价是产出一张不存在的图案，比失败更糟（ADR 0011 第 2 条）。
 */
async function judgeExistence(
  vision: VisionAnalyzer | null,
  image: string,
  category: string,
  signal: AbortSignal,
): Promise<{ exists: boolean; reason: string }> {
  if (!vision) {
    throw new StageError(
      EXTRACTION_ERROR_CODES.visionFailed,
      "没有配置图片理解网关（magpie-vision），无法判定目标是否存在；请到设置页添加该网关",
    );
  }

  let text: string;
  try {
    text = await vision.analyzeImage({ image, prompt: buildExistencePrompt(category) }, { signal });
  } catch (error) {
    // 视觉客户端的消息已经是中文可读说明（`VisionError`），原样交给失败清单。
    throw new StageError(
      EXTRACTION_ERROR_CODES.visionFailed,
      error instanceof Error ? error.message : "图片理解网关没能完成判定",
      { cause: error },
    );
  }

  const verdict = parseExistenceVerdict(text);
  if (!verdict) {
    throw new StageError(
      EXTRACTION_ERROR_CODES.visionFailed,
      `${LIBRARY_COPY.undecidedVerdict}（模型原话：${text.trim().slice(0, 200)}）`,
    );
  }
  return verdict;
}

/**
 * 两段式提示词的第一段：问视觉模型要一句材质描述（MKACG-1000）。
 *
 * 与判定不同，**拿不到就跳过整段**：没有理解网关、上游报错、回复空白都只记一条日志，
 * 返回 `null`，图生图照常发起（AC-PROMPT-3）。判定失败必须记失败，因为那会产出幻觉素材；
 * 材质描述缺失只是少一句补充说明，不值得让一条本来能成的素材失败。
 */
async function describeMaterial(
  vision: VisionAnalyzer | null,
  image: string,
  category: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!vision) return null;

  try {
    const text = await vision.analyzeImage(
      { image, prompt: buildMaterialPrompt(category) },
      { signal },
    );
    return parseMaterialDescription(text);
  } catch (error) {
    // 只记「哪一张、哪个类别、什么原因」，绝不记 base64 与密钥（docs/prd/05 MUST 9）。
    logger.warn("材质描述没拿到，跳过该段", {
      category,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 一张原图准备好的一次性输入：字节压缩结果与按长宽比推导的尺寸，同一张原图的多个类别共用。 */
interface PreparedSource {
  image: string;
  size: string;
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
  const vision = deps.vision !== undefined ? deps.vision : await resolveVisionAnalyzer(context.extraPrompt);
  const compress = deps.compress ?? compressForReferenceImage;
  const readSize = deps.readSize ?? readImageDimensions;
  const model = context.agent.modelId ?? null;
  const total = assets.length * categories.length;

  const images: ExtractedImage[] = [];
  const failures: ExtractionFailure[] = [];
  const skipped: ExtractionSkip[] = [];
  let done = 0;

  await context.reportProgress({ done, total });

  for (const [offset, asset] of assets.entries()) {
    // 原图字节每张只读一次：同一张原图的多个类别共用压缩结果与尺寸。
    let prepared: PreparedSource | null = null;
    let prepareError: unknown = null;
    try {
      const source = await context.readSourceImage(asset.id);
      const [image, dimensions] = await Promise.all([compress(source.bytes), readSize(source.bytes)]);
      prepared = { image, size: deriveExtractionSize(dimensions.width, dimensions.height) };
    } catch (error) {
      prepareError = error;
    }

    for (const category of categories) {
      // 运行被中止（超时、服务停止）时不再继续下一项：否则要等 N×M 次上游超时。
      if (context.signal.aborted) {
        throw new StageError(EXTRACTION_ERROR_CODES.timeout, "提取已中止，停止继续调用");
      }

      try {
        if (prepareError) throw prepareError;
        if (!prepared) {
          throw new StageError(
            EXTRACTION_ERROR_CODES.jobFailed,
            `读不到原图「${asset.fileName}」的字节`,
          );
        }

        // 第一段：判定目标是否存在。不存在就记 skipped，不消耗生图调用（MUST 2b、AC-LIB-11）。
        const verdict = await judgeExistence(vision, prepared.image, category, context.signal);
        if (!verdict.exists) {
          skipped.push({
            category,
            sourceAssetId: asset.id,
            reason: verdict.reason,
          });
        } else {
          // 图生图之前先要一句材质描述，拿不到就跳过该段，不阻断（AC-PROMPT-3）。
          const material = await describeMaterial(vision, prepared.image, category, context.signal);
          // 第二段：判定存在才发起图生图，提示词按该类别描述拼装。
          const prompt = buildImagePrompt({
            agents: context.agent,
            category,
            extractRequirement: context.requirement,
            material,
            extraPrompt: context.extraPrompt,
          });
          const generated = await generator.generate(
            { prompt, image: prepared.image, size: prepared.size, model },
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
        }
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
    skipped: skipped.length,
    failed: failures.length,
  });

  return { images, failures, skipped };
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
