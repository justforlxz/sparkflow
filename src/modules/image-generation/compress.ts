/**
 * 传给上游前的原图压缩（docs/prd/05-image-generation.md MUST 4）：
 * 长边不超过 1536、转 JPEG（质量 85），再包成 `data:` URL。
 *
 * 原图可能是几 MB 的 PNG/HEIC，直接 base64 会把请求体撑大好几倍；压缩后单张约 150–250 KB。
 * 缩放只缩小不放大：低分辨率素材不拉糊（与资源夹缩略图同一条取舍）。
 *
 * 形状用 `data:image/jpeg;base64,...`：线上 `reference_images` 就是这么收的
 * （2026-11-20 实测；也接受纯 base64，用 data URL 与上游 schema 对齐、少一层猜测）。
 */
import sharp from "sharp";

/** 长边上限（像素）。 */
export const MAX_SOURCE_EDGE = 1536;

/** JPEG 质量。 */
export const JPEG_QUALITY = 85;

/** 压缩后的图片 MIME；形状固定为 JPEG，因此 data URL 前缀也固定。 */
export const REFERENCE_IMAGE_MIME = "image/jpeg";

/**
 * 压缩一张原图并返回 data URL。
 * 按 EXIF 方向先摆正再缩放：手机竖拍的图不先摆正会被当成横图压缩。
 */
export async function compressForReferenceImage(bytes: Buffer): Promise<string> {
  const compressed = await sharp(bytes)
    .rotate()
    .resize({
      width: MAX_SOURCE_EDGE,
      height: MAX_SOURCE_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  return `data:${REFERENCE_IMAGE_MIME};base64,${compressed.toString("base64")}`;
}
