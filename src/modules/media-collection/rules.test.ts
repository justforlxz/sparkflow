import { describe, expect, it } from "vitest";
import { isAppError } from "@/lib/errors";
import { assertCollectionMutable, COLLECTION_ERROR_MESSAGES, formatBytes } from "./rules";

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
 * 资源夹允许没有图片（MUST 1、AC-01-2）：保存路径没有「至少 1 张」这条规则，
 * 建夹、整组保存、解除关联都不校验图片数量；「至少要有一张原图」只在发起提取时校验
 * （见 `src/modules/extraction/service.ts`）。这里只留运行中的提取与文案的用例。
 */

describe("有运行中的提取时禁止改图与删除（AC-02-10 判定点）", () => {
  it("有运行中的提取时返回 CONFLICT 并带业务子码", () => {
    const error = catchAppError(() => assertCollectionMutable(1));
    expect(error.code).toBe("CONFLICT");
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({ code: "COLLECTION_BUSY", runningExtractions: 1 });
    expect(error.message).toBe(COLLECTION_ERROR_MESSAGES.busy);
  });

  it("没有运行中的提取时放行", () => {
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
