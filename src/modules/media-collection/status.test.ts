import { describe, expect, it } from "vitest";
import { deriveCollectionStatus, isCollectionStatus, type CollectionCounts } from "./status";

const none: CollectionCounts = { runningTasks: 0, tasks: 0, results: 0, published: 0 };

describe("资源夹派生状态（docs/prd/01-media-collection.md「数据与接口」）", () => {
  it("没有任务也没有结果时为 draft", () => {
    expect(deriveCollectionStatus(none)).toBe("draft");
  });

  it("有运行中任务时为 generating", () => {
    expect(deriveCollectionStatus({ ...none, tasks: 1, runningTasks: 1 })).toBe("generating");
  });

  it("有结果未发布时为 has_results", () => {
    expect(deriveCollectionStatus({ ...none, tasks: 1, results: 1 })).toBe("has_results");
  });

  it("有发布记录时为 published", () => {
    expect(deriveCollectionStatus({ ...none, tasks: 2, results: 2, published: 1 })).toBe("published");
  });

  it("运行中任务优先于已发布：再创作一次时回到 generating", () => {
    expect(deriveCollectionStatus({ ...none, tasks: 3, runningTasks: 1, results: 2, published: 1 })).toBe(
      "generating",
    );
  });
});

describe("状态取值校验", () => {
  it("只接受四个派生状态", () => {
    expect(isCollectionStatus("draft")).toBe(true);
    expect(isCollectionStatus("published")).toBe(true);
    expect(isCollectionStatus("archived")).toBe(false);
  });
});
