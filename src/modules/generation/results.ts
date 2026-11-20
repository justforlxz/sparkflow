/**
 * 结果页签的业务层（docs/prd/07-results.md「结果页签」）：列表、编辑、删除、鉴权读取生成图片。
 *
 * 边界：
 * 1. 编辑只改结果自身的四个字段，任务快照与原始素材不动（MUST NOT）。
 * 2. 删除只删这一组结果，同资源夹的其它结果与原始素材不受影响（AC-07-7）。
 * 3. 生成图片经鉴权路由读取，`?w=` 当场缩放成缩略图，不预生成文件。
 */
import { AppError } from "@/lib/errors";
import { collectionExists } from "@/modules/media-collection/service";
import { scaleImage } from "@/modules/media-collection/thumbnails";
// 只依赖发布模块的同步函数（不经过它的 service），避免创作结果与发布两个模块互相 import。
import { syncPublishedTitle } from "@/modules/publish/sync";
import * as repo from "./repo";
import type { UpdateResultInput } from "./schema";
import { readGeneratedFile, removeResultFiles } from "./storage";
import { toResultView, type ResultView } from "./view";

export interface ResultBytes {
  bytes: Buffer;
  mimeType: string;
}

/** 该资源夹的全部结果，按创建时间倒序；不跨资源夹串数据（MUST 6）。 */
export async function listCollectionResults(collectionId: string): Promise<ResultView[]> {
  // 资源夹不存在时给 404，避免把「查不到」和「没有结果」混成同一个空列表。
  // 只查存在性，不重复取图片与计数：页面已经取过一次资源夹详情。
  if (!(await collectionExists(collectionId))) throw AppError.notFound("资源夹不存在");

  const rows = await repo.listResultsByCollection(collectionId);
  return rows.map(({ result, stages, extractTarget }) =>
    toResultView(result, stages, extractTarget),
  );
}

/**
 * 单个结果的视图（发布模块用）：发布准备要读当前标题 / 正文 / 标签与图片清单，
 * 发布记录要带所属资源夹；这些字段只通过这里给出，不读本模块的表。
 */
export async function getResult(resultId: string): Promise<ResultView> {
  const record = await repo.findResultWithStages(resultId);
  if (!record) throw AppError.notFound("创作结果不存在");
  return toResultView(record.result, record.stages, record.extractTarget);
}

/** 只把请求里真正给出的字段交给下游：`undefined` 表示「这一项不改」。 */
function toPatch(input: UpdateResultInput): Partial<repo.ResultFieldsPatch> {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.visualStyle === undefined ? {} : { visualStyle: input.visualStyle }),
  };
}

/**
 * 编辑结果（MUST 3）：原地更新，不改动任务快照与原始素材。
 *
 * docs/prd/07 MUST 5 还要求「已有发布记录时同步更新发布记录的标题快照」：改标题后调用发布模块的
 * 同步函数，没有记录时它什么都不写（见 `publish/sync.ts`）。
 */
export async function updateResult(
  resultId: string,
  input: UpdateResultInput,
): Promise<ResultView> {
  const patch = toPatch(input);
  const updated = await repo.updateResultFields(resultId, patch);
  if (!updated) throw AppError.notFound("创作结果不存在");

  // 标题改了要同步发布记录的标题快照；没有记录时同步函数不写任何东西。
  if (patch.title !== undefined) await syncPublishedTitle(resultId, patch.title);

  const record = await repo.findResultWithStages(resultId);
  if (!record) throw AppError.notFound("创作结果不存在");
  return toResultView(record.result, record.stages, record.extractTarget);
}

/**
 * 删除整组结果（MUST 4）：记录随外键级联删掉生成图片行与发布记录，磁盘目录尽力清理。
 */
export async function deleteResult(resultId: string): Promise<void> {
  if (!(await repo.deleteResult(resultId))) throw AppError.notFound("创作结果不存在");
  await removeResultFiles(resultId);
}

/** 鉴权读取生成图片；`width` 有值时当场缩放成缩略图（网格统一 `?w=400`）。 */
export async function getResultImage(
  resultId: string,
  assetId: string,
  width?: number,
): Promise<ResultBytes> {
  const asset = await repo.findResultAsset(resultId, assetId);
  if (!asset) throw AppError.notFound("图片不存在");

  const original = await readGeneratedFile(asset.storageKey);
  const bytes = width ? await scaleImage(original, width) : original;
  return { bytes, mimeType: asset.mimeType };
}
