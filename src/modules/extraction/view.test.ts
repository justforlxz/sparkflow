import { describe, expect, it } from "vitest";
import type { ExtractionItemRecord, ExtractionRunRecord, LibraryAssetRecord } from "./types";
import { sourceAssetIndex, toExtractionRunView, toLibraryView } from "./view";

function asset(id: string, category: string, createdAt: string): LibraryAssetRecord {
  return {
    id,
    collectionId: "collection-1",
    extractionRunId: "run-1",
    sourceAssetId: "asset-1",
    category,
    storageKey: `library-assets/run-1/${id}.png`,
    fileName: `${id}.png`,
    mimeType: "image/png",
    width: 1536,
    height: 1024,
    sortOrder: 1,
    createdAt: new Date(createdAt),
  };
}

function skippedItem(id: string, category: string, reason: string): ExtractionItemRecord {
  return {
    id,
    extractionRunId: "run-1",
    sourceAssetId: "asset-1",
    category,
    status: "skipped",
    libraryAssetId: null,
    skipReason: reason,
    error: null,
    createdAt: new Date("2026-11-21T00:00:00Z"),
  };
}

describe("素材库分组视图（docs/prd/12 SHOULD：按类别分组）", () => {
  it("分组顺序取登记表顺序，空组不返回", () => {
    const view = toLibraryView(
      [
        asset("a", "other", "2026-11-21T03:00:00Z"),
        asset("b", "graphic", "2026-11-21T02:00:00Z"),
        asset("c", "topdown", "2026-11-21T01:00:00Z"),
      ],
      [],
      ["asset-1"],
    );

    expect(view.groups.map((group) => group.category)).toEqual(["topdown", "graphic", "other"]);
    expect(view.groups.map((group) => group.label)).toEqual([
      "桌面俯视图",
      "形象设计",
      "其他（历史）",
    ]);
    expect(view.total).toBe(3);
  });

  it("组内保持查询结果的顺序（生成时间倒序）", () => {
    const view = toLibraryView(
      [
        asset("new", "topdown", "2026-11-21T03:00:00Z"),
        asset("old", "topdown", "2026-11-21T01:00:00Z"),
      ],
      [],
      ["asset-1"],
    );
    expect(view.groups[0]?.items.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("每条素材都带来源原图序号、可渲染地址与实际尺寸（AC-LIB-13）", () => {
    const view = toLibraryView(
      [asset("a", "topdown", "2026-11-21T01:00:00Z")],
      [],
      ["asset-0", "asset-1"],
    );
    const item = view.groups[0]?.items[0];
    expect(item?.sourceAssetIndex).toBe(2);
    expect(item?.url).toBe("/api/files/library/a");
    expect(item?.thumbnailUrl).toBe("/api/files/library/a?w=400");
    // 界面按实际尺寸展示，不假设固定比例（MUST 2d）。
    expect(item?.width).toBe(1536);
    expect(item?.height).toBe(1024);
  });

  it("判定为不存在的条目挂在对应组里，带模型原话（AC-LIB-11）", () => {
    const view = toLibraryView(
      [asset("a", "topdown", "2026-11-21T01:00:00Z")],
      [skippedItem("skip-1", "graphic", "不存在：画面里没有印刷图案")],
      ["asset-1"],
    );

    const graphic = view.groups.find((group) => group.category === "graphic");
    expect(graphic?.items).toEqual([]);
    expect(graphic?.skipped).toHaveLength(1);
    expect(graphic?.skipped[0]).toMatchObject({
      categoryLabel: "形象设计",
      reason: "不存在：画面里没有印刷图案",
      sourceAssetIndex: 1,
    });
    // 跳过的条目不是素材：不计入 total。
    expect(view.total).toBe(1);
  });

  it("只有判定为不存在的组也要返回（AC-LIB-12：用户要看得到为什么没提取到）", () => {
    const view = toLibraryView(
      [],
      [skippedItem("skip-1", "texture", "不存在：画面里没有可平铺纹理")],
      ["asset-1"],
    );
    expect(view.total).toBe(0);
    expect(view.groups.map((group) => group.category)).toEqual(["texture"]);
  });
});

describe("来源原图序号", () => {
  it("原图已被移除时如实给 null，不猜编号", () => {
    expect(sourceAssetIndex("gone", ["asset-0"])).toBeNull();
    expect(sourceAssetIndex("asset-0", ["asset-0"])).toBe(1);
  });
});

describe("提取运行视图", () => {
  it("进度原样给出：total 是原图数 × 类别数（AC-LIB-1）", () => {
    const run: ExtractionRunRecord = {
      id: "run-1",
      collectionId: "collection-1",
      status: "running",
      requirement: "flatten",
      categories: ["topdown", "texture"],
      sourceAssetIds: ["asset-1", "asset-2"],
      progress: { done: 2, total: 4 },
      error: null,
      extraPrompt: null,
      createdAt: new Date("2026-11-21T00:00:00Z"),
      finishedAt: null,
    };

    const view = toExtractionRunView(run);
    expect(view.progress).toEqual({ done: 2, total: 4 });
    expect(view.categoryLabels).toEqual(["桌面俯视图", "基本纹理"]);
    expect(view.statusLabel).toBe("提取中");
    expect(view.requirementLabel).toBe("平整化");
  });

  it("`empty` 终态读作「未发现可提取内容」，不是失败（AC-LIB-12）", () => {
    const run: ExtractionRunRecord = {
      id: "run-1",
      collectionId: "collection-1",
      status: "empty",
      requirement: "faithful",
      categories: ["graphic"],
      sourceAssetIds: ["asset-1"],
      progress: null,
      error: null,
      extraPrompt: null,
      createdAt: new Date("2026-11-21T00:00:00Z"),
      finishedAt: new Date("2026-11-21T00:01:00Z"),
    };

    const view = toExtractionRunView(run);
    expect(view.statusLabel).toBe("未发现可提取内容");
    expect(view.error).toBeNull();
  });

  it("部分失败的逐项原因带中文类别名", () => {
    const run: ExtractionRunRecord = {
      id: "run-1",
      collectionId: "collection-1",
      status: "partial",
      requirement: "faithful",
      categories: ["topdown"],
      sourceAssetIds: ["asset-1"],
      progress: null,
      error: {
        code: "EXTRACTION_PARTIAL",
        message: "第 1 项失败",
        at: "2026-11-21T00:00:00Z",
        failures: [
          {
            category: "topdown",
            sourceAssetId: "asset-1",
            fileName: "a.png",
            code: "UPSTREAM_REJECTED",
            message: "上游拒绝",
          },
        ],
      },
      extraPrompt: null,
      createdAt: new Date("2026-11-21T00:00:00Z"),
      finishedAt: new Date("2026-11-21T00:01:00Z"),
    };

    const view = toExtractionRunView(run);
    expect(view.error?.failures[0]?.categoryLabel).toBe("桌面俯视图");
    expect(view.finishedAt).toBe("2026-11-21T00:01:00.000Z");
  });
});
