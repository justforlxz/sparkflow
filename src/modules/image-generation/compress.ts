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

/** 一张图的像素尺寸。 */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * EXIF `Orientation` 为 5–8 时图像被旋转了 90° 或 270°：文件头里的宽高是**未摆正**的，
 * 需要交换才是人眼看到的宽高。
 */
function isQuarterTurn(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8;
}

/**
 * 读一张图的**摆正后**像素尺寸（docs/prd/12 MUST 2d、AC-LIB-13）：输出比例按原图长宽比推导，
 * 素材库记录产物的实际尺寸。读不到时给 0，由调用方退回正方形。
 *
 * 必须与 `compressForReferenceImage` 同向：那边先 `.rotate()` 摆正再压缩，所以传给上游的参考图
 * 已经是摆正后的方向。`metadata()` 只读文件头、不套用任何图像操作，因此这里按 EXIF 方向交换宽高 ——
 * 否则手机竖拍（Orientation 6）的照片会被当成横图，请求出与参考图相反的长宽比，俯视图被裁切或压扁。
 */
export async function readImageDimensions(bytes: Buffer): Promise<ImageDimensions> {
  const metadata = await sharp(bytes).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  return isQuarterTurn(metadata.orientation) ? { width: height, height: width } : { width, height };
}
