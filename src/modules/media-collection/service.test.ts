process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
process.env.AUTH_SECRET ||= "unit-test-secret-with-enough-characters-0123";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAppError } from "@/lib/errors";
import type { CollectionRow, CollectionAssetRow } from "./repo";

/**
 * 整组保存（`saveCollectionEdit`）的单测：磁盘与数据库都替换成 mock，
 * 用来断言「校验不通过时什么都不写」「事务失败时补偿删除本次新写的文件」这类
 * 真实数据库跑不出来的分支（AC-FIX-2、AC-FIX-4）。
 */

vi.mock("./repo", () => ({
  collectionExists: vi.fn(),
  findCollection: vi.fn(),
  listAssetsByCollection: vi.fn(),
  createCollection: vi.fn(),
  saveCollectionEdit: vi.fn(),
}));

vi.mock("./files", () => ({
  readAssetFile: vi.fn(),
  removeAssetFile: vi.fn(),
  writeAssetBytes: vi.fn(),
}));

vi.mock("./thumbnails", () => ({ scaleImage: vi.fn() }));
vi.mock("@/modules/extraction/service", () => ({ countCollectionUsage: vi.fn() }));
vi.mock("@/modules/copy-generation/service", () => ({ countCollectionVersions: vi.fn() }));
vi.mock("@/modules/publish/counts", () => ({ countCollectionPublishRecords: vi.fn() }));

const repo = await import("./repo");
const files = await import("./files");
const counts = await import("@/modules/extraction/service");
const copyCounts = await import("@/modules/copy-generation/service");
const publishCounts = await import("@/modules/publish/counts");
const service = await import("./service");

const COLLECTION_ID = "11111111-1111-4111-8111-111111111111";

/** 1×1 的 PNG：类型判定只看魔数。 */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const FIELDS = {
  name: "秋季穿搭",
  platform: null,
  sourceUrl: null,
  sourceTitle: null,
  sourceBody: null,
};

function assetRow(id: string, sortOrder: number): CollectionAssetRow {
  return {
    id,
    storageKey: `media-assets/${id}.png`,
    fileName: `${id}.png`,
    mimeType: "image/png",
    size: PNG_BYTES.length,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    sortOrder,
  };
}

const ASSET_A = assetRow("asset-a", 0);
const ASSET_B = assetRow("asset-b", 1);

function collectionRow(assets: CollectionAssetRow[]): CollectionRow {
  return {
    id: COLLECTION_ID,
    name: "秋季穿搭",
    platform: null,
    sourceUrl: null,
    sourceTitle: null,
    sourceBody: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    assetCount: assets.length,
    coverAssetId: assets[0]?.id ?? null,
  };
}

function catchAppError(run: () => Promise<unknown>) {
  return run().then(
    () => {
      throw new Error("预期抛出 AppError，但没有抛出");
    },
    (error: unknown) => {
      if (isAppError(error)) return error;
      throw error;
    },
  );
}

function pngFile(name = "c.png") {
  return { fileName: name, bytes: PNG_BYTES };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(repo.collectionExists).mockResolvedValue(true);
  vi.mocked(repo.listAssetsByCollection).mockResolvedValue([ASSET_A, ASSET_B]);
  vi.mocked(repo.findCollection).mockResolvedValue(collectionRow([ASSET_A, ASSET_B]));
  vi.mocked(counts.countCollectionUsage).mockResolvedValue({ runs: 0, activeRuns: 0, libraryAssets: 0 });
  vi.mocked(copyCounts.countCollectionVersions).mockResolvedValue(0);
  vi.mocked(publishCounts.countCollectionPublishRecords).mockResolvedValue(0);
  vi.mocked(files.writeAssetBytes).mockResolvedValue(undefined);
  vi.mocked(files.removeAssetFile).mockResolvedValue(undefined);
  vi.mocked(repo.saveCollectionEdit).mockResolvedValue(undefined);
});

