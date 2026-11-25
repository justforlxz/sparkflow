import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  WATERMARK_BACKGROUND_TOLERANCE,
  WATERMARK_BAND_RATIO,
  WATERMARK_SAFE_MAX_SUBJECT_RATIO,
  bandHeight,
  bandSubjectRatio,
  colorDistance,
  WATERMARK_NOTES,
  removeUpstreamWatermark,
  sampleBackgroundColor,
  type RawPixels,
  type RgbColor,
} from "./watermark";

/**
 * 去水印后处理（MKACG-1004）：
 * 裁掉底部一条 + 用采样背景色补回同样高度，尺寸与长宽比不变、主体不丢；
 * 主体已经贴底时不裁切（MUST NOT 为了去水印把主体裁掉）。
 *
 * 用 sharp 现场造图再处理，断言的是解码回来的真实像素属性，不看实现细节。
 */

/** 采样到的背景色与主体色：差得足够远，安全检测不会把背景误判成主体。 */
const BACKGROUND: RgbColor = { r: 245, g: 243, b: 238 };
const SUBJECT: RgbColor = { r: 40, g: 60, b: 90 };

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 造一块纯色画布（RGB 三通道 raw）。 */
function canvas(width: number, height: number, fill: RgbColor): Buffer {
  const data = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 3] = fill.r;
    data[index * 3 + 1] = fill.g;
    data[index * 3 + 2] = fill.b;
  }
  return data;
}

/** 在画布上刷一块实色矩形。 */
function paint(data: Buffer, canvasWidth: number, rect: Rect, color: RgbColor): void {
  for (let y = rect.top; y < rect.top + rect.height; y += 1) {
    for (let x = rect.left; x < rect.left + rect.width; x += 1) {
      const offset = (y * canvasWidth + x) * 3;
      data[offset] = color.r;
      data[offset + 1] = color.g;
      data[offset + 2] = color.b;
    }
  }
}

function encodeRgb(data: Buffer, width: number, height: number, format: "png" | "jpeg") {
  const pipeline = sharp(data, { raw: { width, height, channels: 3 } });
  return format === "jpeg" ? pipeline.jpeg({ quality: 100 }).toBuffer() : pipeline.png().toBuffer();
}

/** 解码成采样与检测用的像素（与实现同一取向：先摊平 alpha）。 */
async function rawOf(bytes: Buffer): Promise<RawPixels> {
  const { data, info } = await sharp(bytes)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function pixelAt(pixels: RawPixels, x: number, y: number): RgbColor {
  const offset = (y * pixels.width + x) * pixels.channels;
  return {
    r: pixels.data[offset] ?? 0,
    g: pixels.data[offset + 1] ?? 0,
    b: pixels.data[offset + 2] ?? 0,
  };
}

describe("AC-WM-1 裁掉底部一条再补回同样高度：尺寸与长宽比不变", () => {
  it("AC-WM-1 竖版图处理后宽高不变，底部 10% 条带与采样背景色一致，主体仍在原位", async () => {
    const width = 900;
    const height = 1200;
    const data = canvas(width, height, BACKGROUND);
    // 主体落在中间偏上：底部 10%（1200 × 10% = 120 行）里一个主体像素都没有。
    paint(data, width, { left: 100, top: 300, width: 700, height: 600 }, SUBJECT);
    const source = await encodeRgb(data, width, height, "png");

    const result = await removeUpstreamWatermark(source);

    expect(result.removed).toBe(true);
    expect(result.note).toBeNull();
    expect(result.subjectRatio).toBe(0);

    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(width);
    expect(meta.height).toBe(height);
    expect((meta.width ?? 0) / (meta.height ?? 1)).toBeCloseTo(width / height, 6);

    // 底部条带换成了采样背景色：与处理前那张图的采样色差异在阈值内。
    const background = sampleBackgroundColor(await rawOf(source));
    const processed = await rawOf(result.bytes);
    const band = bandHeight(height, WATERMARK_BAND_RATIO);
    for (let y = height - band; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        expect(colorDistance(pixelAt(processed, x, y), background)).toBeLessThanOrEqual(
          WATERMARK_BACKGROUND_TOLERANCE,
        );
      }
    }

    // 主体没被切掉：裁的只是底部，主体像素仍在原坐标上（整张画布与原图重合）。
    expect(colorDistance(pixelAt(processed, 450, 600), SUBJECT)).toBe(0);
    expect(colorDistance(pixelAt(processed, 450, 899), SUBJECT)).toBe(0);
  });

  it("AC-WM-1 保持原格式：JPEG 进 JPEG 出，尺寸不变", async () => {
    const width = 640;
    const height = 960;
    const data = canvas(width, height, BACKGROUND);
    paint(data, width, { left: 80, top: 200, width: 480, height: 480 }, SUBJECT);
    const source = await encodeRgb(data, width, height, "jpeg");

    const result = await removeUpstreamWatermark(source);

    expect(result.removed).toBe(true);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([width, height]);
  });
});

