/**
 * 工作台「最近生成的内容」（docs/prd/09-dashboard.md MUST 2）。
 *
 * 单独成文件是为了避开模块循环：工作台要一份「版本 + 所属资源夹名称 + 缩略图」的轻量形状，
 * 而资源夹名称只能经资源夹模块取（AGENTS.md 硬性规则 2）。
 */
import { getCollectionNames } from "@/modules/media-collection/service";
import { DEFAULT_THUMBNAIL_WIDTH } from "@/modules/media-collection/constants";
import { getLibraryAssets } from "@/modules/extraction/service";
import { libraryAssetUrl } from "@/modules/extraction/view";
import { listRecentVersions as listRecentRows } from "./repo";

export interface RecentVersionView {
  id: string;
  collectionId: string;
  collectionName: string;
  versionNo: number;
  /** 界面上的「v3」：与版本视图同一格式，调用方不再自己拼。 */
  versionLabel: string;
  title: string | null;
  /** 第一张素材的缩略图地址；素材已被删除或没有素材时为 null。 */
  thumbnailUrl: string | null;
  createdAt: string;
}

/** 按创建时间倒序取最近的 `limit` 条版本，字段够工作台卡片直接用。 */
export async function listRecentVersions(limit: number): Promise<RecentVersionView[]> {
  const rows = await listRecentRows(limit);
  const [names, assets] = await Promise.all([
    getCollectionNames(rows.map((row) => row.collectionId)),
    getLibraryAssets(rows.map((row) => row.firstAssetId).filter((id): id is string => Boolean(id))),
  ]);
  const existing = new Set(assets.map((asset) => asset.id));

  return rows.map((row) => ({
    id: row.id,
    collectionId: row.collectionId,
    collectionName: names[row.collectionId] ?? "",
    versionNo: row.versionNo,
    versionLabel: `v${row.versionNo}`,
    title: row.title,
    thumbnailUrl:
      row.firstAssetId && existing.has(row.firstAssetId)
        ? libraryAssetUrl(row.firstAssetId, DEFAULT_THUMBNAIL_WIDTH)
        : null,
    createdAt: row.createdAt.toISOString(),
  }));
}
