/**
 * 发布记录的对外形状：接口与页面只见到这一层（与 `copy-generation/view.ts` 同一约定）。
 * 记录显示版本号与素材快照（docs/prd/12「页面结构」发布页签第 5 条）。
 */
import { libraryAssetUrl } from "@/modules/extraction/view";
import { DEFAULT_THUMBNAIL_WIDTH } from "@/modules/media-collection/constants";
import type { PublishRecordRow } from "./repo";

export interface PublishRecordView {
  id: string;
  /** 发布的文案版本。 */
  copyVersionId: string;
  versionNo: number;
  versionLabel: string;
  collectionId: string;
  /** 来源资源夹名称（列表展示用）。 */
  collectionName: string;
  platform: string;
  publishedAt: string;
  /** 标题快照：发布当时的标题，之后编辑版本也不变。 */
  title: string;
  imageCount: number;
  selectedAssetIds: string[];
  /** 第一张素材的缩略图；素材已被删除时为 null。 */
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublishRecordView(
  row: PublishRecordRow,
  collectionName: string,
  versionNo: number,
  existingAssetIds: ReadonlySet<string>,
): PublishRecordView {
  const firstAssetId = row.selectedAssetIds[0];
  return {
    id: row.id,
    copyVersionId: row.copyVersionId,
    versionNo,
    versionLabel: `v${versionNo}`,
    collectionId: row.collectionId,
    collectionName,
    platform: row.platform,
    publishedAt: row.publishedAt.toISOString(),
    title: row.titleSnapshot,
    imageCount: row.selectedAssetIds.length,
    selectedAssetIds: row.selectedAssetIds,
    thumbnailUrl:
      firstAssetId && existingAssetIds.has(firstAssetId)
        ? libraryAssetUrl(firstAssetId, DEFAULT_THUMBNAIL_WIDTH)
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
