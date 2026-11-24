import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { createGateway } from "@/modules/gateway/service";
import { allocateCopyVersionNumber } from "@/modules/media-collection/service";
import * as copyRepo from "@/modules/copy-generation/repo";
import { deleteLibraryAsset, listLibrary } from "@/modules/extraction/service";
import type { ExtractedImage, ExtractionHandler } from "@/modules/extraction/types";
import { getCopyVersion } from "@/modules/copy-generation/service";
import { listPublishRecords, markPublished } from "@/modules/publish/service";

/**
 * 数据层不变量的集成验证（docs/prd/12、ADR 0010）：版本号不复用、发布幂等、
 * 两条作业链互不触发、删除素材后版本仍可打开。
 *
 * 这些断言都落在真实 PostgreSQL 上：它们依赖唯一约束、计数器的原子自增与外键级联，
 * 用内存替身测不出来。
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

/** 直接写一行素材：这些用例只关心版本与发布记录的关系，不跑真实提取。 */
async function createLibraryAsset(collectionId: string, index: number): Promise<string> {
  const db = getDb();
  const run = await db.extractionRun.create({
    data: {
      collectionId,
      status: "succeeded",
      requirement: "faithful",
      categories: ["topdown"],
      sourceAssetIds: [],
      progress: { done: 1, total: 1 },
      finishedAt: new Date(),
    },
    select: { id: true },
  });
  const asset = await db.libraryAsset.create({
    data: {
      collectionId,
      extractionRunId: run.id,
      sourceAssetId: `source-${index}`,
      category: "topdown",
      storageKey: `library-assets/${run.id}/${index}.png`,
      fileName: `${index}.png`,
      mimeType: "image/png",
      sortOrder: index,
    },
    select: { id: true },
  });
  return asset.id;
}

/** 造一条已生成成功的文案版本（版本号从资源夹计数器取）。 */
async function createSucceededVersion(
  collectionId: string,
  assetIds: string[],
): Promise<string> {
  const versionNo = await allocateCopyVersionNumber(collectionId);
  const version = await copyRepo.createVersion({
    collectionId,
    versionNo,
    copyStyle: "story",
    agentSnapshot: {
      agentType: "copy",
      enabled: true,
      name: "文案 Agent",
      gatewayId: "gateway-1",
      protocol: "openai-chat",
      baseUrl: "https://example.com",
      modelId: "text-model",
      role: "写手",
      systemPrompt: "写文案",
      outputRequirements: "只输出 JSON",
    },
    selectedAssetIds: assetIds,
    extraPrompt: null,
  });
  await getDb().copyVersion.update({
    where: { id: version.id },
    data: { status: "running" },
  });
  await copyRepo.markVersionSucceeded(
    version.id,
    { title: "标题", body: "正文", tags: ["标签"] },
    {},
    new Date(),
  );
  return version.id;
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

describe("AC-LIB-4 两条作业链互不触发", () => {
  test("跑文案不新增提取运行、不新增素材", async () => {
    const { id } = await createCollectionWithAssets(1);
    const assetId = await createLibraryAsset(id, 1);
    const versionId = await createSucceededVersion(id, [assetId]);

    const before = {
      runs: await getDb().extractionRun.count({ where: { collectionId: id } }),
      assets: await getDb().libraryAsset.count({ where: { collectionId: id } }),
    };

    const { createCopyRunner } = await import("@/modules/copy-generation/runner");
    const { claimNextVersion, markVersionFailed, markVersionSucceeded, failRunningVersions } =
      await import("@/modules/copy-generation/repo");

    let generated = 0;
    const runner = createCopyRunner({
      store: { claimNextVersion, markVersionSucceeded, markVersionFailed, failRunningVersions },
      handler: {
        async run() {
          generated += 1;
          return { copy: { title: "新标题", body: "新正文", tags: [] }, meta: {} };
        },
      },
      loadCollection: async () => ({ id, platform: null, sourceTitle: null, sourceBody: null }),
      loadAssets: async () => [
        { id: assetId, category: "topdown", fileName: "1.png", mimeType: "image/png" },
      ],
      loadAssetImage: async () => ({ bytes: Buffer.from(""), mimeType: "image/png" }),
    });

    // 队列是全局的：先清掉其它用例留下的排队版本，只让本用例的这一条被认领。
    await getDb().copyVersion.updateMany({ where: { status: "queued" }, data: { status: "failed" } });
    await getDb().copyVersion.update({ where: { id: versionId }, data: { status: "queued" } });
    await runner.runOnce();

    expect(generated).toBe(1);
    expect(await getDb().extractionRun.count({ where: { collectionId: id } })).toBe(before.runs);
    expect(await getDb().libraryAsset.count({ where: { collectionId: id } })).toBe(before.assets);
  });

  test("跑提取不新增文案版本", async () => {
    await getDb().extractionRun.deleteMany({ where: { status: "queued" } });
    const { id, assetIds } = await createCollectionWithAssets(1);
    const { createExtraction } = await import("@/modules/extraction/service");
    const { extractionStore } = await import("@/modules/extraction/repo");
    const { createExtractionRunner } = await import("@/modules/extraction/runner");
    const { AGENT } = await import("./support/agent");

    await createExtraction(id, {
      sourceAssetIds: assetIds,
      categories: ["topdown"],
      requirement: "faithful",
    });

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
        assets: [{ id: assetIds[0] as string, fileName: "asset-0.png", mimeType: "image/png" }],
      }),
      loadSourceImage: async () => ({ bytes: Buffer.from("src"), mimeType: "image/png" }),
      loadAgent: async () => AGENT,
    });

    await runner.runOnce();
    expect(await getDb().copyVersion.count({ where: { collectionId: id } })).toBe(0);
  });
});

