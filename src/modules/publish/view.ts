/**
 * 发布记录的对外形状：接口与页面只见到这一层（与 `generation/view.ts` 同一约定）。
 * 缩略图地址按「记录里第一张图片」生成；图片读不到时是 404，不影响记录本身。
 */
import { generatedAssetUrl } from "@/modules/generation/view";
import { DEFAULT_THUMBNAIL_WIDTH } from "@/modules/media-collection/constants";
import type { PublishRecordRow } from "./repo";

export interface PublishRecordView {
  id: string;
  resultId: string;
  collectionId: string;
  /** 来源资源夹名称（列表展示用，docs/prd/08「记录项展示」）。 */
  collectionName: string;
  platform: string;
  publishedAt: string;
  /** 标题快照：发布当时的标题，之后编辑结果也不变（docs/prd/08 SHOULD）。 */
  title: string;
  imageCount: number;
  selectedAssetIds: string[];
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublishRecordView(
  row: PublishRecordRow,
  collectionName: string,
): PublishRecordView {
  const firstAssetId = row.selectedAssetIds[0];
  return {
    id: row.id,
    resultId: row.resultId,
    collectionId: row.collectionId,
    collectionName,
    platform: row.platform,
    publishedAt: row.publishedAt.toISOString(),
    title: row.titleSnapshot,
    imageCount: row.selectedAssetIds.length,
    selectedAssetIds: row.selectedAssetIds,
    thumbnailUrl: firstAssetId
      ? generatedAssetUrl(row.resultId, firstAssetId, DEFAULT_THUMBNAIL_WIDTH)
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
