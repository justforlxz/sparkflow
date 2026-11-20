import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { storageRoot } from "@/lib/storage";
import { createStageRegistry } from "@/modules/generation/registry";
import { taskStore } from "@/modules/generation/repo";
import { createRunner } from "@/modules/generation/runner";
import { createTask, getTask } from "@/modules/generation/service";
import { mockCopyStage } from "@/modules/generation/stages/mock";
import { resultAssetWriter } from "@/modules/generation/storage";
import { loadSourceImage, loadStageCollectionContext } from "@/modules/generation/worker";
import type { ImageGenerator } from "@/modules/image-generation/adapters/types";
import { createImageStage } from "@/modules/image-generation/stage";
import { createCollection } from "@/modules/media-collection/service";
import { setFeatureEnabled } from "@/modules/feature-flags/service";

/**
 * 图片创作的集成验收（docs/prd/05-image-generation.md AC-05-2、AC-05-5、AC-05-6）：
 * 真正落库、真正落盘的部分在这里断言：`source_asset_id` 的对应关系、文件字节与回包一致、
 * 部分原图失败时的 `sort_order` 跳号与任务状态。
 *
 * 上游用注入的假适配器（不写真网关）；除此之外阶段处理器、runner、存储与数据库都是真实实现。
 */

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const createdCollectionIds: string[] = [];
const createdGatewayIds: string[] = [];

afterEach(async () => {
  await getDb().agentConfig.updateMany({ data: { gatewayId: null, gatewayModelId: null } });
  const collectionIds = createdCollectionIds.splice(0);
  if (collectionIds.length > 0) {
    await getDb().mediaCollection.deleteMany({ where: { id: { in: collectionIds } } });
  }
  const gatewayIds = createdGatewayIds.splice(0);
  if (gatewayIds.length > 0) {
    await getDb().gateway.deleteMany({ where: { id: { in: gatewayIds } } });
  }
  // 用例可能把开关关掉过：恢复注册表默认（开启），避免影响同库的其它用例。
  await getDb().featureFlag.deleteMany({ where: { key: "image-to-image" } });
});

/** 两个 Agent 都就绪：图片 Agent 不选模型（用网关默认图片模型），文案 Agent 绑定文本模型。 */
async function prepareReadyAgents(): Promise<void> {
  const gateway = await getDb().gateway.create({
    data: {
      name: `图片创作集成网关-${randomUUID().slice(0, 8)}`,
      protocol: "magpie-mcp",
      baseUrl: "https://magpie.integration.example.com",
      // 本文件用假适配器，不发真实请求；这一列只是非空。
      encryptedApiKey: "integration-test-not-a-real-key",
    },
    select: { id: true },
  });
  createdGatewayIds.push(gateway.id);

  await getDb().gatewayModel.createMany({
    data: [
      { gatewayId: gateway.id, modelId: "image-default", capability: "image" },
      { gatewayId: gateway.id, modelId: "text-default", capability: "text" },
    ],
  });
  await getDb().agentConfig.update({
    where: { type: "image" },
    data: { enabled: true, gatewayId: gateway.id, gatewayModelId: null },
  });
  await getDb().agentConfig.update({
    where: { type: "copy" },
    data: { enabled: true, gatewayId: gateway.id, gatewayModelId: "text-default" },
  });
}

/** 造一个带 n 张原图的资源夹：成品张数就等于它（ADR 0008）。 */
async function createCollectionWithImages(name: string, count: number): Promise<string> {
  const collection = await createCollection(
    { name, platform: "小红书", sourceUrl: null, sourceTitle: "原始标题", sourceBody: "原始文案" },
    Array.from({ length: count }, (_, index) => ({
      fileName: `${String.fromCharCode(97 + index)}.png`,
      bytes: PNG_BYTES,
    })),
  );
  createdCollectionIds.push(collection.id);
  return collection.id;
}

/** 只把执行循环换成直接调用 `runner.runOnce()`，避免用例被轮询间隔拖慢。 */
function buildRunner(generator: ImageGenerator) {
  return createRunner({
    store: taskStore,
    files: resultAssetWriter,
    registry: createStageRegistry([createImageStage({ generator }), mockCopyStage]),
    loadCollection: loadStageCollectionContext,
    loadSourceImage,
  });
}

/** 每次调用回一张图：字节里带上序号，便于核对「哪一次调用落成了哪一个文件」。 */
function labelledGenerator(): ImageGenerator {
  let call = 0;
  return {
    generate: async () => {
      call += 1;
      return [
        {
          bytes: Buffer.concat([PNG_BYTES, Buffer.from(`call-${call}`)]),
          mimeType: "image/png",
        },
      ];
    },
  };
}

