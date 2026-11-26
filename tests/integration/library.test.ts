import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { createGateway } from "@/modules/gateway/service";
import { listLibrary } from "@/modules/extraction/service";
import type { ExtractedImage, ExtractionHandler } from "@/modules/extraction/types";

/**
 * 数据层不变量的集成验证（docs/prd/12、ADR 0010）：进度总数、部分失败入库与运行过滤。
 *
 * 这些断言都落在真实 PostgreSQL 上：它们依赖唯一约束、外键级联与真实 SQL 条件，
 * 用内存替身测不出来。
 *
 * 文案版本与发布记录的用例随功能下线删除（ADR 0012 第 3 条、MKACG-976）。
 */

const COLLECTION_IDS: string[] = [];
const GATEWAY_IDS: string[] = [];
/** 总资源库里的照片：删资源夹不会带走它们（AC-POOL-4），用例自己清理。 */
const POOL_ASSET_IDS: string[] = [];

async function createCollectionWithAssets(count: number): Promise<{ id: string; assetIds: string[] }> {
  const db = getDb();
  const collection = await db.mediaCollection.create({
    data: { name: `集成-素材库-${randomUUID().slice(0, 8)}` },
    select: { id: true },
  });
  COLLECTION_IDS.push(collection.id);

  const assetIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    // 照片先进总资源库，再建关联（ADR 0012 第 1 条）。
    const asset = await db.mediaAsset.create({
      data: {
        storageKey: `media-assets/asset-${index}-${randomUUID()}.png`,
        fileName: `asset-${index}.png`,
        mimeType: "image/png",
        size: 1,
      },
      select: { id: true },
    });
    await db.collectionAsset.create({
      data: { collectionId: collection.id, assetId: asset.id, sortOrder: index },
    });
    POOL_ASSET_IDS.push(asset.id);
    assetIds.push(asset.id);
  }
  return { id: collection.id, assetIds };
}

async function bindImageAgentToMockGateway(): Promise<void> {
  if ((await getDb().agentConfig.findUnique({ where: { type: "image" }, select: { gatewayId: true } }))?.gatewayId) {
    return;
  }
  const gateway = await createGateway({
    name: `集成-提取网关-${randomUUID().slice(0, 8)}`,
    protocol: "magpie-mcp",
    baseUrl: "https://example.com",
    apiKey: "test-key",
  });
  GATEWAY_IDS.push(gateway.id);
  await getDb().agentConfig.update({
    where: { type: "image" },
    data: { gatewayId: gateway.id, gatewayModelId: null },
  });
}

beforeAll(async () => {
  await bindImageAgentToMockGateway();
});

afterAll(async () => {
  const db = getDb();
  await db.agentConfig.updateMany({ where: { type: "image" }, data: { gatewayId: null } });
  for (const id of COLLECTION_IDS.splice(0)) {
    await db.mediaCollection.deleteMany({ where: { id } });
  }
  for (const id of POOL_ASSET_IDS.splice(0)) {
    await db.mediaAsset.deleteMany({ where: { id } });
  }
  for (const id of GATEWAY_IDS.splice(0)) {
    await db.gateway.deleteMany({ where: { id } });
  }
});

