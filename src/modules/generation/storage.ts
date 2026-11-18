/**
 * 生成图片的落盘（docs/prd/05-image-generation.md MUST 3、docs/architecture.md「文件」）：
 * `<UPLOAD_DIR>/generated-assets/<resultId>/<uuid>.<ext>`，数据库只存 storage_key。
 * 上游给的是临时 URL，必须在拿到图片时立刻下载落盘到本地，不能只保存 URL。
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
      sortOrder: index,
      width: image.width ?? null,
      height: image.height ?? null,
    });
  }

  return stored;
}

export const resultAssetWriter: ResultAssetWriter = { write: writeGeneratedImages };
