/**
 * 默认阶段注册表：按 `GENERATION_ADAPTER` 决定挂哪套实现。
 *
 * 这是 N6 / N7 唯一需要动的接线处 —— runner、状态机与 worker 都不改：
 *
 * - 生图阶段（N6，`src/modules/image-generation/`）：处理器在两种适配器下都是同一个，
 *   差别只在于它内部按 `GENERATION_ADAPTER` 选 `MagpieMcpImageGenerator` 或 `MockImageGenerator`；
 * - 文案阶段（N7，`src/modules/copy-generation/`）：还没接入，`real` 下没有处理器时阶段以
 *   `STAGE_HANDLER_MISSING` 失败 —— 这是当前真实状态，不用 mock 顶替。
 */
import { getEnv } from "@/lib/env";
import { createImageStage } from "@/modules/image-generation/stage";
import { createStageRegistry, type StageRegistry } from "../registry";
import { mockCopyStage } from "./mock";

export function defaultStageRegistry(): StageRegistry {
  const registry = createStageRegistry();

  // 生图阶段：真实与 mock 都注册同一个处理器（适配器由 service 按环境变量选择）。
  registry.register(createImageStage());

  if (getEnv().GENERATION_ADAPTER === "mock") {
    registry.register(mockCopyStage);
  }

  return registry;
}
