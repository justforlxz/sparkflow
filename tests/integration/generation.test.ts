import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { afterEach, beforeAll, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { storageRoot } from "@/lib/storage";
import { createTask, getTask, retryTask } from "@/modules/generation/service";
import { createStageRegistry } from "@/modules/generation/registry";
import { taskStore } from "@/modules/generation/repo";
import { createRunner } from "@/modules/generation/runner";
import { MOCK_SCRIPT_HINTS, mockCopyStage, mockImageStage } from "@/modules/generation/stages/mock";
import { resultAssetWriter } from "@/modules/generation/storage";
import { loadStageCollectionContext } from "@/modules/generation/worker";
import {
  addCollectionAssets,
  createCollection,
  deleteCollection,
  listCollections,
} from "@/modules/media-collection/service";

/**
 * 创作任务编排的集成验收（docs/prd/04-generation-task.md）：
 * 真正落库的部分在这里断言 —— 阶段行、结果行、生成图片文件、级联删除、资源夹计数，
 * 以及「产出写入时机」「重试只重排失败阶段」在真实数据库上的表现。
 *
 * 表结构、worker 与 mock 处理器都用真实实现；只把执行循环换成直接调用 `runner.runOnce()`，
 * 避免用例被轮询间隔拖慢。
 */

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const createdCollectionIds: string[] = [];
const createdGatewayIds: string[] = [];

/** 用例会改文案 Agent 的提示词，结束时还原，避免影响同一数据库上的其它用例。 */
let originalCopyPrompt: string | null = null;

beforeAll(async () => {
  const row = await getDb().agentConfig.findUnique({
    where: { type: "copy" },
    select: { systemPrompt: true },
  });
  originalCopyPrompt = row?.systemPrompt ?? null;
});

afterEach(async () => {
  await getDb().agentConfig.updateMany({
    data: {
      gatewayId: null,
      gatewayModelId: null,
      ...(originalCopyPrompt === null ? {} : { systemPrompt: originalCopyPrompt }),
    },
  });
  for (const id of createdCollectionIds.splice(0)) {
    await getDb().mediaCollection.deleteMany({ where: { id } });
  }
  const gatewayIds = createdGatewayIds.splice(0);
  if (gatewayIds.length > 0) {
    await getDb().gateway.deleteMany({ where: { id: { in: gatewayIds } } });
  }
});

/** 两个 Agent 都就绪：图片 Agent 用网关默认图片模型，文案 Agent 绑定文本模型。 */
async function prepareReadyAgents(): Promise<void> {
  const gateway = await getDb().gateway.create({
    data: {
      name: `集成网关-${randomUUID().slice(0, 8)}`,
      protocol: "openai-chat",
      baseUrl: "https://gw.integration.example.com/v1",
      // 集成测试从不发真实请求，这里只需要一列非空值。
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
    {
      name,
      platform: "小红书",
      sourceUrl: null,
      sourceTitle: "原始标题",
      sourceBody: "原始文案",
    },
    [{ fileName: "a.png", bytes: PNG_BYTES }],
  );
  createdCollectionIds.push(collection.id);
  return collection.id;
}

/** 用 mock 处理器直接推进阶段，不启动轮询循环。 */
function buildRunner() {
  return createRunner({
    store: taskStore,
    files: resultAssetWriter,
    registry: createStageRegistry([mockImageStage, mockCopyStage]),
    loadCollection: loadStageCollectionContext,
  });
}

async function runStages(taskId: string, rounds = 2): Promise<void> {
  const runner = buildRunner();
  for (let index = 0; index < rounds; index += 1) {
    const outcome = await runner.runOnce();
    expect(outcome.ran, `第 ${index + 1} 次推进应当有阶段可跑`).toBe(true);
    if (outcome.ran) expect(outcome.taskId).toBe(taskId);
  }
}

test("创建任务写两条排队阶段并固化快照，跑完后结果含图片与文案", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImage("集成-任务落库");

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 2,
    extraPrompt: null,
  });

  expect(created.status).toBe("running");
  expect(created.stages.image).toMatchObject({ status: "queued", attempts: 1 });
  expect(created.stages.copy).toMatchObject({ status: "queued", attempts: 1 });
  expect(created.resultId).toBeNull();

  const row = await getDb().generationTask.findUnique({
    where: { id: created.id },
    select: { agentSnapshot: true, stages: { select: { stage: true, status: true } } },
  });
  expect(row?.stages).toHaveLength(2);
  const snapshotText = JSON.stringify(row?.agentSnapshot);
  expect(snapshotText).toContain("systemPrompt");
  expect(snapshotText).not.toContain("apiKey");

  await runStages(created.id);

  const detail = await getTask(created.id);
  expect(detail.status).toBe("succeeded");
  expect(detail.resultId).toBeTruthy();
  expect(detail.result?.title?.length).toBeGreaterThan(0);
  expect(detail.result?.tags.length).toBeGreaterThan(0);
  expect(detail.result?.assets).toHaveLength(2);

  // 图片确实落盘：storage_key 指向 generated-assets/<resultId>/ 下真实存在的文件。
  const assets = await getDb().generatedAsset.findMany({
    where: { resultId: detail.resultId! },
    select: { storageKey: true, mimeType: true },
    orderBy: { sortOrder: "asc" },
  });
  expect(assets).toHaveLength(2);
  for (const asset of assets) {
    expect(asset.storageKey).toMatch(
      new RegExp(`^generated-assets/${detail.resultId}/[0-9a-f-]{36}\\.png$`),
    );
    const file = `${storageRoot()}/${asset.storageKey}`;
    const info = await stat(file);
    expect(info.size).toBeGreaterThan(0);
    expect((await readFile(file)).length).toBeGreaterThan(0);
  }
});

