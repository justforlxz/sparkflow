/**
 * 资源夹、总资源库（照片池）与资源夹关联的持久化访问（AGENTS.md 硬性规则 10：数据访问集中在这里）。
 * 这里只做查询与写入，业务判定在 `service.ts`。
 *
 * 照片与资源夹的关系在 `collection_asset` 关联表上（ADR 0012 第 1 条）：
 * 「夹里的照片」是关联行，「总资源库」是 `media_asset` 全表，两者不能混着查。
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

/** 总资源库里的一张照片：没有「属于哪个夹」这一项，归属在关联行上。 */
export interface AssetRow {
  id: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: Date;
}

/** 夹里的照片：多一个「在这个夹里的顺序」。 */
export interface CollectionAssetRow extends AssetRow {
  sortOrder: number;
}

/** 总资源库列表项：带它被归到了哪些资源夹（AC-POOL-2）。 */
export interface PoolAssetRow extends AssetRow {
  collections: Array<{ id: string; name: string }>;
}

export interface CollectionFields {
  name: string;
  platform: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceBody: string | null;
}

/** 新落库的一张照片。`id` 由调用方先定：`storage_key` 要用它做文件名。 */
export interface NewAsset {
  id: string;
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

/**
 * 发布记录的资源夹筛选选项：只需要 id 与名称，按创建时间倒序。
 * 不翻页 —— 筛选器要列出全部资源夹，否则筛不到排在后面的。
 */
export async function listCollectionOptions(): Promise<Array<{ id: string; name: string }>> {
  return getDb().mediaCollection.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "desc" },
  });
}

const ASSET_SELECT = {
  id: true,
  storageKey: true,
  fileName: true,
  mimeType: true,
  size: true,
  createdAt: true,
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
  // 封面取夹里第一张照片（MAY），顺序与详情页一致。
  // 走 `collectionAssets`（关联行）而不是 `assets`（兼容用的 MediaAsset 反向字段）。
  collectionAssets: { select: { assetId: true }, orderBy: { sortOrder: "asc" }, take: 1 },
  _count: { select: { collectionAssets: true } },
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
  collectionAssets: { assetId: string }[];
  _count: { collectionAssets: number };
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
    assetCount: row._count.collectionAssets,
    coverAssetId: row.collectionAssets[0]?.assetId ?? null,
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
/** 工作台「最近的媒体资源夹」：按创建时间倒序取前 N 条，不加载全量（docs/prd/09 MUST 2）。 */
export async function listRecentCollections(limit: number): Promise<CollectionRow[]> {
  const rows = await getDb().mediaCollection.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: COLLECTION_SELECT,
  });
  return rows.map(toCollectionRow);
}

/** 资源夹总数（工作台统计与侧栏计数）。 */
export async function countCollections(): Promise<number> {
  return getDb().mediaCollection.count();
}

export async function findCollection(id: string): Promise<CollectionRow | null> {
  const row = await getDb().mediaCollection.findUnique({ where: { id }, select: COLLECTION_SELECT });
  return row ? toCollectionRow(row) : null;
}

export async function collectionExists(id: string): Promise<boolean> {
  const row = await getDb().mediaCollection.findUnique({ where: { id }, select: { id: true } });
  return row !== null;
}

/**
 * 资源夹、照片与关联行在同一个嵌套写入里落库，不会出现「资源夹进去了、图片没进」。
 * 照片先进池（`media_asset`），再建关联（`collection_asset`）。
 */
