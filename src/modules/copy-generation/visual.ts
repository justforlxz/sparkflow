/**
 * 视觉提取（docs/prd/06-copy-generation.md「视觉提取」）：
 * 生成文案前，对**每一张原始图片**各做一次读图，按原图顺序编号得到一条中文描述。
 * 描述只围绕提取目标本身的材质、纹理、图案与颜色（docs/prd/06，ADR 0009），不写场景。
 *
 * 边界：
 * 1. 读图走**独立的图片理解网关**（`protocol = magpie-vision`，工具 `analyze_image`），
 *    不再要求文案模型自己具备 `image_input`；
 * 2. 图片压缩与出图同一套（长边 ≤ 1536、JPEG、data URL）；
 * 3. 没配置理解网关、或某张识别失败时：不阻断文案，交回空描述 + 降级状态，
 *    由调用方在任务与结果上标注「未包含照片内容」，不得改用文案模型猜图。
 */
import { logger } from "@/lib/logger";
import type { SourceAssetRef, SourceImageBytes } from "@/modules/generation/types";
import { compressForReferenceImage } from "@/modules/image-generation/compress";

/**
 * 每张原图的一条指令：聚焦提取目标本身的特征（docs/prd/06「视觉提取」，ADR 0009）。
 * 提取目标来自资源夹，改这里就等于改提取口径；不认识目标的描述对文案没用。
 */
export function buildVisualExtractionInstruction(extractTarget: string): string {
  const target = extractTarget.trim();
  // 旧任务没有提取目标时退回「主体目标」，不拿空书名号去问模型。
  return target
    ? `用中文写出照片里「${target}」的材质、纹理、图案与颜色，两句话以内。`
    : "用中文写出这张照片里主体目标的材质、纹理、图案与颜色，两句话以内。";
}

/** 单条描述的长度上限：只防超长输出，不改变语义。 */
export const MAX_VISUAL_DESCRIPTION_LENGTH = 500;

/** 「能识别一张图」的最小契约：真实实现是 `MagpieVisionClient`（网关模块），单测注入假实现。 */
export interface VisionAnalyzer {
  analyzeImage(
    input: { image: string; prompt: string },
    options?: { signal?: AbortSignal },
  ): Promise<string>;
}

/**
 * 视觉提取的三种结局，写进 `generation_stage.meta.visualExtraction`：
 * - `done`：每张原图都拿到了描述；
 * - `skipped-no-vision-gateway`：设置里没有可用的理解网关；
 * - `skipped-vision-failed`：网关在，但识别失败（鉴权、超时、空回包等）。
 *
 * 后两种都必须在任务与结果上标注「未包含照片内容」（不得静默降级，PRD 06）。
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
  assets: readonly SourceAssetRef[];
  readSourceImage(assetId: string): Promise<SourceImageBytes>;
  /** 资源夹的提取目标原文：读图指令围绕它提问（ADR 0009）。 */
  extractTarget: string;
  /** 单测注入：跳过 sharp（与出图阶段的压缩注入同一个形状）。 */
  compress?: (bytes: Buffer) => Promise<string>;
  signal?: AbortSignal;
}

export interface VisualExtractionResult {
  /** 按原图顺序的描述；降级时为空数组。 */
  descriptions: string[];
  state: VisualExtractionState;
}

/**
 * 逐张提取，按原图顺序返回描述。串行执行：与出图共用同一份上游额度。
 *
 * 任何一张失败都整体降级为空描述（而不是「前两条有、第三条没有」）：
 * 一半描述配「未包含照片内容」的标注自相矛盾，也没法在提示词里说清哪张缺了。
 */
export async function extractVisualDescriptions(
  input: VisualExtractionInput,
): Promise<VisualExtractionResult> {
  const compress = input.compress ?? compressForReferenceImage;
  const instruction = buildVisualExtractionInstruction(input.extractTarget);
  const descriptions: string[] = [];

  for (const asset of input.assets) {
    try {
      const source = await input.readSourceImage(asset.id);
      const image = await compress(source.bytes);
      const text = await input.analyzer.analyzeImage(
        { image, prompt: instruction },
        input.signal ? { signal: input.signal } : {},
      );
      const description = parseVisualDescription(text);
      if (description.length === 0) {
        throw new Error("识别结果为空");
      }
      descriptions.push(description);
    } catch (error) {
      logger.warn("原图视觉提取失败，本次文案按「未包含照片内容」处理", {
        sourceAssetId: asset.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { descriptions: [], state: VISUAL_EXTRACTION_STATES.failed };
    }
  }

  return { descriptions, state: VISUAL_EXTRACTION_STATES.done };
}
