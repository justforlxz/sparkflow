/**
 * 生成图片的落盘（docs/prd/05-image-generation.md MUST 3、docs/architecture.md「文件」）：
 * `<UPLOAD_DIR>/generated-assets/<resultId>/<uuid>.<ext>`，数据库只存 storage_key。
 * 上游给的是临时 URL，必须在拿到图片时立刻下载落盘到本地，不能只保存 URL。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { assertStorageSegment, resolveStoragePath } from "@/lib/storage";
import { GENERATED_STORAGE_PREFIX } from "./constants";
import type { ResultAssetWriter, StoredImage } from "./store";
import type { GeneratedImage } from "./types";

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

export function buildGeneratedStorageKey(
  resultId: string,
  mimeType: string,
  fileId: string = randomUUID(),
): string {
  assertStorageSegment(resultId, "创作结果标识不合法");
  assertStorageSegment(fileId, "生成图片标识不合法");
  return `${GENERATED_STORAGE_PREFIX}/${resultId}/${fileId}.${extensionFor(mimeType)}`;
}

/** 逐张写盘；写盘失败直接抛出，由 runner 把阶段记为失败（不得在下载失败时标成功）。 */
export async function writeGeneratedImages(
  resultId: string,
  images: readonly GeneratedImage[],
): Promise<StoredImage[]> {
  const stored: StoredImage[] = [];

  for (const [index, image] of images.entries()) {
    const storageKey = buildGeneratedStorageKey(resultId, image.mimeType);
    const target = resolveStoragePath(storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, image.bytes);

    stored.push({
      storageKey,
      fileName: image.fileName?.trim() || `${index + 1}.${path.extname(storageKey).slice(1)}`,
      mimeType: image.mimeType,
      // 一图对一图：编号用原图序号，第 2 张失败时保留 1 与 3（AC-05-5）。
      sortOrder: image.sortOrder ?? index,
      width: image.width ?? null,
      height: image.height ?? null,
      sourceAssetId: image.sourceAssetId ?? null,
    });
  }

  return stored;
}

export const resultAssetWriter: ResultAssetWriter = { write: writeGeneratedImages };

/** 鉴权读取生成图片；文件缺失按 404 处理（与资源夹原图同一约定）。 */
export async function readGeneratedFile(storageKey: string): Promise<Buffer> {
  try {
    return await readFile(resolveStoragePath(storageKey));
  } catch {
    throw AppError.notFound("图片文件不存在");
  }
}

/**
 * 删除结果时清理它的图片目录（`generated-assets/<resultId>/`）。
 * 与删除资源夹同一条取舍：磁盘删除失败只记日志，不让请求失败。
 */
export async function removeResultFiles(resultId: string): Promise<void> {
  try {
    await rm(resolveStoragePath(`${GENERATED_STORAGE_PREFIX}/${resultId}`), {
      recursive: true,
      force: true,
    });
  } catch (error) {
    logger.error("删除结果图片目录失败，已跳过", { resultId, error });
  }
}
