import { describe, expect, it } from "vitest";
import { buildResultCards, type ResultCardsInput } from "./results";
import type { ExtractionRunView, LibraryAssetView, LibraryView, SkippedItemView } from "./view";

/** 一张素材的最小视图：只需要结果卡片用到的字段，其余给固定值。 */
function asset(overrides: Partial<LibraryAssetView> & { sourceAssetId: string; category: string }): LibraryAssetView {
  return {
    id: `lib-${overrides.sourceAssetId}-${overrides.category}`,
    collectionId: "c1",
    extractionRunId: "run-1",
    categoryLabel: overrides.category,
    sourceAssetIndex: 1,
    fileName: `${overrides.category}.png`,
    mimeType: "image/png",
    width: 1536,
    height: 1024,
    url: "/api/files/library/x",
    thumbnailUrl: "/api/files/library/x?w=400",
    watermarkRemoved: true,
    watermarkNote: null,
    createdAt: "2026-11-24T10:00:00.000Z",
    ...overrides,
  };
}

function skipped(
  overrides: Partial<SkippedItemView> & { sourceAssetId: string; category: string },
): SkippedItemView {
  return {
    id: `skip-${overrides.sourceAssetId}-${overrides.category}`,
    categoryLabel: overrides.category,
    sourceAssetIndex: 1,
    reason: "不存在",
    createdAt: "2026-11-24T10:00:00.000Z",
    ...overrides,
  };
}

function library(items: LibraryAssetView[], skippedItems: SkippedItemView[] = []): LibraryView {
  const groups = new Map<string, { items: LibraryAssetView[]; skipped: SkippedItemView[] }>();
  for (const item of items) {
    const group = groups.get(item.category) ?? { items: [], skipped: [] };
    group.items.push(item);
    groups.set(item.category, group);
  }
  for (const item of skippedItems) {
    const group = groups.get(item.category) ?? { items: [], skipped: [] };
    group.skipped.push(item);
    groups.set(item.category, group);
  }
  return {
    groups: [...groups.entries()].map(([category, group]) => ({ category, label: category, ...group })),
    total: items.length,
  };
}

function run(overrides: Partial<ExtractionRunView> & { id: string }): ExtractionRunView {
  return {
    collectionId: "c1",
    status: "succeeded",
    statusLabel: "已完成",
    requirement: "faithful",
    requirementLabel: "忠实还原",
    categories: ["topdown", "texture", "graphic"],
    categoryLabels: ["桌面俯视图", "基本纹理", "形象设计"],
    sourceAssetIds: ["a1"],
    progress: null,
    error: null,
    extraPrompt: null,
    currentItemKey: null,
    createdAt: "2026-11-24T10:00:00.000Z",
    finishedAt: "2026-11-24T10:00:10.000Z",
    ...overrides,
  };
}

const SOURCES = [
  { id: "a1", fileName: "a1.png", thumbnailUrl: "/a1?w=400" },
  { id: "a2", fileName: "a2.png", thumbnailUrl: "/a2?w=400" },
];

function build(input: Partial<ResultCardsInput>): ReturnType<typeof buildResultCards> {
  return buildResultCards({
    sourceAssets: SOURCES,
    library: { groups: [], total: 0 },
    runs: [],
    ...input,
  });
}

