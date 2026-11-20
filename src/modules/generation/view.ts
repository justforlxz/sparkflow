/**
 * 任务与结果的对外形状：接口与页面只见到这一层。
 * 状态是派生值（`derive.ts`），这里连同中文标签一起给出，界面不再自己判断。
 */
import { AppError } from "@/lib/errors";
// 提取要求与文案风格的中文名只从各自模块的登记表取，界面与本文件都不再写一份枚举。
import { findCopyStyle } from "@/modules/copy-generation/styles";
import { describeResultStyle, extractRequirementLabel } from "@/modules/image-generation/styles";
import { DEFAULT_THUMBNAIL_WIDTH } from "@/modules/media-collection/constants";
import {
  RESULT_COPY,
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
  /** 执行中的进度（「正在生图 第 done/N 张」）；终态为 null。 */
  progress: { done: number; total: number } | null;
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
  /** 这张成品对应的原图；原图被解除关联后为 null（ADR 0008）。 */
  sourceAssetId: string | null;
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
  /** 结果所属任务创建时固化的提取目标；历史结果为 null（ADR 0009 不做数据迁移）。 */
  extractTarget: string | null;
  createdAt: string;
  assets: ResultAssetView[];
  /** 文案阶段失败：文案区域显示附加提示与重试入口，有内容时照常展示（AC-08-11）。 */
  copyFailed: boolean;
  /** 视觉提取降级（没拿到照片内容），文案仍已生成（docs/prd/06 AC-06-8）。 */
  copyVisualDegraded: boolean;
  /** 降级的具体原因与下一步动作；未降级时为 null。 */
  copyVisualDegradedHint: string | null;
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
  /** 提取要求 key（原「视觉方向」，ADR 0009）；对外字段名统一为 extractRequirement。 */
  extractRequirement: string;
  extractRequirementLabel: string;
  /** 创建任务时固化的提取目标原文；ADR 0009 之前的旧任务为 null。 */
  extractTarget: string | null;
  copyStyle: string;
  copyStyleLabel: string;
  /** 预计成品张数 = 这次的原图张数（ADR 0008）：任务不再接收图片数量参数。 */
  expectedImageCount: number;
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
    progress: stage.progress ?? null,
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
  expectedImageCount: number,
): TaskSummaryView {
  const { task, stages } = record;
  const status = deriveTaskStatus(stages);
  return {
    id: task.id,
    collectionId: task.collectionId,
    collectionName,
    status,
    statusLabel: TASK_STATUS_LABELS[status],
    extractRequirement: task.extractRequirement,
    extractRequirementLabel: extractRequirementLabel(task.extractRequirement),
    extractTarget: task.agentSnapshot.extractTarget,
    copyStyle: task.copyStyle,
    copyStyleLabel: findCopyStyle(task.copyStyle)?.label ?? task.copyStyle,
    expectedImageCount,
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
  expectedImageCount: number,
): TaskSummaryView {
  return toSummary(record, collectionName, currentAgents, expectedImageCount);
}

/**
 * 结果视图要带上任务的两条阶段：文案是否失败、能否重试都由它派生。
 * `extractTarget` 来自结果所属任务的快照（ADR 0009）：历史结果没有这一项，传 null。
 */
export function toResultView(
  result: ResultRecord,
  stages: readonly StageRecord[],
  extractTarget: string | null,
): ResultView {
  const copyFailed = stages.some((stage) => stage.stage === "copy" && stage.status === "failed");
  // 视觉提取被降级时必须显式标注，不得静默降级（docs/prd/06 AC-06-8）。
  // 原因分两种：没配置理解网关 / 识别失败——给用户的下一步动作不同。
  const visualExtraction = stages.find((stage) => stage.stage === "copy")?.meta?.visualExtraction;
  const copyVisualDegraded = typeof visualExtraction === "string" && visualExtraction !== "done";
  const copyVisualDegradedHint = !copyVisualDegraded
    ? null
    : visualExtraction === "skipped-no-vision-gateway"
      ? RESULT_COPY.copyVisualDegradedNoGateway
      : RESULT_COPY.copyVisualDegradedFailed;
  return {
    id: result.id,
    taskId: result.taskId,
    collectionId: result.collectionId,
    title: result.title,
    body: result.body,
    tags: result.tags,
    visualStyle: result.visualStyle,
    // 新结果是提取要求 key，历史结果是旧视觉方向 key：两种都要显示（不做数据迁移）。
    visualStyleLabel: describeResultStyle(result.visualStyle),
    extractTarget,
    createdAt: result.createdAt.toISOString(),
    copyFailed,
    copyVisualDegraded,
    copyVisualDegradedHint,
    assets: result.assets.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      sortOrder: asset.sortOrder,
      url: generatedAssetUrl(result.id, asset.id),
      thumbnailUrl: generatedAssetUrl(result.id, asset.id, DEFAULT_THUMBNAIL_WIDTH),
      sourceAssetId: asset.sourceAssetId ?? null,
    })),
  };
}

export function toTaskDetailView(
  record: TaskWithStages,
  result: ResultRecord | null,
  collectionName: string,
  currentAgents: Record<StageName, AgentBindingState>,
  expectedImageCount: number,
): TaskDetailView {
  return {
    ...toSummary(record, collectionName, currentAgents, expectedImageCount),
    agents: record.task.agentSnapshot,
    resultId: result?.id ?? null,
    result: result
      ? toResultView(result, record.stages, record.task.agentSnapshot.extractTarget)
      : null,
  };
}
