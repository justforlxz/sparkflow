import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import type { DashboardCounts, DashboardStats } from "@/modules/dashboard/assemble";
import { getDashboardStats, getNavCounts } from "@/modules/dashboard/service";
import { getResult } from "@/modules/generation/results";
import { createTask, getTask } from "@/modules/generation/service";
import { createStageRegistry } from "@/modules/generation/registry";
import { taskStore } from "@/modules/generation/repo";
import { createRunner } from "@/modules/generation/runner";
import { mockCopyStage } from "@/modules/generation/stages/mock";
import { resultAssetWriter } from "@/modules/generation/storage";
import { loadSourceImage, loadStageCollectionContext } from "@/modules/generation/worker";
import { MockImageGenerator } from "@/modules/image-generation/adapters/mock";
import { createImageStage } from "@/modules/image-generation/stage";
import { createCollection, deleteCollection } from "@/modules/media-collection/service";
import { markPublishedSchema } from "@/modules/publish/schema";
import { markPublished } from "@/modules/publish/service";

/**
 * 工作台统计的集成验收（docs/prd/09-dashboard.md AC-09-2 ~ AC-09-5 的数据层）：
 * 四个数字都由真实 PostgreSQL 上的聚合查询给出，本文件只做「操作 → 数字变化」的断言。
 *
 * 用例自带数据准备与清理，用「前后差值」而不是绝对数字断言，因此不依赖库里的历史数据；
 * 结果由 mock 阶段处理器产出，不调用真实模型。
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
      name: `工作台集成网关-${randomUUID().slice(0, 8)}`,
      protocol: "openai-chat",
      baseUrl: "https://gw.dashboard-integration.example.com/v1",
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
  // 图片 Agent 模型留空 = 用网关侧默认图片模型（docs/prd/03）。
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
async function createCollectionWithImage(name: string, count = 1): Promise<string> {
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

/** 用 mock 处理器直接推进两个阶段，不启动轮询循环。 */
async function runStages(rounds = 2): Promise<void> {
  const runner = createRunner({
    store: taskStore,
    files: resultAssetWriter,
    registry: createStageRegistry([
      createImageStage({ generator: new MockImageGenerator() }),
      mockCopyStage,
    ]),
    loadCollection: loadStageCollectionContext,
    loadSourceImage,
  });
  for (let index = 0; index < rounds; index += 1) {
    const outcome = await runner.runOnce();
    expect(outcome.ran, `第 ${index + 1} 次推进应当有阶段可跑`).toBe(true);
  }
}

async function createFinishedResult(collectionId: string): Promise<string> {
  const task = await createTask(collectionId, {
    visualStyle: "fresh",
    copyStyle: "story",
    extraPrompt: null,
  });
  await runStages(2);

  const detail = await getTask(task.id);
  expect(detail.resultId, "任务应当产出结果").toBeTruthy();
  return detail.resultId as string;
}

function counts(stats: DashboardStats): DashboardCounts {
  return {
    collections: stats.collections,
    pendingGeneration: stats.pendingGeneration,
    pendingPublish: stats.pendingPublish,
    published: stats.published,
  };
}

function delta(after: DashboardStats, before: DashboardStats): DashboardCounts {
  return {
    collections: after.collections - before.collections,
    pendingGeneration: after.pendingGeneration - before.pendingGeneration,
    pendingPublish: after.pendingPublish - before.pendingPublish,
    published: after.published - before.published,
  };
}

