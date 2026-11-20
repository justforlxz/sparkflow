/**
 * 创作任务的数据形状与阶段处理器契约（docs/prd/04-generation-task.md）。
 *
 * 阶段处理器只做「拿到素材要求 → 调上游 → 交出产出」；落库、状态流转、重试判断都在 runner 与
 * service 里。N6 / N7 各加一个实现文件并注册，不改 runner 与状态机。
 */
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import type { StageName, StageStatus } from "./constants";

/**
 * 任务快照，存进 `generation_task.agent_snapshot`（jsonb）。
 *
 * 两份 Agent 配置之外，创建任务时还把资源夹的提取目标原文固化进来（docs/prd/04 4c、ADR 0009）：
 * 之后改资源夹的提取目标不影响已经创建的任务（全局规则 3）。
 */
export interface TaskAgentSnapshots {
  image: AgentSnapshot;
  copy: AgentSnapshot;
  /** 提取目标原文；旧任务没有这一项，读取时统一归一为 null。 */
  extractTarget: string | null;
}

/** 任务参数：创建时固化，执行时只读（docs/prd/00-overview.md 全局规则 3）。 */
export interface TaskParams {
  /** 提取要求 key（原「视觉方向」，ADR 0009）：登记表在 `image-generation/styles.ts`。 */
  extractRequirement: string;
  copyStyle: string;
  /** 提取图张数不再由任务参数决定：它等于这次的原图张数（ADR 0008）。 */
  extraPrompt: string | null;
}

/** 一张原图，只给标识与展示信息；字节按需单独读取，不把整个资源夹的图片一次性载入内存。 */
export interface SourceAssetRef {
  id: string;
  fileName: string;
  mimeType: string;
}

/** 读出来的一张原图字节。 */
export interface SourceImageBytes {
  bytes: Buffer;
  mimeType: string;
}

/** 阶段执行进度：界面据此显示「正在生图 第 done/N 张」。 */
export interface StageProgress {
  done: number;
  total: number;
}

/** 资源夹里阶段处理器要用的部分（来源信息与原图清单，按 `sort_order` 排列）。 */
export interface CollectionContext {
  id: string;
  platform: string | null;
  sourceTitle: string | null;
  sourceBody: string | null;
  /** 资源夹的提取目标原文；未填写为 null（ADR 0009）。 */
  extractTarget: string | null;
  /** 本次要一对一出图的原图，顺序即成品顺序。 */
  assets: readonly SourceAssetRef[];
}

export interface StageErrorRecord {
  code: string;
  /** 已脱敏、已截断的可读原因（docs/prd/04 MUST 5）。 */
  message: string;
  at: string;
}

/** 阶段处理器返回的图片：由 runner 落盘并写 `generated_asset`，处理器不碰数据库。 */
export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  /** 展示用文件名；不参与落盘路径（路径由服务端生成）。 */
  fileName?: string;
  width?: number | null;
  height?: number | null;
  /** 第几张原图（从 1 开始）：`sort_order` 用它，因此中间一张失败时编号会跳号（AC-05-5）。 */
  sortOrder?: number;
  /** 这张成品对应的原图 id，写进 `generated_asset.source_asset_id`。 */
  sourceAssetId?: string | null;
}

/** 文案阶段的产出；字段与清洗规则见 docs/prd/06-generation-copy.md。 */
export interface CopyContent {
  title: string;
  body: string;
  tags: string[];
}

/** 阶段执行上下文：与阶段相关的输入全都显式给出，处理器不查别的模块的表。 */
export interface StageContext {
  taskId: string;
  /** 第几次尝试，从 1 开始；创建时为 1，每次重试加 1。 */
  attempt: number;
  params: TaskParams;
  agents: TaskAgentSnapshots;
  collection: CollectionContext;
  /** 生图阶段成功时已建好的结果行；生图阶段执行时为 null。 */
  resultId: string | null;
  /** 超时或服务停止时被 abort，处理器应尽快放弃正在进行的上游请求。 */
  signal: AbortSignal;
  /** 按 id 读一张原图的字节（由 runner 接到资源夹模块；处理器不直接查别的模块的表）。 */
  readSourceImage(assetId: string): Promise<SourceImageBytes>;
  /** 写阶段执行进度（界面读它显示「正在生图 第 k/N 张」）；runner 负责清空终态。 */
  reportProgress(progress: StageProgress): Promise<void>;
}

export type StageOutcome =
  | {
      stage: "image";
      images: GeneratedImage[];
      meta?: Record<string, unknown>;
      /**
       * 部分原图失败时的说明：阶段本身有产出，状态仍是 `succeeded`，
       * 但要把失败的原图与原因如实记进阶段 `error`（docs/prd/05 MUST 7），任务因此判为 `partial`。
       */
      partialError?: { code: string; message: string };
    }
  | { stage: "copy"; copy: CopyContent; meta?: Record<string, unknown> };

export interface StageHandler {
  readonly stage: StageName;
  run(context: StageContext): Promise<StageOutcome>;
}

/**
 * 阶段处理器主动分类失败（docs/prd/05、06 的失败码）。
 * runner 只认这里的 `code`，其余异常统一记成 `STAGE_FAILED`。
 */
export class StageError extends Error {
  readonly code: string;
  readonly meta?: Record<string, unknown>;

  constructor(code: string, message: string, options: { meta?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "StageError";
    this.code = code;
    this.meta = options.meta;
  }
}

/* ---------- 持久化记录 ---------- */

export interface StageRecord {
  id: string;
  taskId: string;
  stage: StageName;
  status: StageStatus;
  attempts: number;
  error: StageErrorRecord | null;
  meta: Record<string, unknown> | null;
  /** 执行中的进度；进入终态后为 null。 */
  progress: StageProgress | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface TaskRecord {
  id: string;
  collectionId: string;
  /** 提取要求 key；落库列名仍是 visual_style（ADR 0009）。 */
  extractRequirement: string;
  copyStyle: string;
  /** 成品张数 = 原图张数，不落库（ADR 0008）。 */
  extraPrompt: string | null;
  agentSnapshot: TaskAgentSnapshots;
  createdAt: Date;
}

export interface TaskWithStages {
  task: TaskRecord;
  stages: StageRecord[];
}

/** 出队的阶段：任务与两条阶段一起带出，runner 不用再查一次。 */
export interface ClaimedStage extends TaskWithStages {
  stage: StageRecord;
}

export interface ResultAssetInput {
  storageKey: string;
  fileName: string;
  mimeType: string;
  sortOrder: number;
  width: number | null;
  height: number | null;
  /** 对应原图；与 `sortOrder` 一起形成「一图对一图」的对照关系。 */
  sourceAssetId: string | null;
}

export interface ResultAssetRecord {
  id: string;
  fileName: string;
  mimeType: string;
  sortOrder: number;
  sourceAssetId: string | null;
}

export interface ResultRecord {
  id: string;
  taskId: string;
  collectionId: string;
  title: string | null;
  body: string | null;
  tags: string[];
  visualStyle: string;
  createdAt: Date;
  assets: ResultAssetRecord[];
}
