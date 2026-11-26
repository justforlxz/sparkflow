/**
 * 提取运行的常量（docs/prd/12-asset-library.md、ADR 0010）：
 * 状态枚举、错误码、上限、超时与界面文案集中在这里（AGENTS.md 硬性规则 1）。
 */

export const EXTRACTION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "empty",
] as const;

export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const EXTRACTION_STATUS_LABELS: Record<ExtractionStatus, string> = {
  queued: "排队中",
  running: "提取中",
  succeeded: "已完成",
  partial: "部分失败",
  failed: "失败",
  /** 全部条目都被判定为不存在：不是失败，也没有素材产出（MUST 2c、AC-LIB-12）。 */
  empty: "未发现可提取内容",
};

/** 无法推进的终态；`partial` 与 `empty` 也是终态（成功的已入库，失败的记了原因）。 */
export const EXTRACTION_TERMINAL_STATUSES = ["succeeded", "partial", "failed", "empty"] as const;

/** 还没进终态的运行：界面在有这些运行时按 `EXTRACTION_POLL_INTERVAL_MS` 轮询进度。 */
export const EXTRACTION_ACTIVE_STATUSES = ["queued", "running"] as const;

/**
 * 提取条目（原图 × 类别）的状态（ADR 0011 第 3 条）：
 * - `succeeded`：判定存在且图生图成功，产出一条素材；
 * - `skipped`：视觉判定为不存在，不发起图生图，`skipReason` 保存模型原话；
 * - `failed`：判定存在但图生图失败，`error` 记录可读原因。
 */
export const EXTRACTION_ITEM_STATUSES = ["succeeded", "skipped", "failed"] as const;

export type ExtractionItemStatus = (typeof EXTRACTION_ITEM_STATUSES)[number];


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
  /** 视觉判定失败（没有理解网关、上游报错、回复里没有「存在 / 不存在」的结论）。 */
  visionFailed: "EXTRACTION_VISION_FAILED",
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

/**
 * 页头「提取状态」的取值（MKACG-1007 AC-UX-2）：由本夹全部原图的完成情况推导，
 * 与单条运行的状态（`ExtractionStatus`）分开：运行可能只覆盖了一部分原图。
 */
export const EXTRACTION_OVERVIEW_STATES = ["ready", "partial", "failed", "absent", "idle"] as const;

export type ExtractionOverviewState = (typeof EXTRACTION_OVERVIEW_STATES)[number];

/** 界面轮询未终态运行的间隔：`docs/prd/07-results.md` MUST 4 规定 3 秒，不按界面观感改小。 */
export const EXTRACTION_POLL_INTERVAL_MS = 3000;

/** 素材库与提取运行的界面文案（AGENTS.md 硬性规则 1）。 */
export const LIBRARY_COPY = {
  libraryTab: "素材库",
  oneClickExtract: "一键提取",
  submittingLabel: "发起中…",
  /** 三栏页的四块面板标题（ADR 0012 第 4 条）。 */
  sourcePanelTitle: "原始材料",
  resultsPanelTitle: "处理结果",
  settingsPanelTitle: "提取设置",
  /** 左栏「添加」与它的弹窗。 */
  addAction: "添加",
  addDialogTitle: (collectionName: string) => `添加到「${collectionName}」`,
  uploadTab: "本地上传",
  poolTab: "从总资源库添加",
  dropHint: "把图片拖到这里",
  chooseFilesAction: "选择文件",
  pasteHint: "也可以按 ⌘V 粘贴剪贴板里的图片",
  poolEmpty: "总资源库还没有照片。先在总资源库上传几张，再回来添加。",
  /** 已经在夹里的照片：置灰、不可选，并标出原因。 */
  alreadyInCollection: "已加",
  removePendingFile: "不要这张",
  selectedSourceCount: (selected: number, total: number) => `已选 ${selected}/${total} 张`,
  addSummary: (total: number, local: number, pool: number) =>
    `合计 ${total} 张（本地上传 ${local} 张 · 从资源库 ${pool} 张）`,
  addConfirmAction: (total: number) => `添加 ${total} 张`,
  /** 右栏「提取设置」。 */
  conditionLabel: "条件",
  extraPromptLabel: "额外补充",
  extraPromptPlaceholder: "例如：只保留干净背景",
  fixedCategoriesLabel: "固定三类",
  inlineProgressLabel: "提取中",
  /** 页头「提取状态」（MKACG-1007 AC-UX-2）：只由本夹全部原图的完成情况推导。 */
  overviewReady: "已提取",
  overviewPartial: "部分完成",
  overviewFailed: "有失败项",
  overviewAbsent: "未发现可提取内容",
  overviewIdle: "待提取",
  /** 结果卡的格子状态与操作。 */
  retryAction: "重试",
  retryingLabel: "重试中",
  /** 正在处理的那一格；同一次运行里还没轮到的格子（MKACG-999）。 */
  processingLabel: "处理中",
  waitingLabel: "等待中",
  rerunAction: "重跑",
  absentLabel: "不存在",
  idleCellLabel: "未提取",
  emptyResults: "还没有处理结果。选好原始材料与条件后点「一键提取」。",
  selectAllLabel: "勾选全部原图",
  sourceAssetSelectLabel: "选择这张原图",
  librarySelectLabel: "选择这条素材",
  selectedLibraryLabel: "已选素材",
  clearSelection: "清空选择",
  cancelAction: "取消",
  viewImage: "查看大图",
  /** 上游水印没能去掉的素材角标（MKACG-1004）：悬停时用 `watermarkNote` 说明原因。 */
  watermarkBadge: "含水印",
  closePreview: "关闭",
  sourceAssetLabelPrefix: "原图",
  /** 来源原图已被解除关联时如实说明，不猜编号。 */
  noSourceAssetLabel: "原图已解除关联",
  failureCountLabel: "失败项",
  /** 素材删除（MKACG-1006）：结果格上的逐条删除、批量删除与「只保留最新」。 */
  deleteAssetAction: "删除",
  deleteAssetLabel: "删除这条素材",
  deleteSelectedAction: "删除选中",
  keepLatestAction: "只保留最新",
  deleteConfirmTitle: "删除素材",
  deleteConfirmBody: (count: number) =>
    `将删除 ${count} 条素材，5 秒内可以撤销。原图与资源夹不受影响。`,
  keepLatestConfirmTitle: "只保留最新",
  keepLatestConfirmBody: (count: number) =>
    `将删除 ${count} 条重复的旧产物，每张原图每个类别只留最新一条，5 秒内可以撤销。`,
  confirmDelete: "删除",
  deletedToast: (count: number) => `已删除 ${count} 条素材`,
  keepLatestToast: (count: number) => `已清理 ${count} 条重复素材`,
  undoAction: "撤销",
  deleteFailed: "删除素材失败",
  itemCountSuffix: "条",
  /** 被视觉判定为不存在的条目（ADR 0011 第 3 条）：组内如实说明，模型原话可折叠展开。 */
  skippedLabel: "判定为不存在",
  skipReasonLabel: "模型原话",
  /** 视觉判定没给出「存在 / 不存在」的结论时，如实记失败，不猜。 */
  undecidedVerdict: "视觉判定没有给出「存在」或「不存在」的结论",
  /** 判定提示词里要求模型回答的两个词（解析器与提示词共用一份）。 */
  verdictPresent: "存在",
  verdictAbsent: "不存在",
} as const;
