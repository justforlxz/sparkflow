/**
 * 提取运行与素材库的对外形状：接口与页面只见到这一层。
 * 状态与类别的中文名都在这里给出，界面不再自己判断（与旧模块同一约定）。
 */
import { extractRequirementLabel } from "@/modules/image-generation/styles";
import { DEFAULT_THUMBNAIL_WIDTH } from "@/modules/media-collection/constants";
import { EXTRACTION_CATEGORIES, categoryLabel } from "./categories";
import { EXTRACTION_STATUS_LABELS, type ExtractionStatus } from "./constants";
import type {
  ExtractionErrorRecord,
  ExtractionItemRecord,
  ExtractionRunRecord,
  LibraryAssetRecord,
} from "./types";

/** 素材图片的鉴权读取地址（docs/architecture.md「文件」）。 */
export function libraryAssetUrl(assetId: string, width?: number): string {
  const base = `/api/files/library/${assetId}`;
  return width ? `${base}?w=${width}` : base;
}

export interface LibraryAssetView {
  id: string;
  collectionId: string;
  extractionRunId: string;
  category: string;
  categoryLabel: string;
  /** 来源原图 id；原图被解除关联后仍保留这个 id。 */
  sourceAssetId: string;
  /** 来源原图在资源夹里的序号（从 1 开始）；原图已被移除时为 null。 */
  sourceAssetIndex: number | null;
  fileName: string;
  mimeType: string;
  /** 产物的实际像素尺寸（MUST 2d：界面按实际尺寸展示，不假设固定比例）。 */
  width: number | null;
  height: number | null;
  /** 鉴权读取素材图片的地址，可直接渲染。 */
  url: string;
  thumbnailUrl: string;
  /** 是否已经去掉上游水印（MKACG-1004）：false 时界面标「含水印」。 */
  watermarkRemoved: boolean;
  /** 没去水印的原因（可空），界面作为角标的提示文字。 */
  watermarkNote: string | null;
  createdAt: string;
}

/**
 * 一条「判定为不存在」的提取条目（ADR 0011 第 3 条、AC-LIB-11）：
 * 组内显示「判定为不存在」与模型原话，让误判能在界面看出来。
 */
export interface SkippedItemView {
  id: string;
  category: string;
  categoryLabel: string;
  sourceAssetId: string;
  sourceAssetIndex: number | null;
  /** 视觉模型的原话（判定依据）。 */
  reason: string;
  createdAt: string;
}

export interface LibraryGroupView {
  category: string;
  label: string;
  items: LibraryAssetView[];
  /** 这一组里判定为不存在的条目；没有就是空数组。 */
  skipped: SkippedItemView[];
}

/** 素材库按类别分组返回（docs/prd/12 接口表：`GET /api/collections/[id]/library`）。 */
export interface LibraryView {
  groups: LibraryGroupView[];
  /** 素材条数（不含跳过的条目）。 */
  total: number;
}

export interface ExtractionFailureView {
  category: string;
  categoryLabel: string;
  sourceAssetId: string;
  fileName: string;
  code: string;
  message: string;
}

export interface ExtractionRunView {
  id: string;
  collectionId: string;
  status: ExtractionStatus;
  statusLabel: string;
  requirement: string;
  requirementLabel: string;
  categories: string[];
  categoryLabels: string[];
  sourceAssetIds: string[];
  /** `total` = 原图数 × 类别数（AC-LIB-1）；终态为 null。 */
  progress: { done: number; total: number } | null;
  /** 失败原因；部分失败时 `failures` 逐项列出。 */
  error: { code: string; message: string; at: string; failures: ExtractionFailureView[] } | null;
  extraPrompt: string | null;
  /** 正在处理的那一格（`<sourceAssetId>|<category>`）：界面据此区分「处理中」与「等待中」。 */
  currentItemKey: string | null;
  createdAt: string;
  finishedAt: string | null;
}

function toFailureViews(error: ExtractionErrorRecord | null): ExtractionFailureView[] {
  return (error?.failures ?? []).map((failure) => ({
    category: failure.category,
    categoryLabel: categoryLabel(failure.category),
    sourceAssetId: failure.sourceAssetId,
    fileName: failure.fileName,
    code: failure.code,
    message: failure.message,
  }));
}