test("AC-05-11 生图阶段失败时不写 generation_result，文案阶段保持排队", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImage("集成-生图失败");

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 2,
    extraPrompt: MOCK_SCRIPT_HINTS.failImage,
  });

  await runStages(created.id, 1);

  const detail = await getTask(created.id);
  expect(detail.status).toBe("failed");
  expect(detail.stages.image.error?.code).toBe("UPSTREAM_REJECTED");
  expect(detail.stages.copy.status).toBe("queued");
  expect(detail.resultId).toBeNull();
  expect(await getDb().generationResult.count({ where: { taskId: created.id } })).toBe(0);
});

test("AC-04-6、AC-05-12 重试只重排失败阶段，连续两次重试第二次返回 CONFLICT", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImage("集成-重试文案");

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 2,
    extraPrompt: MOCK_SCRIPT_HINTS.failCopyOnce,
  });

  await runStages(created.id);

  const partial = await getTask(created.id);
  expect(partial.status).toBe("partial");
  expect(partial.stages.copy).toMatchObject({ status: "failed", attempts: 1 });
  expect(partial.resultId).toBeTruthy();

  const assetKeysBefore = await getDb().generatedAsset.findMany({
    where: { resultId: partial.resultId! },
    select: { storageKey: true },
    orderBy: { sortOrder: "asc" },
  });

  const retried = await retryTask(created.id);
  expect(retried.stages.copy).toMatchObject({ status: "queued", attempts: 2 });
  expect(retried.stages.image).toMatchObject({ status: "succeeded", attempts: 1 });

  // 第二次重试时文案阶段已经在排队：不重复入队。
  await expect(retryTask(created.id)).rejects.toMatchObject({
    code: "CONFLICT",
    details: { code: "NO_FAILED_STAGE" },
  });

  await runStages(created.id, 1);

  const finished = await getTask(created.id);
  expect(finished.status).toBe("succeeded");
  expect(finished.stages.copy.attempts).toBe(2);
  expect(finished.resultId).toBe(partial.resultId);

  const assetKeysAfter = await getDb().generatedAsset.findMany({
    where: { resultId: finished.resultId! },
    select: { storageKey: true },
    orderBy: { sortOrder: "asc" },
  });
  // 图片没有被替换：重试文案不重建结果，也不重写图片。
  expect(assetKeysAfter).toEqual(assetKeysBefore);
});

test("生图阶段重跑时复用已有结果行并替换图片（不再撞 task_id 唯一约束）", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImage("集成-结果复用");

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 2,
    extraPrompt: null,
  });

  const runner = buildRunner();
  await runner.runOnce();

  const before = await getTask(created.id);
  expect(before.resultId).toBeTruthy();
  const assetKeysBefore = (
    await getDb().generatedAsset.findMany({
      where: { resultId: before.resultId! },
      select: { storageKey: true },
      orderBy: { sortOrder: "asc" },
    })
  ).map((asset) => asset.storageKey);
  expect(assetKeysBefore).toHaveLength(2);

  // 模拟异常中断后的数据：结果行已存在，但生图阶段被改判为失败。
  await getDb().generationStage.updateMany({
    where: { taskId: created.id, stage: "image" },
    data: { status: "failed", error: { code: "SERVER_RESTARTED" } },
  });

  const retried = await retryTask(created.id);
  expect(retried.stages.image).toMatchObject({ status: "queued", attempts: 2 });

  expect(await runner.runOnce()).toMatchObject({ stage: "image", status: "succeeded" });

  // 结果行被复用，图片行被整体替换：任务不会因为唯一约束而永久失败。
  expect(await getDb().generationResult.count({ where: { taskId: created.id } })).toBe(1);
  const after = await getTask(created.id);
  expect(after.resultId).toBe(before.resultId);
  expect(after.result?.assets).toHaveLength(2);

  const assetKeysAfter = (
    await getDb().generatedAsset.findMany({
      where: { resultId: after.resultId! },
      select: { storageKey: true },
      orderBy: { sortOrder: "asc" },
    })
  ).map((asset) => asset.storageKey);
  expect(assetKeysAfter).not.toEqual(assetKeysBefore);

  // 文案阶段照常接在这条结果上跑完。
  expect(await runner.runOnce()).toMatchObject({ stage: "copy", status: "succeeded" });
  expect((await getTask(created.id)).status).toBe("succeeded");
});

