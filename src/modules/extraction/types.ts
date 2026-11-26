/**
 * 提取运行与素材库的数据形状，以及提取处理器的契约
 * （docs/prd/12-asset-library.md、docs/adr/0010）。
 *
 * 处理器只做「拿到原图与类别 → 调上游 → 交出图片与失败项」；落盘、写库、状态流转都在
 * `runner.ts` 与 `service.ts` 里。
 */
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import type { FailureRecord } from "@/lib/job-failure";
import type { ExtractionItemStatus, ExtractionStatus } from "./constants";

/** 一张原图，只给标识与展示信息；字节按需单独读取。 */
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

/** 进度：`total` = 原图数 × 类别数，`done` 按完成的项累加。 */
export interface ExtractionProgress {
  done: number;
  total: number;
}

/** 资源夹里处理器要用的部分（来源信息与原图清单，按 `sort_order` 排列）。 */
export interface CollectionContext {
  id: string;
  platform: string | null;
  sourceTitle: string | null;
  sourceBody: string | null;
  assets: readonly SourceAssetRef[];
}

/** 一项失败（原图 × 类别）的可读原因：整体 partial 时逐项点名。 */
export interface ExtractionFailure {
  category: string;
  sourceAssetId: string;
  fileName: string;
  code: string;
  message: string;
}

/** 处理器返回的一张素材：由 runner 落盘并写 `library_asset`，处理器不碰数据库。 */
export interface ExtractedImage {
  bytes: Buffer;
  mimeType: string;
  /** 展示用文件名；不参与落盘路径（路径由服务端生成）。 */
  fileName?: string;
  width?: number | null;
  height?: number | null;
  category: string;
  sourceAssetId: string;
  /** 同一张原图下的序号（从 1 开始），`sort_order` 用它。 */
  sortOrder: number;
  /**
   * 产物是否不含上游模型自带的水印（MKACG-1004、MKACG-1008）：
   * 新通道（REST + `watermark:false`）出图本身没有水印，直接是 `true`；
   * 注入后处理时，`true` 表示裁切补边成功，`false` 表示保留了带水印的原图。
   */
  watermarkRemoved: boolean;
  /** 没去水印的原因；去掉时是 null。界面据此说明为什么带着水印。 */
  watermarkNote: string | null;
}

/** 提取执行上下文：与运行相关的输入全都显式给出，处理器不查别的模块的表。 */
export interface ExtractionContext {
  runId: string;
  collectionId: string;
  /** 提取要求 key（faithful / flatten / dereflect），登记在 `image-generation/styles.ts`。 */
  requirement: string;
  categories: readonly string[];
  /** 本次参与提取的原图 id，顺序即调用顺序。 */
  sourceAssetIds: readonly string[];
  extraPrompt: string | null;
  agent: AgentSnapshot;
  collection: CollectionContext;
  /** 超时或服务停止时被 abort，处理器应尽快放弃正在进行的上游请求。 */
  signal: AbortSignal;
  /** 按 id 读一张原图的字节（由 runner 接到资源夹模块）。 */
  readSourceImage(assetId: string): Promise<SourceImageBytes>;
  /**
   * 写执行进度，同时记下正在处理的那一格（`<sourceAssetId>|<category>`）：
   * 界面据此把「处理中」与「等待中」分开（MKACG-999）。还没轮到的项与终态都写 null。
   */
  reportProgress(
    progress: ExtractionProgress,
    currentItemKey: string | null,
  ): Promise<void>;
}

/**
 * 一项被视觉判定为「不存在」（原图 × 类别，ADR 0011 第 2 条）：
 * 不发起图生图，`reason` 保存模型原话（判定依据，AC-LIB-11）。
 */
export interface ExtractionSkip {
  category: string;
  sourceAssetId: string;
  reason: string;
}

export interface ExtractionOutcome {
  images: ExtractedImage[];
  failures: ExtractionFailure[];
  /** 判定为不存在、没有发起图生图的条目。 */
  skipped: ExtractionSkip[];
  meta?: Record<string, unknown>;
}

export interface ExtractionHandler {
  run(context: ExtractionContext): Promise<ExtractionOutcome>;
}

/** 运行失败记录：部分失败时带上逐项失败清单（`failures`），界面据此点名。 */
export interface ExtractionErrorRecord extends FailureRecord {
  failures?: ExtractionFailure[];
}

/* ---------- 持久化记录 ---------- */

export interface ExtractionRunRecord {
  id: string;
  collectionId: string;
  status: ExtractionStatus;
  requirement: string;
  categories: string[];
  sourceAssetIds: string[];
  progress: ExtractionProgress | null;
  error: ExtractionErrorRecord | null;
  extraPrompt: string | null;
  /** 正在处理的那一格（`<sourceAssetId>|<category>`）；没在跑或运行已进终态时为 null。 */
  currentItemKey: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/**
 * 一条提取条目（原图 × 类别）的落库形状（ADR 0011 第 3 条）。
 * 三种结局共用一行：`libraryAssetId` 只在 `succeeded` 时有值，`skipReason` 只在 `skipped` 时有值。
 */
export interface ExtractionItemInput {
  sourceAssetId: string;
  category: string;
  status: ExtractionItemStatus;
  libraryAssetId: string | null;
  skipReason: string | null;
  error: FailureRecord | null;
}

export interface ExtractionItemRecord extends ExtractionItemInput {
  id: string;
  extractionRunId: string;
  createdAt: Date;
}

export interface LibraryAssetInput {
  storageKey: string;
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  category: string;
  sourceAssetId: string;
  sortOrder: number;
  /** 是否已经去掉上游水印（MKACG-1004）。 */
  watermarkRemoved: boolean;
  /** 没去水印的原因；去掉时是 null。 */
  watermarkNote: string | null;
}

export interface LibraryAssetRecord {
  id: string;
  collectionId: string;
  extractionRunId: string;
  sourceAssetId: string;
  category: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  sortOrder: number;
  /** 是否已经去掉上游水印（MKACG-1004）。 */
  watermarkRemoved: boolean;
  /** 没去水印的原因；去掉时是 null。 */
  watermarkNote: string | null;
  createdAt: Date;
}
