/**
 * 任务状态与重试的纯逻辑（docs/prd/04-generation-task.md、ADR 0005）。
 *
 * 这两件事单独成函数、不碰数据库，是为了让判定表与重试语义能被单测逐行锁定：
 * 状态是派生值，任何写入路径都必须经过这里，不能各写一份 `if`。
 */
import { AppError } from "@/lib/errors";
import {
  STAGE_NAMES,
  TASK_ERROR_CODES,
  TASK_STATUS_LABELS,
  type StageName,
  type StageStatus,
  type TaskStatus,
} from "./constants";

export interface StageState {
  stage: StageName;
  status: StageStatus;
}

/**
 * 任务状态判定表（docs/prd/04「阶段与状态」）：
 *
 * | 阶段组合 | 任务状态 |
 * | --- | --- |
 * | 两个都 succeeded | `succeeded` |
 * | image succeeded、copy failed | `partial` |
 * | image failed（copy 保持 queued 或 failed） | `failed` |
 * | 任一 running，或还有 queued 阶段没跑 | `running` |
 */
export function deriveTaskStatus(stages: readonly StageState[]): TaskStatus {
  const statusOf = (name: StageName): StageStatus =>
    stages.find((stage) => stage.stage === name)?.status ?? "queued";

  const image = statusOf("image");
  const copy = statusOf("copy");

  if (image === "failed") return "failed";
  if (image === "succeeded" && copy === "succeeded") return "succeeded";
  if (image === "succeeded" && copy === "failed") return "partial";
  return "running";
}

/**
 * 重试只作用于失败阶段（ADR 0005、AC-04-8）：
 * 没有失败阶段就抛 `CONFLICT`（全部成功、还在跑、还没开始跑都属于这种情况），
 * 并把当前阶段状态放进 `details` 说明原因。返回的阶段按执行顺序排列。
 */
export function planStagesToRetry(stages: readonly StageState[]): StageName[] {
  const failed = STAGE_NAMES.filter((name) =>
    stages.some((stage) => stage.stage === name && stage.status === "failed"),
  );
  if (failed.length === 0) {
    const status = deriveTaskStatus(stages);
    throw new AppError("CONFLICT", `任务没有失败的阶段，不能重试（当前状态：${TASK_STATUS_LABELS[status]}）`, {
      details: {
        code: TASK_ERROR_CODES.noFailedStage,
        taskStatus: status,
        stages: STAGE_NAMES.map((name) => ({
          stage: name,
          status: stages.find((stage) => stage.stage === name)?.status ?? "queued",
        })),
      },
    });
  }
  return failed;
}
