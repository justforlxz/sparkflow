/**
 * 文案版本的对外形状：接口与页面只见到这一层（与 `extraction/view.ts` 同一约定）。
 *
 * 版本里固化的 `selected_asset_ids` 要在返回前还原成可用图片（MUST 4）：
 * 素材已被删除时保留 id 并标记 `deleted`，界面显示「已删除素材」而不是让这一项消失。
 */
import type { LibraryAssetRecord } from "@/modules/extraction/types";
import { libraryAssetUrl } from "@/modules/extraction/view";
import { DEFAULT_THUMBNAIL_WIDTH } from "@/modules/media-collection/constants";
import { categoryLabel } from "@/modules/extraction/categories";
import { findCopyStyle } from "./styles";
import { COPY_VERSION_COPY, COPY_VERSION_STATUS_LABELS } from "./constants";
import type { CopyVersionRecord } from "./types";

export interface CopyVersionAssetView {
  id: string;
  /** 素材已从素材库删除：版本里仍然保留这个 id。 */
  deleted: boolean;
  category: string | null;
  categoryLabel: string | null;
  fileName: string | null;
  url: string | null;
  thumbnailUrl: string | null;
}

export interface CopyVersionView {
  id: string;
  collectionId: string;
  versionNo: number;
  /** 界面上的「v3」。 */
  versionLabel: string;
  status: CopyVersionRecord["status"];
  statusLabel: string;
  title: string | null;
  body: string | null;
  tags: string[];
  copyStyle: string;
  copyStyleLabel: string;
  selectedAssetIds: string[];
  /** 与 `selectedAssetIds` 同序；已删除的素材是 `deleted: true` 的占位。 */
  assets: CopyVersionAssetView[];
  extraPrompt: string | null;
  /** 失败原因（`code` / `message` / `at`）。 */
  error: { code: string; message: string; at: string } | null;
  /** 视觉提取降级（没拿到素材内容），文案仍已生成（docs/prd/06）。 */
  copyVisualDegraded: boolean;
  copyVisualDegradedHint: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** 视觉提取的结局存在 `meta.visualExtraction`：`done` 之外的值都要标注。 */
function visualDegraded(meta: Record<string, unknown> | null): {
  degraded: boolean;
  hint: string | null;
} {
  const state = meta?.visualExtraction;
  if (state === undefined || state === null || state === "done") {
    return { degraded: false, hint: null };
  }
  return {
    degraded: true,
    hint:
      state === "skipped-no-vision-gateway"
        ? COPY_VERSION_COPY.visualDegradedNoGateway
        : COPY_VERSION_COPY.visualDegradedFailed,
  };
}

export function toCopyVersionView(
  version: CopyVersionRecord,
  resolvedAssets: readonly LibraryAssetRecord[],
): CopyVersionView {
  const byId = new Map(resolvedAssets.map((asset) => [asset.id, asset]));
  const visual = visualDegraded(version.meta);

  return {
    id: version.id,
    collectionId: version.collectionId,
    versionNo: version.versionNo,
    versionLabel: `v${version.versionNo}`,
    status: version.status,
    statusLabel: COPY_VERSION_STATUS_LABELS[version.status],
    title: version.title,
    body: version.body,
    tags: version.tags,
    copyStyle: version.copyStyle,
    copyStyleLabel: findCopyStyle(version.copyStyle)?.label ?? version.copyStyle,
    selectedAssetIds: version.selectedAssetIds,
    assets: version.selectedAssetIds.map((assetId) => {
      const asset = byId.get(assetId);
      if (!asset) {
        return {
          id: assetId,
          deleted: true,
          category: null,
          categoryLabel: COPY_VERSION_COPY.deletedAssetLabel,
          fileName: null,
          url: null,
          thumbnailUrl: null,
        };
      }
      return {
        id: asset.id,
        deleted: false,
        category: asset.category,
        categoryLabel: categoryLabel(asset.category),
        fileName: asset.fileName,
        url: libraryAssetUrl(asset.id),
        thumbnailUrl: libraryAssetUrl(asset.id, DEFAULT_THUMBNAIL_WIDTH),
      };
    }),
    extraPrompt: version.extraPrompt,
    error: version.error
      ? { code: version.error.code, message: version.error.message, at: version.error.at }
      : null,
    copyVisualDegraded: visual.degraded,
    copyVisualDegradedHint: visual.hint,
    createdAt: version.createdAt.toISOString(),
    finishedAt: version.finishedAt?.toISOString() ?? null,
  };
}
