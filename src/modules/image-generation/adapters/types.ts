/**
 * 出图适配器契约（docs/prd/05-image-generation.md MUST 1、MUST 2）：
 * 业务代码只依赖 `ImageGenerator`，真实实现是 `MagpieImageGenerator`，
 * CI 用 `MockImageGenerator`。新增一种出图后端 = 加一个实现文件并在 `service.ts` 选择。
 *
 * 一图对一图（ADR 0008）：一次 `generate` 只带**一张**原图（`reference_images` 只有它），
 * 期望拿回一张成品图。要不要跳过某张由上层 `service.ts` 决定，适配器只负责一次调用。
 */
import type { GeneratedImage } from "@/modules/generation/types";

/** 一次「按这张原图重绘」的请求。 */
export interface GenerateImageInput {
  prompt: string;
  /**
   * 原图，`data:<mime>;base64,<...>` 形式（已压缩成 JPEG，长边 ≤ 1536）。
   * 线上 `generate_image.reference_images` 按 data URL 接收（2026-11-20 实测）。
   */
  image: string;
  /** 尺寸（视觉方向的默认尺寸）；null 表示省略，用上游默认。 */
  size: string | null;
  /** 快照里的模型；null 表示省略该参数，用网关侧默认图片模型（MUST 5）。 */
  model: string | null;
}

/**
 * 出图适配器。返回的图片字节已经取回（内联或从网关 URL 下载），
 * 落盘与写 `generated_asset` 由 generation 模块的 runner 负责。
 */
export interface ImageGenerator {
  generate(input: GenerateImageInput, options?: { signal?: AbortSignal }): Promise<GeneratedImage[]>;
}

/**
 * 出图阶段的失败分类（docs/prd/05 MUST 7）。这些字符串直接作为
 * `generation_stage.error.code` 写入，runner 原样记录。
 */
export const IMAGE_ERROR_CODES = {
  /** 上游超时或暂时不可用，含下载图片失败。 */
  timeout: "UPSTREAM_TIMEOUT",
  /** 鉴权失败：401 / 403，或网关密钥读不出来。 */
  auth: "UPSTREAM_AUTH",
  /** 参数或模型不被接受（含上游 `isError` 的工具结果）。 */
  rejected: "UPSTREAM_REJECTED",
  /** 上游响应结构不符合 MCP / 文档约定。 */
  format: "UPSTREAM_FORMAT",
  /** 部分原图成功、部分失败：阶段仍有产出，但原因要留在阶段 `error` 上（AC-05-5）。 */
  partial: "UPSTREAM_PARTIAL",
} as const;
