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
import { loadStageCollectionContext } from "@/modules/generation/worker";
import type { ImageGenerator } from "@/modules/image-generation/adapters/types";
import { generateWithReferenceImages } from "@/modules/image-generation/service";
import { createImageStage } from "@/modules/image-generation/stage";
import { createCollection } from "@/modules/media-collection/service";

/**
 * 图片创作的集成验收（docs/prd/05-image-generation.md AC-05-5、AC-05-6、AC-05-7）：
 * 真正落库、真正落盘的部分在这里断言。
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

async function createCollectionWithImage(name: string): Promise<string> {
  const collection = await createCollection(
    { name, platform: "小红书", sourceUrl: null, sourceTitle: "原始标题", sourceBody: "原始文案" },
    [{ fileName: "a.png", bytes: PNG_BYTES }],
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
  });
}

function fixedGenerator(images: { bytes: Buffer; mimeType: string }[]): ImageGenerator {
  return { generate: async () => images.map((image) => ({ ...image })) };
}

test("AC-05-5 生成图片落盘后能按记录读回字节与 content-type", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImage("集成-图片落盘");

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 2,
    extraPrompt: null,
  });

  const runner = buildRunner(
    fixedGenerator([
      { bytes: Buffer.concat([PNG_BYTES, Buffer.from("first")]), mimeType: "image/png" },
      { bytes: Buffer.concat([PNG_BYTES, Buffer.from("second")]), mimeType: "image/png" },
    ]),
  );

  // 生图阶段
  expect(await runner.runOnce()).toMatchObject({ ran: true, stage: "image", status: "succeeded" });
  // 文案阶段
  expect(await runner.runOnce()).toMatchObject({ ran: true, stage: "copy", status: "succeeded" });

  const detail = await getTask(created.id);
  expect(detail.status).toBe("succeeded");
  expect(detail.resultId).toBeTruthy();
  expect(detail.result?.assets.map((asset) => asset.mimeType)).toEqual(["image/png", "image/png"]);

  const assets = await getDb().generatedAsset.findMany({
    where: { resultId: detail.resultId! },
    select: { storageKey: true, mimeType: true },
    orderBy: { sortOrder: "asc" },
  });
  expect(assets).toHaveLength(2);

  for (const [index, asset] of assets.entries()) {
    // 落在 generated-assets/<resultId>/ 下，文件名由服务端生成。
    expect(asset.storageKey).toMatch(
      new RegExp(`^generated-assets/${detail.resultId}/[0-9a-f-]{36}\\.png$`),
    );
    expect(asset.mimeType).toBe("image/png");

    const file = `${storageRoot()}/${asset.storageKey}`;
    expect((await stat(file)).size).toBeGreaterThan(0);
    const expected = Buffer.concat([PNG_BYTES, Buffer.from(index === 0 ? "first" : "second")]);
    expect((await readFile(file)).equals(expected)).toBe(true);
  }
});

test("AC-05-6 部分批次失败：阶段记为失败、不写结果，批次摘要落进阶段 meta", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImage("集成-部分批次失败");

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 5,
    extraPrompt: null,
  });

  let call = 0;
  const generator: ImageGenerator = {
    generate: async (input) => {
      call += 1;
      if (call === 2) throw new Error("上游第二批失败");
      return Array.from({ length: input.n }, () => ({ bytes: PNG_BYTES, mimeType: "image/png" }));
    },
  };

  const outcome = await buildRunner(generator).runOnce();
  expect(outcome).toMatchObject({ ran: true, stage: "image", status: "failed" });

  const detail = await getTask(created.id);
  expect(detail.status).toBe("failed");
  expect(detail.stages.image.error?.code).toBe("STAGE_FAILED");
  expect(detail.stages.image.error?.message).toContain("第 2 批（1 张）失败");
  expect(detail.stages.image.error?.message).toContain("已取回 4/5 张");
  expect(detail.stages.copy.status).toBe("queued");
  expect(detail.resultId).toBeNull();
  expect(await getDb().generationResult.count({ where: { taskId: created.id } })).toBe(0);
  expect(await getDb().generatedAsset.count({ where: { result: { taskId: created.id } } })).toBe(0);

  const row = await getDb().generationStage.findFirst({
    where: { taskId: created.id, stage: "image" },
    select: { meta: true },
  });
  expect(row?.meta).toMatchObject({
    batches: [
      { n: 4, ok: true },
      { n: 1, ok: false, errorCode: "STAGE_FAILED" },
    ],
  });
});

test("AC-05-7 图生图入口被功能开关拦下，返回 FEATURE_DISABLED", async () => {
  const error = await generateWithReferenceImages({
    prompt: "按原图重绘",
    n: 1,
    referenceImages: ["https://example.com/a.png"],
  }).catch((caught: unknown) => caught);

  expect(error).toMatchObject({
    code: "CONFLICT",
    details: { code: "FEATURE_DISABLED", feature: "image-to-image" },
  });
});
