/**
 * 出图适配器契约（docs/prd/05-image-generation.md MUST 1）：
 * 业务代码只依赖 `ImageGenerator`，真实实现是 `MagpieMcpImageGenerator`，
 * CI 用 `MockImageGenerator`。新增一种出图后端 = 加一个实现文件并在 `service.ts` 选择。
 */
import type { GeneratedImage } from "@/modules/generation/types";

/** 一次出图请求（一批）。字段与 magpie `generate_image` 的参数一一对应。 */
export interface GenerateImageInput {
  prompt: string;
  /** 本批张数，1–4（MUST 2）。 */
  n: number;
  /** 尺寸；null 表示省略，用上游默认。 */
  size: string | null;
  /** 画质；null 表示省略。 */
  quality: string | null;
  /** 快照里的模型；null 表示省略该参数，用 magpie 侧默认图片模型（MUST 5）。 */
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
 * 出图阶段的失败分类（docs/prd/05 SHOULD）。这些字符串直接作为
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
  /** 图生图等被功能开关拦下的能力。 */
  featureDisabled: "FEATURE_DISABLED",
} as const;
