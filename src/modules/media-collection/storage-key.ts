/**
 * 落盘路径的生成与解析（MUST 2）：服务端生成 `<UPLOAD_DIR>/media-assets/<collectionId>/<uuid>.<ext>`，
 * 用户上传时的原始文件名只存进数据库当展示字段，绝不参与路径拼接。
 *
 * 路径段校验与 `storage_key` 解析在 `src/lib/storage.ts`：生成图片用的是同一套规则。
 */
import { randomUUID } from "node:crypto";
import { assertStorageSegment, resolveStoragePath } from "@/lib/storage";
import { ASSET_STORAGE_PREFIX, IMAGE_EXTENSION, type ImageMime } from "./constants";

export { resolveStoragePath };

function assertSafeSegment(segment: string): void {
  assertStorageSegment(segment, "资源夹标识不合法");
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
