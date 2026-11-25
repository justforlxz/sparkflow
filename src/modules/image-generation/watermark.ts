/**
 * 上游模型自带水印的确定性后处理（MKACG-1004，docs/prd/05「水印（实测结论，2026-11-20）」）。
 *
 * 背景：sensenova 出图在**右下角**固定位置带「日日新 / senseNova」水印，`watermark: false`
 * 与提示词都无效（2026-11-25 再次实测确认）。可行解只有一种确定性做法：
 *
 * 1. 采样背景色：取顶部条带与四角的众数色（避开中间与底部的主体）；
 * 2. 裁掉底部 `WATERMARK_BAND_RATIO`（默认 10%：6.5% / 7% / 8% 都还留水印碎片）；
 * 3. 用采样色把底部补回同样高度 —— 尺寸与长宽比不变，主体整体上移，不被切掉；
 * 4. 安全检测：裁掉的那条带里「与背景色差异超过阈值」的像素过多，说明主体已经进入该带，
 *    这时**不裁切**，原图原样返回并给出原因。宁可留水印，也不能把用户的图切坏。
 *
 * 只裁下、不裁右：裁右 8% 会把主体右边与右下圆角切掉（issue 实测依据）。
 *
 * 本文件只做纯计算，不碰数据库、不写日志（调用方 `extraction.ts` 决定记什么日志）。
 */
import sharp from "sharp";

/** 裁掉的底部条带占图高的比例。实测 10% 才干净；6.5% / 7% / 8% 仍见水印痕迹。 */
export const WATERMARK_BAND_RATIO = 0.1;

/** 底部条带里允许的「主体像素」占比上限：超过就不裁（MUST NOT 为了去水印把主体裁掉）。 */
export const WATERMARK_SAFE_MAX_SUBJECT_RATIO = 0.05;

/** 采样背景色的顶部条带占图高的比例（避开中间与底部的主体）。 */
export const WATERMARK_SAMPLE_BAND_RATIO = 0.08;

/** 采样背景色时每个角取的方块边长（像素）：只取角上的一小块，不受主体影响。 */
export const WATERMARK_CORNER_SAMPLE_EDGE = 32;

/** 「与背景色的差异」阈值：单通道最大差值超过它就算这个像素不是背景。 */
export const WATERMARK_BACKGROUND_TOLERANCE = 32;

/** 重编码为 JPEG 时的质量：只做一次裁切 + 补边，给高一点减少可见损失。 */
export const WATERMARK_JPEG_QUALITY = 95;

/**
 * 处理透明图时把 alpha 摊平到的底色：与界面上「纯色空边」的预期一致。
 * 不摊平会把透明像素的 RGB（通常是 0,0,0）当成背景色，补边补出一片黑。
 */
const FLATTEN_BACKGROUND = { r: 255, g: 255, b: 255 } as const;

/** 没去水印时写进 `library_asset.watermark_note` 的原因（界面据此说明为什么带着水印）。 */
export const WATERMARK_NOTES = {
  /**
   * 两个参数都是 0–1 的比例，百分比只在这里格式化一次。
   * 上一版让调用方把 `${(ratio * 100).toFixed(1)}%` 传进来、模板又补一个百分号，
   * 界面上显示成 `7.0%%`（功能检测阻断项）；同一单位、一处格式化，避免再犯。
   */
  subjectInBand: (bandRatio: number, subjectRatio: number): string =>
    `未去水印：底部 ${Math.round(bandRatio * 100)}% 条带里主体像素占 ${(subjectRatio * 100).toFixed(1)}%，裁掉会切掉主体，已保留原图`,
  bandTooShort: (width: number, height: number): string =>
    `未去水印：图片 ${width}×${height} 太矮，底部条带不足 1 像素，已保留原图`,
  failed: (reason: string): string => `未去水印：后处理失败（${reason}），已保留原图`,
} as const;

