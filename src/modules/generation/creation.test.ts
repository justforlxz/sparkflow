import { describe, expect, it } from "vitest";
import {
  CREATION_EXPANDED_STORAGE_KEY,
  failedStages,
  groupCreationTasks,
  originalAssetLabel,
  parseExpandedIds,
  readExpandedIds,
  serializeExpandedIds,
  toggleExpandedId,
  writeExpandedIds,
} from "./creation";
import type { StageView, TaskSummaryView } from "./view";

/**
 * 资源夹详情「创作」区的纯逻辑（MKACG-916，docs/prd/07「资源夹详情的「创作」区」）。
 * 用例只锁规则：任务怎么分组、哪条任务能重试、成品图标成哪张原图、折叠状态怎么存。
 */

function stageView(overrides: Partial<StageView> & Pick<StageView, "stage">): StageView {
  return {
    label: overrides.stage === "image" ? "生图阶段" : "文案阶段",
    status: "succeeded",
    statusLabel: "已完成",
    attempts: 1,
    error: null,
    startedAt: null,
    finishedAt: null,
    progress: null,
    ...overrides,
  };
}

function taskView(
  overrides: Partial<TaskSummaryView> & Pick<TaskSummaryView, "id" | "status">,
): TaskSummaryView {
  return {
    collectionId: "collection-1",
    collectionName: "资源夹一",
    statusLabel: "已完成",
    extractRequirement: "faithful",
    extractRequirementLabel: "忠实还原",
    extractTarget: "桌垫的织物纹理",
    copyStyle: "story",
    copyStyleLabel: "故事",
    expectedImageCount: 2,
    extraPrompt: null,
    createdAt: "2026-11-20T00:00:00.000Z",
    stages: {
      image: stageView({ stage: "image" }),
      copy: stageView({ stage: "copy" }),
    },
    retryHint: null,
    ...overrides,
  };
}

describe("创作区的任务分组", () => {
  it("执行中的进 running，失败与部分完成进 troubled，成功的不单独占一块", () => {
    const running = taskView({ id: "t-running", status: "running" });
    const failed = taskView({ id: "t-failed", status: "failed" });
    const partial = taskView({ id: "t-partial", status: "partial" });
    const succeeded = taskView({ id: "t-succeeded", status: "succeeded" });

    const groups = groupCreationTasks([running, failed, partial, succeeded]);

    expect(groups.running.map((task) => task.id)).toEqual(["t-running"]);
    expect(groups.troubled.map((task) => task.id)).toEqual(["t-failed", "t-partial"]);
  });

  it("没有任务时两组都是空数组", () => {
    expect(groupCreationTasks([])).toEqual({ running: [], troubled: [] });
  });
});

describe("创作区的重试入口", () => {
  it("只有失败的阶段算失败：文案失败只给文案阶段", () => {
    const task = taskView({
      id: "t1",
      status: "partial",
      stages: {
        image: stageView({ stage: "image" }),
        copy: stageView({ stage: "copy", status: "failed", statusLabel: "失败" }),
      },
    });

    expect(failedStages(task)).toEqual([{ name: "copy", label: "文案阶段" }]);
  });

  it("部分原图失败（阶段本身成功）没有可重试的阶段", () => {
    const task = taskView({
      id: "t2",
      status: "partial",
      stages: {
        image: stageView({
          stage: "image",
          error: { code: "IMAGE_REJECTED", message: "第 2 张原图被上游拒绝", at: "2026-11-20T00:00:00.000Z" },
        }),
        copy: stageView({ stage: "copy" }),
      },
    });

    expect(failedStages(task)).toEqual([]);
  });

  it("两个阶段都失败时按执行顺序给出两条", () => {
    const task = taskView({
      id: "t3",
      status: "failed",
      stages: {
        image: stageView({ stage: "image", status: "failed", statusLabel: "失败" }),
        copy: stageView({ stage: "copy", status: "failed", statusLabel: "失败" }),
      },
    });

    expect(failedStages(task).map((stage) => stage.name)).toEqual(["image", "copy"]);
  });
});

describe("成品图与原图的对照标签", () => {
  const sourceAssetIds = ["asset-a", "asset-b", "asset-c"];

  it("按资源夹里原图的顺序编号", () => {
    expect(originalAssetLabel("asset-a", sourceAssetIds)).toBe("原图 1");
    expect(originalAssetLabel("asset-c", sourceAssetIds)).toBe("原图 3");
  });

  it("原图被解除关联或已从资源夹移除时如实说明，不猜编号", () => {
    expect(originalAssetLabel(null, sourceAssetIds)).toBe("原图已解除关联");
    expect(originalAssetLabel("asset-gone", sourceAssetIds)).toBe("原图已解除关联");
  });
});

describe("折叠状态存本地", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      values,
    };
  }

  it("没有本地值、不是数组、JSON 坏掉、混入非字符串时都按全部折叠处理", () => {
    expect(parseExpandedIds(null)).toEqual([]);
    expect(parseExpandedIds("")).toEqual([]);
    expect(parseExpandedIds("{}")).toEqual([]);
    expect(parseExpandedIds("not-json")).toEqual([]);
    expect(parseExpandedIds('[1, "result-1", null, ""]')).toEqual(["result-1"]);
  });

  it("展开与收起只切换目标结果，其余保持原顺序", () => {
    expect(toggleExpandedId([], "r1")).toEqual(["r1"]);
    expect(toggleExpandedId(["r1"], "r2")).toEqual(["r1", "r2"]);
    expect(toggleExpandedId(["r1", "r2"], "r1")).toEqual(["r2"]);
  });

  it("写入后能原样读回，且只用一个本地键", () => {
    const storage = fakeStorage();
    writeExpandedIds(storage, ["r2", "r1"]);

    expect(parseExpandedIds(storage.values.get(CREATION_EXPANDED_STORAGE_KEY) ?? null)).toEqual([
      "r2",
      "r1",
    ]);
    expect(readExpandedIds(storage)).toEqual(["r2", "r1"]);
    expect([...storage.values.keys()]).toEqual([CREATION_EXPANDED_STORAGE_KEY]);
  });

  it("本地存储不可用时读成全部折叠、写入不抛错", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("本地存储被禁用");
      },
      setItem: (): void => {
        throw new Error("本地存储被禁用");
      },
    };

    expect(readExpandedIds(broken)).toEqual([]);
    expect(() => writeExpandedIds(broken, ["r1"])).not.toThrow();
  });

  it("序列化结果能被解析回同一个数组", () => {
    const ids = ["r1", "r2"];
    expect(parseExpandedIds(serializeExpandedIds(ids))).toEqual(ids);
  });
});
