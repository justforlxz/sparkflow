/**
 * 提取运行与素材库的业务层：8 个端点里与「AI 处理 / 素材库」相关的部分都调用这里
 * （docs/prd/12-asset-library.md、ADR 0010）。
 *
 * 边界：
 * 1. 发起提取前依次校验「资源夹存在、有原图、勾选的原图属于它」「类别可选」「提取要求合法」
 *    与「图片 Agent 就绪」；任一不满足都不写运行记录。
 * 2. 提取只依赖图片 Agent：文案 Agent 没配置好不该挡住「AI 处理」（MUST 1：两个动作互不依赖）。
 * 3. `progress.total` 在创建时就算成「勾选原图数 × 类别数」，接口立即给得出这个数（AC-LIB-1）。
 */
import { AppError } from "@/lib/errors";
import { requireAgentSnapshotOf } from "@/modules/agent-config/service";
import { requireEnabled } from "@/modules/feature-flags/service";
import { listGatewayViews } from "@/modules/gateway/service";
import { EXTRACT_REQUIREMENTS, findExtractRequirement } from "@/modules/image-generation/styles";
import { getCollection, collectionExists } from "@/modules/media-collection/service";
import { scaleImage } from "@/modules/media-collection/thumbnails";
import { isSelectableCategory, SELECTABLE_CATEGORIES } from "./categories";
import * as repo from "./repo";
import type { CreateExtractionInput } from "./schema";
import { readLibraryFile, removeLibraryFile } from "./storage";
import type { ExtractionProgress, LibraryAssetRecord } from "./types";
import { toExtractionRunView, toLibraryView, type ExtractionRunView, type LibraryView } from "./view";

export interface LibraryBytes {
  bytes: Buffer;
  mimeType: string;
}

/** 勾选的原图必须都属于这个资源夹：去重后原样保留用户勾选顺序。 */
function normalizeSourceAssetIds(
  input: readonly string[],
  collectionAssetIds: readonly string[],
): string[] {
  const owned = new Set(collectionAssetIds);
  const unique = [...new Set(input.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (unique.length === 0) {
    throw AppError.validationFailed("至少勾选一张原图");
  }
  for (const assetId of unique) {
    if (!owned.has(assetId)) {
      throw AppError.validationFailed("勾选的原图里有一张不属于这个资源夹，请刷新页面后重试");
    }
  }
  return unique;
}

/** 类别必须来自可选登记表：`other` 只用于历史数据，新提取不接受。 */
function normalizeCategories(input: readonly string[]): string[] {
  const unique = [...new Set(input.map((value) => value.trim()).filter((value) => value.length > 0))];
  if (unique.length === 0) {
    throw AppError.validationFailed("至少选择一个类别");
  }
  for (const value of unique) {
    if (!isSelectableCategory(value)) {
      const allowed = SELECTABLE_CATEGORIES.map((category) => category.label).join(" / ");
      throw AppError.validationFailed(`类别无效，请选择：${allowed}`);
    }
  }
  return unique;
}

/** 提取要求的取值必须来自登记表。 */
function assertValidRequirement(value: string): void {
  if (!findExtractRequirement(value)) {
    const allowed = EXTRACT_REQUIREMENTS.map((entry) => entry.label).join(" / ");
    throw AppError.validationFailed(`提取要求无效，请选择：${allowed}`);
  }
}

/**
 * 发起提取（`POST /api/collections/[id]/extractions`）：只写库并立即返回，执行交给 worker。
 * 图片 Agent 未就绪时抛 `CONFLICT` + `AGENT_NOT_READY`，且不产生运行记录。
 */
export async function createExtraction(
  collectionId: string,
  input: CreateExtractionInput,
): Promise<ExtractionRunView> {
  // 功能关闭时必须在入口拦下，不产生任何运行记录（docs/prd/10 MUST 2、AC-10-4）。
  await requireEnabled("image-to-image");

  const collection = await getCollection(collectionId);
  if (collection.assetCount < 1) {
    throw AppError.validationFailed("资源夹没有原始图片，不能发起 AI 处理");
  }

  const sourceAssetIds = normalizeSourceAssetIds(
    input.sourceAssetIds,
    collection.assets.map((asset) => asset.id),
  );
  const categories = normalizeCategories(input.categories);
  assertValidRequirement(input.requirement);

  // 只校验图片 Agent：文案 Agent 没配好不该挡住「AI 处理」（MUST 1：两个动作互不依赖）。
  await requireAgentSnapshotOf(await listGatewayViews(), "image");

  const progress: ExtractionProgress = {
    done: 0,
    total: sourceAssetIds.length * categories.length,
  };

  const run = await repo.createRun({
    collectionId,
    requirement: input.requirement,
    categories,
    sourceAssetIds,
    extraPrompt: input.extraPrompt ?? null,
    progress,
  });

  // 创建接口的响应一定是「刚排队」的初始状态，不会因为 worker 抢跑而变成 running。
  return toExtractionRunView(run);
}

/** 提取运行列表：按创建时间倒序，含进度与失败原因（`GET .../extractions`）。 */
export async function listExtractionRuns(collectionId: string): Promise<ExtractionRunView[]> {
  if (!(await collectionExists(collectionId))) throw AppError.notFound("资源夹不存在");
  const runs = await repo.listRunsByCollection(collectionId);
  return runs.map(toExtractionRunView);
}

/** 素材库：按类别分组（`GET .../library`）。来源原图序号取自资源夹当前的原图顺序。 */
export async function listLibrary(collectionId: string): Promise<LibraryView> {
  const collection = await getCollection(collectionId);
  const assets = await repo.listLibraryByCollection(collectionId);
  return toLibraryView(
    assets,
    collection.assets.map((asset) => asset.id),
  );
}

/** 批量取素材记录：文案版本要把 `selected_asset_ids` 还原成可用图片（AC-LIB-5）。 */
export async function getLibraryAssets(assetIds: readonly string[]): Promise<LibraryAssetRecord[]> {
  return repo.findLibraryAssetsByIds(assetIds);
}

/**
 * 删除一张素材（`DELETE /api/library/[assetId]`，PRD 12 MAY）：
 * 只删素材与磁盘文件；引用它的文案版本保留 id，界面显示「已删除素材」（MUST 4）。
 */
export async function deleteLibraryAsset(assetId: string): Promise<void> {
  const deleted = await repo.deleteLibraryAsset(assetId);
  if (!deleted) throw AppError.notFound("素材不存在");
  // 只删这一张的文件：同一次运行里的其它素材不受影响。磁盘清理尽力而为，文件不在了也算成功。
  await removeLibraryFile(deleted.storageKey);
}

/** 鉴权读取素材图片；`width` 有值时当场缩放成缩略图。 */
export async function getLibraryImage(assetId: string, width?: number): Promise<LibraryBytes> {
  const asset = await repo.findLibraryAsset(assetId);
  if (!asset) throw AppError.notFound("图片不存在");

  const original = await readLibraryFile(asset.storageKey);
  const bytes = width ? await scaleImage(original, width) : original;
  return { bytes, mimeType: asset.mimeType };
}

/* ---------- 供资源夹与工作台使用的计数（不读本模块的表） ---------- */

export async function countCollectionUsage(collectionId: string): Promise<repo.ExtractionUsage> {
  return repo.countCollectionUsage(collectionId);
}

/** 工作台「待创作」：还没有任何素材的资源夹数（docs/prd/09 MUST 1）。 */
export async function countDraftCollections(): Promise<number> {
  return repo.countCollectionsWithoutLibrary();
}