describe("AC-LIB-6 删除素材后版本仍可打开", () => {
  test("被删素材在版本里是「已删除素材」占位", async () => {
    const { id } = await createCollectionWithAssets(1);
    const keep = await createLibraryAsset(id, 1);
    const removed = await createLibraryAsset(id, 2);
    const versionId = await createSucceededVersion(id, [keep, removed]);

    await deleteLibraryAsset(removed);

    const version = await getCopyVersion(versionId);
    expect(version.assets).toHaveLength(2);
    expect(version.assets[0]).toMatchObject({ id: keep, deleted: false });
    expect(version.assets[1]).toMatchObject({
      id: removed,
      deleted: true,
      categoryLabel: "已删除素材",
      url: null,
    });
  });
});

describe("AC-LIB-7 版本号在资源夹内递增且不复用", () => {
  test("删掉 v2 之后再生成是 v3，不是 v2", async () => {
    const { id } = await createCollectionWithAssets(1);
    const assetId = await createLibraryAsset(id, 1);

    const v1 = await createSucceededVersion(id, [assetId]);
    const v2 = await createSucceededVersion(id, [assetId]);

    const versions = await getDb().copyVersion.findMany({
      where: { collectionId: id },
      orderBy: { versionNo: "asc" },
      select: { id: true, versionNo: true },
    });
    expect(versions.map((version) => version.versionNo)).toEqual([1, 2]);
    expect(versions[1]?.id).toBe(v2);

    // 界面删除某一版之后编号不回收：计数器只增不减（MUST 5）。
    await getDb().copyVersion.deleteMany({ where: { id: v2 } });
    const v3 = await createSucceededVersion(id, [assetId]);
    const third = await getDb().copyVersion.findUnique({
      where: { id: v3 },
      select: { versionNo: true },
    });

    expect(third?.versionNo).toBe(3);
    expect(v1).not.toBe(v3);
  });
});

describe("AC-LIB-8 同一版本重复标记发布只留一条记录", () => {
  test("两次 POST 得到同一条记录，总数为 1", async () => {
    const { id } = await createCollectionWithAssets(1);
    const assetId = await createLibraryAsset(id, 1);
    const versionId = await createSucceededVersion(id, [assetId]);

    const first = await markPublished(versionId, { platform: "小红书" });
    const second = await markPublished(versionId, { platform: "小红书" });

    expect(second.id).toBe(first.id);
    expect(
      await getDb().publishRecord.count({ where: { copyVersionId: versionId } }),
    ).toBe(1);

    const list = await listPublishRecords({ collectionId: id, page: 1, pageSize: 20 });
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      copyVersionId: versionId,
      versionNo: 1,
      versionLabel: "v1",
      title: "标题",
      selectedAssetIds: [assetId],
    });
  });

  test("生成中的版本不能标记发布", async () => {
    const { id } = await createCollectionWithAssets(1);
    const assetId = await createLibraryAsset(id, 1);
    const versionNo = await allocateCopyVersionNumber(id);
    const version = await copyRepo.createVersion({
      collectionId: id,
      versionNo,
      copyStyle: "story",
      agentSnapshot: {
        agentType: "copy",
        enabled: true,
        name: "文案 Agent",
        gatewayId: "gateway-1",
        protocol: "openai-chat",
        baseUrl: "https://example.com",
        modelId: "text-model",
        role: "写手",
        systemPrompt: "写文案",
        outputRequirements: "只输出 JSON",
      },
      selectedAssetIds: [assetId],
      extraPrompt: null,
    });

    await expect(markPublished(version.id, { platform: "小红书" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