export function toExtractionRunView(run: ExtractionRunRecord): ExtractionRunView {
  return {
    id: run.id,
    collectionId: run.collectionId,
    status: run.status,
    statusLabel: EXTRACTION_STATUS_LABELS[run.status],
    requirement: run.requirement,
    requirementLabel: extractRequirementLabel(run.requirement),
    categories: run.categories,
    categoryLabels: run.categories.map(categoryLabel),
    sourceAssetIds: run.sourceAssetIds,
    progress: run.progress,
    error: run.error
      ? {
          code: run.error.code,
          message: run.error.message,
          at: run.error.at,
          failures: toFailureViews(run.error),
        }
      : null,
    extraPrompt: run.extraPrompt,
    currentItemKey: run.currentItemKey,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/**
 * 来源原图在资源夹里的序号：`indexOf` 为 -1 说明原图已被移除，
 * 这时不猜编号，如实给出 null，界面显示「原图已解除关联」（LIBRARY_COPY）。
 */
export function sourceAssetIndex(
  sourceAssetId: string,
  orderedSourceAssetIds: readonly string[],
): number | null {
  const index = orderedSourceAssetIds.indexOf(sourceAssetId);
  return index === -1 ? null : index + 1;
}

export function toLibraryAssetView(
  asset: LibraryAssetRecord,
  orderedSourceAssetIds: readonly string[],
): LibraryAssetView {
  return {
    id: asset.id,
    collectionId: asset.collectionId,
    extractionRunId: asset.extractionRunId,
    category: asset.category,
    categoryLabel: categoryLabel(asset.category),
    sourceAssetId: asset.sourceAssetId,
    sourceAssetIndex: sourceAssetIndex(asset.sourceAssetId, orderedSourceAssetIds),
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    url: libraryAssetUrl(asset.id),
    thumbnailUrl: libraryAssetUrl(asset.id, DEFAULT_THUMBNAIL_WIDTH),
    watermarkRemoved: asset.watermarkRemoved,
    watermarkNote: asset.watermarkNote,
    createdAt: asset.createdAt.toISOString(),
  };
}

export function toSkippedItemView(
  item: ExtractionItemRecord,
  orderedSourceAssetIds: readonly string[],
): SkippedItemView {
  return {
    id: item.id,
    category: item.category,
    categoryLabel: categoryLabel(item.category),
    sourceAssetId: item.sourceAssetId,
    sourceAssetIndex: sourceAssetIndex(item.sourceAssetId, orderedSourceAssetIds),
    reason: item.skipReason ?? "",
    createdAt: item.createdAt.toISOString(),
  };
}

/**
 * 按类别分组：分组顺序取登记表顺序（桌面俯视图 / 基本纹理 / 形象设计 / 其他（历史）），
 * 空组不返回；组内顺序沿用查询结果（按生成时间倒序）。
 *
 * 只有「判定为不存在」条目的组也要返回 —— 否则用户看不到「为什么这次什么都没提取到」（AC-LIB-12）。
 */
export function toLibraryView(
  assets: readonly LibraryAssetRecord[],
  skipped: readonly ExtractionItemRecord[],
  orderedSourceAssetIds: readonly string[],
): LibraryView {
  const itemsByCategory = new Map<string, LibraryAssetView[]>();
  for (const asset of assets) {
    const views = itemsByCategory.get(asset.category) ?? [];
    views.push(toLibraryAssetView(asset, orderedSourceAssetIds));
    itemsByCategory.set(asset.category, views);
  }

  const skippedByCategory = new Map<string, SkippedItemView[]>();
  for (const item of skipped) {
    const views = skippedByCategory.get(item.category) ?? [];
    views.push(toSkippedItemView(item, orderedSourceAssetIds));
    skippedByCategory.set(item.category, views);
  }

  const known: string[] = EXTRACTION_CATEGORIES.map((entry) => entry.value);
  const present = [...itemsByCategory.keys(), ...skippedByCategory.keys()];
  const order = [...known, ...present.filter((value) => !known.includes(value))];
  const groups = order
    .map((category) => ({
      category,
      label: categoryLabel(category),
      items: itemsByCategory.get(category) ?? [],
      skipped: skippedByCategory.get(category) ?? [],
    }))
    .filter((group) => group.items.length > 0 || group.skipped.length > 0);

  return { groups, total: assets.length };
}