describe("buildResultCards", () => {
  it("还没跑过时一张原图一张卡，三类产出都是 idle，完成数 0/3", () => {
    const cards = build({});

    expect(cards).toHaveLength(2);
    expect(cards[0]?.sourceAssetId).toBe("a1");
    expect(cards[0]?.cells.map((cell) => cell.category)).toEqual(["topdown", "texture", "graphic"]);
    expect(cards[0]?.cells.every((cell) => cell.state === "idle")).toBe(true);
    expect(cards[0]).toMatchObject({ done: 0, total: 3 });
    // 原图缩略图与文件名来自资源夹，不在结果卡里另存一份。
    expect(cards[0]).toMatchObject({ fileName: "a1.png", thumbnailUrl: "/a1?w=400" });
  });

  it("完成的格子带上产物地址，完成数按格计", () => {
    const cards = build({
      library: library([
        asset({ sourceAssetId: "a1", category: "topdown" }),
        asset({ sourceAssetId: "a1", category: "texture" }),
      ]),
    });

    expect(cards[0]?.done).toBe(2);
    expect(cards[0]?.cells[0]?.state).toBe("done");
    expect(cards[0]?.cells[0]?.asset).toMatchObject({ id: "lib-a1-topdown" });
    expect(cards[0]?.cells[0]?.reason).toBeNull();
    expect(cards[0]?.cells[2]?.state).toBe("idle");
  });

  it("判定为不存在的格子显示模型原话，不算完成", () => {
    const cards = build({
      library: library([], [skipped({ sourceAssetId: "a1", category: "graphic", reason: "没有图案" })]),
    });

    expect(cards[0]?.cells[2]).toMatchObject({
      state: "absent",
      reason: "没有图案",
      asset: null,
      retry: null,
    });
    expect(cards[0]?.done).toBe(0);
  });

  it("失败的格子带原因与单格重试参数（要求沿用那次运行）", () => {
    const cards = build({
      runs: [
        run({
          id: "run-1",
          requirement: "dereflect",
          error: {
            code: "EXTRACTION_PARTIAL",
            message: "已保留 2/3 条素材",
            at: "2026-11-24T10:00:10.000Z",
            failures: [
              {
                category: "texture",
                categoryLabel: "基本纹理",
                sourceAssetId: "a1",
                fileName: "a1.png",
                code: "UPSTREAM_FAILED",
                message: "上游拒绝了这张图",
              },
            ],
          },
        }),
      ],
    });

    expect(cards[0]?.cells[1]).toMatchObject({
      state: "failed",
      reason: "上游拒绝了这张图",
      retry: { sourceAssetId: "a1", category: "texture", requirement: "dereflect" },
    });
  });

  it("有未终态运行时，它覆盖的格子还没出结论；没有当前条目时都是 waiting", () => {
    const cards = build({
      library: library([asset({ sourceAssetId: "a1", category: "topdown" })]),
      runs: [
        run({
          id: "run-retry",
          status: "running",
          progress: { done: 0, total: 2 },
          sourceAssetIds: ["a1"],
          categories: ["texture", "graphic"],
          finishedAt: null,
        }),
        run({ id: "run-1" }),
      ],
    });

    expect(cards[0]?.cells.map((cell) => cell.state)).toEqual(["done", "waiting", "waiting"]);
    // 正在重试的格子不再显示上一次失败的原因。
    expect(cards[0]?.cells[1]?.retry).toBeNull();
    // 另一张原图不受这条运行影响。
    expect(cards[1]?.cells.every((cell) => cell.state === "idle")).toBe(true);
  });

  it("运行指出当前正在处理的那一格：只有那一格是 pending，同运行其余格子是 waiting（AC-PROG-1）", () => {
    const cards = build({
      runs: [
        run({
          id: "run-1",
          status: "running",
          progress: { done: 0, total: 3 },
          sourceAssetIds: ["a1"],
          categories: ["topdown", "texture", "graphic"],
          currentItemKey: "a1|topdown",
          finishedAt: null,
        }),
      ],
    });

    expect(cards[0]?.cells.map((cell) => cell.state)).toEqual(["pending", "waiting", "waiting"]);
    // 排队中的格子同样不带上一次尝试的产物与原因。
    expect(cards[0]?.cells[1]).toMatchObject({ asset: null, reason: null, retry: null });
  });

  it("当前条目随进度前移，「处理中」换到下一格（AC-PROG-2）", () => {
    const states = (currentItemKey: string, done: number) =>
      build({
        runs: [
          run({
            id: "run-1",
            status: "running",
            progress: { done, total: 3 },
            sourceAssetIds: ["a1"],
            categories: ["topdown", "texture", "graphic"],
            currentItemKey,
            finishedAt: null,
          }),
        ],
      })[0]?.cells.map((cell) => cell.state);

    expect(states("a1|topdown", 0)).toEqual(["pending", "waiting", "waiting"]);
    expect(states("a1|texture", 1)).toEqual(["waiting", "pending", "waiting"]);
    expect(states("a1|graphic", 2)).toEqual(["waiting", "waiting", "pending"]);
  });

  it("排队中（worker 还没认领）的运行没有当前条目，它覆盖的格子都还是 waiting", () => {
    const cards = build({
      runs: [
        run({
          id: "run-queued",
          status: "queued",
          progress: { done: 0, total: 2 },
          sourceAssetIds: ["a1"],
          categories: ["texture", "graphic"],
          currentItemKey: null,
          finishedAt: null,
        }),
      ],
    });

    expect(cards[0]?.cells.map((cell) => cell.state)).toEqual(["idle", "waiting", "waiting"]);
  });

  it("运行结束后不再有 pending / waiting（AC-PROG-5）", () => {
    const cards = build({
      library: library([
        asset({ sourceAssetId: "a1", category: "topdown" }),
        asset({ sourceAssetId: "a1", category: "texture" }),
        asset({ sourceAssetId: "a1", category: "graphic" }),
      ]),
      runs: [run({ id: "run-1", status: "succeeded" })],
    });

    expect(cards[0]?.cells.map((cell) => cell.state)).toEqual(["done", "done", "done"]);
  });

  it("同一个格子有多次尝试时取最近一次（重试成功覆盖上一次失败）", () => {
    const cards = build({
      library: library([
        asset({
          sourceAssetId: "a1",
          category: "texture",
          createdAt: "2026-11-24T11:00:00.000Z",
        }),
      ]),
      runs: [
        run({
          id: "run-old",
          finishedAt: "2026-11-24T10:00:10.000Z",
          error: {
            code: "EXTRACTION_PARTIAL",
            message: "已保留 0/1 条素材",
            at: "2026-11-24T10:00:10.000Z",
            failures: [
              {
                category: "texture",
                categoryLabel: "基本纹理",
                sourceAssetId: "a1",
                fileName: "a1.png",
                code: "UPSTREAM_FAILED",
                message: "上一次失败",
              },
            ],
          },
        }),
      ],
    });

    expect(cards[0]?.cells[1]?.state).toBe("done");
    expect(cards[0]?.cells[1]?.reason).toBeNull();
  });

  it("重跑一张原图时沿用最近一次包含它的运行的要求", () => {
    const cards = build({
      runs: [
        run({ id: "run-a2", requirement: "flatten", sourceAssetIds: ["a2"] }),
        run({ id: "run-a1", requirement: "dereflect", sourceAssetIds: ["a1"] }),
      ],
    });

    expect(cards[0]?.requirement).toBe("dereflect");
    expect(cards[1]?.requirement).toBe("flatten");
  });
});