/** 一个像素的颜色。 */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** 解码后的像素（`sharp().raw()` 的输出，`channels` 可能是 1、3 或 4）。 */
export interface RawPixels {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

/** 取第 `index` 个像素的颜色；灰度图把单通道铺到三个通道上。 */
function readPixel(data: Buffer, index: number, channels: number): RgbColor {
  if (channels === 1) {
    const value = data[index] ?? 0;
    return { r: value, g: value, b: value };
  }
  return { r: data[index] ?? 0, g: data[index + 1] ?? 0, b: data[index + 2] ?? 0 };
}

/** 单个颜色通道的最大差值：0 表示完全一致，255 表示黑白之差。 */
export function colorDistance(a: RgbColor, b: RgbColor): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/** 采样背景用的行范围：顶部条带，至少一行（1×1 图也有得取）。 */
function sampleRowEnd(height: number): number {
  return Math.min(height, Math.max(1, Math.round(height * WATERMARK_SAMPLE_BAND_RATIO)));
}

/**
 * 采样背景色：顶部条带与四角像素的众数色。
 *
 * 用众数而不是平均值：整幅图求平均会把主体的颜色混进来，补出来的边带明显偏色。
 * 四角单独补采一次，是因为主体偶尔会盖住顶部条带（俯视图顶到边），角上通常仍是背景。
 */
export function sampleBackgroundColor(pixels: RawPixels): RgbColor {
  const { data, width, height, channels } = pixels;
  const counts = new Map<number, number>();

  function count(x: number, y: number): void {
    const { r, g, b } = readPixel(data, (y * width + x) * channels, channels);
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (let y = 0; y < sampleRowEnd(height); y += 1) {
    for (let x = 0; x < width; x += 1) count(x, y);
  }

  const edge = Math.min(WATERMARK_CORNER_SAMPLE_EDGE, width, height);
  for (const [cornerX, cornerY] of [
    [0, 0],
    [width - edge, 0],
    [0, height - edge],
    [width - edge, height - edge],
  ]) {
    for (let y = cornerY; y < cornerY + edge; y += 1) {
      for (let x = cornerX; x < cornerX + edge; x += 1) count(x, y);
    }
  }

  // 众数；票数相同时取先出现的那个（Map 按插入顺序迭代），结果只由像素决定。
  let best = 0;
  let bestCount = -1;
  for (const [key, value] of counts) {
    if (value > bestCount) {
      best = key;
      bestCount = value;
    }
  }
  return { r: (best >> 16) & 0xff, g: (best >> 8) & 0xff, b: best & 0xff };
}

/** 底部条带的行数；不足一行时按一行算，调用方再判断能不能真的裁。 */
export function bandHeight(height: number, bandRatio: number): number {
  return Math.max(1, Math.round(height * bandRatio));
}

/**
 * 底部条带里「不是背景」的像素占比（0–1）：安全检测的判据。
 *
 * 只统计最底下 `bandRatio` 那几行 —— 那正是要被裁掉的部分；占比高说明主体已经贴到底边，
 * 裁掉就会切坏主体。
 */
export function bandSubjectRatio(
  pixels: RawPixels,
  background: RgbColor,
  bandRatio: number = WATERMARK_BAND_RATIO,
  tolerance: number = WATERMARK_BACKGROUND_TOLERANCE,
): number {
  const { data, width, height, channels } = pixels;
  const band = Math.min(height, bandHeight(height, bandRatio));
  const start = height - band;
  let subject = 0;
  for (let y = start; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (colorDistance(readPixel(data, (y * width + x) * channels, channels), background) > tolerance) {
        subject += 1;
      }
    }
  }
  return subject / (band * width);
}

/** 一张产物的后处理结果。`removed` 为 false 时 `bytes` 就是原图。 */
export interface WatermarkRemovalResult {
  bytes: Buffer;
  /** 是否真的去掉了水印（裁了并补回）。 */
  removed: boolean;
  /** 没去水印的原因；去掉时是 null。 */
  note: string | null;
  /** 底部条带里主体像素的占比（0–1），用于日志。 */
  subjectRatio: number;
}

export interface WatermarkRemovalOptions {
  /** 覆盖默认裁切比例（默认 `WATERMARK_BAND_RATIO`）。 */
  bandRatio?: number;
  /** 覆盖默认的主体占比上限（默认 `WATERMARK_SAFE_MAX_SUBJECT_RATIO`）。 */
  maxSubjectRatio?: number;
}

function unchanged(
  bytes: Buffer,
  subjectRatio: number,
  note: string,
): WatermarkRemovalResult {
  return { bytes, removed: false, note, subjectRatio };
}

/**
 * 去掉上游模型固定在底部的水印：裁掉底部一条，再用采样背景色补回同样高度。
 *
 * 三种「不动原图」的结局都给得出可读原因（写进 `watermark_note`）：
 * 图片太矮、主体贴在底部条带里、以及本函数抛错（由调用方兜住）。
 * 解码失败、格式不受支持等情况直接抛错 —— 调用方保留原图并记 warn，提取照常成功。
 */
export async function removeUpstreamWatermark(
  bytes: Buffer,
  options: WatermarkRemovalOptions = {},
): Promise<WatermarkRemovalResult> {
  const bandRatio = options.bandRatio ?? WATERMARK_BAND_RATIO;
  const maxSubjectRatio = options.maxSubjectRatio ?? WATERMARK_SAFE_MAX_SUBJECT_RATIO;

  const metadata = await sharp(bytes).metadata();
  const format = metadata.format;
  if (!format) throw new Error("读不出图片格式");

  // 摊平 alpha 后再取像素：透明像素的 RGB 不能当成背景色用。
  const { data, info } = await sharp(bytes)
    .flatten({ background: FLATTEN_BACKGROUND })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels: RawPixels = {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };

  const band = bandHeight(info.height, bandRatio);
  if (band >= info.height) {
    return unchanged(bytes, 0, WATERMARK_NOTES.bandTooShort(info.width, info.height));
  }

  const background = sampleBackgroundColor(pixels);
  const subjectRatio = bandSubjectRatio(pixels, background, bandRatio);
  if (subjectRatio > maxSubjectRatio) {
    const note = WATERMARK_NOTES.subjectInBand(bandRatio, subjectRatio);
    return unchanged(bytes, subjectRatio, note);
  }

  const pipeline = sharp(bytes)
    .flatten({ background: FLATTEN_BACKGROUND })
    .extract({ left: 0, top: 0, width: info.width, height: info.height - band })
    .extend({ bottom: band, background: { ...background, alpha: 1 } });

  // 保持原格式：`library_asset.mime_type` 由上游回包的 content-type 决定，换格式会与记录不一致。
  const encoded =
    format === "jpeg"
      ? await pipeline.jpeg({ quality: WATERMARK_JPEG_QUALITY }).toBuffer()
      : await pipeline.toFormat(format).toBuffer();

  return { bytes: encoded, removed: true, note: null, subjectRatio };
}
