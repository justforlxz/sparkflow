import { describe, expect, it } from "vitest";
import type { ExtractionRunRecord, LibraryAssetRecord } from "./types";
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
    width: 1024,
    height: 1536,
    sortOrder: 1,
    createdAt: new Date(createdAt),
  };
}

describe("素材库分组视图（docs/prd/12 SHOULD：按类别分组）", () => {
  it("分组顺序取登记表顺序，空组不返回", () => {
    const view = toLibraryView(
      [
        asset("a", "other", "2026-11-21T03:00:00Z"),
        asset("b", "border", "2026-11-21T02:00:00Z"),
        asset("c", "material", "2026-11-21T01:00:00Z"),
      ],
      ["asset-1"],
    );

    expect(view.groups.map((group) => group.category)).toEqual(["material", "border", "other"]);
    expect(view.groups.map((group) => group.label)).toEqual(["材质纹理", "边框样式", "其他（历史）"]);
    expect(view.total).toBe(3);
  });

  it("组内保持查询结果的顺序（生成时间倒序）", () => {
    const view = toLibraryView(
      [
        asset("new", "material", "2026-11-21T03:00:00Z"),
        asset("old", "material", "2026-11-21T01:00:00Z"),
      ],
      ["asset-1"],
    );
    expect(view.groups[0]?.items.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("每条素材都带来源原图序号与可渲染地址", () => {
    const view = toLibraryView([asset("a", "material", "2026-11-21T01:00:00Z")], ["asset-0", "asset-1"]);
    const item = view.groups[0]?.items[0];
    expect(item?.sourceAssetIndex).toBe(2);
    expect(item?.url).toBe("/api/files/library/a");
    expect(item?.thumbnailUrl).toBe("/api/files/library/a?w=400");
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
      categories: ["material", "border"],
      sourceAssetIds: ["asset-1", "asset-2"],
      progress: { done: 2, total: 4 },
      error: null,
      extraPrompt: null,
      createdAt: new Date("2026-11-21T00:00:00Z"),
      finishedAt: null,
    };

    const view = toExtractionRunView(run);
    expect(view.progress).toEqual({ done: 2, total: 4 });
    expect(view.categoryLabels).toEqual(["材质纹理", "边框样式"]);
    expect(view.statusLabel).toBe("提取中");
    expect(view.requirementLabel).toBe("平整化");
  });

  it("部分失败的逐项原因带中文类别名", () => {
    const run: ExtractionRunRecord = {
      id: "run-1",
      collectionId: "collection-1",
      status: "partial",
      requirement: "faithful",
      categories: ["material"],
      sourceAssetIds: ["asset-1"],
      progress: null,
      error: {
        code: "EXTRACTION_PARTIAL",
        message: "第 1 项失败",
        at: "2026-11-21T00:00:00Z",
        failures: [
          {
            category: "material",
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
    expect(view.error?.failures[0]?.categoryLabel).toBe("材质纹理");
    expect(view.finishedAt).toBe("2026-11-21T00:01:00.000Z");
  });
});
