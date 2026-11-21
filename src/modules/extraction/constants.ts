/**
 * 提取运行的常量（docs/prd/12-asset-library.md、ADR 0010）：
 * 状态枚举、错误码、上限、超时与界面文案集中在这里（AGENTS.md 硬性规则 1）。
 */

export const EXTRACTION_STATUSES = ["queued", "running", "succeeded", "partial", "failed"] as const;

export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const EXTRACTION_STATUS_LABELS: Record<ExtractionStatus, string> = {
  queued: "排队中",
  running: "提取中",
  succeeded: "已完成",
  partial: "部分失败",
  failed: "失败",
};

/** 无法推进的终态；`partial` 也是终态（成功的已入库，失败的记了原因）。 */
export const EXTRACTION_TERMINAL_STATUSES = ["succeeded", "partial", "failed"] as const;

/** 作业错误的业务子码（写进 `extraction_run.error.code`）。 */
export const EXTRACTION_ERROR_CODES = {
  /** 服务重启时把残留的 running 记为失败。 */
  serverRestarted: "SERVER_RESTARTED",
  /** 单次运行总超时。 */
  timeout: "EXTRACTION_TIMEOUT",
  /** 处理器抛出的不是带业务码的错误。 */
  jobFailed: "EXTRACTION_FAILED",
  /** 执行时读不到资源夹（多半是运行跑到一半资源夹被删，外键级联已把运行删掉）。 */
  collectionMissing: "COLLECTION_MISSING",
  /** 全部项都没提取成功。 */
  allFailed: "EXTRACTION_ALL_FAILED",
  /** 部分项失败：成功的已入库，整体记 partial。 */
  partial: "EXTRACTION_PARTIAL",
} as const;

/** 单次提取运行的总超时：一图一类别一次调用，随勾选量增长。 */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 45 * 60 * 1000;

/** worker 轮询间隔（docs/prd/04 SHOULD）。 */
export const DEFAULT_POLL_INTERVAL_MS = 1500;

/** 素材图片存储子目录（docs/architecture.md「文件」）。 */
export const LIBRARY_STORAGE_PREFIX = "library-assets";

/**
 * 一次提取最多勾选多少张原图、多少个类别：只是防超长输入的护栏。
 * 真实上限是资源夹里的原图数与可选类别数。
 */
export const MAX_SOURCE_ASSETS = 50;
export const MAX_CATEGORIES = 10;

/** 界面轮询未终态运行的间隔（docs/prd/07 MUST 4）。 */
export const EXTRACTION_POLL_INTERVAL_MS = 3000;

/** 素材库与提取运行的界面文案（AGENTS.md 硬性规则 1）。 */
export const LIBRARY_COPY = {
  runsTitle: "提取运行",
  emptyRuns: "这个资源夹还没有提取运行。",
  emptyLibrary: "还没有素材；先勾选原图并处理。",
  progressLabel: "正在提取",
  sourceAssetLabelPrefix: "原图",
  /** 来源原图已被解除关联时如实说明，不猜编号。 */
  noSourceAssetLabel: "原图已解除关联",
  failureCountLabel: "失败项",
  deleteAction: "删除",
  deleteConfirmTitle: "删除这张素材？",
  deleteConfirmBody: "已经引用它的文案版本仍能打开，被删的素材会显示为「已删除素材」。",
  confirmDelete: "确认删除",
  historyGroupLabel: "其他（历史）",
} as const;
