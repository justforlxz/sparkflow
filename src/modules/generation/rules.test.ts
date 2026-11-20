import { describe, expect, it } from "vitest";
import { isAppError } from "@/lib/errors";
import { assertCollectionHasImages } from "./rules";

function catchAppError(run: () => void) {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("预期抛出 AppError，但没有抛出");
}

/**
 * 「至少要有一张原图」只在发起创作时校验（docs/prd/01-media-collection.md MUST 1、
 * docs/prd/04-generation-task.md）。资源夹本身允许 0 张图片，所以这个判据属于任务创建路径。
 */
describe("发起创作要求资源夹有原始图片（AC-01-8）", () => {
  it("0 张图片时返回 VALIDATION_FAILED，说明不能创建任务", () => {
    const error = catchAppError(() => assertCollectionHasImages(0));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.status).toBe(400);
    expect(error.message).toContain("没有原始图片");
  });

  it("至少 1 张图片时放行", () => {
    expect(() => assertCollectionHasImages(1)).not.toThrow();
    expect(() => assertCollectionHasImages(3)).not.toThrow();
  });
});
