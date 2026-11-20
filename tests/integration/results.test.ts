import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { isAppError } from "@/lib/errors";
import { createTask, getTask } from "@/modules/generation/service";
import { deleteResult, getResultImage, listCollectionResults, updateResult } from "@/modules/generation/results";
import { createStageRegistry } from "@/modules/generation/registry";
import { taskStore } from "@/modules/generation/repo";
import { createRunner } from "@/modules/generation/runner";
import { MOCK_SCRIPT_HINTS, mockCopyStage } from "@/modules/generation/stages/mock";
import { resultAssetWriter } from "@/modules/generation/storage";
import { loadSourceImage, loadStageCollectionContext } from "@/modules/generation/worker";
import { MockImageGenerator } from "@/modules/image-generation/adapters/mock";
import { createImageStage } from "@/modules/image-generation/stage";
import { createCollection, deleteCollection } from "@/modules/media-collection/service";

/**
 * 结果页签的集成验收（docs/prd/07「结果页签」）：真正落库的隔离查询、编辑、删除级联，
 * 以及 partial 结果的视图标记。表结构、service 与 mock 处理器都用真实实现。
 */

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const createdCollectionIds: string[] = [];
const createdGatewayIds: string[] = [];

beforeEach(async () => {
  const gateway = await getDb().gateway.create({
    data: {
      name: `结果集成网关-${randomUUID().slice(0, 8)}`,
      protocol: "openai-chat",
      baseUrl: "https://gw.results-integration.example.com/v1",
      // 用例从不发真实请求，这里只需要一列非空值。
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
});

afterEach(async () => {
  await getDb().agentConfig.updateMany({ data: { gatewayId: null, gatewayModelId: null } });
  for (const id of createdCollectionIds.splice(0)) {
    await deleteCollection(id);
  }
  const gatewayIds = createdGatewayIds.splice(0);
  if (gatewayIds.length > 0) {
    await getDb().gateway.deleteMany({ where: { id: { in: gatewayIds } } });
  }
});

/** 造一个带 n 张原图的资源夹：成品张数 = 原图张数（ADR 0008）。 */
async function createCollectionWithImage(name: string, count = 2): Promise<string> {
  const collection = await createCollection(
    {
      name,
      platform: "小红书",
      sourceUrl: null,
      sourceTitle: "原始标题",
      sourceBody: "原始文案",
    },
    Array.from({ length: count }, (_, index) => ({
      fileName: `${String.fromCharCode(97 + index)}.png`,
      bytes: PNG_BYTES,
    })),
  );
  createdCollectionIds.push(collection.id);
  return collection.id;
}

function buildRunner() {
  return createRunner({
    store: taskStore,
    files: resultAssetWriter,
    registry: createStageRegistry([
      createImageStage({ generator: new MockImageGenerator() }),
      mockCopyStage,
    ]),
    loadCollection: loadStageCollectionContext,
    loadSourceImage,
  });
}

/** 用 mock 处理器直接推进阶段，不启动轮询循环。 */
async function runStages(rounds = 2): Promise<void> {
  const runner = buildRunner();
  for (let index = 0; index < rounds; index += 1) {
    const outcome = await runner.runOnce();
    expect(outcome.ran, `第 ${index + 1} 次推进应当有阶段可跑`).toBe(true);
  }
}

/** 创建一个任务并跑到终态，返回结果 id。 */
async function createFinishedResult(
  collectionId: string,
  extraPrompt: string | null = null,
): Promise<string> {
  const task = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    extraPrompt,
  });
  // 生图 + 文案两条阶段各推进一次。
  await runStages(2);

  const detail = await getTask(task.id);
  expect(detail.resultId, "任务应当产出结果").toBeTruthy();
  return detail.resultId!;
}

describe("结果列表", () => {
  test("按资源夹隔离查询，结果带文案阶段状态与缩略图地址", async () => {
    const firstCollection = await createCollectionWithImage("结果-隔离-甲");
    const secondCollection = await createCollectionWithImage("结果-隔离-乙");
    const firstResultId = await createFinishedResult(firstCollection);
    const secondResultId = await createFinishedResult(secondCollection);

    const firstResults = await listCollectionResults(firstCollection);
    expect(firstResults.map((result) => result.id)).toEqual([firstResultId]);
    expect(firstResults[0].copyFailed).toBe(false);
    expect(firstResults[0].assets).toHaveLength(2);
    expect(firstResults[0].assets[0].thumbnailUrl).toMatch(/\?w=400$/);

    const secondResults = await listCollectionResults(secondCollection);
    expect(secondResults.map((result) => result.id)).toEqual([secondResultId]);
  });

  test("文案阶段失败的结果标记 copyFailed，并在重试成功后恢复", async () => {
    const collectionId = await createCollectionWithImage("结果-文案失败");
    const resultId = await createFinishedResult(collectionId, MOCK_SCRIPT_HINTS.failCopyOnce);

    const [partial] = await listCollectionResults(collectionId);
    expect(partial.id).toBe(resultId);
    expect(partial.copyFailed).toBe(true);
    expect(partial.title).toBeNull();
  });

  test("资源夹不存在时抛出 NOT_FOUND，不返回空列表", async () => {
    await expect(listCollectionResults(randomUUID())).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === "NOT_FOUND",
    );
  });
});

