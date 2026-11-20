import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  JPEG_QUALITY,
  MAX_SOURCE_EDGE,
  REFERENCE_IMAGE_MIME,
  compressForReferenceImage,
} from "./compress";

/**
 * 原图压缩（docs/prd/05 MUST 4、AC-05-3）：
 * 长边 ≤ 1536、转 JPEG（质量 85）、形状是 `data:image/jpeg;base64,...`。
 *
 * 用 sharp 现场造图再压缩，断言的是解码回来的真实图像属性，不看实现细节。
 */

async function pngOf(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 160, b: 200 } },
  })
    .png()
    .toBuffer();
}

/** 取出 data URL 里的 base64 段。 */
function bytesOf(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

/** JPEG 的 SOI 标记：FF D8 FF。 */
function isJpeg(bytes: Buffer): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

describe("AC-05-3 传给上游前的原图压缩", () => {
  it("超长边的图缩到长边 1536 并转成 JPEG，形状是 data URL", async () => {
    const encoded = await compressForReferenceImage(await pngOf(3000, 2000));

    expect(encoded.startsWith(`data:${REFERENCE_IMAGE_MIME};base64,`)).toBe(true);

    const decoded = bytesOf(encoded);
    expect(isJpeg(decoded)).toBe(true);

    const meta = await sharp(decoded).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(MAX_SOURCE_EDGE);
    // 等比缩放：3000×2000 → 1536×1024
    expect([meta.width, meta.height]).toEqual([1536, 1024]);
  });

  it("竖图按高度缩到上限，横竖比例不变", async () => {
    const meta = await sharp(bytesOf(await compressForReferenceImage(await pngOf(1200, 2400)))).metadata();

    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(MAX_SOURCE_EDGE);
    expect([meta.width, meta.height]).toEqual([768, 1536]);
  });

  it("小图不放大，只转格式", async () => {
    const decoded = bytesOf(await compressForReferenceImage(await pngOf(320, 240)));
    const meta = await sharp(decoded).metadata();

    expect([meta.width, meta.height]).toEqual([320, 240]);
    expect(isJpeg(decoded)).toBe(true);
  });

  it("压缩后的体积明显小于原 PNG（同一张图）", async () => {
    const source = await pngOf(3000, 2000);
    const encoded = await compressForReferenceImage(source);

    expect(bytesOf(encoded).length).toBeLessThan(source.length);
    expect(JPEG_QUALITY).toBe(85);
  });
});
