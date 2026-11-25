import { randomUUID } from "node:crypto";
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
          })),
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
