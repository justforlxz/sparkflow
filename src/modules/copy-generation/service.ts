/**
 * 文案版本的业务层：生成入口、版本列表、原地编辑（docs/prd/12「接口」表后四项）。
 *
 * 边界：
 * 1. 生成文案只依赖文案 Agent：图片 Agent 没配置好不该挡住文案（MUST 1：两个动作互不依赖）；
 * 2. 生成不触发提取、也不读提取的队列，只读素材库里选中的那几张（MUST NOT）；
 * 3. 每次生成都新建一条版本，`version_no` 在资源夹内递增（MUST 5）；编辑只是原地改当前版本。
 */
import { AppError } from "@/lib/errors";
import { requireAgentSnapshotOf } from "@/modules/agent-config/service";
import { allocateCopyVersionNumber, getCollection } from "@/modules/media-collection/service";
import { getLibraryAssets } from "@/modules/extraction/service";
import type { LibraryAssetRecord } from "@/modules/extraction/types";
import * as repo from "./repo";
import type { CreateCopyVersionInput, UpdateCopyVersionInput } from "./schema";
import { findCopyStyle } from "./styles";
import { toCopyVersionView, type CopyVersionView } from "./view";
import { listGatewayViews } from "@/modules/gateway/service";

/** 选中素材的去重与归属校验：素材必须属于这个资源夹，且不能是已删除的。 */
async function resolveSelectedAssets(
  collectionId: string,
  input: readonly string[],
): Promise<{ assetIds: string[]; assets: LibraryAssetRecord[] }> {
  const assetIds = [...new Set(input.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (assetIds.length === 0) throw AppError.validationFailed("至少选择一张素材");

  const assets = await getLibraryAssets(assetIds);
  if (assets.length !== assetIds.length) {
    throw AppError.validationFailed("所选素材里有已被删除的，请重新选择");
  }
  for (const asset of assets) {
    if (asset.collectionId !== collectionId) {
      throw AppError.validationFailed("所选素材里有一张不属于这个资源夹，请刷新页面后重试");
    }
  }
  return { assetIds, assets };
}

function assertValidCopyStyle(value: string): void {
  if (!findCopyStyle(value)) {
    throw AppError.validationFailed("文案风格无效，请重新选择");
  }
}

/**
 * 生成文案（`POST /api/collections/[id]/copy-versions`）：只写库并立即返回，执行交给 worker。
 * 文案 Agent 未就绪时抛 `CONFLICT` + `AGENT_NOT_READY`，且不产生版本记录。
 */
export async function createCopyVersion(
  collectionId: string,
  input: CreateCopyVersionInput,
): Promise<CopyVersionView> {
  // 资源夹不存在时 404，避免把「查不到」写成一条孤立版本。
  await getCollection(collectionId);

  const { assetIds, assets } = await resolveSelectedAssets(collectionId, input.selectedAssetIds);
  assertValidCopyStyle(input.copyStyle);

  // 只校验文案 Agent：图片 Agent 没配好不该挡住文案（MUST 1）。
  const agent = await requireAgentSnapshotOf(await listGatewayViews(), "copy");

  // 版本号在资源夹上分配：只增不减，删掉某一版之后也不会重发（MUST 5、AC-LIB-7）。
  const versionNo = await allocateCopyVersionNumber(collectionId);
  const version = await repo.createVersion({
    collectionId,
    versionNo,
    copyStyle: input.copyStyle,
    agentSnapshot: agent,
    selectedAssetIds: assetIds,
    extraPrompt: input.extraPrompt ?? null,
  });

  return toCopyVersionView(version, assets);
}

/** 版本列表：最新在前（`GET /api/collections/[id]/copy-versions`）。 */
export async function listCopyVersions(collectionId: string): Promise<CopyVersionView[]> {
  const versions = await repo.listVersionsByCollection(collectionId);
  if (versions.length === 0) return [];

  const assets = await getLibraryAssets(versions.flatMap((version) => version.selectedAssetIds));
  return versions.map((version) => toCopyVersionView(version, assets));
}

/** 单个版本（发布模块用）：发布记录要读它的标题快照与素材快照。 */
export async function getCopyVersion(versionId: string): Promise<CopyVersionView> {
  const version = await repo.findVersion(versionId);
  if (!version) throw AppError.notFound("文案版本不存在");
  const assets = await getLibraryAssets(version.selectedAssetIds);
  return toCopyVersionView(version, assets);
}

/**
 * 编辑当前版本（`PATCH /api/copy-versions/[id]`）：原地改，不产生新版本（MUST NOT）。
 * 只有生成成功的版本才可编辑：生成中改会被执行覆盖，失败版本没有内容可改。
 */
export async function updateCopyVersion(
  versionId: string,
  input: UpdateCopyVersionInput,
): Promise<CopyVersionView> {
  const version = await repo.findVersion(versionId);
  if (!version) throw AppError.notFound("文案版本不存在");
  if (version.status !== "succeeded") {
    throw new AppError("CONFLICT", "只有生成完成的文案版本才能编辑", {
      details: { code: "COPY_VERSION_NOT_EDITABLE", status: version.status },
    });
  }

  await repo.updateVersionFields(versionId, {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
  });

  return getCopyVersion(versionId);
}

/* ---------- 供资源夹与工作台使用的计数（不读本模块的表） ---------- */

/** 资源夹里的文案版本数（资源夹列表的派生状态用）。 */
export async function countCollectionVersions(collectionId: string): Promise<number> {
  return repo.countCollectionVersions(collectionId);
}

/** 工作台「待发布」：还没有发布记录的版本数（docs/prd/09 MUST 1）。 */
export async function countUnpublishedVersions(): Promise<number> {
  return repo.countUnpublishedVersions();
}

/** 批量取版本号（发布记录展示用）：只给 id 与版本号，不读整行。 */
export async function getCopyVersionSummaries(
  versionIds: readonly string[],
): Promise<Record<string, number>> {
  const rows = await repo.findVersionSummaries(versionIds);
  return Object.fromEntries(rows.map((row) => [row.id, row.versionNo]));
}
