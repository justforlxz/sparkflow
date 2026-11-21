/**
 * 发布记录的持久化访问（AGENTS.md 硬性规则 10：数据访问集中在这里）。
 * 记录挂在文案版本上（`copy_version_id` 唯一），重复标记只更新这一行（docs/prd/12 MUST 6）。
 */
import { getDb } from "@/lib/db";

export interface PublishRecordRow {
  id: string;
  copyVersionId: string;
  collectionId: string;
  platform: string;
  publishedAt: Date;
  titleSnapshot: string;
  selectedAssetIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PublishRecordFields {
  copyVersionId: string;
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
  copyVersionId: true,
  collectionId: true,
  platform: true,
  publishedAt: true,
  titleSnapshot: true,
  selectedAssetIds: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toRow(row: PublishRecordRow): PublishRecordRow {
  return { ...row, selectedAssetIds: row.selectedAssetIds ?? [] };
}

/**
 * 写入发布记录（AC-LIB-8）：`copy_version_id` 唯一，已有记录时原地更新。
 * 用 upsert 而不是「先查再写」，重复标记不会产生第二条。
 */
export async function upsertRecord(fields: PublishRecordFields): Promise<PublishRecordRow> {
  const row = await getDb().publishRecord.upsert({
    where: { copyVersionId: fields.copyVersionId },
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

export async function findRecordByVersionId(
  copyVersionId: string,
): Promise<PublishRecordRow | null> {
  const row = await getDb().publishRecord.findUnique({
    where: { copyVersionId },
    select: RECORD_SELECT,
  });
  return row ? toRow(row) : null;
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

/** 批量判断发布状态：只取 id，不做整行读取。 */
export async function findPublishedVersionIds(
  versionIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(versionIds)];
  if (unique.length === 0) return [];
  const rows = await getDb().publishRecord.findMany({
    where: { copyVersionId: { in: unique } },
    select: { copyVersionId: true },
  });
  return rows.map((row) => row.copyVersionId);
}
