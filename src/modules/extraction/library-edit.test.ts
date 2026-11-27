import { describe, expect, it } from "vitest";
import { duplicateLibraryAssets, removeLibraryAssets } from "./library-edit";
import type { LibraryAssetView, LibraryView, SkippedItemView } from "./view";

/**
 * 素材删除与去重的纯逻辑（MKACG-1006）：界面只消费这里算出来的结果。
 *
 * 两条断言分别对应界面的两个操作：逐条/批量删除留下的视图，与「只保留最新」要删掉的那批 id。
 */
function asset(
  id: string,
  category: string,
  sourceAssetId: string,
  createdAt: string,
): LibraryAssetView {
  return {
    id,
    collectionId: "collection-1",
    extractionRunId: "run-1",
    category,
    categoryLabel: category,
    sourceAssetId,
    sourceAssetIndex: 1,
    fileName: `${id}.png`,
    mimeType: "image/png",
    width: 1536,
    height: 1024,
    url: `/api/files/library/${id}`,
    thumbnailUrl: `/api/files/library/${id}?w=400`,
    watermarkRemoved: true,
    source: "model",
    sourceLabel: "模型提取（可能重画）",
    watermarkNote: null,
    createdAt,
  };
}

function skipped(id: string, category: string): SkippedItemView {
  return {
    id,
    category,
    categoryLabel: category,
    sourceAssetId: "source-1",
    sourceAssetIndex: 1,
    reason: "模型原话",
    createdAt: "2026-11-26T01:00:00Z",
  };
}

function library(groups: LibraryView["groups"]): LibraryView {
  return { groups, total: groups.reduce((sum, group) => sum + group.items.length, 0) };
}

describe("removeLibraryAssets：删除后的素材库视图（AC-DEL2-1、AC-DEL2-2）", () => {
  it("去掉指定素材：条数重算，别的素材与别的组不受影响", () => {
    const before = library([
      {
        category: "topdown",
        label: "桌面俯视图",
        items: [
          asset("a1", "topdown", "source-1", "2026-11-26T03:00:00Z"),
          asset("a2", "topdown", "source-2", "2026-11-26T02:00:00Z"),
        ],
        skipped: [],
      },
      {
        category: "texture",
        label: "基本纹理",
        items: [asset("b1", "texture", "source-1", "2026-11-26T01:00:00Z")],
        skipped: [],
      },
    ]);
    expect(before.total).toBe(3);

    const after = removeLibraryAssets(before, new Set(["a1"]));

    expect(after.total).toBe(2);
    expect(after.groups.map((group) => group.category)).toEqual(["topdown", "texture"]);
    expect(after.groups[0].items.map((item) => item.id)).toEqual(["a2"]);
    expect(after.groups[1].items.map((item) => item.id)).toEqual(["b1"]);
  });

  it("删空一个组后该组消失，条数归零", () => {
    const before = library([
      {
        category: "topdown",
        label: "桌面俯视图",
        items: [asset("a1", "topdown", "source-1", "2026-11-26T03:00:00Z")],
        skipped: [],
      },
    ]);

    const after = removeLibraryAssets(before, new Set(["a1"]));

    expect(after.groups).toHaveLength(0);
    expect(after.total).toBe(0);
  });

  it("只剩「判定为不存在」的组保留：用户仍要能看到为什么这次什么都没提取到", () => {
    const before = library([
      {
        category: "topdown",
        label: "桌面俯视图",
        items: [asset("a1", "topdown", "source-1", "2026-11-26T03:00:00Z")],
        skipped: [skipped("s1", "topdown")],
      },
    ]);

    const after = removeLibraryAssets(before, new Set(["a1"]));

    expect(after.groups).toHaveLength(1);
    expect(after.groups[0].items).toHaveLength(0);
    expect(after.groups[0].skipped.map((item) => item.id)).toEqual(["s1"]);
    expect(after.total).toBe(0);
  });

  it("没有指定任何素材时原样返回", () => {
    const before = library([
      {
        category: "topdown",
        label: "桌面俯视图",
        items: [asset("a1", "topdown", "source-1", "2026-11-26T03:00:00Z")],
        skipped: [],
      },
    ]);

    expect(removeLibraryAssets(before, new Set())).toBe(before);
  });
});

describe("duplicateLibraryAssets：只保留最新（范围 4）", () => {
  it("同一张原图同一类别有两次运行产物时，留下的那批是较旧的一条", () => {
    const before = library([
      {
        category: "topdown",
        label: "桌面俯视图",
        items: [
          asset("new", "topdown", "source-1", "2026-11-26T05:00:00Z"),
          asset("old", "topdown", "source-1", "2026-11-26T04:00:00Z"),
        ],
        skipped: [],
      },
    ]);

    const stale = duplicateLibraryAssets(before);

    expect(stale.map((item) => item.id)).toEqual(["old"]);
  });

  it("不同原图、不同类别彼此不算重复", () => {
    const before = library([
      {
        category: "topdown",
        label: "桌面俯视图",
        items: [
          asset("a1", "topdown", "source-1", "2026-11-26T05:00:00Z"),
          asset("a2", "topdown", "source-2", "2026-11-26T04:00:00Z"),
        ],
        skipped: [],
      },
      {
        category: "texture",
        label: "基本纹理",
        items: [asset("b1", "texture", "source-1", "2026-11-26T03:00:00Z")],
        skipped: [],
      },
    ]);

    expect(duplicateLibraryAssets(before)).toEqual([]);
  });

  it("顺序颠倒时仍按生成时间留最新的一条", () => {
    const before = library([
      {
        category: "topdown",
        label: "桌面俯视图",
        items: [
          asset("old", "topdown", "source-1", "2026-11-26T04:00:00Z"),
          asset("new", "topdown", "source-1", "2026-11-26T05:00:00Z"),
        ],
        skipped: [],
      },
    ]);

    expect(duplicateLibraryAssets(before).map((item) => item.id)).toEqual(["old"]);
  });
});
