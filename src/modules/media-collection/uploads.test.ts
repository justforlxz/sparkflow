import { describe, expect, it } from "vitest";
import { isAppError } from "@/lib/errors";
import { prepareImages } from "./uploads";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const TEN_MIB = 10 * 1024 * 1024;

function catchAppError(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("预期抛出 AppError，但没有抛出");
}

describe("上传校验（MUST 3、AC-01-3）", () => {
  it("合格的图片带上按内容判断出的 MIME", () => {
    const prepared = prepareImages([{ fileName: "a.png", bytes: PNG }], TEN_MIB);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({ fileName: "a.png", mimeType: "image/png" });
  });

  it("多张图片逐张判断类型", () => {
    const prepared = prepareImages(
      [
        { fileName: "a.png", bytes: PNG },
        { fileName: "b.jpg", bytes: JPEG },
      ],
      TEN_MIB,
    );
    expect(prepared.map((image) => image.mimeType)).toEqual(["image/png", "image/jpeg"]);
  });

  it("文本改名成 .png 仍被拒绝（AC-02-8）", () => {
    const error = catchAppError(() =>
      prepareImages([{ fileName: "fake.png", bytes: Buffer.from("这不是图片") }], TEN_MIB),
    );
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("fake.png");
    expect(error.message).toContain("JPEG、PNG、WebP");
  });

  it("超过上限被拒绝，提示里写出具体上限（AC-02-9）", () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(TEN_MIB)]);
    const error = catchAppError(() => prepareImages([{ fileName: "big.png", bytes: oversized }], TEN_MIB));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("10 MiB");
    expect(error.details).toMatchObject({ maxUploadBytes: TEN_MIB });
  });

  it("空文件被拒绝", () => {
    const error = catchAppError(() => prepareImages([{ fileName: "empty.png", bytes: Buffer.alloc(0) }], TEN_MIB));
    expect(error.message).toContain("空文件");
  });

  it("有一张不合格时整体拒绝，不返回部分结果", () => {
    const error = catchAppError(() =>
      prepareImages(
        [
          { fileName: "ok.png", bytes: PNG },
          { fileName: "bad.png", bytes: Buffer.from("nope") },
        ],
        TEN_MIB,
      ),
    );
    expect(error.message).toContain("bad.png");
  });

  it("恰好等于上限时通过", () => {
    const exact = Buffer.concat([PNG, Buffer.alloc(TEN_MIB - PNG.length)]);
    expect(prepareImages([{ fileName: "exact.png", bytes: exact }], TEN_MIB)).toHaveLength(1);
  });
});
