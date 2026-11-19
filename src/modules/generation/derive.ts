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
 * 重试被拒绝时的统一信封：全部成功、还在跑、已排队（含并发重试被另一条抢先）都归到这里，
 * `details` 带当前阶段状态说明原因。顺序与并发两条路径共用这一处，形状不会各写一份。
 */
export function throwRetryConflict(stages: readonly StageState[]): never {
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

/**
 * 重试只作用于失败阶段（ADR 0005、AC-04-8）：
 * 没有失败阶段就抛 `CONFLICT`（全部成功、还在跑、还没开始跑都属于这种情况），
 * 并把当前阶段状态放进 `details` 说明原因。返回的阶段按执行顺序排列。
 */
export function planStagesToRetry(stages: readonly StageState[]): StageName[] {
  const failed = STAGE_NAMES.filter((name) =>
    stages.some((stage) => stage.stage === name && stage.status === "failed"),
  );
  if (failed.length === 0) throwRetryConflict(stages);
  return failed;
}

/** 一个 Agent 的绑定状态：判断任务快照有没有被改过只看模型与网关这两项。 */
export interface AgentBindingState {
  gatewayId: string | null;
  modelId: string | null;
}

/**
 * 失败阶段上的重试说明（MKACG-904）。
 *
 * 重试只重跑失败阶段（ADR 0005），配置取自任务创建时的快照（docs/prd/05 MUST 5），
 * 所以改过 Agent 配置之后点重试仍会用旧配置。三档返回值：
 *
 * | 返回值 | 含义 | 界面 |
 * | --- | --- | --- |
 * | `null` | 没有失败阶段，也没有重试入口 | 不显示 |
 * | `snapshot` | 失败阶段的快照与当前配置一致 | 普通说明 |
 * | `snapshot-changed` | 失败阶段的快照与当前配置已不同 | 警示样式，点出差异 |
 *
 * 只比较失败阶段：重试不会碰已成功的阶段，那些阶段的配置改了也不影响这次重试。
 */
export type RetryHint = "snapshot" | "snapshot-changed";

export function deriveRetryHint(
  stages: readonly StageState[],
  snapshot: Record<StageName, AgentBindingState>,
  current: Record<StageName, AgentBindingState>,
): RetryHint | null {
  const failed = STAGE_NAMES.filter((name) =>
    stages.some((stage) => stage.stage === name && stage.status === "failed"),
  );
  if (failed.length === 0) return null;

  const changed = failed.some(
    (name) =>
      snapshot[name].modelId !== current[name].modelId ||
      snapshot[name].gatewayId !== current[name].gatewayId,
  );
  return changed ? "snapshot-changed" : "snapshot";
}
