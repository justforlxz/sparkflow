import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { isAppError } from "@/lib/errors";
import { createTask, getTask } from "@/modules/generation/service";
import { deleteResult, getResult, updateResult } from "@/modules/generation/results";
import { createStageRegistry } from "@/modules/generation/registry";
import { taskStore } from "@/modules/generation/repo";
import { createRunner } from "@/modules/generation/runner";
import { mockCopyStage } from "@/modules/generation/stages/mock";
import { resultAssetWriter } from "@/modules/generation/storage";
import { loadSourceImage, loadStageCollectionContext } from "@/modules/generation/worker";
import { MockImageGenerator } from "@/modules/image-generation/adapters/mock";
import { createImageStage } from "@/modules/image-generation/stage";
import { createCollection, deleteCollection, getCollection } from "@/modules/media-collection/service";
import { markPublishedSchema, type MarkPublishedInput } from "@/modules/publish/schema";
import {
  downloadResultAssets,
  getPublishRecord,
  getPublishedResultIds,
  listPublishRecords,
  markPublished,
  revokePublished,
} from "@/modules/publish/service";

/**
 * 发布记录的集成验收（docs/prd/08）：真正落库的幂等 upsert、标题快照同步、
 * 两个列表同一份数据、打包下载与级联删除。表结构、service 与 mock 处理器都用真实实现。
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
      name: `发布集成网关-${randomUUID().slice(0, 8)}`,
      protocol: "openai-chat",
      baseUrl: "https://gw.publish-integration.example.com/v1",
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
      extractTarget: "桌垫的织物纹理",
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

async function createFinishedResult(collectionId: string): Promise<string> {
  const task = await createTask(collectionId, {
    extractRequirement: "faithful",
    copyStyle: "story",
    extraPrompt: null,
  });
  await runStages(2);

  const detail = await getTask(task.id);
  expect(detail.resultId, "任务应当产出结果").toBeTruthy();
  return detail.resultId as string;
}

/** 走一次真实的请求体校验，顺便确认弹窗能提交的形状就是 service 接受的形状。 */
function publishInput(
  assetIds: readonly string[],
  overrides: Partial<MarkPublishedInput> = {},
): MarkPublishedInput {
  return markPublishedSchema.parse({
    title: "发布标题",
    body: "发布正文",
    tags: ["话题甲", "话题乙"],
    selectedAssetIds: [...assetIds],
    ...overrides,
  });
}

