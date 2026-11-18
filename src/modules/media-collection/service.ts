/**
 * 媒体资源夹服务（docs/prd/01-media-collection.md）。页面与接口只调用这里的函数。
 *
 * 落盘与写库的顺序：先写文件再写记录。写库失败会留下没人引用的文件，
 * 但这是 ADR 明确接受的方向 —— 不引入引用计数或垃圾回收（MUST NOT）。
 */
import { randomUUID } from "node:crypto";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { countCollectionUsage } from "@/modules/generation/counts";
import { countCollectionPublishRecords } from "@/modules/publish/counts";
import { DEFAULT_THUMBNAIL_WIDTH, type CollectionStatus } from "./constants";
import { readAssetFile, removeCollectionFiles, writeAssetBytes } from "./files";
import * as repo from "./repo";
import { assertCanRemoveImage, assertCollectionMutable, assertHasImage } from "./rules";
import type { CollectionFieldsInput, ListCollectionsQuery } from "./schema";
import { buildAssetStorageKey } from "./storage-key";
import { deriveCollectionStatus, type CollectionCounts } from "./status";
import { scaleImage } from "./thumbnails";
import { prepareImages, type IncomingFile } from "./uploads";

export interface CollectionAssetView {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sortOrder: number;
  /** 可直接渲染的鉴权 URL（SHOULD：上传后不必二次查询）。 */
  url: string;
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
  taskCount: number;
  resultCount: number;
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
 * 任务与结果的数量来自创作任务模块的 service，不直接查它的表（AGENTS.md 硬性规则 2）。
 * 「运行中任务」指派生状态为 running 的任务：有阶段排队或执行中都算，因为此时改图或删夹会
 * 影响正在进行的任务。
 * 发布记录数量来自发布模块的计数函数（同样不直接查它的表）：有记录即派生为 `published`。
 */
async function relatedCounts(collectionId: string): Promise<CollectionCounts> {
  const [usage, published] = await Promise.all([
    countCollectionUsage(collectionId),
    countCollectionPublishRecords(collectionId),
  ]);
  return {
    runningTasks: usage.activeTasks,
    tasks: usage.tasks,
    results: usage.results,
    published,
  };
}

export function assetFileUrl(collectionId: string, assetId: string, width?: number): string {
  const base = `/api/files/${collectionId}/${assetId}`;
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
    taskCount: counts.tasks,
    resultCount: counts.results,
    coverUrl: row.coverAssetId ? assetFileUrl(row.id, row.coverAssetId, DEFAULT_THUMBNAIL_WIDTH) : null,
  };
}

function toAssetView(collectionId: string, asset: repo.AssetRow): CollectionAssetView {
  return {
    id: asset.id,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
    sortOrder: asset.sortOrder,
    url: assetFileUrl(collectionId, asset.id),
  };
}

/**
 * 列表：先按关键词查，再按派生状态筛选与分页。
 * 状态依赖任务/结果/发布记录计数，暂时无法下推到 SQL；等那些表落地后可以改成一次聚合查询。
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

/**
 * 批量取资源夹名称（创作任务列表用）。查不到的 id 不出现在结果里：
 * 资源夹被删时任务随外键级联删除，正常不会出现「任务在、资源夹没了」。
 */
export async function getCollectionNames(
  ids: readonly string[],
): Promise<Record<string, string>> {
  return repo.findCollectionNames([...new Set(ids)]);
}

/** 只查存在性：创作任务与结果需要判断资源夹是否还在，但不需要它的图片与计数。 */
export async function collectionExists(id: string): Promise<boolean> {
  return repo.collectionExists(id);
}

export async function getCollection(id: string): Promise<CollectionDetailView> {
  const row = await repo.findCollection(id);
  if (!row) throw AppError.notFound("资源夹不存在");

  const [assets, counts] = await Promise.all([repo.listAssets(id), relatedCounts(id)]);
  return { ...toSummary(row, counts), assets: assets.map((asset) => toAssetView(id, asset)) };
}

