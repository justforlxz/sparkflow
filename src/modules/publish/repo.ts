/**
 * 发布记录的持久化访问（AGENTS.md 硬性规则 10：数据访问集中在这里）。
 * 这里只有查询与写入；文案拼格式、打包、幂等判定与视图组装在 `service.ts`。
 */
import { getDb } from "@/lib/db";

export interface PublishRecordRow {
  id: string;
  resultId: string;
  collectionId: string;
  platform: string;
  publishedAt: Date;
  titleSnapshot: string;
  selectedAssetIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PublishRecordFields {
  resultId: string;
  collectionId: string;
  platform: string;
  publishedAt: Date;
  titleSnapshot: string;
  selectedAssetIds: string[];
}

export interface ListRecordsFilter {
  collectionId?: string;
  skip: number;
  take: number;
}

const RECORD_SELECT = {
  id: true,
  resultId: true,
  collectionId: true,
  platform: true,
  publishedAt: true,
  titleSnapshot: true,
  selectedAssetIds: true,
  createdAt: true,
  updatedAt: true,
} as const;

type RawRecordRow = {
  id: string;
  resultId: string;
  collectionId: string;
  platform: string;
  publishedAt: Date;
  titleSnapshot: string;
  selectedAssetIds: string[];
  createdAt: Date;
  updatedAt: Date;
};

function toRow(row: RawRecordRow): PublishRecordRow {
  return { ...row, selectedAssetIds: row.selectedAssetIds ?? [] };
}

/**
 * 写入发布记录（docs/prd/08 MUST 6、AC-08-5）：`result_id` 唯一，已有记录时原地更新。
 * 用 upsert 而不是「先查再写」，重复标记不会产生第二条，也不依赖调用方先读一次。
 */
export async function upsertRecord(fields: PublishRecordFields): Promise<PublishRecordRow> {
  const row = await getDb().publishRecord.upsert({
    where: { resultId: fields.resultId },
    create: { ...fields },
    update: {
      collectionId: fields.collectionId,
      platform: fields.platform,
      publishedAt: fields.publishedAt,
      titleSnapshot: fields.titleSnapshot,
      selectedAssetIds: fields.selectedAssetIds,
    },
    select: RECORD_SELECT,
  });
  return toRow(row);
}

export async function findRecordByResultId(resultId: string): Promise<PublishRecordRow | null> {
  const row = await getDb().publishRecord.findUnique({
    where: { resultId },
    select: RECORD_SELECT,
  });
  return row ? toRow(row) : null;
}

/** 撤销发布记录；没有记录时返回 false，由 service 决定怎么报错。 */
export async function deleteRecordByResultId(resultId: string): Promise<boolean> {
  const result = await getDb().publishRecord.deleteMany({ where: { resultId } });
  return result.count > 0;
}

/** 按发布时间倒序（docs/prd/08 SHOULD）；同一秒内按创建顺序兜底，翻页结果稳定。 */
export async function listRecords(filter: ListRecordsFilter): Promise<PublishRecordRow[]> {
  const rows = await getDb().publishRecord.findMany({
    where: filter.collectionId ? { collectionId: filter.collectionId } : undefined,
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    skip: filter.skip,
    take: filter.take,
    select: RECORD_SELECT,
  });
  return rows.map(toRow);
}

export async function countRecords(collectionId?: string): Promise<number> {
  return getDb().publishRecord.count({
    where: collectionId ? { collectionId } : undefined,
  });
}

/** 结果页签用：哪些结果已经有发布记录。只取 id，不做整行读取。 */
export async function findPublishedResultIds(
  resultIds: readonly string[],
): Promise<string[]> {
  if (resultIds.length === 0) return [];
  const rows = await getDb().publishRecord.findMany({
    where: { resultId: { in: [...resultIds] } },
    select: { resultId: true },
  });
  return rows.map((row) => row.resultId);
}

/**
 * 结果被编辑后同步标题快照（docs/prd/07 MUST 5）。
 * 没有发布记录时什么都不写：这里是同步，不是创建。
 */
export async function updateTitleSnapshot(resultId: string, title: string): Promise<void> {
  await getDb().publishRecord.updateMany({
    where: { resultId },
    data: { titleSnapshot: title },
  });
}
