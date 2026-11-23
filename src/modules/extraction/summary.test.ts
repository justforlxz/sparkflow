import { describe, expect, it } from "vitest";
import { isActiveRun, runFailureCount, runFailureText, runProgressText, splitRuns } from "./summary";
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

describe("运行分组", () => {
  it("进行中与已结束各自保持传入顺序", () => {
    const split = splitRuns([
      run({ id: "a", status: "succeeded" }),
      run({ id: "b", status: "running" }),
      run({ id: "c", status: "failed" }),
      run({ id: "d", status: "queued" }),
    ]);

    expect(split.active.map((entry) => entry.id)).toEqual(["b", "d"]);
    expect(split.finished.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("没有运行时不返回空组", () => {
    expect(splitRuns([])).toEqual({ active: [], finished: [] });
  });
});

describe("进度文案", () => {
  it("进行中运行读成「正在提取 完成/总数」", () => {
    expect(runProgressText(run({ status: "running", progress: { done: 2, total: 4 } }))).toBe(
      "正在提取 2/4",
    );
  });

  it("刚排队的运行也有进度读数", () => {
    expect(runProgressText(run({ status: "queued", progress: { done: 0, total: 4 } }))).toBe(
      "正在提取 0/4",
    );
  });

  it("终态没有进度读数", () => {
    expect(runProgressText(run({ status: "partial", progress: null }))).toBeNull();
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