/** 创建（MUST 1、MUST 2、MUST 3）：至少一张图片，路径由服务端生成，类型与大小逐张校验。 */
export async function createCollection(
  fields: CollectionFieldsInput,
  files: readonly IncomingFile[],
): Promise<CollectionDetailView> {
  const images = prepareImages(files, getEnv().MAX_UPLOAD_BYTES);
  assertHasImage(images.length);

  // 先定 id：storage_key 要用它做目录名（MUST 2），也避免「先建空资源夹再补图片」的中间状态。
  const collectionId = randomUUID();
  const prepared = images.map((image) => ({
    ...image,
    storageKey: buildAssetStorageKey(collectionId, image.mimeType),
  }));

  for (const asset of prepared) {
    await writeAssetBytes(asset.storageKey, asset.bytes);
  }

  await repo.createCollection(
    collectionId,
    fields,
    prepared.map((asset) => ({
      storageKey: asset.storageKey,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      size: asset.bytes.length,
    })),
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

export async function addCollectionAssets(
  id: string,
  files: readonly IncomingFile[],
): Promise<CollectionDetailView> {
  if (!(await repo.collectionExists(id))) throw AppError.notFound("资源夹不存在");
  assertCollectionMutable((await relatedCounts(id)).runningTasks);

  const images = prepareImages(files, getEnv().MAX_UPLOAD_BYTES);
  assertHasImage(images.length);

  const prepared = images.map((image) => ({
    ...image,
    storageKey: buildAssetStorageKey(id, image.mimeType),
  }));

  for (const asset of prepared) {
    await writeAssetBytes(asset.storageKey, asset.bytes);
  }

  await repo.appendAssets(
    id,
    prepared.map((asset) => ({
      storageKey: asset.storageKey,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      size: asset.bytes.length,
    })),
  );

  return getCollection(id);
}

/** 解除单张原图（AC-01-5）：只删关联记录，磁盘文件保留（MUST 4），且不允许删到 0 张。 */
export async function removeCollectionAsset(
  id: string,
  assetId: string,
): Promise<CollectionDetailView> {
  if (!(await repo.collectionExists(id))) throw AppError.notFound("资源夹不存在");
  assertCollectionMutable((await relatedCounts(id)).runningTasks);

  assertCanRemoveImage((await repo.countAssets(id)) - 1);

  if (!(await repo.deleteAsset(id, assetId))) throw AppError.notFound("图片不存在");
  return getCollection(id);
}

/** 删除资源夹（MUST 5）：先删记录（外键级联到任务/结果/发布记录），再尽力清理磁盘；清理失败只记日志。 */
export async function deleteCollection(id: string): Promise<void> {
  if (!(await repo.collectionExists(id))) throw AppError.notFound("资源夹不存在");
  assertCollectionMutable((await relatedCounts(id)).runningTasks);

  await repo.deleteCollection(id);
  await removeCollectionFiles(id);
}

/** 资源夹总数：工作台统计与侧栏计数（docs/prd/09 MUST 1、MUST 2），一次聚合查询。 */
export async function countCollections(): Promise<number> {
  return repo.countCollections();
}

/**
 * 「待创作」：还没有任何生成结果的资源夹数（docs/prd/09 MUST 1）。
 * 判定落在本模块自己表的 `results` 反向关系上，不读生成结果表的内容。
 */
export async function countDraftCollections(): Promise<number> {
  return repo.countCollectionsWithoutResults();
}

/** 工作台「最近的媒体资源夹」：最多 `limit` 条，字段与列表页一致（含封面与派生状态）。 */
export async function listRecentCollections(limit: number): Promise<CollectionSummaryView[]> {
  const rows = await repo.listRecentCollections(limit);
  const decorated = await Promise.all(
    rows.map(async (row) => ({ row, counts: await relatedCounts(row.id) })),
  );
  return decorated.map(({ row, counts }) => toSummary(row, counts));
}

/** 鉴权读取原图字节（AC-01-7）；`width` 有值时当场缩放成缩略图。 */
export async function getAssetImage(
  collectionId: string,
  assetId: string,
  width?: number,
): Promise<AssetBytes> {
  const asset = await repo.findAsset(collectionId, assetId);
  if (!asset) throw AppError.notFound("图片不存在");

  const original = await readAssetFile(asset.storageKey);
  const bytes = width ? await scaleImage(original, width) : original;
  return { bytes, mimeType: asset.mimeType, fileName: asset.fileName };
}