describe("整组换图成功（AC-FIX-1）", () => {
  it("两张原图全换新图时，删两条旧记录、插一条新记录，顺序按下标写入", async () => {
    const result = await service.saveCollectionEdit(COLLECTION_ID, {
      fields: FIELDS,
      assets: [
        { kind: "remove", assetId: ASSET_A.id },
        { kind: "remove", assetId: ASSET_B.id },
        { kind: "add", tempKey: "pending-1" },
      ],
      files: new Map([["pending-1", pngFile()]]),
    });

    expect(result.id).toBe(COLLECTION_ID);
    expect(vi.mocked(files.writeAssetBytes)).toHaveBeenCalledTimes(1);

    const [collectionId, fields, plan] = vi.mocked(repo.saveCollectionEdit).mock.calls[0];
    expect(collectionId).toBe(COLLECTION_ID);
    expect(fields).toEqual(FIELDS);
    expect(plan.remove).toEqual([ASSET_A.id, ASSET_B.id]);
    expect(plan.keep).toEqual([]);
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0]).toMatchObject({ fileName: "c.png", mimeType: "image/png", sortOrder: 2 });
    expect(plan.adds[0].storageKey).toMatch(/^media-assets\/[0-9a-f-]{36}\.png$/);
  });

  it("保留 + 新增混合时，sort_order 取清单下标，不按写入先后（AC-FIX-8）", async () => {
    await service.saveCollectionEdit(COLLECTION_ID, {
      fields: FIELDS,
      assets: [
        { kind: "remove", assetId: ASSET_A.id },
        { kind: "keep", assetId: ASSET_B.id },
        { kind: "add", tempKey: "pending-1" },
        { kind: "add", tempKey: "pending-2" },
      ],
      files: new Map([
        ["pending-1", pngFile("c.png")],
        ["pending-2", pngFile("d.png")],
      ]),
    });

    const [, , plan] = vi.mocked(repo.saveCollectionEdit).mock.calls[0];
    expect(plan.remove).toEqual([ASSET_A.id]);
    expect(plan.keep).toEqual([{ assetId: ASSET_B.id, sortOrder: 1 }]);
    expect(plan.adds.map((asset) => asset.sortOrder)).toEqual([2, 3]);
    expect(plan.adds.map((asset) => asset.fileName)).toEqual(["c.png", "d.png"]);
  });
});

describe("事务失败时补偿删除新写文件（AC-FIX-4）", () => {
  it("写库抛错时删掉本次写入的每个文件，并返回 500 与统一文案", async () => {
    vi.mocked(repo.saveCollectionEdit).mockRejectedValue(new Error("数据库写入失败"));

    const error = await catchAppError(() =>
      service.saveCollectionEdit(COLLECTION_ID, {
        fields: FIELDS,
        assets: [
          { kind: "keep", assetId: ASSET_A.id },
          { kind: "keep", assetId: ASSET_B.id },
          { kind: "add", tempKey: "pending-1" },
          { kind: "add", tempKey: "pending-2" },
        ],
        files: new Map([
          ["pending-1", pngFile("c.png")],
          ["pending-2", pngFile("d.png")],
        ]),
      }),
    );

    const [, , plan] = vi.mocked(repo.saveCollectionEdit).mock.calls[0];
    const writtenKeys = plan.adds.map((asset) => asset.storageKey);
    expect(writtenKeys).toHaveLength(2);
    expect(vi.mocked(files.removeAssetFile).mock.calls.map(([key]) => key)).toEqual(writtenKeys);

    expect(error.code).toBe("INTERNAL");
    expect(error.status).toBe(500);
    expect(error.message).toBe("保存失败，资源夹没有发生改动，请重试");
  });

  it("写盘中途失败时也回滚已经写好的文件，且不进入写库", async () => {
    vi.mocked(files.writeAssetBytes)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("磁盘不可写"));

    const error = await catchAppError(() =>
      service.saveCollectionEdit(COLLECTION_ID, {
        fields: FIELDS,
        assets: [
          { kind: "keep", assetId: ASSET_A.id },
          { kind: "keep", assetId: ASSET_B.id },
          { kind: "add", tempKey: "pending-1" },
          { kind: "add", tempKey: "pending-2" },
        ],
        files: new Map([
          ["pending-1", pngFile("c.png")],
          ["pending-2", pngFile("d.png")],
        ]),
      }),
    );

    const [firstKey] = vi.mocked(files.writeAssetBytes).mock.calls[0];
    expect(vi.mocked(files.removeAssetFile).mock.calls.map(([key]) => key)).toEqual([firstKey]);
    expect(repo.saveCollectionEdit).not.toHaveBeenCalled();
    expect(error.code).toBe("INTERNAL");
  });
});

describe("资源夹允许没有图片（AC-01-2）", () => {
  it("0 张图片也能建夹：不写盘，建一条没有图片的记录", async () => {
    await service.createCollection(FIELDS, []);

    expect(files.writeAssetBytes).not.toHaveBeenCalled();
    expect(repo.createCollection).toHaveBeenCalledWith(expect.any(String), FIELDS, []);
  });

  it("全部标为移除时保存成功：保留为空、删除两条旧关联（AC-01-2）", async () => {
    await service.saveCollectionEdit(COLLECTION_ID, {
      fields: FIELDS,
      assets: [
        { kind: "remove", assetId: ASSET_A.id },
        { kind: "remove", assetId: ASSET_B.id },
      ],
      files: new Map(),
    });

    expect(files.writeAssetBytes).not.toHaveBeenCalled();
    expect(repo.saveCollectionEdit).toHaveBeenCalledWith(COLLECTION_ID, FIELDS, {
      keep: [],
      remove: [ASSET_A.id, ASSET_B.id],
      adds: [],
    });
  });
});