/** 按 central directory 读出 ZIP 条目名，用来断言序号顺序（AC-09-10）。 */
function zipEntryNames(archive: Buffer): string[] {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(endOffset).toBeGreaterThanOrEqual(0);
  const count = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    names.push(archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

describe("标记已发布", () => {
  test("未标记前没有记录，结果也不在已发布集合里（AC-08-3）", async () => {
    const collectionId = await createCollectionWithImage("发布-未标记");
    const resultId = await createFinishedResult(collectionId);

    expect(await getPublishRecord(resultId)).toBeNull();
    expect(await getPublishedResultIds([resultId])).toEqual([]);
  });

  test("首次标记写入记录，并把弹窗里的文案写回结果（AC-08-4、AC-08-6）", async () => {
    const collectionId = await createCollectionWithImage("发布-首次");
    const resultId = await createFinishedResult(collectionId);
    const result = await getResult(resultId);
    const selected = result.assets.slice(1).map((asset) => asset.id);

    const record = await markPublished(
      resultId,
      publishInput(selected, { title: "改过的标题", body: "改过的正文", tags: ["新话题"] }),
    );

    expect(record).toMatchObject({
      resultId,
      collectionId,
      platform: "小红书",
      title: "改过的标题",
      imageCount: 1,
      selectedAssetIds: selected,
    });
    expect(record.thumbnailUrl).toContain(`/api/files/generated/${resultId}/${selected[0]}`);

    const updated = await getResult(resultId);
    expect(updated).toMatchObject({
      title: "改过的标题",
      body: "改过的正文",
      tags: ["新话题"],
    });
    expect(await getPublishedResultIds([resultId])).toEqual([resultId]);
  });

  test("重复标记只更新同一条记录，不产生第二条（AC-08-5）", async () => {
    const collectionId = await createCollectionWithImage("发布-重复");
    const resultId = await createFinishedResult(collectionId);
    const result = await getResult(resultId);
    const allAssets = result.assets.map((asset) => asset.id);

    await markPublished(resultId, publishInput(allAssets.slice(0, 1), { title: "第一次" }));
    await markPublished(resultId, publishInput(allAssets, { title: "第二次" }));

    const rows = await getDb().publishRecord.findMany({
      where: { resultId },
      select: { titleSnapshot: true, selectedAssetIds: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      titleSnapshot: "第二次",
      selectedAssetIds: allAssets,
    });
  });

  test("编辑结果标题时同步发布记录的标题快照（docs/prd/07 MUST 5）", async () => {
    const collectionId = await createCollectionWithImage("发布-改标题");
    const resultId = await createFinishedResult(collectionId);
    const result = await getResult(resultId);
    await markPublished(resultId, publishInput(result.assets.map((asset) => asset.id)));

    await updateResult(resultId, { title: "发布后又改了标题" });

    const record = await getPublishRecord(resultId);
    expect(record?.title).toBe("发布后又改了标题");
  });

  test("撤销发布记录后结果回到未发布，重复撤销给 NOT_FOUND", async () => {
    const collectionId = await createCollectionWithImage("发布-撤销");
    const resultId = await createFinishedResult(collectionId);
    const result = await getResult(resultId);
    await markPublished(resultId, publishInput(result.assets.map((asset) => asset.id)));

    await revokePublished(resultId);
    expect(await getPublishRecord(resultId)).toBeNull();

    await expect(revokePublished(resultId)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === "NOT_FOUND",
    );
  });
});

describe("发布记录列表", () => {
  test("全局与资源夹列表是同一份数据，按发布时间倒序（AC-08-4）", async () => {
    const firstCollection = await createCollectionWithImage("发布-列表甲");
    const secondCollection = await createCollectionWithImage("发布-列表乙");
    const firstResultId = await createFinishedResult(firstCollection);
    const secondResultId = await createFinishedResult(secondCollection);

    const first = await getResult(firstResultId);
    const second = await getResult(secondResultId);
    await markPublished(firstResultId, publishInput(first.assets.map((asset) => asset.id)));
    await markPublished(secondResultId, publishInput(second.assets.map((asset) => asset.id)));

    const global = await listPublishRecords({ page: 1, pageSize: 50 });
    expect(global.items.map((item) => item.resultId)).toEqual([secondResultId, firstResultId]);
    expect(global.items[0]?.collectionName).toBe("发布-列表乙");

    const scoped = await listPublishRecords({
      collectionId: firstCollection,
      page: 1,
      pageSize: 50,
    });
    expect(scoped.total).toBe(1);
    expect(scoped.items.map((item) => item.resultId)).toEqual([firstResultId]);
  });

  test("发布后资源夹的派生状态变成 published", async () => {
    const collectionId = await createCollectionWithImage("发布-派生状态");
    // 还没有任务与结果：`draft`。
    expect((await getCollection(collectionId)).status).toBe("draft");

    const resultId = await createFinishedResult(collectionId);
    // 有结果未发布：`has_results`。
    expect((await getCollection(collectionId)).status).toBe("has_results");

    const result = await getResult(resultId);
    await markPublished(resultId, publishInput(result.assets.map((asset) => asset.id)));
    expect((await getCollection(collectionId)).status).toBe("published");
  });
});

describe("下载所选图片", () => {
  test("选 1 张直接返回该图片字节", async () => {
    const collectionId = await createCollectionWithImage("下载-单张");
    const resultId = await createFinishedResult(collectionId);
    const result = await getResult(resultId);
    const asset = result.assets[1];

    const file = await downloadResultAssets(resultId, [asset!.id]);
    expect(file.mimeType).toBe("image/png");
    expect(file.fileName).toBe(asset!.fileName);
    expect(file.bytes.equals(PNG_BYTES)).toBe(true);
  });

  test("选多张按勾选顺序编号进 ZIP，只有选中的图片（AC-08-1、AC-09-10）", async () => {
    const collectionId = await createCollectionWithImage("下载-多张");
    const resultId = await createFinishedResult(collectionId);
    const result = await getResult(resultId);
    const [first, second] = result.assets;

    // 故意按「后一张、前一张」勾选，序号必须跟着勾选顺序。
    const file = await downloadResultAssets(resultId, [second!.id, first!.id]);
    expect(file.mimeType).toBe("application/zip");
    expect(zipEntryNames(file.bytes)).toEqual([
      `01-${second!.fileName}`,
      `02-${first!.fileName}`,
    ]);
  });

  test("没给图片时打包全部图片", async () => {
    const collectionId = await createCollectionWithImage("下载-全部");
    const resultId = await createFinishedResult(collectionId);
    const result = await getResult(resultId);

    const file = await downloadResultAssets(resultId, []);
    expect(zipEntryNames(file.bytes)).toHaveLength(result.assets.length);
  });

  test("选了不属于这个结果的图片被拒绝", async () => {
    const firstCollection = await createCollectionWithImage("下载-越界甲");
    const secondCollection = await createCollectionWithImage("下载-越界乙");
    const firstResultId = await createFinishedResult(firstCollection);
    const secondResultId = await createFinishedResult(secondCollection);
    const otherAssetId = (await getResult(secondResultId)).assets[0]!.id;

    await expect(downloadResultAssets(firstResultId, [otherAssetId])).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === "VALIDATION_FAILED",
    );
    await expect(
      markPublished(firstResultId, publishInput([otherAssetId])),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === "VALIDATION_FAILED",
    );
  });
});

describe("级联删除", () => {
  test("删除结果后发布记录消失（AC-08-8）", async () => {
    const collectionId = await createCollectionWithImage("级联-删结果");
    const resultId = await createFinishedResult(collectionId);
    const result = await getResult(resultId);
    await markPublished(resultId, publishInput(result.assets.map((asset) => asset.id)));

    await deleteResult(resultId);

    expect(await getPublishRecord(resultId)).toBeNull();
    expect((await listPublishRecords({ page: 1, pageSize: 50 })).items).toHaveLength(0);
  });

  test("删除资源夹后发布记录一起消失（docs/prd/01 MUST 5）", async () => {
    const collectionId = await createCollectionWithImage("级联-删资源夹");
    const resultId = await createFinishedResult(collectionId);
    const result = await getResult(resultId);
    await markPublished(resultId, publishInput(result.assets.map((asset) => asset.id)));

    await deleteCollection(collectionId);
    createdCollectionIds.splice(createdCollectionIds.indexOf(collectionId), 1);

    expect(await getDb().publishRecord.count()).toBe(0);
  });
});