describe("编辑结果", () => {
  test("只更新结果自身字段，原始素材、任务快照与同资源夹其它结果都不变", async () => {
    const collectionId = await createCollectionWithImage("结果-编辑");
    const firstResultId = await createFinishedResult(collectionId);
    const secondResultId = await createFinishedResult(collectionId);

    const beforeSecond = (await listCollectionResults(collectionId)).find(
      (result) => result.id === secondResultId,
    );
    const taskRow = await getDb().generationResult.findUnique({
      where: { id: firstResultId },
      select: { taskId: true, task: { select: { agentSnapshot: true } } },
    });
    const snapshotBefore = JSON.stringify(taskRow?.task.agentSnapshot);

    const updated = await updateResult(firstResultId, {
      title: "改过的标题",
      body: "改过的正文",
      tags: ["新标签"],
      visualStyle: "product",
    });
    expect(updated).toMatchObject({
      title: "改过的标题",
      body: "改过的正文",
      tags: ["新标签"],
      visualStyle: "product",
      visualStyleLabel: "产品质感",
    });

    // 数据库里确实写进去了。
    const persisted = await getDb().generationResult.findUnique({
      where: { id: firstResultId },
      select: { title: true, body: true, tags: true, visualStyle: true },
    });
    expect(persisted).toMatchObject({
      title: "改过的标题",
      body: "改过的正文",
      tags: ["新标签"],
      visualStyle: "product",
    });

    // 原始素材与任务快照不动（docs/prd/07 MUST NOT）。
    const collection = await getDb().mediaCollection.findUnique({
      where: { id: collectionId },
      select: { sourceBody: true, sourceTitle: true, assets: { select: { id: true } } },
    });
    expect(collection?.sourceBody).toBe("原始文案");
    expect(collection?.sourceTitle).toBe("原始标题");
    expect(collection?.assets).toHaveLength(2);

    const taskAfter = await getDb().generationResult.findUnique({
      where: { id: firstResultId },
      select: { task: { select: { agentSnapshot: true } } },
    });
    expect(JSON.stringify(taskAfter?.task.agentSnapshot)).toBe(snapshotBefore);

    // 同资源夹的另一个结果不受影响。
    const afterSecond = (await listCollectionResults(collectionId)).find(
      (result) => result.id === secondResultId,
    );
    expect(afterSecond?.title).toBe(beforeSecond?.title);
    expect(afterSecond?.body).toBe(beforeSecond?.body);
    expect(afterSecond?.assets.map((asset) => asset.id)).toEqual(
      beforeSecond?.assets.map((asset) => asset.id),
    );
  });

  test("编辑不存在的结果时抛出 NOT_FOUND", async () => {
    await expect(updateResult(randomUUID(), { title: "标题" })).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === "NOT_FOUND",
    );
  });
});

describe("删除结果", () => {
  test("只删这一组结果与它的生成图片，同资源夹的另一个结果与原始素材仍在", async () => {
    const collectionId = await createCollectionWithImage("结果-删除");
    const firstResultId = await createFinishedResult(collectionId);
    const secondResultId = await createFinishedResult(collectionId);

    await deleteResult(firstResultId);

    expect(await getDb().generationResult.count({ where: { id: firstResultId } })).toBe(0);
    expect(await getDb().generatedAsset.count({ where: { resultId: firstResultId } })).toBe(0);

    const remaining = await listCollectionResults(collectionId);
    expect(remaining.map((result) => result.id)).toEqual([secondResultId]);
    expect(remaining[0].assets).toHaveLength(2);
    // 生成图片行还在，文件也还能读出来。
    const image = await getResultImage(secondResultId, remaining[0].assets[0].id);
    expect(image.bytes.byteLength).toBeGreaterThan(0);
    expect(image.mimeType).toBe("image/png");

    // 原始素材未被牵连（AC-07-7）。
    const collection = await getDb().mediaCollection.findUnique({
      where: { id: collectionId },
      select: { assets: { select: { id: true } }, sourceBody: true },
    });
    expect(collection?.assets).toHaveLength(2);
    expect(collection?.sourceBody).toBe("原始文案");
  });

  test("删除不存在的结果时抛出 NOT_FOUND", async () => {
    await expect(deleteResult(randomUUID())).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === "NOT_FOUND",
    );
  });
});

describe("生成图片读取", () => {
  test("缩略图按 w 参数缩放，跨结果读取别人的图片返回 NOT_FOUND", async () => {
    const collectionId = await createCollectionWithImage("结果-读图");
    const resultId = await createFinishedResult(collectionId);
    const [result] = await listCollectionResults(collectionId);

    const original = await getResultImage(resultId, result.assets[0].id);
    const thumbnail = await getResultImage(resultId, result.assets[0].id, 400);
    expect(original.bytes.byteLength).toBeGreaterThan(0);
    expect(thumbnail.bytes.byteLength).toBeGreaterThan(0);

    const otherResultId = await createFinishedResult(collectionId);
    await expect(getResultImage(otherResultId, result.assets[0].id)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === "NOT_FOUND",
    );
  });
});
