/**
 * 单应透视矫正（MKACG-1001、docs/prd/13-quad-rectify.md「几何计算」）：
 * 把用户框选的四角拉成正视矩形，输出**原图像素的几何变换结果**。
 *
 * 三条边界：
 * 1. **全程不调用任何模型**。产物是像素级重采样，文字与角色必然原样（AC-QUAD-9）；
 *    同一张原图连续跑两次结果字节完全一致（AC-QUAD-10）。
 * 2. 重采样用**双线性**，查表方向是「目标像素 → 源像素」（`rectToImage`）：
 *    目标图的每个像素反查回原图上的一点，避免正向映射留下空洞。
 * 3. 采样点落到原图之外时按边缘像素**钳制**，不填黑边：四边形贴着图片边界时不该出现黑框。
 *
 * 先 `.rotate()` 套用 EXIF 方向再取像素：界面上的四点是浏览器渲染（已摆正）后的坐标，
 * 不先摆正就会在手机竖拍的照片上算错位置（与 `readImageDimensions` 同一口径）。
 */
import sharp from "sharp";
import { logger } from "@/lib/logger";
import { rectToImage, type NormalizedQuad } from "./quad";

/** 矫正的目标尺寸（像素）。由调用方按估算/手输比例推导，见 `deriveExtractionSizeFromRatio`。 */
export interface RectifyTarget {
  width: number;
  height: number;
}

export interface RectifyInput {
  sourceBytes: Buffer;
  quad: NormalizedQuad;
  target: RectifyTarget;
}

/** 解码后的像素缓冲：`channels` 通常是 3（去掉 alpha 后的 RGB）。 */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

/**
 * 双线性取样一个通道值。`x`、`y` 是像素坐标（像素中心在 `.5` 的位置也会被正确处理）。
 * 越界坐标先钳制到 `[0, width-1] × [0, height-1]`：钳制比补黑边更接近原图。
 */
export function sampleBilinear(
  image: RawImage,
  x: number,
  y: number,
  channel: number,
): number {
  const maxX = image.width - 1;
  const maxY = image.height - 1;
  const clampedX = Math.min(maxX, Math.max(0, x));
  const clampedY = Math.min(maxY, Math.max(0, y));

  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(maxX, x0 + 1);
  const y1 = Math.min(maxY, y0 + 1);
  const fx = clampedX - x0;
  const fy = clampedY - y0;

  const { data, channels } = image;
  const at = (px: number, py: number): number => data[(py * image.width + px) * channels + channel];

  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** 解码成 RGB 原始像素；alpha 直接丢掉（原图都是不透明照片，透明底不在本单范围内）。 */
async function decodeRgb(sourceBytes: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(sourceBytes)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * 把四边形矫正成 `target` 尺寸的正视矩形，返回 PNG 字节。
 *
 * 用 PNG 而不是 JPEG：矫正产物会直接当作 `graphic` 类的成品入库，
 * 无损编码保证「同一张原图两次运行字节一致」（AC-QUAD-10），也不引入编码器质量控制参数。
 */
export async function rectifyImage(input: RectifyInput): Promise<Buffer> {
  const { sourceBytes, quad, target } = input;
  const source = await decodeRgb(sourceBytes);

  const matrix = rectToImage(quad, source, target);
  if (!matrix) {
    throw new Error("四角退化，解不出单应矩阵");
  }

  const [a, b, c, d, e, f, g, h, i] = matrix;
  const width = Math.round(target.width);
  const height = Math.round(target.height);
  const output = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    // 取像素中心：直接用整数坐标会让整体偏移半个像素。
    const v = y + 0.5;
    for (let x = 0; x < width; x += 1) {
      const u = x + 0.5;
      const denominator = g * u + h * v + i;
      const offset = (y * width + x) * 3;

      if (!Number.isFinite(denominator) || Math.abs(denominator) < Number.EPSILON) {
        // 齐次坐标落在无穷远：这一格没有对应像素，填白而不是填黑（视觉上更像「没内容」）。
        output[offset] = 255;
        output[offset + 1] = 255;
        output[offset + 2] = 255;
        continue;
      }

      const sourceX = (a * u + b * v + c) / denominator;
      const sourceY = (d * u + e * v + f) / denominator;

      output[offset] = Math.round(sampleBilinear(source, sourceX, sourceY, 0));
      output[offset + 1] = Math.round(sampleBilinear(source, sourceX, sourceY, 1));
      output[offset + 2] = Math.round(sampleBilinear(source, sourceX, sourceY, 2));
    }
  }

  logger.info("单应矫正完成", {
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetWidth: width,
    targetHeight: height,
  });

  return sharp(output, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** 矫正图的 MIME：固定 PNG（见 `rectifyImage` 的说明）。 */
export const RECTIFIED_MIME_TYPE = "image/png";