export async function createCollection(
  id: string,
  fields: CollectionFields,
  assets: NewAsset[],
): Promise<void> {
  await getDb().mediaCollection.create({
    data: {
      id,
      ...fields,
      collectionAssets: {
        create: assets.map((asset, index) => ({
          sortOrder: index,
          asset: {
            create: {
              id: asset.id,
              storageKey: asset.storageKey,
              fileName: asset.fileName,
              mimeType: asset.mimeType,
              size: asset.size,
            },
          },
        })),
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

/**
 * 删除资源夹：只删资源夹行，**照片行与磁盘文件都保留**（AC-POOL-4、ADR 0012 第 1 条）。
 *
 * 两条外键动作在这里各管一半，缺一条就会删照片：
 * - `collection_asset.collection_id` 是 `ON DELETE CASCADE`，关联行随夹删除；
 * - `media_asset.collection_id` 是 `ON DELETE SET NULL`，迁移来的历史照片只丢归属（AC-POOL-8）。
 * 任务、结果、发布记录同样由它们自己 schema 里的外键负责。
 */
export async function deleteCollection(id: string): Promise<boolean> {
  const { count } = await getDb().mediaCollection.deleteMany({ where: { id } });
  return count > 0;
}

/** 夹里的照片：经关联表取，顺序按关联行上的 `sort_order`。 */
export async function listAssetsByCollection(collectionId: string): Promise<CollectionAssetRow[]> {
  const rows = await getDb().collectionAsset.findMany({
    where: { collectionId },
    orderBy: [{ sortOrder: "asc" }, { addedAt: "asc" }],
    select: { sortOrder: true, asset: { select: ASSET_SELECT } },
  });
  return rows.map((row) => ({ ...row.asset, sortOrder: row.sortOrder }));
}


/** 总资源库里的一张照片（与它属于哪个夹无关）。 */
export async function findAsset(assetId: string): Promise<AssetRow | null> {
  return getDb().mediaAsset.findUnique({ where: { id: assetId }, select: ASSET_SELECT });
}

export async function findAssetsByIds(ids: readonly string[]): Promise<AssetRow[]> {
  if (ids.length === 0) return [];
  return getDb().mediaAsset.findMany({
    where: { id: { in: [...ids] } },
    select: ASSET_SELECT,
  });
}

/**
 * 总资源库列表（AC-POOL-2）：按上传时间倒序分页，每张照片带它被归到的资源夹。
 * 列表与总数是两条独立查询并发发出，没有跨查询快照；分页期间有新增时，
 * `total` 可能比这一页能翻到的条数多一条，属于可接受的分页漂移。
 */
export async function listPoolAssets(
  page: number,
  pageSize: number,
): Promise<{ rows: PoolAssetRow[]; total: number }> {
  const [rows, total] = await Promise.all([
    getDb().mediaAsset.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        ...ASSET_SELECT,
        collections: {
          select: { collectionId: true, collection: { select: { name: true } } },
          orderBy: { addedAt: "asc" },
        },
      },
    }),
    getDb().mediaAsset.count(),
  ]);

  return {
    total,
    rows: rows.map(({ collections, ...asset }) => ({
      ...asset,
      collections: collections.map((item) => ({
        id: item.collectionId,
        name: item.collection.name,
      })),
    })),
  };
}

/** 只入池：上传到总资源库不建任何关联（`POST /api/library/assets`）。返回落库后的行。 */
export async function createPoolAssets(assets: NewAsset[]): Promise<AssetRow[]> {
  if (assets.length === 0) return [];
  return getDb().mediaAsset.createManyAndReturn({ data: assets, select: ASSET_SELECT });
}

/**
 * 加入资源夹（AC-POOL-5）：已存在的关联跳过，重复调用不会多出行。
 * 新关联接在当前最大顺序之后，保持「按加入顺序」。
 */
export async function addAssetsToCollection(
  collectionId: string,
  assetIds: readonly string[],
): Promise<void> {
  if (assetIds.length === 0) return;

  const last = await getDb().collectionAsset.findFirst({
    where: { collectionId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const start = (last?.sortOrder ?? -1) + 1;

  await getDb().collectionAsset.createMany({
    data: assetIds.map((assetId, index) => ({
      collectionId,
      assetId,
      sortOrder: start + index,
    })),
    skipDuplicates: true,
  });
}

/** 从夹里移除：只删关联行，照片与磁盘文件都保留（AC-POOL-3、MUST 4）。 */
export async function removeAssetFromCollection(
  collectionId: string,
  assetId: string,
): Promise<boolean> {
  const { count } = await getDb().collectionAsset.deleteMany({
    where: { collectionId, assetId },
  });
  return count > 0;
}

/** 从总资源库删除照片：关联行随外键级联删除（AC-POOL-7）。 */
export async function deletePoolAsset(assetId: string): Promise<boolean> {
  const { count } = await getDb().mediaAsset.deleteMany({ where: { id: assetId } });
  return count > 0;
}

export interface CollectionEditPlan {
  /** 保留的图片与它们在新顺序里的位置（数组下标即 `sort_order`）。 */
  keep: Array<{ assetId: string; sortOrder: number }>;
  /** 从夹里移除的图片 id（只删关联行）。 */
  remove: string[];
  /** 新增的图片：入池 + 建关联，`sortOrder` 同样是新顺序里的位置。 */
  adds: Array<NewAsset & { sortOrder: number }>;
}

/**
 * 编辑保存的落库：来源字段与图片变更在同一个事务里提交，要么全成，要么全不变。
 * 调用方负责先把新文件写盘；本函数只动数据库，失败时由调用方补偿删除本次新写的文件。
 * 「移除」只删关联行（AC-POOL-3），照片留在池里。
 */
export async function saveCollectionEdit(
  collectionId: string,
  fields: CollectionFields,
  plan: CollectionEditPlan,
): Promise<void> {
  await getDb().$transaction(async (tx) => {
    await tx.mediaCollection.update({ where: { id: collectionId }, data: fields });

    if (plan.remove.length > 0) {
      await tx.collectionAsset.deleteMany({
        where: { collectionId, assetId: { in: plan.remove } },
      });
    }

    // 保留项的排序逐条更新：Prisma 没有「一次更新多个不同值」的批量写法。
    for (const item of plan.keep) {
      await tx.collectionAsset.updateMany({
        where: { collectionId, assetId: item.assetId },
        data: { sortOrder: item.sortOrder },
      });
    }

    for (const asset of plan.adds) {
      await tx.mediaAsset.create({
        data: {
          id: asset.id,
          storageKey: asset.storageKey,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          size: asset.size,
        },
      });
      await tx.collectionAsset.create({
        data: { collectionId, assetId: asset.id, sortOrder: asset.sortOrder },
      });
    }
  });
}

/**
 * 夹内上传（AC-POOL-6）：照片入池 + 建关联，一次事务。
 * 新关联接在当前最大顺序之后，保持「按上传顺序」。
 */
export async function appendAssetsToCollection(
  collectionId: string,
  assets: NewAsset[],
): Promise<void> {
  if (assets.length === 0) return;

  await getDb().$transaction(async (tx) => {
    const last = await tx.collectionAsset.findFirst({
      where: { collectionId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const start = (last?.sortOrder ?? -1) + 1;

    for (const [index, asset] of assets.entries()) {
      await tx.mediaAsset.create({
        data: {
          id: asset.id,
          storageKey: asset.storageKey,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          size: asset.size,
        },
      });
      await tx.collectionAsset.create({
        data: { collectionId, assetId: asset.id, sortOrder: start + index },
      });
    }
  });
}

/**
 * 分配下一个文案版本号（docs/prd/12 MUST 5）：在资源夹的计数器上原子加一。
 *
 * 为什么不是「当前最大版本号 + 1」：删掉最高的那一版之后，那种算法会把编号再发一次，
 * 而版本号在资源夹内必须只增不减。计数器只增不减，删除版本也不回收。
 */
export async function allocateCopyVersionNumber(collectionId: string): Promise<number> {
  const row = await getDb().mediaCollection.update({
    where: { id: collectionId },
    data: { copyVersionSeq: { increment: 1 } },
    select: { copyVersionSeq: true },
  });
  return row.copyVersionSeq;
}
