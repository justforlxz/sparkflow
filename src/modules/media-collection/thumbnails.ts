import sharp from "sharp";
import { DEFAULT_THUMBNAIL_WIDTH, MAX_THUMBNAIL_WIDTH } from "./constants";

/**
 * 缩略图按需缩放（docs/architecture.md「文件」）：请求带 `w` 时才处理，不预生成、不落缓存文件。
 * 只缩小不放大，避免把低分辨率原图拉糊。
 */
export async function scaleImage(
  bytes: Buffer,
  width: number = DEFAULT_THUMBNAIL_WIDTH,
): Promise<Buffer> {
  const target = Math.min(width, MAX_THUMBNAIL_WIDTH);
  return sharp(bytes).resize({ width: target, withoutEnlargement: true }).toBuffer();
}
