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
 * 7. 落盘与写库不在这里（提取模块的 runner 负责），本文件只交图片、跳过项与失败清单；
 * 8. 新通道（REST + `watermark:false`）出图本身不带水印，**不再做裁切后处理**（MKACG-1008
 *    AC-REST-3）：那一步会无条件裁掉底部 10% 再用采样色补回，属真实内容损失。
 *    `watermark.ts` 与它的安全检测保留为兜底，只在单测显式注入时才执行。
 * 9. **几何矫正的产物不经模型**（MKACG-1001 MUST、AC-QUAD-9、AC-QUAD-10）：原图已框选
 *    「图案四个角」时，`graphic` 类别的产物就是单应矫正后的裁切图 —— 连视觉判定与材质描述
 *    都不调用，纯代码路径，所以文字与角色必然原样、两次运行字节一致。
 *    框选「桌面四个角」时，矫正图只当 `topdown` / `texture` 的**模型输入**（`graphic` 不动）。
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
import { WATERMARK_NOTES, type WatermarkRemovalResult } from "./watermark";
import { IMAGE_ERROR_CODES } from "./adapters/types";
import { extractionItemKey } from "@/modules/extraction/item-key";
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
  /**
   * 单测注入：产物去水印的后处理。**默认不注入** —— 新通道（REST + `watermark:false`）
   * 出图本身不带水印，裁切后处理默认不执行（MKACG-1008 AC-REST-3）。
   * 注入了就照注入的做：抛错不阻断提取，调用方保留原图、记 warn、把素材标成「未去水印」
   * （AC-WM-4）。
   */
  watermark?: (bytes: Buffer) => Promise<WatermarkRemovalResult>;
  /** 单测注入：跳过 sharp，直接给出原图像素尺寸。 */
  readSize?: (bytes: Buffer) => Promise<{ width: number; height: number }>;
}

function errorCodeOf(error: unknown): string {
  return error instanceof StageError ? error.code : EXTRACTION_ERROR_CODES.jobFailed;
}

/**
 * 下一格（原图 × 类别）的键：同一张原图的下一个类别，否则下一张原图的第一个类别。
 * 全部轮完时返回 null（调用方会把「正在处理」留在最后一格，运行进终态时由终态写入清空）。
 */