test("AC-04-8 全部成功后重试返回 CONFLICT 且不产生副作用", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImage("集成-全部成功后重试");

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 1,
    extraPrompt: null,
  });
  await runStages(created.id);

  const before = await getDb().generationStage.findMany({
    where: { taskId: created.id },
    select: { stage: true, status: true, attempts: true },
    orderBy: { stage: "asc" },
  });

  await expect(retryTask(created.id)).rejects.toMatchObject({
    code: "CONFLICT",
    details: { code: "NO_FAILED_STAGE", taskStatus: "succeeded" },
  });

  const after = await getDb().generationStage.findMany({
    where: { taskId: created.id },
    select: { stage: true, status: true, attempts: true },
    orderBy: { stage: "asc" },
  });
  expect(after).toEqual(before);
});

test("删除资源夹级联清掉任务、阶段、结果与生成图片（全局规则 7）", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImage("集成-级联删除");

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 1,
    extraPrompt: null,
  });
  await runStages(created.id);
  const detail = await getTask(created.id);
  expect(detail.resultId).toBeTruthy();

  await deleteCollection(collectionId);
  createdCollectionIds.length = 0;

  expect(await getDb().generationTask.count({ where: { collectionId } })).toBe(0);
  expect(await getDb().generationStage.count({ where: { taskId: created.id } })).toBe(0);
  expect(await getDb().generationResult.count({ where: { collectionId } })).toBe(0);
  expect(await getDb().generatedAsset.count({ where: { resultId: detail.resultId! } })).toBe(0);
});

test("AC-02-10 资源夹有运行中任务时禁止改图，列表状态为 generating；出结果后变为 has_results", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImage("集成-资源夹状态");

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 1,
    extraPrompt: null,
  });

  const generating = await listCollections({ page: 1, pageSize: 20, status: "generating" });
  expect(generating.items.map((item) => item.id)).toContain(collectionId);
  expect(generating.items.find((item) => item.id === collectionId)?.taskCount).toBe(1);

  await expect(
    addCollectionAssets(collectionId, [{ fileName: "b.png", bytes: PNG_BYTES }]),
  ).rejects.toMatchObject({ code: "CONFLICT", details: { code: "COLLECTION_BUSY" } });

  await runStages(created.id);

  const withResults = await listCollections({ page: 1, pageSize: 20, status: "has_results" });
  const item = withResults.items.find((candidate) => candidate.id === collectionId);
  expect(item?.resultCount).toBe(1);
  expect(item?.status).toBe("has_results");
});

test("AC-04-10 启动清理：把残留的 running 记为 SERVER_RESTARTED，排队阶段仍可执行", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImage("集成-重启恢复");

  // 模拟服务在生图阶段执行中被杀：阶段行停在 running。
  const crashed = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 1,
    extraPrompt: null,
  });
  const claimed = await taskStore.claimNextStage(new Date());
  expect(claimed?.task.id).toBe(crashed.id);
  expect(claimed?.stage.stage).toBe("image");

  const waiting = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 1,
    extraPrompt: null,
  });

  const runner = buildRunner();
  expect(await runner.recover()).toBe(1);

  const crashedDetail = await getTask(crashed.id);
  expect(crashedDetail.stages.image).toMatchObject({
    status: "failed",
    error: { code: "SERVER_RESTARTED" },
  });

  // 排队中的阶段不受影响：另一条任务照常推进。
  const outcome = await runner.runOnce();
  expect(outcome).toMatchObject({ ran: true, taskId: waiting.id, stage: "image" });
});

test("AC-03-8 任务创建后修改 Agent 提示词，任务详情里的快照不变", async () => {
  await prepareReadyAgents();
  const collectionId = await createCollectionWithImage("集成-快照不变");

  const created = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    imageCount: 1,
    extraPrompt: null,
  });
  const snapshotPrompt = created.agents.copy.systemPrompt;
  const changedPrompt = `改过的提示词-${randomUUID().slice(0, 8)}`;

  await getDb().agentConfig.update({
    where: { type: "copy" },
    data: { systemPrompt: changedPrompt },
  });

  const detail = await getTask(created.id);
  expect(detail.agents.copy.systemPrompt).toBe(snapshotPrompt);
  expect(detail.agents.copy.systemPrompt).not.toBe(changedPrompt);
});