describe("校验不通过时不做任何写操作（AC-FIX-2）", () => {
  it("新增文件不是图片时整体拒绝，磁盘与库都不动", async () => {
    const error = await catchAppError(() =>
      service.saveCollectionEdit(COLLECTION_ID, {
        fields: FIELDS,
        assets: [
          { kind: "remove", assetId: ASSET_A.id },
          { kind: "remove", assetId: ASSET_B.id },
          { kind: "add", tempKey: "pending-1" },
        ],
        files: new Map([["pending-1", { fileName: "note.txt", bytes: Buffer.from("纯文本") }]]),
      }),
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("note.txt");
    expect(files.writeAssetBytes).not.toHaveBeenCalled();
    expect(repo.saveCollectionEdit).not.toHaveBeenCalled();
  });

  it("超限图片同样整体拒绝", async () => {
    const error = await catchAppError(() =>
      service.saveCollectionEdit(COLLECTION_ID, {
        fields: FIELDS,
        assets: [
          { kind: "keep", assetId: ASSET_A.id },
          { kind: "keep", assetId: ASSET_B.id },
          { kind: "add", tempKey: "pending-1" },
        ],
        files: new Map([
          ["pending-1", { fileName: "big.png", bytes: Buffer.concat([PNG_BYTES, Buffer.alloc(10 * 1024 * 1024)]) }],
        ]),
      }),
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("10 MiB");
    expect(files.writeAssetBytes).not.toHaveBeenCalled();
  });

  it("清单里有别的资源夹的图片时拒绝", async () => {
    const error = await catchAppError(() =>
      service.saveCollectionEdit(COLLECTION_ID, {
        fields: FIELDS,
        assets: [
          { kind: "keep", assetId: ASSET_A.id },
          { kind: "keep", assetId: ASSET_B.id },
          { kind: "remove", assetId: "asset-other" },
        ],
        files: new Map(),
      }),
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("不属于这个资源夹");
    expect(repo.saveCollectionEdit).not.toHaveBeenCalled();
  });

  it("同一张图片出现两次时拒绝", async () => {
    const error = await catchAppError(() =>
      service.saveCollectionEdit(COLLECTION_ID, {
        fields: FIELDS,
        assets: [
          { kind: "keep", assetId: ASSET_A.id },
          { kind: "remove", assetId: ASSET_A.id },
          { kind: "keep", assetId: ASSET_B.id },
        ],
        files: new Map(),
      }),
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("出现了多次");
  });

  it("现有图片没有出现在清单里时拒绝，避免顺序无从确定", async () => {
    const error = await catchAppError(() =>
      service.saveCollectionEdit(COLLECTION_ID, {
        fields: FIELDS,
        assets: [{ kind: "keep", assetId: ASSET_A.id }],
        files: new Map(),
      }),
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("没有给出保留或移除的处理方式");
  });

  it("新增项缺少文件内容时拒绝", async () => {
    const error = await catchAppError(() =>
      service.saveCollectionEdit(COLLECTION_ID, {
        fields: FIELDS,
        assets: [
          { kind: "keep", assetId: ASSET_A.id },
          { kind: "keep", assetId: ASSET_B.id },
          { kind: "add", tempKey: "pending-1" },
        ],
        files: new Map(),
      }),
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("缺少文件内容");
  });

  it("资源夹不存在时返回 NOT_FOUND，不写任何东西", async () => {
    vi.mocked(repo.collectionExists).mockResolvedValue(false);

    const error = await catchAppError(() =>
      service.saveCollectionEdit(COLLECTION_ID, {
        fields: FIELDS,
        assets: [{ kind: "add", tempKey: "pending-1" }],
        files: new Map([["pending-1", pngFile()]]),
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(files.writeAssetBytes).not.toHaveBeenCalled();
  });
});

describe("运行中任务时拒绝保存（AC-FIX-6）", () => {
  it("有运行中任务时返回 CONFLICT，且在写盘之前拦下", async () => {
    vi.mocked(counts.countCollectionUsage).mockResolvedValue({ runs: 1, activeRuns: 1, libraryAssets: 0 });

    const error = await catchAppError(() =>
      service.saveCollectionEdit(COLLECTION_ID, {
        fields: FIELDS,
        assets: [
          { kind: "keep", assetId: ASSET_A.id },
          { kind: "keep", assetId: ASSET_B.id },
          { kind: "add", tempKey: "pending-1" },
        ],
        files: new Map([["pending-1", pngFile()]]),
      }),
    );

    expect(error.code).toBe("CONFLICT");
    expect(error.details).toMatchObject({ code: "COLLECTION_BUSY" });
    expect(files.writeAssetBytes).not.toHaveBeenCalled();
    expect(repo.saveCollectionEdit).not.toHaveBeenCalled();
  });
});
