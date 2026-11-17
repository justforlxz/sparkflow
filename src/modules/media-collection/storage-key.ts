/**
 * 落盘路径的生成与解析（MUST 2）：服务端生成 `<UPLOAD_DIR>/media-assets/<collectionId>/<uuid>.<ext>`，
 * 用户上传时的原始文件名只存进数据库当展示字段，绝不参与路径拼接。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { storageRoot } from "@/lib/storage";
import { ASSET_STORAGE_PREFIX, IMAGE_EXTENSION, type ImageMime } from "./constants";

const SAFE_SEGMENT = /^[A-Za-z0-9-]+$/;

function assertSafeSegment(segment: string): void {
  if (!SAFE_SEGMENT.test(segment)) {
    throw AppError.validationFailed("资源夹标识不合法");
  }
}

/** 生成 storage_key。`fileId` 可注入，便于测试断言路径形状。 */
export function buildAssetStorageKey(
  collectionId: string,
  mimeType: ImageMime,
  fileId: string = randomUUID(),
): string {
  assertSafeSegment(collectionId);
  assertSafeSegment(fileId);
  return `${ASSET_STORAGE_PREFIX}/${collectionId}/${fileId}.${IMAGE_EXTENSION[mimeType]}`;
}

/** 资源夹图片目录的 storage_key 前缀（删除资源夹时清理整个目录）。 */
export function collectionStoragePrefix(collectionId: string): string {
  assertSafeSegment(collectionId);
  return `${ASSET_STORAGE_PREFIX}/${collectionId}`;
}

/**
 * 把 storage_key 解析成磁盘绝对路径。`..`、绝对路径等越界写法一律拒绝，
 * 保证读取接口不会读到 `UPLOAD_DIR` 之外的文件。
 */
export function resolveStoragePath(storageKey: string): string {
  const root = storageRoot();
  const resolved = path.resolve(root, storageKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw AppError.validationFailed("图片路径不合法");
  }
  return resolved;
}
