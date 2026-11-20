/**
 * 生图阶段处理器（docs/prd/04「阶段处理器注册点」、docs/prd/05）：
 * 只做「拿到阶段上下文 → 调上游出图 → 交出图片与调用摘要」，
 * 落盘、写库、状态流转都由 generation 模块的 runner 负责（本阶段不改状态机）。
 */
import type { StageContext, StageHandler, StageOutcome } from "@/modules/generation/types";
import { generateImages, type ImageGenerationDeps } from "./service";

/**
 * 造一个生图阶段处理器。
 * `deps` 只给单测注入假适配器用；线上 `stages/index.ts` 用默认参数，按 `GENERATION_ADAPTER` 选适配器。
 */
export function createImageStage(deps: ImageGenerationDeps = {}): StageHandler {
  return {
    stage: "image",
    async run(context: StageContext): Promise<StageOutcome> {
      const { images, meta, partialError } = await generateImages(context, deps);
      // 部分原图失败时把原因一起交出去：runner 写进阶段 `error`，任务因此判为 partial（AC-05-5）。
      return {
        stage: "image",
        images,
        meta: { ...meta },
        ...(partialError ? { partialError } : {}),
      };
    },
  };
}
