/**
 * 提取运行与素材库的对外形状：接口与页面只见到这一层。
 * 状态与类别的中文名都在这里给出，界面不再自己判断（与旧模块同一约定）。
 */
import { extractRequirementLabel } from "@/modules/image-generation/styles";
import { DEFAULT_THUMBNAIL_WIDTH } from "@/modules/media-collection/constants";
import { EXTRACTION_CATEGORIES, categoryLabel } from "./categories";
import { EXTRACTION_STATUS_LABELS, type ExtractionStatus } from "./constants";
import type { ExtractionErrorRecord, ExtractionRunRecord, LibraryAssetRecord } from "./types";

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
  /** 鉴权读取素材图片的地址，可直接渲染。 */
  url: string;
  thumbnailUrl: string;
  createdAt: string;
}

export interface LibraryGroupView {
  category: string;
  label: string;
  items: LibraryAssetView[];
}

/** 素材库按类别分组返回（docs/prd/12 接口表：`GET /api/collections/[id]/library`）。 */
export interface LibraryView {
  groups: LibraryGroupView[];
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
    url: libraryAssetUrl(asset.id),
    thumbnailUrl: libraryAssetUrl(asset.id, DEFAULT_THUMBNAIL_WIDTH),
    createdAt: asset.createdAt.toISOString(),
  };
}

/**
 * 按类别分组：分组顺序取登记表顺序（材质纹理 / 边框样式 / 其他（历史）），
 * 空组不返回；组内顺序沿用查询结果（按生成时间倒序）。
 */
export function toLibraryView(
  assets: readonly LibraryAssetRecord[],
  orderedSourceAssetIds: readonly string[],
): LibraryView {
  const byCategory = new Map<string, LibraryAssetView[]>();
  for (const asset of assets) {
    const views = byCategory.get(asset.category) ?? [];
    views.push(toLibraryAssetView(asset, orderedSourceAssetIds));
    byCategory.set(asset.category, views);
  }

  const known: string[] = EXTRACTION_CATEGORIES.map((entry) => entry.value);
  const order = [...known, ...[...byCategory.keys()].filter((value) => !known.includes(value))];
  const groups = order
    .filter((category) => (byCategory.get(category)?.length ?? 0) > 0)
    .map((category) => ({
      category,
      label: categoryLabel(category),
      items: byCategory.get(category) ?? [],
    }));

  return { groups, total: assets.length };
}
