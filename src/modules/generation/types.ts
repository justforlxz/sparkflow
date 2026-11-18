/**
 * 创作任务的数据形状与阶段处理器契约（docs/prd/04-generation-task.md）。
 *
 * 阶段处理器只做「拿到素材要求 → 调上游 → 交出产出」；落库、状态流转、重试判断都在 runner 与
 * service 里。N6 / N7 各加一个实现文件并注册，不改 runner 与状态机。
 */
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import type { StageName, StageStatus } from "./constants";

/** 两份 Agent 配置快照，按类型存进 `generation_task.agent_snapshot`（jsonb）。 */
export interface TaskAgentSnapshots {
  image: AgentSnapshot;
  copy: AgentSnapshot;
}

/** 任务参数：创建时固化，执行时只读（docs/prd/00-overview.md 全局规则 3）。 */
export interface TaskParams {
  visualStyle: string;
  copyStyle: string;
  imageCount: number;
  extraPrompt: string | null;
}

/** 资源夹里阶段处理器要用的部分（来源信息、图片张数），不含图片字节：本版本不传参考图。 */
export interface CollectionContext {
  id: string;
  platform: string | null;
  sourceTitle: string | null;
  sourceBody: string | null;
  assetCount: number;
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
}

export type StageOutcome =
  | { stage: "image"; images: GeneratedImage[]; meta?: Record<string, unknown> }
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
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface TaskRecord {
  id: string;
  collectionId: string;
  visualStyle: string;
  copyStyle: string;
  imageCount: number;
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
}

export interface ResultAssetRecord {
  id: string;
  fileName: string;
  mimeType: string;
  sortOrder: number;
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
