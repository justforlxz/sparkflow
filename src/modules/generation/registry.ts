/**
 * 阶段处理器注册表（docs/prd/04-generation-task.md「阶段处理器注册点」）。
 *
 * worker 与 runner 只问注册表「这个阶段由谁执行」，不认识任何具体实现；
 * N6（图片创作）与 N7（文案创作）各加一个实现文件并在 `stages/index.ts` 注册，不改 runner。
 */
import { STAGE_NAMES, type StageName } from "./constants";
import type { StageHandler } from "./types";

export interface StageRegistry {
  get(stage: StageName): StageHandler | null;
  register(handler: StageHandler): void;
  /** 已注册的阶段，按执行顺序排列。 */
  registeredStages(): StageName[];
}

export function createStageRegistry(handlers: readonly StageHandler[] = []): StageRegistry {
  const byStage = new Map<StageName, StageHandler>();

  const registry: StageRegistry = {
    get: (stage) => byStage.get(stage) ?? null,
    register: (handler) => {
      if (byStage.has(handler.stage)) {
        throw new Error(`阶段 ${handler.stage} 已有处理器：${byStage.get(handler.stage)?.constructor.name}`);
      }
      byStage.set(handler.stage, handler);
    },
    registeredStages: () => STAGE_NAMES.filter((stage) => byStage.has(stage)),
  };

  for (const handler of handlers) registry.register(handler);
  return registry;
}
