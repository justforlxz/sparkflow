import { describe, expect, it } from "vitest";
import {
  COLLECTION_STATUSES,
  type CollectionStatus,
} from "@/modules/media-collection/constants";
import { assembleStats, type DashboardStats } from "./assemble";
import { RECENT_COLLECTIONS_LIMIT, RECENT_RESULTS_LIMIT } from "./constants";
import type { RecentVersionView } from "@/modules/copy-generation/recent";
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
    copyVersionCount: 0,
    coverUrl: null,
  };
}

function result(index: number): RecentVersionView {
  return {
    id: `result-${index}`,
    collectionId: `collection-${index}`,
    collectionName: `资源夹 ${index}`,
    versionNo: index,
    versionLabel: `v${index}`,
    title: `标题 ${index}`,
    thumbnailUrl: null,
    createdAt: "2026-11-18T00:00:00.000Z",
  };
}

function source(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    collections: 0,
    pendingGeneration: 0,
    pendingPublish: 0,
    published: 0,
    recentCollections: [],
    recentResults: [],
    ...overrides,
  };
}

describe("工作台统计组装（docs/prd/09 MUST 1）", () => {
  it("没有任何数据时四个数字都是 0，两份列表为空（AC-09-1）", () => {
    expect(assembleStats(source())).toEqual({
      collections: 0,
      pendingGeneration: 0,
      pendingPublish: 0,
      published: 0,
      recentCollections: [],
      recentResults: [],
    });
  });

  it("四个数字原样透传，不在界面层重新推算", () => {
    const stats = assembleStats(
      source({ collections: 7, pendingGeneration: 3, pendingPublish: 2, published: 1 }),
    );

    expect(stats.collections).toBe(7);
    expect(stats.pendingGeneration).toBe(3);
    expect(stats.pendingPublish).toBe(2);
    expect(stats.published).toBe(1);
  });

  it(`最近资源夹最多 ${RECENT_COLLECTIONS_LIMIT} 条、最近内容最多 ${RECENT_RESULTS_LIMIT} 条`, () => {
    const stats = assembleStats(
      source({
        recentCollections: [1, 2, 3, 4, 5, 6, 7, 8].map(collection),
        recentResults: [1, 2, 3, 4, 5].map(result),
      }),
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
    expect(stats.recentResults).toHaveLength(RECENT_RESULTS_LIMIT);
    expect(stats.recentResults.map((item) => item.id)).toEqual([
      "result-1",
      "result-2",
      "result-3",
      "result-4",
    ]);
  });

  it("组装不修改来源数组（服务端数据保持原样）", () => {
    const recentCollections = [1, 2, 3, 4, 5, 6, 7].map(collection);
    assembleStats(source({ recentCollections }));

    expect(recentCollections).toHaveLength(7);
  });

  it("统计口径覆盖全部资源夹状态枚举", () => {
    // 四个数字分别对应资源夹状态的四种取值，新增状态时必须同时更新口径与文案。
    expect([...COLLECTION_STATUSES]).toEqual(["draft", "generating", "has_results", "published"]);
  });
});
