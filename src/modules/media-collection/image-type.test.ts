import { describe, expect, it } from "vitest";
import { detectImageMime } from "./image-type";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const TEXT = Buffer.from("%PDF-1.7\n%âãÏÓ\n", "binary");

describe("图片类型按内容判断（MUST 3、AC-02-8）", () => {
  it("识别 PNG 魔数", () => {
    expect(detectImageMime(PNG)).toBe("image/png");
  });

  it("识别 JPEG 魔数", () => {
    expect(detectImageMime(JPEG)).toBe("image/jpeg");
  });

  it("识别 WebP 的 RIFF....WEBP 结构", () => {
    expect(detectImageMime(WEBP)).toBe("image/webp");
  });

  it("纯文本内容即使改名成 .png 也返回 null", () => {
    expect(detectImageMime(TEXT)).toBeNull();
  });

  it("只有 RIFF 头、没有 WEBP 标识时不算 WebP", () => {
    const riffOnly = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE")]);
    expect(detectImageMime(riffOnly)).toBeNull();
  });

  it("空文件与过短内容返回 null", () => {
    expect(detectImageMime(Buffer.alloc(0))).toBeNull();
    expect(detectImageMime(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});
