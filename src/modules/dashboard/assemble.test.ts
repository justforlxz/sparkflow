import { describe, expect, it } from "vitest";
import {
  COLLECTION_STATUSES,
  type CollectionStatus,
} from "@/modules/media-collection/constants";
import { assembleStats, type DashboardStats } from "./assemble";
import { RECENT_COLLECTIONS_LIMIT } from "./constants";
import type { CollectionSummaryView } from "@/modules/media-collection/service";

/** 造一个字段够用、内容确定的资源夹卡片。 */
function collection(index: number): CollectionSummaryView {
  return {
    id: `collection-${index}`,
    name: `资源夹 ${index}`,
    platform: null,
    sourceUrl: null,
    sourceTitle: null,
    sourceBody: null,
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:00.000Z",
    status: "draft" as CollectionStatus,
    assetCount: 1,
    extractionRunCount: 0,
    libraryAssetCount: 0,
    coverUrl: null,
  };
}

function source(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    collections: 0,
    pendingGeneration: 0,
    recentCollections: [],
    ...overrides,
  };
}

describe("工作台统计组装（docs/prd/09 MUST 1）", () => {
  it("没有任何数据时两个数字都是 0，最近列表为空（AC-09-1）", () => {
    expect(assembleStats(source())).toEqual({
      collections: 0,
      pendingGeneration: 0,
      recentCollections: [],
    });
  });

  it("两个数字原样透传，不在界面层重新推算", () => {
    const stats = assembleStats(source({ collections: 7, pendingGeneration: 3 }));

    expect(stats.collections).toBe(7);
    expect(stats.pendingGeneration).toBe(3);
  });

  it(`最近资源夹最多 ${RECENT_COLLECTIONS_LIMIT} 条`, () => {
    const stats = assembleStats(
      source({ recentCollections: [1, 2, 3, 4, 5, 6, 7, 8].map(collection) }),
    );

    expect(stats.recentCollections).toHaveLength(RECENT_COLLECTIONS_LIMIT);
    expect(stats.recentCollections.map((item) => item.id)).toEqual([
      "collection-1",
      "collection-2",
      "collection-3",
      "collection-4",
      "collection-5",
      "collection-6",
    ]);
  });

  it("组装不修改来源数组（服务端数据保持原样）", () => {
    const recentCollections = [1, 2, 3, 4, 5, 6, 7].map(collection);
    assembleStats(source({ recentCollections }));

    expect(recentCollections).toHaveLength(7);
  });

  it("统计口径覆盖全部资源夹状态枚举", () => {
    // 两个数字分别对应资源夹状态的取值，新增状态时必须同时更新口径与文案。
    // 文案与发布下线后没有「已发布」（ADR 0012 第 3 条、MKACG-976）。
    expect([...COLLECTION_STATUSES]).toEqual(["draft", "generating", "has_results"]);
  });
});