describe("工作台统计口径", () => {
  test("新建资源夹后，资源夹总数与待创作各加 1（AC-09-2）", async () => {
    const before = await getDashboardStats();

    await createCollectionWithImage("工作台-新建资源夹");

    const after = await getDashboardStats();
    expect(delta(after, before)).toEqual({
      collections: 1,
      pendingGeneration: 1,
      pendingPublish: 0,
      published: 0,
    });
  });

  test("产生结果后，待创作减 1、待发布加 1（AC-09-3）", async () => {
    const collectionId = await createCollectionWithImage("工作台-产生结果");
    const before = await getDashboardStats();

    await createFinishedResult(collectionId);

    const after = await getDashboardStats();
    expect(delta(after, before)).toEqual({
      collections: 0,
      pendingGeneration: -1,
      pendingPublish: 1,
      published: 0,
    });
  });

  test("标记发布后，待发布减 1、已发布加 1（AC-09-4）", async () => {
    const collectionId = await createCollectionWithImage("工作台-标记发布");
    const resultId = await createFinishedResult(collectionId);
    const before = await getDashboardStats();

    const result = await getResult(resultId);
    await markPublished(
      resultId,
      markPublishedSchema.parse({
        title: "发布标题",
        body: "发布正文",
        tags: ["话题甲"],
        selectedAssetIds: [result.assets[0].id],
      }),
    );

    const after = await getDashboardStats();
    expect(delta(after, before)).toEqual({
      collections: 0,
      pendingGeneration: 0,
      pendingPublish: -1,
      published: 1,
    });
  });

  test("同一资源夹的两条结果各自计入待发布，资源夹本身不再计入待创作", async () => {
    const collectionId = await createCollectionWithImage("工作台-两条结果");
    const before = await getDashboardStats();

    await createFinishedResult(collectionId);
    await createFinishedResult(collectionId);

    const after = await getDashboardStats();
    expect(delta(after, before)).toEqual({
      collections: 0,
      pendingGeneration: -1,
      pendingPublish: 2,
      published: 0,
    });
  });

  test("删除资源夹后，统计回到操作前的数值（级联不留残数）", async () => {
    const before = await getDashboardStats();

    const collectionId = await createCollectionWithImage("工作台-删除资源夹");
    const resultId = await createFinishedResult(collectionId);
    const result = await getResult(resultId);
    await markPublished(
      resultId,
      markPublishedSchema.parse({
        title: "发布标题",
        body: "发布正文",
        tags: [],
        selectedAssetIds: [result.assets[0].id],
      }),
    );
    createdCollectionIds.splice(createdCollectionIds.indexOf(collectionId), 1);
    await deleteCollection(collectionId);

    const after = await getDashboardStats();
    expect(counts(after)).toEqual(counts(before));
  });

  test("侧栏计数与工作台前两项统计是同一份数据（AC-09-5）", async () => {
    await createCollectionWithImage("工作台-侧栏计数");

    const [stats, navCounts] = await Promise.all([getDashboardStats(), getNavCounts()]);
    expect(navCounts).toEqual({
      collections: stats.collections,
      pendingGeneration: stats.pendingGeneration,
    });
  });
});

describe("工作台最近列表", () => {
  test("最近资源夹按创建时间倒序，最多 6 条", async () => {
    const created: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      created.push(await createCollectionWithImage(`工作台-最近-${index}`));
    }

    const stats = await getDashboardStats();
    expect(stats.recentCollections).toHaveLength(6);
    // 最新建的排在最前，最老的那条被上限挤掉。
    expect(stats.recentCollections.map((item) => item.id).slice(0, 6)).toEqual(
      created.slice(1).reverse(),
    );
  });

  test("最近内容按创建时间倒序，最多 4 条，并带所属资源夹名称与缩略图", async () => {
    const collectionId = await createCollectionWithImage("工作台-最近内容");
    const created: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      created.push(await createFinishedResult(collectionId));
    }

    const stats = await getDashboardStats();
    expect(stats.recentResults).toHaveLength(4);
    expect(stats.recentResults.map((item) => item.id)).toEqual(created.slice(1).reverse());

    const newest = stats.recentResults[0];
    expect(newest.collectionId).toBe(collectionId);
    expect(newest.collectionName).toBe("工作台-最近内容");
    expect(newest.thumbnailUrl).toContain(`/api/files/generated/${newest.id}/`);
  });
});
