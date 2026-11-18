/**
 * 任务与结果的对外形状：接口与页面只见到这一层。
 * 状态是派生值（`derive.ts`），这里连同中文标签一起给出，界面不再自己判断。
 */
import { AppError } from "@/lib/errors";
import {
  STAGE_LABELS,
  STAGE_STATUS_LABELS,
  STAGE_NAMES,
  TASK_STATUS_LABELS,
  type StageName,
  type TaskStatus,
} from "./constants";
import { deriveTaskStatus } from "./derive";
import type {
  ResultRecord,
  StageErrorRecord,
  StageRecord,
  TaskAgentSnapshots,
  TaskWithStages,
} from "./types";

export interface StageView {
  stage: StageName;
  label: string;
  status: string;
  statusLabel: string;
  attempts: number;
  error: StageErrorRecord | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ResultAssetView {
  id: string;
  fileName: string;
  mimeType: string;
  sortOrder: number;
}

export interface ResultView {
  id: string;
  title: string | null;
  body: string | null;
  tags: string[];
  visualStyle: string;
  createdAt: string;
  assets: ResultAssetView[];
}

export interface TaskSummaryView {
  id: string;
  collectionId: string;
  status: TaskStatus;
  statusLabel: string;
  visualStyle: string;
  copyStyle: string;
  imageCount: number;
  extraPrompt: string | null;
  createdAt: string;
  /** 两条阶段各自的状态，界面必须分别展示（docs/prd/07 MUST 1）。 */
  stages: Record<StageName, StageView>;
}

export interface TaskDetailView extends TaskSummaryView {
  /** 创建时固化的两份 Agent 配置；之后改提示词不影响它（AC-03-8）。 */
  agents: TaskAgentSnapshots;
  resultId: string | null;
  result: ResultView | null;
}

function toStageView(stage: StageRecord): StageView {
  return {
    stage: stage.stage,
    label: STAGE_LABELS[stage.stage],
    status: stage.status,
    statusLabel: STAGE_STATUS_LABELS[stage.status],
    attempts: stage.attempts,
    error: stage.error,
    startedAt: stage.startedAt?.toISOString() ?? null,
    finishedAt: stage.finishedAt?.toISOString() ?? null,
  };
}

/** 两条阶段必须都在：缺一条说明写入路径漏了，属于数据损坏，不当成空状态。 */
function toStageMap(stages: readonly StageRecord[]): Record<StageName, StageView> {
  const entries = STAGE_NAMES.map((name) => {
    const stage = stages.find((candidate) => candidate.stage === name);
    if (!stage) {
      throw new AppError("INTERNAL", `任务缺少 ${STAGE_LABELS[name]}记录，请检查数据写入路径`);
    }
    return [name, toStageView(stage)] as const;
  });
  return Object.fromEntries(entries) as Record<StageName, StageView>;
}

function toSummary({ task, stages }: TaskWithStages): TaskSummaryView {
  const status = deriveTaskStatus(stages);
  return {
    id: task.id,
    collectionId: task.collectionId,
    status,
    statusLabel: TASK_STATUS_LABELS[status],
    visualStyle: task.visualStyle,
    copyStyle: task.copyStyle,
    imageCount: task.imageCount,
    extraPrompt: task.extraPrompt,
    createdAt: task.createdAt.toISOString(),
    stages: toStageMap(stages),
  };
}

export function toTaskSummaryView(record: TaskWithStages): TaskSummaryView {
  return toSummary(record);
}

export function toResultView(result: ResultRecord): ResultView {
  return {
    id: result.id,
    title: result.title,
    body: result.body,
    tags: result.tags,
    visualStyle: result.visualStyle,
    createdAt: result.createdAt.toISOString(),
    assets: result.assets.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      sortOrder: asset.sortOrder,
    })),
  };
}

export function toTaskDetailView(
  record: TaskWithStages,
  result: ResultRecord | null,
): TaskDetailView {
  return {
    ...toSummary(record),
    agents: record.task.agentSnapshot,
    resultId: result?.id ?? null,
    result: result ? toResultView(result) : null,
  };
}
