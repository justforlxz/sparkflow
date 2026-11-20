import { describe, expect, it } from "vitest";
import { isAppError } from "@/lib/errors";
import {
  assertCollectionHasImages,
  assertValidExtractRequirement,
  requireCollectionExtractTarget,
} from "./rules";

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

/**
 * 提取目标在发起创作时必须非空（ADR 0009、AC-01-9）。三种空形态都要拦：
 * 数据库里的 null、空字符串、纯空白。资源夹可以空着保存，只是不能拿它发起创作。
 */
describe("发起创作要求资源夹有提取目标（AC-01-9、AC-EX-1）", () => {
  it("null / 空串 / 纯空白都返回 VALIDATION_FAILED，说明缺的是提取目标", () => {
    for (const value of [null, "", "   "]) {
      const error = catchAppError(() => requireCollectionExtractTarget(value));
      expect(error.code, JSON.stringify(value)).toBe("VALIDATION_FAILED");
      expect(error.status, JSON.stringify(value)).toBe(400);
      expect(error.message, JSON.stringify(value)).toContain("提取目标");
    }
  });

  it("有值时放行，返回去掉首尾空白后的原文（供任务快照固化）", () => {
    expect(requireCollectionExtractTarget("  桌垫的织物纹理 ")).toBe("桌垫的织物纹理");
  });
});

/** 提取要求只剩三项（AC-EX-3），旧的三项视觉方向被拒绝。 */
describe("提取要求的取值必须在登记表里（AC-EX-3）", () => {
  it("三项新取值放行", () => {
    for (const value of ["faithful", "flatten", "dereflect"]) {
      expect(() => assertValidExtractRequirement(value), value).not.toThrow();
    }
  });

  it("旧的视觉方向三项被拒绝，错误里点名可选项", () => {
    for (const legacy of ["fresh", "editorial", "product"]) {
      const error = catchAppError(() => assertValidExtractRequirement(legacy));
      expect(error.code, legacy).toBe("VALIDATION_FAILED");
      expect(error.message, legacy).toContain("提取要求");
      expect(error.message, legacy).toContain("忠实还原");
      expect(error.message, legacy).toContain("平整化");
      expect(error.message, legacy).toContain("去反光");
    }
  });

  it("空串与陌生取值同样被拒绝", () => {
    expect(() => assertValidExtractRequirement("")).toThrow();
    expect(() => assertValidExtractRequirement("sunset")).toThrow();
  });
});
