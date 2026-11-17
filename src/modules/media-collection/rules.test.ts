import { describe, expect, it } from "vitest";
import { isAppError } from "@/lib/errors";
import {
  assertCanRemoveImage,
  assertCollectionMutable,
  assertHasImage,
  COLLECTION_ERROR_MESSAGES,
  formatBytes,
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

describe("至少一张原始图片（MUST 1、AC-01-2）", () => {
  it("0 张图片时返回 VALIDATION_FAILED", () => {
    const error = catchAppError(() => assertHasImage(0));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toBe(COLLECTION_ERROR_MESSAGES.imageRequired);
  });

  it("至少 1 张时通过", () => {
    expect(() => assertHasImage(1)).not.toThrow();
    expect(() => assertHasImage(3)).not.toThrow();
  });
});

describe("解除关联后不能变成 0 张（AC-01-5）", () => {
  it("会剩下 0 张时拒绝，并指出去删资源夹", () => {
    const error = catchAppError(() => assertCanRemoveImage(0));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("1 张");
  });

  it("至少还剩 1 张时通过", () => {
    expect(() => assertCanRemoveImage(1)).not.toThrow();
  });
});

describe("运行中任务时禁止改图与删除（AC-02-10 判定点）", () => {
  it("有运行中任务时返回 CONFLICT 并带业务子码", () => {
    const error = catchAppError(() => assertCollectionMutable(1));
    expect(error.code).toBe("CONFLICT");
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({ code: "COLLECTION_BUSY", runningTasks: 1 });
    expect(error.message).toBe(COLLECTION_ERROR_MESSAGES.busy);
  });

  it("没有运行中任务时放行", () => {
    expect(() => assertCollectionMutable(0)).not.toThrow();
  });
});

describe("上限文案（AC-02-9）", () => {
  it("整 MiB 不带小数", () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MiB");
  });

  it("非整 MiB 保留一位小数", () => {
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MiB");
  });

  it("小于 1 MiB 时用 KiB", () => {
    expect(formatBytes(2048)).toBe("2 KiB");
  });
});
