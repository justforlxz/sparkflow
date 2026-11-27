/**
 * 落盘路径的生成与解析：服务端生成 `<UPLOAD_DIR>/media-assets/<assetId>.<ext>`，
 * 用户上传时的原始文件名只存进数据库当展示字段，绝不参与路径拼接。
 *
 * 目录里不再有资源夹这一层：照片属于总资源库，一张照片可以同时属于多个资源夹，
 * 用资源夹 id 做目录会让「从夹里移除」与「删夹」都动到别的夹还在用的文件
 * （docs/adr/0012-总资源库与资源夹的相册模型.md 第 1 条）。
 *
 * 路径段校验与 `storage_key` 解析在 `src/lib/storage.ts`：生成图片用的是同一套规则。
 */
import { randomUUID } from "node:crypto";
import { assertStorageSegment, resolveStoragePath } from "@/lib/storage";
import { ASSET_STORAGE_PREFIX, IMAGE_EXTENSION, type ImageMime } from "./constants";

export { resolveStoragePath };

/**
 * 矫正图的 storage_key：`media-assets/<assetId>-rectified.png`。
 *
 * 与原图放在同一层、以原图 id 为前缀：删除原图时一起清掉，不需要额外的引用记录；
 * 后缀固定 `.png`，与 `rectify.ts` 只输出 PNG 一致（无损，保证字节可复现）。
 */
export function buildRectifiedStorageKey(assetId: string): string {
  assertStorageSegment(assetId, "图片标识不合法");
  return `${ASSET_STORAGE_PREFIX}/${assetId}-rectified.png`;
}

/** 生成 storage_key。`assetId` 可注入，便于测试断言路径形状。 */
export function buildAssetStorageKey(
  mimeType: ImageMime,
  assetId: string = randomUUID(),
): string {
  assertStorageSegment(assetId, "图片标识不合法");
  return `${ASSET_STORAGE_PREFIX}/${assetId}.${IMAGE_EXTENSION[mimeType]}`;
}
