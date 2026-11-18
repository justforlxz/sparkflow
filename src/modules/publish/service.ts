/**
 * 发布记录业务层（docs/prd/08-publish.md）：标记已发布、撤销、列表与打包下载。
 *
 * 边界：
 * 1. 记录只由用户手动标记产生，系统不推断发布成功（MUST NOT）。
 * 2. 发布准备弹窗里的文案编辑写回创作结果（调用创作结果模块的 service），标题同时存进快照。
 * 3. 文案拼格式与 ZIP 打包是纯函数（`text.ts`、`zip.ts`），这里只负责取数据与校验。
 */
import { AppError } from "@/lib/errors";
import { getResult, getResultImage, updateResult } from "@/modules/generation/results";
import type { ResultView } from "@/modules/generation/view";
import { collectionExists, getCollectionNames } from "@/modules/media-collection/service";
import { PUBLISH_COPY, ZIP_FALLBACK_NAME, ZIP_MIME_TYPE } from "./constants";
import * as repo from "./repo";
import type { ListPublishRecordsQuery, MarkPublishedInput } from "./schema";
import { toPublishRecordView, type PublishRecordView } from "./view";
import { createZip, numberedZipName } from "./zip";

export interface PublishRecordList {
  items: PublishRecordView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublishDownload {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
}

/**
 * 选中的图片必须都属于这个结果，并按用户勾选的顺序保留（ZIP 序号用它，AC-09-10）。
 * 重复的 id 只算一次：同一张图在压缩包里只能有一个文件。
 */
function assertSelection(result: ResultView, assetIds: readonly string[]): string[] {
  const owned = new Set(result.assets.map((asset) => asset.id));
  const ordered = [...new Set(assetIds)];
  if (ordered.length === 0) throw AppError.validationFailed(PUBLISH_COPY.selectAtLeastOne);
  for (const assetId of ordered) {
    if (!owned.has(assetId)) {
      throw AppError.validationFailed("所选图片不属于这个结果");
    }
  }
  return ordered;
}

async function collectionNameOf(collectionId: string): Promise<string> {
  const names = await getCollectionNames([collectionId]);
  // 删除资源夹时记录随外键级联删除，取不到名称说明数据已损坏，不编造占位文案。
  const name = names[collectionId];
  if (!name) {
    throw new AppError("INTERNAL", "发布记录所属的资源夹不存在，请检查数据写入路径");
  }
  return name;
}

/**
 * 标记为已发布（AC-08-4 ~ AC-08-6）：
 * 1. 把弹窗里的标题 / 正文 / 标签写回结果 —— 已经有内容的字段不重复写；
 * 2. upsert 记录（`result_id` 唯一，重复标记不产生第二条）；
 * 3. 返回记录视图，界面据此刷新发布状态与记录列表。
 */
export async function markPublished(
  resultId: string,
  input: MarkPublishedInput,
): Promise<PublishRecordView> {
  const result = await getResult(resultId);
  const selectedAssetIds = assertSelection(result, input.selectedAssetIds);

  const title = input.title.trim();
  const body = input.body.trim();
  const patch: { title?: string; body?: string; tags?: string[] } = {};
  if (title.length > 0 && title !== result.title) patch.title = title;
  if (body.length > 0 && body !== result.body) patch.body = body;
  // 标签允许被清空：用户在弹窗里删掉全部标签就是「这次不带话题」。
  patch.tags = input.tags;
  await updateResult(resultId, patch);

  const row = await repo.upsertRecord({
    resultId,
    collectionId: result.collectionId,
    platform: input.platform,
    publishedAt: new Date(),
    titleSnapshot: title,
    selectedAssetIds,
  });
  return toPublishRecordView(row, await collectionNameOf(row.collectionId));
}

/** 撤销发布记录（docs/prd/08 接口表）：只是删掉这一行，结果与图片不动。 */
export async function revokePublished(resultId: string): Promise<void> {
  if (!(await repo.deleteRecordByResultId(resultId))) {
    throw AppError.notFound("发布记录不存在");
  }
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

  const names = await getCollectionNames(rows.map((row) => row.collectionId));
  return {
    items: rows.map((row) => toPublishRecordView(row, names[row.collectionId] ?? "")),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** 单个结果的发布记录；结果页签用它决定展示「已发布」还是「未发布」（AC-08-3）。 */
export async function getPublishRecord(resultId: string): Promise<PublishRecordView | null> {
  const row = await repo.findRecordByResultId(resultId);
  if (!row) return null;
  return toPublishRecordView(row, await collectionNameOf(row.collectionId));
}

/** 结果页签批量判断发布状态：只查 id，不给每个结果再查一次记录。 */
export async function getPublishedResultIds(resultIds: readonly string[]): Promise<string[]> {
  return repo.findPublishedResultIds(resultIds);
}

function zipFileName(title: string | null): string {
  const base =
    (title ?? "").trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || ZIP_FALLBACK_NAME;
  return `${base}.zip`;
}

/**
 * 下载所选图片（docs/prd/08 MUST 3、AC-08-1、AC-09-10）：
 * 选 1 张直接回该文件；选多张打包 ZIP，文件名按勾选顺序编号。
 * 没有给 `assets` 时按「全部图片」处理，下载入口不需要先选一次。
 */
export async function downloadResultAssets(
  resultId: string,
  assetIds: readonly string[],
): Promise<PublishDownload> {
  const result = await getResult(resultId);
  if (result.assets.length === 0) throw AppError.notFound("这个结果还没有生成图片");

  const selected =
    assetIds.length > 0 ? assertSelection(result, assetIds) : result.assets.map((asset) => asset.id);
  const assetOf = (assetId: string): ResultView["assets"][number] => {
    const asset = result.assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw AppError.notFound("图片不存在");
    return asset;
  };

  if (selected.length === 1) {
    const assetId = selected[0] as string;
    const image = await getResultImage(resultId, assetId);
    return { bytes: image.bytes, fileName: assetOf(assetId).fileName, mimeType: image.mimeType };
  }

  const entries: { name: string; bytes: Buffer }[] = [];
  for (const [index, assetId] of selected.entries()) {
    const image = await getResultImage(resultId, assetId);
    entries.push({
      name: numberedZipName(index, selected.length, assetOf(assetId).fileName),
      bytes: image.bytes,
    });
  }

  return {
    bytes: createZip(entries, new Date()),
    fileName: zipFileName(result.title),
    mimeType: ZIP_MIME_TYPE,
  };
}