describe("AC-LIB-1 进度总数 = 原图数 × 类别数（接口层给得出）", () => {
  test("2 张原图 × 2 个类别，创建响应的 progress.total 就是 4", async () => {
    const { id, assetIds } = await createCollectionWithAssets(2);
    const { createExtraction } = await import("@/modules/extraction/service");

    const run = await createExtraction(id, {
      sourceAssetIds: assetIds,
      categories: ["topdown", "texture"],
      requirement: "faithful",
    });

    expect(run.progress).toEqual({ done: 0, total: 4 });
    expect(run.status).toBe("queued");
  });

  test("勾选的原图不属于这个资源夹时拒绝，不写运行记录", async () => {
    const { id } = await createCollectionWithAssets(1);
    const { id: otherId } = await createCollectionWithAssets(1);
    const { createExtraction } = await import("@/modules/extraction/service");

    await expect(
      createExtraction(otherId, {
        sourceAssetIds: [`${id}-not-an-asset`],
        categories: ["topdown"],
        requirement: "faithful",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("历史类别 other 不能用于新提取", async () => {
    const { id, assetIds } = await createCollectionWithAssets(1);
    const { createExtraction } = await import("@/modules/extraction/service");

    await expect(
      createExtraction(id, {
        sourceAssetIds: assetIds,
        categories: ["other"],
        requirement: "faithful",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("AC-LIB-2 部分失败：成功的照常入库，整体记 partial", () => {
  test("4 项里 1 项失败 → 3 条素材入库，运行 partial 且带失败原因", async () => {
    // 队列是全局的：先清掉其它用例留下的排队运行，确保这一轮认领的就是本用例的。
    await getDb().extractionRun.deleteMany({ where: { status: "queued" } });
    const { id, assetIds } = await createCollectionWithAssets(2);
    const { createExtraction, listExtractionRuns } = await import("@/modules/extraction/service");
    const { extractionStore } = await import("@/modules/extraction/repo");
    const { createExtractionRunner } = await import("@/modules/extraction/runner");
    const { AGENT } = await import("./support/agent");

    await createExtraction(id, {
      sourceAssetIds: assetIds,
      categories: ["topdown", "texture"],
      requirement: "faithful",
    });

    let call = 0;
    const handler: ExtractionHandler = {
      async run() {
        call += 1;
        const images: ExtractedImage[] = [];
        const failures = [];
        for (const [assetIndex, assetId] of assetIds.entries()) {
          for (const category of ["topdown", "texture"]) {
            if (call === 2) {
              failures.push({
                category,
                sourceAssetId: assetId,
                fileName: `asset-${assetIndex}.png`,
                code: "UPSTREAM_REJECTED",
                message: "上游不接受这个模型",
              });
            } else {
              images.push({
                bytes: Buffer.from("png"),
                mimeType: "image/png",
                category,
                sourceAssetId: assetId,
                sortOrder: assetIndex + 1,
                watermarkRemoved: true,
                watermarkNote: null,
              });
            }
            call += 1;
          }
        }
        return { images, failures, skipped: [] };
      },
    };

    const runner = createExtractionRunner({
      store: extractionStore,
      files: {
        write: async (_runId, images) =>
          images.map((image, index) => ({
            storageKey: `library-assets/test/${randomUUID()}-${index}.png`,
            fileName: `${index}.png`,
            mimeType: image.mimeType,
            width: null,
            height: null,
            category: image.category,
            sourceAssetId: image.sourceAssetId,
            sortOrder: image.sortOrder,
            watermarkRemoved: image.watermarkRemoved,
            watermarkNote: image.watermarkNote,
          })),
        discard: async () => {},
      },
      handler,
      loadCollection: async () => ({
        id,
        platform: null,
        sourceTitle: null,
        sourceBody: null,
        assets: assetIds.map((assetId, index) => ({
          id: assetId,
          fileName: `asset-${index}.png`,
          mimeType: "image/png",
        })),
      }),
      loadSourceImage: async () => ({ bytes: Buffer.from("src"), mimeType: "image/png" }),
      loadAgent: async () => AGENT,
    });

    const outcome = await runner.runOnce();
    expect(outcome).toMatchObject({ ran: true, status: "partial" });

    const [run] = await listExtractionRuns(id);
    expect(run?.status).toBe("partial");
    expect(run?.progress).toBeNull();
    expect(run?.error?.failures).toHaveLength(1);

    const library = await listLibrary(id);
    expect(library.total).toBe(3);
    expect(library.groups.map((group) => group.category).sort()).toEqual(["texture", "topdown"]);
  });
});

/**
 * 去水印的结局要一路带到界面（MKACG-1004、AC-WM-3）：落盘 → 入库 → 视图回读。
 * 用真实的落盘与真实 PostgreSQL 断言两列确实写进去了，内存替身测不出「列没写」。
 */
describe("AC-WM-3 素材记录带上「是否去水印」与原因", () => {
  test("AC-WM-3 未去水印的素材入库后，视图回读到 watermarkRemoved=false 与原因", async () => {
    const { id, assetIds } = await createCollectionWithAssets(1);
    const { createExtraction, listLibrary } = await import("@/modules/extraction/service");
    const { extractionStore } = await import("@/modules/extraction/repo");
    const { removeLibraryFile, writeLibraryImages } = await import("@/modules/extraction/storage");

    const run = await createExtraction(id, {
      sourceAssetIds: assetIds,
      categories: ["topdown"],
      requirement: "faithful",
    });

    const note = "未去水印：底部 10% 条带里主体像素占 80.0%，裁掉会切掉主体，已保留原图";
    const bytes = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 245, g: 243, b: 238 } },
    })
      .png()
      .toBuffer();

    const written = await writeLibraryImages(run.id, [
      {
        bytes,
        mimeType: "image/png",
        width: 20,
        height: 20,
        category: "topdown",
        sourceAssetId: assetIds[0] ?? "",
        sortOrder: 1,
        watermarkRemoved: false,
        watermarkNote: note,
      },
    ]);

    try {
      await extractionStore.saveAssets(run.id, id, written);

      const library = await listLibrary(id);
      const item = library.groups.flatMap((group) => group.items)[0];
      expect(item).toMatchObject({ watermarkRemoved: false, watermarkNote: note });
    } finally {
      for (const asset of written) await removeLibraryFile(asset.storageKey);
    }
  });
});

/**
 * 重跑不叠加（MKACG-1007 AC-UX-3）：同一（原图 × 类别）只保留最新一条产物，旧行与旧文件一起走。
 * 依赖真实 PostgreSQL 的事务与外键：内存替身测不出「删旧行 + 写新行」是不是同一笔。
 */
describe("AC-UX-3 同一（原图 × 类别）只保留最新产物", () => {
  test("同一格连跑两次：库里仍是 1 条、旧素材被顶掉、旧文件交出去删掉", async () => {
    // 队列是全局的：先清掉其它用例留下的排队运行，确保这一轮认领的就是本用例的。
    await getDb().extractionRun.deleteMany({ where: { status: "queued" } });
    const { id, assetIds } = await createCollectionWithAssets(1);
    const { createExtraction, listExtractionRuns, listLibrary } = await import(
      "@/modules/extraction/service"
    );
    const { extractionStore } = await import("@/modules/extraction/repo");
    const { createExtractionRunner } = await import("@/modules/extraction/runner");
    const { AGENT } = await import("./support/agent");

    /** 记录每次落盘的 storage_key 与交给 `discard` 的旧 key。 */
    const writtenKeys: string[] = [];
    const discarded: string[][] = [];

    async function extractOnce(): Promise<void> {
      await createExtraction(id, {
        sourceAssetIds: assetIds,
        categories: ["topdown"],
        requirement: "faithful",
      });

      const runner = createExtractionRunner({
        store: extractionStore,
        files: {
          write: async (_runId, images) =>
            images.map((image, index) => {
              const storageKey = `library-assets/test/${randomUUID()}-${index}.png`;
              writtenKeys.push(storageKey);
              return {
                storageKey,
                fileName: `${index}.png`,
                mimeType: image.mimeType,
                width: null,
                height: null,
                category: image.category,
                sourceAssetId: image.sourceAssetId,
                sortOrder: image.sortOrder,
                watermarkRemoved: image.watermarkRemoved,
                watermarkNote: image.watermarkNote,
              };
            }),
          discard: async (storageKeys) => {
            discarded.push([...storageKeys]);
          },
        },
        handler: {
          async run() {
            return {
              images: [
                {
                  bytes: Buffer.from("png"),
                  mimeType: "image/png",
                  category: "topdown",
                  sourceAssetId: assetIds[0] as string,
                  sortOrder: 1,
                  watermarkRemoved: true,
                  watermarkNote: null,
                },
              ],
              failures: [],
              skipped: [],
            };
          },
        },
        loadCollection: async () => ({
          id,
          platform: null,
          sourceTitle: null,
          sourceBody: null,
          assets: assetIds.map((assetId, index) => ({
            id: assetId,
            fileName: `asset-${index}.png`,
            mimeType: "image/png",
          })),
        }),
        loadSourceImage: async () => ({ bytes: Buffer.from("src"), mimeType: "image/png" }),
        loadAgent: async () => AGENT,
      });

      expect(await runner.runOnce()).toMatchObject({ ran: true, status: "succeeded" });
    }

    await extractOnce();
    const first = await listLibrary(id);
    expect(first.total).toBe(1);
    const firstAssetId = first.groups[0]?.items[0]?.id;
    expect(firstAssetId).toBeDefined();
    expect(discarded).toEqual([]);

    await extractOnce();
    const second = await listLibrary(id);
    // 条数不增加：同一格只留最新一条（AC-UX-3）。
    expect(second.total).toBe(1);
    expect(second.groups[0]?.items[0]?.id).not.toBe(firstAssetId);
    // 旧素材的文件一并交出去删，磁盘不残留。
    expect(discarded).toEqual([[writtenKeys[0] as string]]);
    // 两次运行都还在：运行历史不被删，只是产物被顶掉。
    expect((await listExtractionRuns(id)).length).toBe(2);
  });
});
