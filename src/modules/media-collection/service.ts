/**
 * 媒体资源夹与总资源库服务（docs/prd/01-media-collection.md、
 * docs/adr/0012-总资源库与资源夹的相册模型.md 第 1 条）。页面与接口只调用这里的函数。
 *
 * 两条上传入口（ADR 0012 第 1 条）：
 * - `uploadPoolAssets`：只入池，不建关联（总资源库直接上传）；
 * - `uploadCollectionAssets`：入池 + 建关联，一次事务（夹内上传）。
 *
 * 落盘与写库的顺序：先写文件再写记录。写库失败会留下没人引用的文件，
 * 但这是 ADR 明确接受的方向 —— 不引入引用计数或垃圾回收（MUST NOT）。
 * 例外是「本次请求自己新写的文件」：失败时逐个删掉，不留孤儿（AC-POOL-6）。
 */
import { randomUUID } from "node:crypto";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { countCollectionUsage, countDraftCollections } from "@/modules/extraction/service";
import { DEFAULT_THUMBNAIL_WIDTH, type CollectionStatus } from "./constants";
import { readAssetFile, removeAssetFile, writeAssetBytes } from "./files";
import * as repo from "./repo";
import { assertCollectionMutable, COLLECTION_ERROR_MESSAGES } from "./rules";
import type {
  CollectionEditAssetInput,
  CollectionFieldsInput,
  ListCollectionsQuery,
  ListPoolAssetsQuery,
} from "./schema";
import { buildAssetStorageKey } from "./storage-key";
import { deriveCollectionStatus, type CollectionCounts } from "./status";
import { scaleImage } from "./thumbnails";
import { prepareImages, type IncomingFile, type PreparedImage } from "./uploads";

export interface CollectionAssetView {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sortOrder: number;
  /** 可直接渲染的鉴权 URL（SHOULD：上传后不必二次查询）。 */
  url: string;
  /** 网格用的缩略图地址（`?w=400`）：弹窗里加载 `url` 原图（docs/prd/07 SHOULD）。 */
  thumbnailUrl: string;
}

/** 总资源库里的一张照片：多带它被归到了哪些资源夹（AC-POOL-2）。 */
export interface PoolAssetView {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  url: string;
  thumbnailUrl: string;
  collectionIds: string[];
  collectionNames: string[];
}

