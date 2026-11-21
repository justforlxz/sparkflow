/**
 * 素材图片的落盘与读取（docs/prd/12-asset-library.md、docs/architecture.md「文件」）：
 * `<UPLOAD_DIR>/library-assets/<runId>/<uuid>.<ext>`，数据库只存 storage_key。
 * 上游给的是临时地址，必须在拿到图片时立刻下载落盘，不能只保存 URL。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { assertStorageSegment, resolveStoragePath } from "@/lib/storage";
import { LIBRARY_STORAGE_PREFIX } from "./constants";
import type { LibraryWriter } from "./store";
import type { ExtractedImage, LibraryAssetInput } from "./types";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** 上游返回的类型不在表里时按子类型取扩展名；取不到才退回通用后缀。 */
function extensionFor(mimeType: string): string {
  const known = EXTENSIONS[mimeType];
  if (known) return known;
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
  return /^[a-z0-9]+$/.test(subtype) ? subtype : "bin";
}

export function buildLibraryStorageKey(
  runId: string,
  mimeType: string,
  fileId: string = randomUUID(),
): string {
  assertStorageSegment(runId, "提取运行标识不合法");
  assertStorageSegment(fileId, "素材标识不合法");
  return `${LIBRARY_STORAGE_PREFIX}/${runId}/${fileId}.${extensionFor(mimeType)}`;
}

/** 逐张写盘；写盘失败直接抛出，由 runner 把运行记为失败。 */
export async function writeLibraryImages(
  runId: string,
  images: readonly ExtractedImage[],
): Promise<LibraryAssetInput[]> {
  const stored: LibraryAssetInput[] = [];

  for (const [index, image] of images.entries()) {
    const storageKey = buildLibraryStorageKey(runId, image.mimeType);
    const target = resolveStoragePath(storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, image.bytes);

    const sortOrder = image.sortOrder || index + 1;
    stored.push({
      storageKey,
      // 展示文件名与 sort_order 取同一个值：同一张原图下的多个类别不会错位。
      fileName: image.fileName?.trim() || `${sortOrder}.${path.extname(storageKey).slice(1)}`,
      mimeType: image.mimeType,
      width: image.width ?? null,
      height: image.height ?? null,
      category: image.category,
      sourceAssetId: image.sourceAssetId,
      sortOrder,
    });
  }

  return stored;
}

export const libraryAssetWriter: LibraryWriter = { write: writeLibraryImages };

/** 鉴权读取素材图片；文件缺失按 404 处理（与资源夹原图同一约定）。 */
export async function readLibraryFile(storageKey: string): Promise<Buffer> {
  try {
    return await readFile(resolveStoragePath(storageKey));
  } catch {
    throw AppError.notFound("图片文件不存在");
  }
}

/**
 * 删除一张素材的文件：只删这一个 storage_key，同一次运行里的其它素材不受影响。
 * 与删除资源夹同一条取舍：磁盘删除失败只记日志，不让请求失败。
 */
export async function removeLibraryFile(storageKey: string): Promise<void> {
  try {
    await rm(resolveStoragePath(storageKey), { force: true });
  } catch (error) {
    logger.error("删除素材文件失败，已跳过", { storageKey, error });
  }
}