test("AC-05-2、AC-05-6 两张原图各落一张成品，source_asset_id 一一对应且文件字节与回包一致", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImages("集成-图片落盘", 2);

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    extraPrompt: null,
  });

  const runner = buildRunner(labelledGenerator());

  expect(await runner.runOnce()).toMatchObject({ ran: true, stage: "image", status: "succeeded" });
  expect(await runner.runOnce()).toMatchObject({ ran: true, stage: "copy", status: "succeeded" });

  const detail = await getTask(created.id);
  expect(detail.status).toBe("succeeded");
  expect(detail.expectedImageCount).toBe(2);
  expect(detail.result?.assets.map((asset) => asset.mimeType)).toEqual(["image/png", "image/png"]);

  const assets = await getDb().generatedAsset.findMany({
    where: { resultId: detail.resultId! },
    select: { storageKey: true, mimeType: true, sortOrder: true, sourceAssetId: true },
    orderBy: { sortOrder: "asc" },
  });
  expect(assets).toHaveLength(2);

  // 原图清单（按 sort_order）：成品的 source_asset_id 必须都能在里面找到，且不重复。
  const sources = await getDb().mediaAsset.findMany({
    where: { collectionId },
    select: { id: true },
    orderBy: { sortOrder: "asc" },
  });
  const sourceIds = new Set(sources.map((source) => source.id));
  expect(assets.map((asset) => asset.sortOrder)).toEqual([1, 2]);
  for (const asset of assets) {
    expect(asset.sourceAssetId).toBeTruthy();
    expect(sourceIds.has(asset.sourceAssetId!)).toBe(true);
  }
  expect(new Set(assets.map((asset) => asset.sourceAssetId)).size).toBe(2);

  for (const [index, asset] of assets.entries()) {
    // 落在 generated-assets/<resultId>/ 下，文件名由服务端生成。
    expect(asset.storageKey).toMatch(
      new RegExp(`^generated-assets/${detail.resultId}/[0-9a-f-]{36}\\.png$`),
    );
    expect(asset.mimeType).toBe("image/png");

    const file = `${storageRoot()}/${asset.storageKey}`;
    expect((await stat(file)).size).toBeGreaterThan(0);
    const expected = Buffer.concat([PNG_BYTES, Buffer.from(`call-${index + 1}`)]);
    expect((await readFile(file)).equals(expected)).toBe(true);
  }
});

test("AC-05-5 三张原图里第 2 张失败：保留 2 张成品、sort_order 为 1 与 3，任务为 partial", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImages("集成-部分失败", 3);

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    extraPrompt: null,
  });

  let call = 0;
  const generator: ImageGenerator = {
    generate: async () => {
      call += 1;
      if (call === 2) throw new Error("上游第二次调用失败");
      return [{ bytes: PNG_BYTES, mimeType: "image/png" }];
    },
  };

  const runner = buildRunner(generator);
  expect(await runner.runOnce()).toMatchObject({ ran: true, stage: "image", status: "succeeded" });
  expect(await runner.runOnce()).toMatchObject({ ran: true, stage: "copy", status: "succeeded" });

  const detail = await getTask(created.id);
  expect(detail.status).toBe("partial");
  expect(detail.resultId).toBeTruthy();
  expect(detail.result?.assets.map((asset) => asset.sortOrder)).toEqual([1, 3]);

  // 失败原因留在阶段 error 上，并点名第 2 张原图。
  expect(detail.stages.image.status).toBe("succeeded");
  expect(detail.stages.image.error?.code).toBe("UPSTREAM_PARTIAL");
  expect(detail.stages.image.error?.message).toContain("第 2 张原图（b.png）");

  const row = await getDb().generationStage.findFirst({
    where: { taskId: created.id, stage: "image" },
    select: { meta: true, progress: true },
  });
  expect(row?.meta).toMatchObject({
    failures: [expect.objectContaining({ index: 2, fileName: "b.png" })],
  });
  // 进入终态后进度清空。
  expect(row?.progress).toBeNull();
});

test("功能关闭时创建任务被拦下，不产生任务记录（docs/prd/10 MUST 2、AC-10-4）", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImages("集成-开关关闭", 1);

  await setFeatureEnabled("image-to-image", false);

  const error = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    extraPrompt: null,
  }).catch((caught: unknown) => caught);

  expect(error).toMatchObject({
    code: "CONFLICT",
    details: { code: "FEATURE_DISABLED", feature: "image-to-image" },
  });
  expect(await getDb().generationTask.count({ where: { collectionId } })).toBe(0);
});

test("生图阶段执行中把进度写进 generation_stage.progress", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImages("集成-进度", 2);

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    extraPrompt: null,
  });

  const seen: { done: number; total: number }[] = [];
  const generator: ImageGenerator = {
    generate: async () => {
      // 每次调用前读一次库里的进度：第 1 次是 0/2，第 2 次已经是 1/2。
      const row = await getDb().generationStage.findFirst({
        where: { taskId: created.id, stage: "image" },
        select: { progress: true },
      });
      if (row?.progress) seen.push(row.progress as { done: number; total: number });
      return [{ bytes: PNG_BYTES, mimeType: "image/png" }];
    },
  };

  await buildRunner(generator).runOnce();

  expect(seen).toEqual([
    { done: 0, total: 2 },
    { done: 1, total: 2 },
  ]);
});
