import { describe, expect, it } from "vitest";
import type { ResultCellState } from "./results";
import {
  extractionOverview,
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
    currentItemKey: null,
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

/**
 * 页头「提取状态」（MKACG-1007 AC-UX-2）：只由本夹全部原图的完成情况推导，
 * 不从「最近一条运行」抄。数据出现 1/3、0/3 时不允许写「已提取」。
 */
describe("页头提取状态", () => {
  const cell = (state: ResultCellState) => ({
    category: "topdown",
    label: "桌面俯视图",
    state,
    asset: null,
    reason: null,
    retry: null,
  });
  const card = (...states: ResultCellState[]) => ({ cells: states.map(cell) });

  it("每格都有产物才算「已提取」，并给出完成格数", () => {
    const overview = extractionOverview([card("done", "done", "done"), card("done", "done", "done")]);
    expect(overview).toMatchObject({ state: "ready", label: "已提取", done: 6, total: 6 });
  });

  it("有产物但没齐（1/3、0/3 混在一起）时是「部分完成」，不是「已完成」", () => {
    const overview = extractionOverview([
      card("done", "idle", "idle"),
      card("done", "done", "done"),
      card("idle", "idle", "idle"),
    ]);
    expect(overview).toMatchObject({ state: "partial", label: "部分完成", done: 4, total: 9 });
  });

  it("有失败格时是「有失败项」，即使其余格子都已出图", () => {
    const overview = extractionOverview([card("done", "done", "failed")]);
    expect(overview).toMatchObject({ state: "failed", label: "有失败项", done: 2, total: 3 });
  });

  it("一个产物都没有时是「待提取」", () => {
    expect(extractionOverview([card("idle", "idle", "idle")])).toMatchObject({
      state: "idle",
      label: "待提取",
      done: 0,
      total: 3,
    });
  });

  it("处理中/等待中不算产物：仍是「待提取」", () => {
    expect(extractionOverview([card("pending", "waiting", "idle")])).toMatchObject({
      state: "idle",
      done: 0,
    });
  });

  it("每格都判定为不存在时沿用「未发现可提取内容」，不写「待提取」", () => {
    expect(extractionOverview([card("absent", "absent", "absent")])).toMatchObject({
      state: "absent",
      label: "未发现可提取内容",
    });
  });

  it("部分不存在、部分出图时仍算「部分完成」", () => {
    expect(extractionOverview([card("done", "done", "absent")])).toMatchObject({
      state: "partial",
      done: 2,
      total: 3,
    });
  });

  it("资源夹里没有原图时是「待提取」", () => {
    expect(extractionOverview([])).toMatchObject({ state: "idle", done: 0, total: 0 });
  });
});
