/**
 * 任务与结果的对外形状：接口与页面只见到这一层。
 * 状态是派生值（`derive.ts`），这里连同中文标签一起给出，界面不再自己判断。
 */
import { AppError } from "@/lib/errors";
// 视觉方向与文案风格的中文名只从各自模块的登记表取，界面与本文件都不再写一份枚举。
import { findCopyStyle } from "@/modules/copy-generation/styles";
import { visualStyleLabel } from "@/modules/image-generation/styles";
import { DEFAULT_THUMBNAIL_WIDTH } from "@/modules/media-collection/constants";
import {
  STAGE_LABELS,
  STAGE_STATUS_LABELS,
  STAGE_NAMES,
  TASK_COPY,
  TASK_STATUS_LABELS,
  type StageName,
  type TaskStatus,
} from "./constants";
import {
  deriveRetryHint,
  deriveTaskStatus,
  type AgentBindingState,
  type RetryHint,
} from "./derive";
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
  /** 鉴权读取生成图片的地址，可直接渲染（与资源夹原图同一个约定）。 */
  url: string;
  /** 网格统一走缩略图参数（docs/prd/07 SHOULD）。 */
  thumbnailUrl: string;
}

export interface ResultView {
  id: string;
  /** 结果所属任务：重试失败阶段要用它（ADR 0005）。 */
  taskId: string;
  /** 结果所属资源夹：发布记录按它归档，并按资源夹筛选（docs/prd/08）。 */
  collectionId: string;
  title: string | null;
  body: string | null;
  tags: string[];
  visualStyle: string;
  visualStyleLabel: string;
  createdAt: string;
  assets: ResultAssetView[];
  /** 文案阶段失败：文案区域显示附加提示与重试入口，有内容时照常展示（AC-08-11）。 */
  copyFailed: boolean;
}

/** 失败阶段上的重试说明（MKACG-904）：`state` 决定样式，`message` 直接渲染。 */
export interface RetryHintView {
  state: RetryHint;
  message: string;
}

/** 两种说明的文案都只在 `constants.ts` 维护，这里只负责选择。 */
const RETRY_HINT_MESSAGES: Record<RetryHint, string> = {
  snapshot: TASK_COPY.retryUsesSnapshotHint,
  "snapshot-changed": TASK_COPY.retrySnapshotChangedHint,
};

export interface TaskSummaryView {
  id: string;
  collectionId: string;
  collectionName: string;
  status: TaskStatus;
  statusLabel: string;
  visualStyle: string;
  visualStyleLabel: string;
  copyStyle: string;
  copyStyleLabel: string;
  imageCount: number;
  extraPrompt: string | null;
  createdAt: string;
  /** 两条阶段各自的状态，界面必须分别展示（docs/prd/07 MUST 1）。 */
  stages: Record<StageName, StageView>;
  /** 有失败阶段时的重试说明；没有失败阶段为 `null`（MKACG-904 MUST 1）。 */
  retryHint: RetryHintView | null;
}

export interface TaskDetailView extends TaskSummaryView {
  /** 创建时固化的两份 Agent 配置；之后改提示词不影响它（AC-03-8）。 */
  agents: TaskAgentSnapshots;
  resultId: string | null;
  result: ResultView | null;
}

/** 生成图片的鉴权读取地址（docs/architecture.md「文件」）。 */
export function generatedAssetUrl(resultId: string, assetId: string, width?: number): string {
  const base = `/api/files/generated/${resultId}/${assetId}`;
  return width ? `${base}?w=${width}` : base;
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

/** 快照里只有模型与网关参与「是否已被改过」的判断，其余字段不影响这次重试取到的上游。 */
function snapshotBindings(snapshots: TaskAgentSnapshots): Record<StageName, AgentBindingState> {
  return {
    image: { gatewayId: snapshots.image.gatewayId, modelId: snapshots.image.modelId },
    copy: { gatewayId: snapshots.copy.gatewayId, modelId: snapshots.copy.modelId },
  };
}

function toRetryHint(
  stages: readonly StageRecord[],
  snapshots: TaskAgentSnapshots,
  currentAgents: Record<StageName, AgentBindingState>,
): RetryHintView | null {
  const state = deriveRetryHint(stages, snapshotBindings(snapshots), currentAgents);
  return state ? { state, message: RETRY_HINT_MESSAGES[state] } : null;
}

function toSummary(
  record: TaskWithStages,
  collectionName: string,
  currentAgents: Record<StageName, AgentBindingState>,
): TaskSummaryView {
  const { task, stages } = record;
  const status = deriveTaskStatus(stages);
  return {
    id: task.id,
    collectionId: task.collectionId,
    collectionName,
    status,
    statusLabel: TASK_STATUS_LABELS[status],
    visualStyle: task.visualStyle,
    visualStyleLabel: visualStyleLabel(task.visualStyle),
    copyStyle: task.copyStyle,
    copyStyleLabel: findCopyStyle(task.copyStyle)?.label ?? task.copyStyle,
    imageCount: task.imageCount,
    extraPrompt: task.extraPrompt,
    createdAt: task.createdAt.toISOString(),
    stages: toStageMap(stages),
    retryHint: toRetryHint(stages, task.agentSnapshot, currentAgents),
  };
}

export function toTaskSummaryView(
  record: TaskWithStages,
  collectionName: string,
  currentAgents: Record<StageName, AgentBindingState>,
): TaskSummaryView {
  return toSummary(record, collectionName, currentAgents);
}

/** 结果视图要带上任务的两条阶段：文案是否失败、能否重试都由它派生。 */
export function toResultView(
  result: ResultRecord,
  stages: readonly StageRecord[],
): ResultView {
  const copyFailed = stages.some((stage) => stage.stage === "copy" && stage.status === "failed");
  return {
    id: result.id,
    taskId: result.taskId,
    collectionId: result.collectionId,
    title: result.title,
    body: result.body,
    tags: result.tags,
    visualStyle: result.visualStyle,
    visualStyleLabel: visualStyleLabel(result.visualStyle),
    createdAt: result.createdAt.toISOString(),
    copyFailed,
    assets: result.assets.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      sortOrder: asset.sortOrder,
      url: generatedAssetUrl(result.id, asset.id),
      thumbnailUrl: generatedAssetUrl(result.id, asset.id, DEFAULT_THUMBNAIL_WIDTH),
    })),
  };
}

export function toTaskDetailView(
  record: TaskWithStages,
  result: ResultRecord | null,
  collectionName: string,
  currentAgents: Record<StageName, AgentBindingState>,
): TaskDetailView {
  return {
    ...toSummary(record, collectionName, currentAgents),
    agents: record.task.agentSnapshot,
    resultId: result?.id ?? null,
    result: result ? toResultView(result, record.stages) : null,
  };
}
