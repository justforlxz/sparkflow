/**
 * 默认阶段注册表：按 `GENERATION_ADAPTER` 决定挂哪套实现。
 *
 * 这是 N6 / N7 唯一需要动的接线处 —— runner、状态机与 worker 都不改：
 *
 * ```ts
 * if (getEnv().GENERATION_ADAPTER === "real") {
 *   registerImageGenerationStages(registry);  // N6：src/modules/image-generation/
 *   registerCopyGenerationStages(registry);   // N7：src/modules/copy-generation/
 * }
 * ```
 *
 * 在它们接入之前，`real` 适配器下两个阶段都没有处理器，阶段会以
 * `STAGE_HANDLER_MISSING` 失败 —— 这是当前真实状态，不用 mock 顶替。
 */
import { getEnv } from "@/lib/env";
import { createStageRegistry, type StageRegistry } from "../registry";
import { mockCopyStage, mockImageStage } from "./mock";

export function defaultStageRegistry(): StageRegistry {
  const registry = createStageRegistry();

  if (getEnv().GENERATION_ADAPTER === "mock") {
    registry.register(mockImageStage);
    registry.register(mockCopyStage);
  }

  return registry;
}