export interface PoolAssetList {
  items: PoolAssetView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CollectionSummaryView {
  id: string;
  name: string;
  platform: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceBody: string | null;
  createdAt: string;
  updatedAt: string;
  status: CollectionStatus;
  assetCount: number;
  /** 提取运行数（列表与详情顶部显示）。 */
  extractionRunCount: number;
  /** 素材库里的素材数。 */
  libraryAssetCount: number;
  /** 封面取第一张原图（MAY），没有图片时为 null。 */
  coverUrl: string | null;
}

export interface CollectionDetailView extends CollectionSummaryView {
  assets: CollectionAssetView[];
}

export interface CollectionList {
  items: CollectionSummaryView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AssetBytes {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}

/**
 * 关联记录计数（AC-02-10 的判定点、列表的派生状态）。
 *
 * 提取运行与素材数来自提取模块的 service：不直接查别人的表（AGENTS.md 硬性规则 2）。
 * 「运行中提取」指排队或执行中的运行：此时改图或删夹会影响正在进行的提取。
 */
async function relatedCounts(collectionId: string): Promise<CollectionCounts> {
  const usage = await countCollectionUsage(collectionId);
  return {
    runningExtractions: usage.activeRuns,
    extractionRuns: usage.runs,
    libraryAssets: usage.libraryAssets,
  };
}

/**
 * 原图字节的鉴权地址。路径里没有资源夹：照片属于总资源库，一张照片可以同时属于多个夹，
 * 把夹 id 放进 URL 会让同一张照片在不同夹下变成不同地址（ADR 0012 第 1 条）。
 */
export function assetFileUrl(assetId: string, width?: number): string {
  const base = `/api/files/assets/${assetId}`;
  return width ? `${base}?w=${width}` : base;
}

function toSummary(row: repo.CollectionRow, counts: CollectionCounts): CollectionSummaryView {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    sourceUrl: row.sourceUrl,
    sourceTitle: row.sourceTitle,
    sourceBody: row.sourceBody,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    status: deriveCollectionStatus(counts),
    assetCount: row.assetCount,
    extractionRunCount: counts.extractionRuns,
    libraryAssetCount: counts.libraryAssets,
    coverUrl: row.coverAssetId
      ? assetFileUrl(row.coverAssetId, DEFAULT_THUMBNAIL_WIDTH)
      : null,
  };
}

function toAssetView(asset: repo.CollectionAssetRow): CollectionAssetView {
  return {
    id: asset.id,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
    sortOrder: asset.sortOrder,
    url: assetFileUrl(asset.id),
    thumbnailUrl: assetFileUrl(asset.id, DEFAULT_THUMBNAIL_WIDTH),
  };
}

function toPoolAssetView(asset: repo.PoolAssetRow): PoolAssetView {
  return {
    id: asset.id,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
    createdAt: asset.createdAt.toISOString(),
    url: assetFileUrl(asset.id),
    thumbnailUrl: assetFileUrl(asset.id, DEFAULT_THUMBNAIL_WIDTH),
    collectionIds: asset.collections.map((collection) => collection.id),
    collectionNames: asset.collections.map((collection) => collection.name),
  };
}

/**
 * 列表：先按关键词查，再按派生状态筛选与分页。
 * 状态依赖提取运行与素材计数，暂时无法下推到 SQL；等这些计数能一次聚合出来再改。
 */
export async function listCollections(query: ListCollectionsQuery): Promise<CollectionList> {
  const rows = await repo.listCollections(query.q);

  const decorated = await Promise.all(
    rows.map(async (row) => ({ row, counts: await relatedCounts(row.id) })),
  );
  const matched = query.status
    ? decorated.filter((item) => deriveCollectionStatus(item.counts) === query.status)
    : decorated;

  const start = (query.page - 1) * query.pageSize;
  return {
    items: matched.slice(start, start + query.pageSize).map(({ row, counts }) => toSummary(row, counts)),
    total: matched.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** 只查存在性：创作任务与结果需要判断资源夹是否还在，但不需要它的图片与计数。 */
export async function collectionExists(id: string): Promise<boolean> {
  return repo.collectionExists(id);
}

export async function getCollection(id: string): Promise<CollectionDetailView> {
  const row = await repo.findCollection(id);
  if (!row) throw AppError.notFound("资源夹不存在");

  const [assets, counts] = await Promise.all([repo.listAssetsByCollection(id), relatedCounts(id)]);
  return { ...toSummary(row, counts), assets: assets.map(toAssetView) };
}

/** 校验通过的一张待落库照片：`id` 先定好，`storage_key` 要用它做文件名。 */
interface PreparedAsset extends PreparedImage {
  id: string;
  storageKey: string;
}

function prepareAssets(images: readonly PreparedImage[]): PreparedAsset[] {
  return images.map((image) => {
    const id = randomUUID();
    return { ...image, id, storageKey: buildAssetStorageKey(image.mimeType, id) };
  });
}

function toNewAsset(asset: PreparedAsset): repo.NewAsset {
  return {
    id: asset.id,
    storageKey: asset.storageKey,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.bytes.length,
  };
}

/**
 * 写盘 + 写库，任一步失败都把本次新写的文件删掉（AC-POOL-6：写库失败时磁盘不留孤儿文件）。
 *
 * 写盘中途失败与写库失败走同一条回滚路径，对外统一转成 500 —— 调用方拿到的永远是
 * 「库与磁盘都回到请求前的状态」，不需要区分是哪一步出的问题。
 */
async function commitAssets<T>(
  assets: readonly PreparedAsset[],
  persist: () => Promise<T>,
  failure: { message: string; log: string; details?: Record<string, unknown> },
): Promise<T> {
  const written: string[] = [];
  try {
    for (const asset of assets) {
      await writeAssetBytes(asset.storageKey, asset.bytes);
      written.push(asset.storageKey);
    }
    return await persist();
  } catch (error) {
    for (const storageKey of written) await removeAssetFile(storageKey);
    logger.error(failure.log, { ...failure.details, error });
    throw new AppError("INTERNAL", failure.message, { cause: error });
  }
}

/**
 * 创建（MUST 1、MUST 2、MUST 3）：图片可以为空，路径由服务端生成，类型与大小逐张校验。
 * 「至少要有一张原图」不在这里，也不在保存路径上：只在发起创作时校验（AC-01-8）。
 */
export async function createCollection(
  fields: CollectionFieldsInput,
  files: readonly IncomingFile[],
): Promise<CollectionDetailView> {
  const prepared = prepareAssets(prepareImages(files, getEnv().MAX_UPLOAD_BYTES));

  // 先定 id：storage_key 要用它做文件名（MUST 2），新建时还没有图片也不影响这一步。
  const collectionId = randomUUID();

  await commitAssets(
    prepared,
    () => repo.createCollection(collectionId, fields, prepared.map(toNewAsset)),
    {
      message: COLLECTION_ERROR_MESSAGES.saveFailed,
      log: "创建资源夹失败，已回滚本次新写的文件",
      details: { collectionId },
    },
  );

  return getCollection(collectionId);
}

/** 编辑只改来源信息，图片完全不动（AC-01-4）。 */
export async function updateCollectionFields(
  id: string,
  fields: CollectionFieldsInput,
): Promise<CollectionDetailView> {
  const updated = await repo.updateCollectionFields(id, fields);
  if (!updated) throw AppError.notFound("资源夹不存在");
  return getCollection(id);
}

/** 总资源库列表（AC-POOL-2）：每张照片带它被归到的资源夹。 */
export async function listPoolAssets(query: ListPoolAssetsQuery): Promise<PoolAssetList> {
  const { rows, total } = await repo.listPoolAssets(query.page, query.pageSize);
  return {
    items: rows.map(toPoolAssetView),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * 上传到总资源库（只入池，不建关联）。
 * 写库失败时删掉本次新写的文件，不留孤儿（AC-POOL-6 同口径）。
 */
export async function uploadPoolAssets(
  files: readonly IncomingFile[],
): Promise<PoolAssetView[]> {
  const prepared = prepareAssets(prepareImages(files, getEnv().MAX_UPLOAD_BYTES));

  const created = await commitAssets(
    prepared,
    () => repo.createPoolAssets(prepared.map(toNewAsset)),
    {
      message: COLLECTION_ERROR_MESSAGES.poolUploadFailed,
      log: "上传到总资源库失败，已回滚本次新写的文件",
    },
  );

  return created.map((asset) => toPoolAssetView({ ...asset, collections: [] }));
}

/**
 * 从总资源库删除照片（AC-POOL-7）：关联行随外键级联删除，磁盘文件一并删除。
 * 这是唯一会删原图文件的入口 —— 从夹里移除与删夹都不删文件。
 */
export async function deletePoolAsset(assetId: string): Promise<void> {
  const asset = await repo.findAsset(assetId);
  if (!asset) throw AppError.notFound("图片不存在");

  await repo.deletePoolAsset(assetId);
  await removeAssetFile(asset.storageKey);
}

/**
 * 从总资源库挑照片加入资源夹（AC-POOL-2、AC-POOL-5）。
 * 幂等：已经在夹里的照片跳过，第二次调用返回成功但关联行不增加。
 */
export async function addAssetsToCollection(
  id: string,
  assetIds: readonly string[],
): Promise<CollectionDetailView> {
  if (!(await repo.collectionExists(id))) throw AppError.notFound("资源夹不存在");
  assertCollectionMutable((await relatedCounts(id)).runningExtractions);

  const unique = [...new Set(assetIds)];
  const found = await repo.findAssetsByIds(unique);
  if (found.length !== unique.length) {
    throw AppError.validationFailed(COLLECTION_ERROR_MESSAGES.unknownPoolAsset);
  }

  await repo.addAssetsToCollection(id, unique);
  return getCollection(id);
}

/**
 * 夹内上传（AC-POOL-6）：入池 + 建关联，一次事务。
 * 写库失败时删掉本次新写的文件，库与磁盘都回到上传前的状态。
 */
export async function uploadCollectionAssets(
  id: string,
  files: readonly IncomingFile[],
): Promise<CollectionDetailView> {
  if (!(await repo.collectionExists(id))) throw AppError.notFound("资源夹不存在");
  assertCollectionMutable((await relatedCounts(id)).runningExtractions);

  const prepared = prepareAssets(prepareImages(files, getEnv().MAX_UPLOAD_BYTES));

  await commitAssets(prepared, () => repo.appendAssetsToCollection(id, prepared.map(toNewAsset)), {
    message: COLLECTION_ERROR_MESSAGES.saveFailed,
    log: "夹内上传失败，已回滚本次新写的文件",
    details: { collectionId: id },
  });

  return getCollection(id);
}

/**
 * 从夹里移除单张原图（AC-01-5、AC-POOL-3）：只删关联记录，照片与磁盘文件都保留（MUST 4）。
 * 允许移除到最后一张——资源夹允许没有图片，之后补图即可（AC-01-2）。
 */
export async function removeCollectionAsset(
  id: string,
  assetId: string,
): Promise<CollectionDetailView> {
  if (!(await repo.collectionExists(id))) throw AppError.notFound("资源夹不存在");
  assertCollectionMutable((await relatedCounts(id)).runningExtractions);

  if (!(await repo.removeAssetFromCollection(id, assetId))) {
    throw AppError.notFound("图片不存在");
  }
  return getCollection(id);
}

export interface CollectionEditPayload {
  /** 整体替换的来源信息。 */
  fields: CollectionFieldsInput;
  /** 有序图片清单：顺序即保存后的 `sort_order`。 */
  assets: readonly CollectionEditAssetInput[];
  /** `kind: "add"` 的文件，按 `tempKey` 取（multipart 的 `file:<tempKey>` part）。 */
  files: ReadonlyMap<string, IncomingFile>;
}

/**
 * 编辑保存的唯一入口：来源信息与图片变更一次提交，服务端一个事务。
 *
 * 执行顺序（MKACG-870 定稿方案，MKACG-914 去掉「至少 1 张」后的顺序）：
 * 1. 校验图片归属与是否给出处理方式；2. 有运行中任务时拒绝；
 * 3. 逐个校验上传文件；4. 全部通过后才写盘；
 * 5. 事务内改字段、删关联、插新增、更新保留项顺序；6. 成功后返回最终列表。
 * 保存后的图片张数不设下限：全部移除等于得到一个 0 张图的资源夹（AC-01-2）。
 * 任何一步失败都不动数据库；写盘之后失败会补偿删除本次新写的文件，返回 500。
 * 被移除的原图只解除关联，照片还留在总资源库（AC-POOL-3）。
 */
export async function saveCollectionEdit(
  id: string,
  payload: CollectionEditPayload,
): Promise<CollectionDetailView> {
  if (!(await repo.collectionExists(id))) throw AppError.notFound("资源夹不存在");

  const existingIds = new Set((await repo.listAssetsByCollection(id)).map((asset) => asset.id));
  const keep: Array<{ assetId: string; sortOrder: number }> = [];
  const remove: string[] = [];
  const adds: Array<{ tempKey: string; sortOrder: number }> = [];
  const handled = new Set<string>();

  payload.assets.forEach((item, index) => {
    if (item.kind === "add") {
      adds.push({ tempKey: item.tempKey, sortOrder: index });
      return;
    }

    if (!existingIds.has(item.assetId)) {
      throw AppError.validationFailed(COLLECTION_ERROR_MESSAGES.foreignAsset);
    }
    if (handled.has(item.assetId)) {
      throw AppError.validationFailed(COLLECTION_ERROR_MESSAGES.duplicateAsset);
    }
    handled.add(item.assetId);

    if (item.kind === "keep") keep.push({ assetId: item.assetId, sortOrder: index });
    else remove.push(item.assetId);
  });

  // 清单就是保存后的完整列表：每张现有图片都必须出现一次，否则顺序无从确定。
  if (handled.size !== existingIds.size) {
    throw AppError.validationFailed(COLLECTION_ERROR_MESSAGES.unhandledAsset);
  }

  assertCollectionMutable((await relatedCounts(id)).runningExtractions);

  // 新增项按清单顺序取文件：缺一个就整体拒绝，避免只存一部分。
  const incoming = adds.map((add) => {
    const file = payload.files.get(add.tempKey);
    if (!file) throw AppError.validationFailed(COLLECTION_ERROR_MESSAGES.missingUpload);
    return file;
  });
  const preparedAdds = prepareAssets(prepareImages(incoming, getEnv().MAX_UPLOAD_BYTES)).map(
    (asset, index) => ({ ...asset, sortOrder: adds[index].sortOrder }),
  );

  await commitAssets(
    preparedAdds,
    () =>
      repo.saveCollectionEdit(id, payload.fields, {
        keep,
        remove,
        adds: preparedAdds.map((asset) => ({ ...toNewAsset(asset), sortOrder: asset.sortOrder })),
      }),
    {
      message: COLLECTION_ERROR_MESSAGES.saveFailed,
      log: "资源夹整组保存失败，已回滚本次新写的文件",
      details: { collectionId: id },
    },
  );

  return getCollection(id);
}

/**
 * 删除资源夹（AC-POOL-4）：只删资源夹行，关联行随外键级联删除；
 * **照片行与磁盘文件都保留** —— 它们属于总资源库，别的夹可能也在用（ADR 0012 第 1 条）。
 */
export async function deleteCollection(id: string): Promise<void> {
  if (!(await repo.collectionExists(id))) throw AppError.notFound("资源夹不存在");
  assertCollectionMutable((await relatedCounts(id)).runningExtractions);

  await repo.deleteCollection(id);
}

/** 资源夹总数：工作台统计与侧栏计数（docs/prd/09 MUST 1、MUST 2），一次聚合查询。 */
export async function countCollections(): Promise<number> {
  return repo.countCollections();
}

/**
 * 「待处理」：还没有任何素材的资源夹数（docs/prd/09 MUST 1；ADR 0010 后口径改为「还没有素材」）。
 * 判定由提取模块给出，本模块不读它的表。
 */
export { countDraftCollections };

/** 工作台「最近的媒体资源夹」：最多 `limit` 条，字段与列表页一致（含封面与派生状态）。 */
export async function listRecentCollections(limit: number): Promise<CollectionSummaryView[]> {
  const rows = await repo.listRecentCollections(limit);
  const decorated = await Promise.all(
    rows.map(async (row) => ({ row, counts: await relatedCounts(row.id) })),
  );
  return decorated.map(({ row, counts }) => toSummary(row, counts));
}

/** 鉴权读取原图字节（AC-01-7）；`width` 有值时当场缩放成缩略图。 */
export async function getAssetImage(assetId: string, width?: number): Promise<AssetBytes> {
  const asset = await repo.findAsset(assetId);
  if (!asset) throw AppError.notFound("图片不存在");

  const original = await readAssetFile(asset.storageKey);
  const bytes = width ? await scaleImage(original, width) : original;
  return { bytes, mimeType: asset.mimeType, fileName: asset.fileName };
}