describe("AC-WM-3 原因文案（`watermark_note` 是界面上唯一的解释）", () => {
  it("AC-WM-3 比例只格式化一次：百分号只出现一次，不是 `7.0%%`", () => {
    // 功能检测阻断项：调用方带上 `%`、模板又补一个，界面上显示成 `7.0%%`。
    expect(WATERMARK_NOTES.subjectInBand(0.1, 0.07)).toBe(
      "未去水印：底部 10% 条带里主体像素占 7.0%，裁掉会切掉主体，已保留原图",
    );
    // 条带比例同样是格式化出来的，一位小数以外的精度按四舍五入给出。
    expect(WATERMARK_NOTES.subjectInBand(0.075, 0.1234)).toContain("底部 8% 条带里主体像素占 12.3%");
  });

  it("AC-WM-3 另外两种结局的原因文案固定", () => {
    expect(WATERMARK_NOTES.bandTooShort(1, 1)).toBe(
      "未去水印：图片 1×1 太矮，底部条带不足 1 像素，已保留原图",
    );
    expect(WATERMARK_NOTES.failed("读不出图片格式")).toBe(
      "未去水印：后处理失败（读不出图片格式），已保留原图",
    );
  });
});

describe("AC-WM-3 主体贴底时不裁切：原图保留并给出原因", () => {
  async function subjectAtBottom(coveredRows: number): Promise<{ source: Buffer; width: number; height: number }> {
    const width = 600;
    const height = 600;
    const data = canvas(width, height, BACKGROUND);
    // 主体从左到右铺满，向下压到整张图的最底部（安全检测要拦住的那条带）。
    paint(data, width, { left: 0, top: height - coveredRows, width, height: coveredRows }, SUBJECT);
    return { source: await encodeRgb(data, width, height, "png"), width, height };
  }

  it("AC-WM-3 主体占满底部条带：不裁切、原图原样返回、removed=false、note 写明原因", async () => {
    const { source, width, height } = await subjectAtBottom(150);

    const result = await removeUpstreamWatermark(source);

    expect(result.removed).toBe(false);
    expect(result.bytes.equals(source)).toBe(true);
    // 断言完整句式：原因文案是界面上唯一的一句解释，只查关键词会漏掉 `7.0%%` 这种错字
    // （功能检测 MKACG-1004 阻断项）。
    expect(result.note).toBe(
      "未去水印：底部 10% 条带里主体像素占 100.0%，裁掉会切掉主体，已保留原图",
    );
    expect(result.subjectRatio).toBeGreaterThan(WATERMARK_SAFE_MAX_SUBJECT_RATIO);

    const meta = await sharp(result.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([width, height]);
  });

  it("AC-WM-3 整幅都是同一个颜色时没有可辨认的主体：照样裁切补回，视觉不变", async () => {
    const width = 300;
    const height = 300;
    const solid = await encodeRgb(canvas(width, height, SUBJECT), width, height, "png");

    const result = await removeUpstreamWatermark(solid);

    // 采样到的背景色就是主体色：裁掉的那条带补回同色，像素与原图逐点相同。
    expect(result.removed).toBe(true);
    const meta = await sharp(result.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([width, height]);
    expect(pixelAt(await rawOf(result.bytes), 10, height - 1)).toEqual(SUBJECT);
  });
});

describe("AC-WM-5 背景色采样与安全检测比例", () => {
  it("AC-WM-5 采样取顶部条带与四角的众数色，不被中部主体带偏", () => {
    const width = 100;
    const height = 100;
    const data = canvas(width, height, BACKGROUND);
    // 中部一大块主体（7000 个像素，比顶部条带的 800 个多得多），采样不该取它。
    paint(data, width, { left: 10, top: 20, width: 80, height: 70 }, SUBJECT);

    const pixels: RawPixels = { data, width, height, channels: 3 };
    expect(sampleBackgroundColor(pixels)).toEqual(BACKGROUND);
  });

  it("AC-WM-5 主体像素占比按底部条带的面积算", () => {
    const width = 10;
    const height = 10;
    const data = canvas(width, height, BACKGROUND);
    // 底部 20% = 2 行 = 20 个像素，其中左半 5 列 × 2 行 = 10 个是主体 → 0.5。
    paint(data, width, { left: 0, top: 8, width: 5, height: 2 }, SUBJECT);

    const pixels: RawPixels = { data, width, height, channels: 3 };
    expect(bandSubjectRatio(pixels, BACKGROUND, 0.2)).toBeCloseTo(0.5, 6);
    // 默认 10% 只看最后 1 行：10 个像素里 5 个主体 → 0.5。
    expect(bandSubjectRatio(pixels, BACKGROUND)).toBeCloseTo(0.5, 6);
  });

  it("AC-WM-5 阈值以内的细微噪点不算主体", () => {
    const width = 10;
    const height = 10;
    const data = canvas(width, height, BACKGROUND);
    const noisy = {
      r: BACKGROUND.r - WATERMARK_BACKGROUND_TOLERANCE,
      g: BACKGROUND.g + 1,
      b: BACKGROUND.b,
    };
    paint(data, width, { left: 0, top: 8, width: 10, height: 2 }, noisy);

    const pixels: RawPixels = { data, width, height, channels: 3 };
    expect(bandSubjectRatio(pixels, BACKGROUND, 0.2)).toBe(0);
  });

  it("AC-WM-5 两项阈值可覆盖：放宽主体占比上限后就敢裁", async () => {
    const width = 400;
    const height = 400;
    const data = canvas(width, height, BACKGROUND);
    paint(data, width, { left: 0, top: 380, width: 400, height: 20 }, SUBJECT);
    const source = await encodeRgb(data, width, height, "png");

    // 底部 10% 条带里 50% 是主体：默认阈值（5%）拒绝裁切。
    expect((await removeUpstreamWatermark(source)).removed).toBe(false);

    const relaxed = await removeUpstreamWatermark(source, {
      bandRatio: 0.1,
      maxSubjectRatio: 0.9,
    });
    expect(relaxed.removed).toBe(true);
    const meta = await sharp(relaxed.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([width, height]);
  });
});

describe("AC-WM-5 退化输入", () => {
  it("AC-WM-5 全黑图：背景色就是黑，不误判主体，尺寸不变", async () => {
    const width = 200;
    const height = 200;
    const black: RgbColor = { r: 0, g: 0, b: 0 };
    const source = await encodeRgb(canvas(width, height, black), width, height, "png");

    const result = await removeUpstreamWatermark(source);

    expect(result.removed).toBe(true);
    expect(result.subjectRatio).toBe(0);
    const meta = await sharp(result.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([width, height]);
    expect(pixelAt(await rawOf(result.bytes), 0, height - 1)).toEqual(black);
  });

  it("AC-WM-5 1×1 图：底部条带不足一个像素可裁，原图返回并说明原因", async () => {
    const source = await encodeRgb(canvas(1, 1, BACKGROUND), 1, 1, "png");

    const result = await removeUpstreamWatermark(source);

    expect(result.removed).toBe(false);
    expect(result.bytes.equals(source)).toBe(true);
    expect(result.note).toBe("未去水印：图片 1×1 太矮，底部条带不足 1 像素，已保留原图");
  });

  it("AC-WM-5 带透明通道：先摊平再处理，尺寸不变且底部不再透明", async () => {
    const width = 200;
    const height = 200;
    const rgba = Buffer.alloc(width * height * 4);
    // 全透明画布 + 一块不透明白色主体：透明像素的 RGB 是 0，不能被当成背景色。
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const inside = x >= 40 && x < 160 && y >= 40 && y < 160;
        rgba[offset] = 255;
        rgba[offset + 1] = 255;
        rgba[offset + 2] = 255;
        rgba[offset + 3] = inside ? 255 : 0;
      }
    }
    const source = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();

    const result = await removeUpstreamWatermark(source);

    expect(result.removed).toBe(true);
    const meta = await sharp(result.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([width, height]);
    expect(meta.hasAlpha).toBe(false);
    // 底部补边用的是摊平后的白底，不是透明像素里的黑。
    expect(pixelAt(await rawOf(result.bytes), 10, height - 1)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("AC-WM-5 不是图片的字节直接抛错（由调用方保留原图）", async () => {
    await expect(removeUpstreamWatermark(Buffer.from("png"))).rejects.toThrow();
  });
});
