/**
 * 发布记录业务层（docs/prd/08-publish.md、docs/prd/12 MUST 6）：
 * 标记已发布、列表查询与发布状态。
 *
 * 边界：
 * 1. 记录只由用户手动标记产生，系统不推断发布成功（MUST NOT）；
 * 2. 记录挂文案版本：标题快照与素材快照都取自版本本身；
 * 3. 读版本、素材与资源夹名称都经各自模块的 service，本模块不查别人的表。
 */
import { AppError } from "@/lib/errors";
import { getCopyVersion, getCopyVersionSummaries } from "@/modules/copy-generation/service";
import { getLibraryAssets } from "@/modules/extraction/service";
import { collectionExists, getCollectionNames } from "@/modules/media-collection/service";
import * as repo from "./repo";
import type { ListPublishRecordsQuery, MarkPublishedInput } from "./schema";
import { toPublishRecordView, type PublishRecordView } from "./view";

export interface PublishRecordList {
  items: PublishRecordView[];
  total: number;
  page: number;
  pageSize: number;
}

/** 批量组装视图：资源夹名称、版本号与「素材是否还在」各查一次，不逐行查询。 */
async function decorate(rows: readonly repo.PublishRecordRow[]): Promise<PublishRecordView[]> {
  if (rows.length === 0) return [];
  const [names, versionNos, assets] = await Promise.all([
    getCollectionNames(rows.map((row) => row.collectionId)),
    getCopyVersionSummaries(rows.map((row) => row.copyVersionId)),
    getLibraryAssets(rows.flatMap((row) => row.selectedAssetIds)),
  ]);
  const existing = new Set(assets.map((asset) => asset.id));
  return rows.map((row) =>
    toPublishRecordView(row, names[row.collectionId] ?? "", versionNos[row.copyVersionId] ?? 0, existing),
  );
}

/**
 * 标记为已发布（AC-LIB-8）：`copy_version_id` 唯一，重复标记只更新已有记录。
 * 只有生成成功的版本才能标记：排队中或失败版本没有可发布的文案。
 */
export async function markPublished(
  copyVersionId: string,
  input: MarkPublishedInput,
): Promise<PublishRecordView> {
  const version = await getCopyVersion(copyVersionId);
  if (version.status !== "succeeded") {
    throw new AppError("CONFLICT", "只有生成完成的文案版本才能标记为已发布", {
      details: { code: "COPY_VERSION_NOT_PUBLISHABLE", status: version.status },
    });
  }

  const row = await repo.upsertRecord({
    copyVersionId,
    collectionId: version.collectionId,
    platform: input.platform,
    publishedAt: new Date(),
    titleSnapshot: version.title ?? "",
    selectedAssetIds: version.selectedAssetIds,
  });
  const [view] = await decorate([row]);
  if (!view) throw new AppError("INTERNAL", "发布记录写入后读不到，请检查数据写入路径");
  return view;
}

/** 全局列表与资源夹页签共用：按发布时间倒序，可按资源夹筛选（docs/prd/08 SHOULD）。 */
export async function listPublishRecords(
  query: ListPublishRecordsQuery,
): Promise<PublishRecordList> {
  if (query.collectionId && !(await collectionExists(query.collectionId))) {
    throw AppError.notFound("资源夹不存在");
  }

  const [rows, total] = await Promise.all([
    repo.listRecords({
      collectionId: query.collectionId,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    repo.countRecords(query.collectionId),
  ]);

  return {
    items: await decorate(rows),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** 单个版本的发布记录；发布页签用它决定显示「已发布」还是「未发布」。 */
export async function getPublishRecord(
  copyVersionId: string,
): Promise<PublishRecordView | null> {
  const row = await repo.findRecordByVersionId(copyVersionId);
  if (!row) return null;
  const [view] = await decorate([row]);
  return view ?? null;
}

/** 批量判断发布状态：只查 id，不给每个版本再查一次记录。 */
export async function getPublishedVersionIds(
  versionIds: readonly string[],
): Promise<string[]> {
  return repo.findPublishedVersionIds(versionIds);
}