function nextItemKey(
  assets: readonly SourceAssetRef[],
  categories: readonly string[],
  assetIndex: number,
  categoryIndex: number,
): string | null {
  const category = categories[categoryIndex + 1];
  if (category !== undefined) {
    return extractionItemKey(assets[assetIndex].id, category);
  }
  const nextAsset = assets[assetIndex + 1];
  return nextAsset ? extractionItemKey(nextAsset.id, categories[0] ?? "") : null;
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

/** 一次去水印的结果：`bytes` 是要落盘的字节，`removed`/`note` 原样写进素材记录。 */
interface WatermarkOutcome {
  bytes: Buffer;
  removed: boolean;
  note: string | null;
}

/**
 * 出图后、入库前去一次上游水印（MKACG-1004）。新通道下**默认不调用**（MKACG-1008）：
 *
 * 三种结局都不阻断提取：
 * - 去掉了：用处理后的字节，`note` 为空；
 * - 安全检测拒绝（主体已进入底部条带）：保留原图，带上原因（AC-WM-3）；
 * - 后处理抛错（解码失败、格式不受支持）：保留原图，带上原因并记 warn（AC-WM-4）。
 *
 * 只记「哪一张、哪个类别、什么原因」，绝不记图片字节与密钥（docs/prd/05 MUST 9）。
 */
async function removeWatermark(
  bytes: Buffer,
  remove: (source: Buffer) => Promise<WatermarkRemovalResult>,
  item: { sourceAssetId: string; category: string },
): Promise<WatermarkOutcome> {
  try {
    const result = await remove(bytes);
    if (result.removed) return { bytes: result.bytes, removed: true, note: null };
    logger.warn("产物没有去掉上游水印，已保留原图", {
      ...item,
      reason: result.note,
      subjectRatio: result.subjectRatio,
    });
    return { bytes, removed: false, note: result.note };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn("去水印后处理失败，已保留原图", { ...item, reason });
    return { bytes, removed: false, note: WATERMARK_NOTES.failed(reason) };
  }
}

/** 一张原图准备好的一次性输入：字节压缩结果与按长宽比推导的尺寸，同一张原图的多个类别共用。 */
interface PreparedSource {
  /** 传给上游的 `data:` URL。 */
  image: string;
  /** 上游输出尺寸（`1536x1024`），按这张图的真实长宽比推导。 */
  size: string;
  /** 原像素字节：几何矫正的产物直接用它入库，不经过模型。 */
  bytes: Buffer;
  /** 像素尺寸。 */
  width: number;
  height: number;
}

/** 一张原图的两种输入：原图 + （已框选时的）矫正图。用不到的那一份为 null。 */
interface PreparedAssetSource {
  original: PreparedSource | null;
  /** 没框选、还是矫正图读不到：为 null，模型路径退回原图。 */
  rectified: PreparedSource | null;
}

/**
 * 这张原图在这个类别上怎么用矫正图（MKACG-1001）：
 * - `direct`：产物**就是**矫正图，全程不调用模型（图案四角 × 形象设计）；
 * - `input`：矫正图当成模型输入（桌面四角 × 俯视图 / 纹理）；
 * - `none`：用原图。
 *
 * 用途与类别不匹配时退回 `none`：框了图案却要俯视图，拿图案的裁切图喂模型只会更糟。
 */
function rectificationMode(
  asset: SourceAssetRef,
  category: string,
): "direct" | "input" | "none" {
  if (asset.rectifiedKind === "pattern" && category === "graphic") return "direct";
  if (asset.rectifiedKind === "surface" && (category === "topdown" || category === "texture")) {
    return "input";
  }
  return "none";
}

/** 压缩一张图并推导上游输出尺寸。几何矫正直接入库时不需要压缩，只读尺寸。 */
async function prepareSource(
  bytes: Buffer,
  compress: (source: Buffer) => Promise<string>,
  readSize: (source: Buffer) => Promise<{ width: number; height: number }>,
  options: { compress: boolean } = { compress: true },
): Promise<PreparedSource> {
  const [dimensions, image] = await Promise.all([
    readSize(bytes),
    options.compress ? compress(bytes) : Promise.resolve(""),
  ]);
  return {
    image,
    size: deriveExtractionSize(dimensions.width, dimensions.height),
    bytes,
    width: dimensions.width,
    height: dimensions.height,
  };
}

/**
 * 一张原图的两种输入各准备一次；矫正图读不到不当失败，只是没有它。
 *
 * 只压缩真的会当模型输入的那一份：几何矫正的产物直接入库，不需要 `data:` URL，
 * 白压缩一次 1536² 的图在批量提取里是实打实的浪费。
 */
async function prepareAsset(
  context: ExtractionContext,
  asset: SourceAssetRef,
  categories: readonly string[],
  compress: (source: Buffer) => Promise<string>,
  readSize: (source: Buffer) => Promise<{ width: number; height: number }>,
): Promise<PreparedAssetSource> {
  const modes = categories.map((category) => rectificationMode(asset, category));
  const rectifiedBytes = modes.some((mode) => mode === "input")
    ? await context.readRectifiedImage(asset.id)
    : null;

  // 原图在「有类别要用原图」或「矫正图读不到（退回原图）」时才需要。
  const needsOriginal = modes.some((mode) => mode !== "input") || rectifiedBytes === null;
  const original = needsOriginal
    ? await prepareSource((await context.readSourceImage(asset.id)).bytes, compress, readSize)
    : null;
  const rectified = rectifiedBytes
    ? await prepareSource(rectifiedBytes.bytes, compress, readSize)
    : null;

  return { original, rectified };
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
  // 裁切后处理默认关掉：REST + watermark:false 的产物本身没有水印（MKACG-1008 AC-REST-3）。
  const watermark = deps.watermark ?? null;
  const model = context.agent.modelId ?? null;
  const total = assets.length * categories.length;

  const images: ExtractedImage[] = [];
  const failures: ExtractionFailure[] = [];
  const skipped: ExtractionSkip[] = [];
  let done = 0;

  // 第一格已经开始：界面据此把这一格显示成「处理中」，同一次运行里其余格子显示「等待中」（MKACG-999）。
  await context.reportProgress({ done, total }, extractionItemKey(assets[0].id, categories[0] ?? ""));

  for (const [offset, asset] of assets.entries()) {
    // 原图与矫正图每张各准备一次：同一张原图的多个类别共用压缩结果与尺寸。
    let prepared: PreparedAssetSource | null = null;
    let prepareError: unknown = null;
    try {
      prepared = await prepareAsset(context, asset, categories, compress, readSize);
    } catch (error) {
      prepareError = error;
    }

    for (const [categoryIndex, category] of categories.entries()) {
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

        const mode = rectificationMode(asset, category);

        if (mode === "direct") {
          // MUST（AC-QUAD-9、AC-QUAD-10）：几何矫正的原样产物。这里**不调用任何模型** ——
          // 不判定、不要材质描述、不生图，所以文字与角色与原图逐字一致，两次运行字节完全一致。
          const geometry = await context.readRectifiedImage(asset.id);
          if (!geometry) {
            throw new StageError(
              EXTRACTION_ERROR_CODES.jobFailed,
              `原图「${asset.fileName}」的矫正图读不到，请重新保存四个角后再提取`,
            );
          }
          const dimensions = await readSize(geometry.bytes);
          images.push({
            bytes: geometry.bytes,
            mimeType: geometry.mimeType,
            width: dimensions.width,
            height: dimensions.height,
            category,
            sourceAssetId: asset.id,
            // 序号用原图位置：同一张原图的多个类别共用同一个序号，界面据此对上来源原图。
            sortOrder: offset + 1,
            // 原像素的重采样结果：没有模型参与，也没有上游水印。
            watermarkRemoved: true,
            watermarkNote: null,
            source: "rectified",
          });
        } else {
          // 桌面四角已框选时，俯视图与纹理用矫正图当模型输入：比例与正视图都由代码保证。
          const input = (mode === "input" ? prepared.rectified : null) ?? prepared.original;
          if (!input) {
            throw new StageError(
              EXTRACTION_ERROR_CODES.jobFailed,
              `读不到原图「${asset.fileName}」的字节`,
            );
          }

          // 第一段：判定目标是否存在。不存在就记 skipped，不消耗生图调用（MUST 2b、AC-LIB-11）。
          const verdict = await judgeExistence(vision, input.image, category, context.signal);
          if (!verdict.exists) {
            skipped.push({
              category,
              sourceAssetId: asset.id,
              reason: verdict.reason,
            });
          } else {
            // 图生图之前先要一句材质描述，拿不到就跳过该段，不阻断（AC-PROMPT-3）。
            const material = await describeMaterial(vision, input.image, category, context.signal);
            // 第二段：判定存在才发起图生图，提示词按该类别描述拼装。
            const prompt = buildImagePrompt({
              agents: context.agent,
              category,
              extractRequirement: context.requirement,
              material,
              extraPrompt: context.extraPrompt,
            });
            const generated = await generator.generate(
              { prompt, image: input.image, size: input.size, model },
              { signal: context.signal },
            );

            const first = generated[0];
            if (!first) {
              throw new StageError(
                IMAGE_ERROR_CODES.rejected,
                `上游没有返回原图「${asset.fileName}」的提取图`,
              );
            }
            // 产物本身没有水印（REST + watermark:false），默认原样入库；
            // 只有单测显式注入后处理时才走裁切（AC-REST-3、AC-WM-3、AC-WM-4）。
            const removal: WatermarkOutcome = watermark
              ? await removeWatermark(first.bytes, watermark, { sourceAssetId: asset.id, category })
              : { bytes: first.bytes, removed: true, note: null };

            images.push({
              ...first,
              bytes: removal.bytes,
              watermarkRemoved: removal.removed,
              watermarkNote: removal.note,
              category,
              sourceAssetId: asset.id,
              sortOrder: offset + 1,
              // 模型产物：界面必须标成「模型提取（可能重画）」（AC-QUAD-11）。
              source: "model",
            });
          }
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
      // 一项做完就写进度，并把「正在处理」指向下一格：界面上的「处理中」随之换位（AC-PROG-2）。
      // 最后一格做完后仍指向它，直到运行进终态时清空 —— 运行期间始终恰好一格「处理中」。
      await context.reportProgress(
        { done, total },
        nextItemKey(assets, categories, offset, categoryIndex) ??
          extractionItemKey(asset.id, category),
      );
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
