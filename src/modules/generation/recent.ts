/**
 * 工作台「最近生成的内容」（docs/prd/09-dashboard.md MUST 2）。
 *
 * 单独成文件的原因与 `counts.ts` 相同：工作台要一份「结果 + 所属资源夹名称 + 缩略图」的轻量形状，
 * 而资源夹名称只能经资源夹模块取（AGENTS.md 硬性规则 2），没必要把它塞进任务 service。
 */
import { getCollectionNames } from "@/modules/media-collection/service";
import { DEFAULT_THUMBNAIL_WIDTH } from "@/modules/media-collection/constants";
import { generatedAssetUrl } from "./view";
import { listRecentResults as listRecentRows } from "./repo";

export interface RecentResultView {
  id: string;
  collectionId: string;
  /** 资源夹被删时结果随外键级联删除；取不到名称说明数据已损坏，这里留空字符串，页面不编造名称。 */
  collectionName: string;
  title: string | null;
  /** 第一张生成图片的缩略图地址；没有图片（理论上不会发生）时为 null。 */
  thumbnailUrl: string | null;
  createdAt: string;
}

/** 按创建时间倒序取最近的 `limit` 条结果，字段够工作台卡片直接用。 */
export async function listRecentResults(limit: number): Promise<RecentResultView[]> {
  const rows = await listRecentRows(limit);
  const names = await getCollectionNames(rows.map((row) => row.collectionId));

  return rows.map((row) => ({
    id: row.id,
    collectionId: row.collectionId,
    collectionName: names[row.collectionId] ?? "",
    title: row.title,
    thumbnailUrl: row.firstAssetId
      ? generatedAssetUrl(row.id, row.firstAssetId, DEFAULT_THUMBNAIL_WIDTH)
      : null,
    createdAt: row.createdAt.toISOString(),
  }));
}
