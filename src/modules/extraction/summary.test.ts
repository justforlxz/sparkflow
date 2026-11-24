import { describe, expect, it } from "vitest";
import {
  isActiveRun,
  progressPercent,
  runFailureCount,
  runFailureText,
} from "./summary";
import type { ExtractionRunView } from "./view";

/** 只填本文件关心的字段：界面派生读法只看状态、进度与失败清单。 */
function run(overrides: Partial<ExtractionRunView> = {}): ExtractionRunView {
  return {
    id: "run-1",
    collectionId: "collection-1",
    status: "succeeded",
    statusLabel: "已完成",
    requirement: "faithful",
    requirementLabel: "忠实还原",
    categories: ["topdown"],
    categoryLabels: ["桌面俯视图"],
    sourceAssetIds: ["asset-1"],
    progress: null,
    error: null,
    extraPrompt: null,
    createdAt: "2026-11-21T01:00:00.000Z",
    finishedAt: "2026-11-21T01:01:00.000Z",
    ...overrides,
  };
}

function failure(category: string, fileName: string) {
  return {
    category,
    categoryLabel: category,
    sourceAssetId: "asset-1",
    fileName,
    code: "EXTRACTION_FAILED",
    message: "上游返回 500",
  };
}

describe("运行是否还需要轮询", () => {
  it("queued / running 算进行中", () => {
    expect(isActiveRun(run({ status: "queued" }))).toBe(true);
    expect(isActiveRun(run({ status: "running" }))).toBe(true);
  });

  it("终态（含 partial）不再轮询", () => {
    for (const status of ["succeeded", "partial", "failed"] as const) {
      expect(isActiveRun(run({ status }))).toBe(false);
    }
  });
});

describe("失败项数量", () => {
  it("没有 error 或没有逐项失败时为 0，不显示失败项文案", () => {
    expect(runFailureCount(run())).toBe(0);
    expect(runFailureText(run())).toBeNull();
    expect(
      runFailureText(
        run({ error: { code: "EXTRACTION_FAILED", message: "全部失败", at: "", failures: [] } }),
      ),
    ).toBeNull();
  });

  it("部分失败时逐项计数", () => {
    const partial = run({
      status: "partial",
      error: {
        code: "EXTRACTION_PARTIAL",
        message: "已保留 3/4 条素材",
        at: "2026-11-21T01:01:00.000Z",
        failures: [failure("texture", "a.png")],
      },
    });
    expect(runFailureCount(partial)).toBe(1);
    expect(runFailureText(partial)).toBe("失败项 1 条");
  });
});

describe("进度百分比", () => {
  it("按 done / total 四舍五入", () => {
    expect(progressPercent({ done: 0, total: 4 })).toBe(0);
    expect(progressPercent({ done: 1, total: 4 })).toBe(25);
    expect(progressPercent({ done: 1, total: 3 })).toBe(33);
    expect(progressPercent({ done: 2, total: 3 })).toBe(67);
    expect(progressPercent({ done: 4, total: 4 })).toBe(100);
  });

  it("没有进度或总数为 0 时给 0，不出现 NaN 或负数", () => {
    expect(progressPercent(null)).toBe(0);
    expect(progressPercent({ done: 0, total: 0 })).toBe(0);
  });

  it("夹在 0~100，进度异常时不画出界", () => {
    expect(progressPercent({ done: 9, total: 4 })).toBe(100);
    expect(progressPercent({ done: -1, total: 4 })).toBe(0);
  });
});
