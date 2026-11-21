import { describe, expect, it } from "vitest";
import { deriveCollectionStatus, isCollectionStatus, type CollectionCounts } from "./status";

const none: CollectionCounts = {
  runningExtractions: 0,
  extractionRuns: 0,
  libraryAssets: 0,
  copyVersions: 0,
  published: 0,
};

describe("资源夹派生状态（docs/prd/01-media-collection.md「数据与接口」）", () => {
  it("没有提取也没有素材时为 draft", () => {
    expect(deriveCollectionStatus(none)).toBe("draft");
  });

  it("有排队或执行中的提取时为 generating", () => {
    expect(deriveCollectionStatus({ ...none, extractionRuns: 1, runningExtractions: 1 })).toBe(
      "generating",
    );
  });

  it("有素材未发布时为 has_results", () => {
    expect(deriveCollectionStatus({ ...none, extractionRuns: 1, libraryAssets: 1 })).toBe(
      "has_results",
    );
  });

  it("只有文案版本也算 has_results", () => {
    expect(deriveCollectionStatus({ ...none, copyVersions: 1 })).toBe("has_results");
  });

  it("有发布记录时为 published", () => {
    expect(
      deriveCollectionStatus({ ...none, libraryAssets: 2, copyVersions: 2, published: 1 }),
    ).toBe("published");
  });

  it("运行中提取优先于已发布：再提取一次时回到 generating", () => {
    expect(
      deriveCollectionStatus({
        ...none,
        extractionRuns: 3,
        runningExtractions: 1,
        libraryAssets: 2,
        copyVersions: 2,
        published: 1,
      }),
    ).toBe("generating");
  });
});

describe("状态取值校验", () => {
  it("只接受四个派生状态", () => {
    expect(isCollectionStatus("draft")).toBe(true);
    expect(isCollectionStatus("published")).toBe(true);
    expect(isCollectionStatus("archived")).toBe(false);
  });
});
