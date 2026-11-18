/**
 * 资源夹与原图的持久化访问（AGENTS.md 硬性规则 10：数据访问集中在这里）。
 * 这里只做查询与写入，业务判定在 `service.ts`。
 */
import { getDb } from "@/lib/db";

export interface CollectionRow {
  id: string;
  name: string;
  platform: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceBody: string | null;
  createdAt: Date;
  updatedAt: Date;
  assetCount: number;
  coverAssetId: string | null;
}

export interface AssetRow {
  id: string;
  collectionId: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  size: number;
  sortOrder: number;
}

export interface CollectionFields {
  name: string;
  platform: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceBody: string | null;
}

export interface NewAsset {
  storageKey: string;
  fileName: string;
  mimeType: string;
  size: number;
}

/**
 * 批量取资源夹名称：创作任务列表要显示资源夹名，只能经本模块的 service 取
 * （AGENTS.md 硬性规则 2：不直接查别的模块的表）。
 */
export async function findCollectionNames(
  ids: readonly string[],
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const rows = await getDb().mediaCollection.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true },
  });
  return Object.fromEntries(rows.map((row) => [row.id, row.name]));
}

const ASSET_SELECT = {
  id: true,
  collectionId: true,
  storageKey: true,
  fileName: true,
  mimeType: true,
  size: true,
  sortOrder: true,
} as const;

const COLLECTION_SELECT = {
  id: true,
  name: true,
  platform: true,
  sourceUrl: true,
  sourceTitle: true,
  sourceBody: true,
  createdAt: true,
  updatedAt: true,
  assets: { select: { id: true }, orderBy: { sortOrder: "asc" }, take: 1 },
  _count: { select: { assets: true } },
} as const;

type RawCollectionRow = {
  id: string;
  name: string;
  platform: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceBody: string | null;
  createdAt: Date;
  updatedAt: Date;
  assets: { id: string }[];
  _count: { assets: number };
};

function toCollectionRow(row: RawCollectionRow): CollectionRow {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    sourceUrl: row.sourceUrl,
    sourceTitle: row.sourceTitle,
    sourceBody: row.sourceBody,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    assetCount: row._count.assets,
    coverAssetId: row.assets[0]?.id ?? null,
  };
}

/** 列表：按创建时间倒序。`q` 同时匹配名称、原始标题与来源链接。 */
export async function listCollections(q?: string): Promise<CollectionRow[]> {
  const rows = await getDb().mediaCollection.findMany({
    where: q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { sourceTitle: { contains: q, mode: "insensitive" } },
            { sourceUrl: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "desc" },
    select: COLLECTION_SELECT,
  });
  return rows.map(toCollectionRow);
}

export async function findCollection(id: string): Promise<CollectionRow | null> {
  const row = await getDb().mediaCollection.findUnique({ where: { id }, select: COLLECTION_SELECT });
  return row ? toCollectionRow(row) : null;
}

export async function collectionExists(id: string): Promise<boolean> {
  const row = await getDb().mediaCollection.findUnique({ where: { id }, select: { id: true } });
  return row !== null;
}

/** 资源夹与它的图片在同一个嵌套写入里落库，不会出现「资源夹进去了、图片没进」。 */
export async function createCollection(
  id: string,
  fields: CollectionFields,
  assets: NewAsset[],
): Promise<void> {
  await getDb().mediaCollection.create({
    data: {
      id,
      ...fields,
      assets: {
        create: assets.map((asset, index) => ({ ...asset, sortOrder: index })),
      },
    },
    select: { id: true },
  });
}

export async function updateCollectionFields(
  id: string,
  fields: CollectionFields,
): Promise<boolean> {
  const { count } = await getDb().mediaCollection.updateMany({ where: { id }, data: fields });
  return count > 0;
}

/** 任务、结果、发布记录的级联删除由它们自己 schema 里的外键负责（见 prisma/schema/collection.prisma 顶部说明）。 */
export async function deleteCollection(id: string): Promise<boolean> {
  const { count } = await getDb().mediaCollection.deleteMany({ where: { id } });
  return count > 0;
}

export async function listAssets(collectionId: string): Promise<AssetRow[]> {
  return getDb().mediaAsset.findMany({
    where: { collectionId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: ASSET_SELECT,
  });
}

export async function findAsset(collectionId: string, assetId: string): Promise<AssetRow | null> {
  return getDb().mediaAsset.findFirst({
    where: { id: assetId, collectionId },
    select: ASSET_SELECT,
  });
}

export async function countAssets(collectionId: string): Promise<number> {
  return getDb().mediaAsset.count({ where: { collectionId } });
}

/** 追加图片接在当前最大排序值之后，保持「按上传顺序」。 */
export async function appendAssets(collectionId: string, assets: NewAsset[]): Promise<void> {
  const last = await getDb().mediaAsset.findFirst({
    where: { collectionId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const start = (last?.sortOrder ?? -1) + 1;

  await getDb().mediaAsset.createMany({
    data: assets.map((asset, index) => ({
      ...asset,
      collectionId,
      sortOrder: start + index,
    })),
  });
}

/** 只删关联记录，磁盘文件保留（MUST 4）。 */
export async function deleteAsset(collectionId: string, assetId: string): Promise<boolean> {
  const { count } = await getDb().mediaAsset.deleteMany({ where: { id: assetId, collectionId } });
  return count > 0;
}
