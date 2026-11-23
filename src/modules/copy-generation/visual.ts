/**
 * 视觉提取（docs/prd/06「视觉提取」，ADR 0010）：生成文案前，对**每一张选中的素材**各做一次读图，
 * 按素材顺序编号得到一条中文描述。描述只围绕素材本身的材质、纹理、图案与颜色。
 *
 * 边界：
 * 1. 读图走**独立的图片理解网关**（`protocol = magpie-vision`，工具 `analyze_image`），
 *    不要求文案模型自己具备 `image_input`；
 * 2. 图片压缩与出图同一套（长边 ≤ 1536、JPEG、data URL）；
 * 3. 没配置理解网关、或某张识别失败时：不阻断文案，交回空描述 + 降级状态，
 *    由调用方在版本上标注「未包含照片内容」，不得改用文案模型猜图。
 */
import { logger } from "@/lib/logger";
import { categoryLabel } from "@/modules/extraction/categories";
import { compressForReferenceImage } from "@/modules/image-generation/compress";
import type { VisionAnalyzer } from "@/modules/gateway/vision";
import type { AssetImageBytes, SelectedAssetRef } from "./types";

/**
 * 每张素材的一条指令：聚焦素材本身的特征。
 * 类别决定问什么 —— 桌面俯视图问整体构图，基本纹理问质感，形象设计问图案。
 */
export function buildVisualExtractionInstruction(category: string): string {
  return `用中文写出这张「${categoryLabel(category)}」素材的材质、纹理、图案与颜色，两句话以内。`;
}

/** 单条描述的长度上限：只防超长输出，不改变语义。 */
export const MAX_VISUAL_DESCRIPTION_LENGTH = 500;

/**
 * 视觉提取的三种结局，写进 `copy_version.agent_snapshot` 之外的调用摘要：
 * - `done`：每张素材都拿到了描述；
 * - `skipped-no-vision-gateway`：设置里没有可用的理解网关；
 * - `skipped-vision-failed`：网关在，但识别失败（鉴权、超时、空回包等）。
 *
 * 后两种都必须在版本上标注「未包含照片内容」（不得静默降级，PRD 06）。
 */
export const VISUAL_EXTRACTION_STATES = {
  done: "done",
  noGateway: "skipped-no-vision-gateway",
  failed: "skipped-vision-failed",
} as const;

export type VisualExtractionState =
  (typeof VISUAL_EXTRACTION_STATES)[keyof typeof VISUAL_EXTRACTION_STATES];

/** 一条模型回复 → 一条描述：去掉换行与多余空白；空回复交给调用方按「识别失败」处理。 */
export function parseVisualDescription(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.slice(0, MAX_VISUAL_DESCRIPTION_LENGTH);
}

export interface VisualExtractionInput {
  analyzer: VisionAnalyzer;
  assets: readonly SelectedAssetRef[];
  readAssetImage(assetId: string): Promise<AssetImageBytes>;
  /** 单测注入：跳过 sharp（与出图阶段的压缩注入同一个形状）。 */
  compress?: (bytes: Buffer) => Promise<string>;
  signal?: AbortSignal;
}

export interface VisualExtractionResult {
  /** 按素材顺序的描述；降级时为空数组。 */
  descriptions: string[];
  state: VisualExtractionState;
}

/**
 * 逐张提取，按素材顺序返回描述。串行执行：与出图共用同一份上游额度。
 *
 * 任何一张失败都整体降级为空描述（而不是「前两条有、第三条没有」）：
 * 一半描述配「未包含照片内容」的标注自相矛盾，也没法在提示词里说清哪张缺了。
 */
export async function extractVisualDescriptions(
  input: VisualExtractionInput,
): Promise<VisualExtractionResult> {
  const compress = input.compress ?? compressForReferenceImage;
  const descriptions: string[] = [];

  for (const asset of input.assets) {
    try {
      const source = await input.readAssetImage(asset.id);
      const image = await compress(source.bytes);
      const text = await input.analyzer.analyzeImage(
        { image, prompt: buildVisualExtractionInstruction(asset.category) },
        input.signal ? { signal: input.signal } : {},
      );
      const description = parseVisualDescription(text);
      if (description.length === 0) {
        throw new Error("识别结果为空");
      }
      descriptions.push(description);
    } catch (error) {
      logger.warn("素材视觉提取失败，本次文案按「未包含照片内容」处理", {
        assetId: asset.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { descriptions: [], state: VISUAL_EXTRACTION_STATES.failed };
    }
  }

  return { descriptions, state: VISUAL_EXTRACTION_STATES.done };
}
