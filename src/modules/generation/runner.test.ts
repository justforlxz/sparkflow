import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { STAGE_ERROR_CODES, STAGE_NAMES, type StageName } from "./constants";
import { createStageRegistry, type StageRegistry } from "./registry";
import { createRunner } from "./runner";
import type {
  CollectionUsage,
  NewResultInput,
  NewTaskInput,
  ResultAssetWriter,
  StoredImage,
  TaskStore,
} from "./store";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import {
  StageError,
  type ClaimedStage,
  type CollectionContext,
  type CopyContent,
  type GeneratedImage,
  type ResultAssetInput,
  type ResultRecord,
  type StageErrorRecord,
  type StageHandler,
  type StageRecord,
  type TaskRecord,
  type TaskWithStages,
} from "./types";

/**
 * 内存版 `TaskStore`：与 `repo.ts` 的选择规则保持一致（生图阶段优先，文案阶段只在生图成功后跑），
 * 但不碰数据库。这样「产出写入时机」「重启恢复」「重试复用结果」这些语义可以在这里逐条断言。
 */
class MemoryStore implements TaskStore {
  readonly tasks: TaskRecord[] = [];
  readonly stages: StageRecord[] = [];
  readonly results: ResultRecord[] = [];
  private sequence = 0;
  private assetSequence = 0;

  private stagesOf(taskId: string): StageRecord[] {
    return this.stages.filter((stage) => stage.taskId === taskId);
  }

  private findStage(stageId: string): StageRecord | undefined {
    return this.stages.find((stage) => stage.id === stageId);
  }

  async createTask(input: NewTaskInput): Promise<TaskWithStages> {
    this.sequence += 1;
    const task: TaskRecord = {
      id: `task-${this.sequence}`,
      createdAt: new Date(2026, 0, 1, 0, 0, this.sequence),
      ...input,
    };
    this.tasks.push(task);
    for (const stage of STAGE_NAMES) {
      this.stages.push({
        id: `${task.id}-${stage}`,
        taskId: task.id,
        stage,
        status: "queued",
        attempts: 1,
        error: null,
        meta: null,
        progress: null,
        startedAt: null,
        finishedAt: null,
      });
    }
    return { task: { ...task }, stages: this.stagesOf(task.id).map((stage) => ({ ...stage })) };
  }

  async findTask(taskId: string): Promise<TaskWithStages | null> {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return null;
    return {
      task: { ...task },
      stages: this.stagesOf(taskId).map((stage) => ({ ...stage })),
    };
  }

  async listTasks(): Promise<TaskWithStages[]> {
    const result: TaskWithStages[] = [];
    for (const task of this.tasks) {
      const found = await this.findTask(task.id);
      if (found) result.push(found);
    }
    return result;
  }

  async claimNextStage(now: Date): Promise<ClaimedStage | null> {
    for (const task of this.tasks) {
      const stages = this.stagesOf(task.id);
      if (stages.some((stage) => stage.status === "running")) continue;

      const image = stages.find((stage) => stage.stage === "image");
      const copy = stages.find((stage) => stage.stage === "copy");
      if (!image || !copy) continue;

      const candidate =
        image.status === "queued"
          ? image
          : image.status === "succeeded" && copy.status === "queued"
            ? copy
            : null;
      if (!candidate) continue;

      candidate.status = "running";
      candidate.startedAt = now;
      return {
        task: { ...task },
        stages: stages.map((stage) => ({ ...stage })),
        stage: { ...candidate },
      };
    }
    return null;
  }

  async markStageSucceeded(
    stageId: string,
    meta: Record<string, unknown> | null,
    error: StageErrorRecord | null,
    now: Date,
  ): Promise<number> {
    const stage = this.findStage(stageId);
    if (!stage || stage.status !== "running") return 0;
    stage.status = "succeeded";
    stage.finishedAt = now;
    stage.error = error;
    stage.meta = meta;
    stage.progress = null;
    return 1;
  }

  async updateStageProgress(
    stageId: string,
    progress: { done: number; total: number },
  ): Promise<number> {
    const stage = this.findStage(stageId);
    if (!stage || stage.status !== "running") return 0;
    stage.progress = { ...progress };
    return 1;
  }

  async markStageFailed(
    stageId: string,
    error: StageErrorRecord,
    meta: Record<string, unknown> | null,
    now: Date,
  ): Promise<number> {
    const stage = this.findStage(stageId);
    if (!stage || stage.status !== "running") return 0;
    stage.status = "failed";
    stage.finishedAt = now;
    stage.error = error;
    stage.meta = meta;
    stage.progress = null;
    return 1;
  }

  async failRunningStages(error: StageErrorRecord, now: Date): Promise<number> {
    let count = 0;
    for (const stage of this.stages) {
      if (stage.status !== "running") continue;
      stage.status = "failed";
      stage.finishedAt = now;
      stage.error = error;
      stage.progress = null;
      count += 1;
    }
    return count;
  }

  async createResult(input: NewResultInput): Promise<void> {
    this.results.push({
      id: input.id,
      taskId: input.taskId,
      collectionId: input.collectionId,
      title: null,
      body: null,
      tags: [],
      visualStyle: input.visualStyle,
      createdAt: new Date(),
      assets: this.toAssetRecords(input.assets),
    });
  }

  /** 每次落库都发新编号：断言「图片被替换」时才能区分新旧行。 */
  private toAssetRecords(assets: readonly ResultAssetInput[]): ResultRecord["assets"] {
    return assets.map((asset) => {
      this.assetSequence += 1;
      return {
        id: `asset-${this.assetSequence}`,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        sortOrder: asset.sortOrder,
        sourceAssetId: asset.sourceAssetId,
      };
    });
  }

  async replaceResultAssets(
    resultId: string,
    assets: readonly ResultAssetInput[],
  ): Promise<void> {
    const result = this.results.find((candidate) => candidate.id === resultId);
    if (!result) return;
    result.assets = this.toAssetRecords(assets);
  }

  async findResultByTask(taskId: string): Promise<ResultRecord | null> {
    return this.results.find((result) => result.taskId === taskId) ?? null;
  }

  async updateResultCopy(resultId: string, copy: CopyContent): Promise<void> {
    const result = this.results.find((candidate) => candidate.id === resultId);
    if (!result) return;
    result.title = copy.title;
    result.body = copy.body;
    result.tags = [...copy.tags];
  }

  async resetStages(taskId: string, stages: readonly StageName[]): Promise<number> {
    let count = 0;
    for (const stage of this.stagesOf(taskId)) {
      // 与 repo 的条件更新一致：只有还是 failed 的阶段能被置回排队。
      if (!stages.includes(stage.stage) || stage.status !== "failed") continue;
      stage.status = "queued";
      stage.attempts += 1;
      stage.error = null;
      stage.meta = null;
      stage.progress = null;
      stage.startedAt = null;
      stage.finishedAt = null;
      count += 1;
    }
    return count;
  }

  async countCollectionUsage(collectionId: string): Promise<CollectionUsage> {
    const tasks = this.tasks.filter((task) => task.collectionId === collectionId);
    const activeTasks = tasks.filter((task) =>
      this.stagesOf(task.id).some((stage) => stage.status !== "succeeded" && stage.status !== "failed"),
    ).length;
    return {
      tasks: tasks.length,
      activeTasks,
      results: this.results.filter((result) => result.collectionId === collectionId).length,
    };
  }
}

class MemoryFiles implements ResultAssetWriter {
  failNext = false;
  readonly writes: { resultId: string; count: number }[] = [];

  async write(resultId: string, images: readonly GeneratedImage[]): Promise<StoredImage[]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("写盘失败");
    }
    this.writes.push({ resultId, count: images.length });
    return images.map((image, index) => ({
      storageKey: `generated-assets/${resultId}/${index}.png`,
      fileName: image.fileName ?? `${index + 1}.png`,
      mimeType: image.mimeType,
      sortOrder: image.sortOrder ?? index,
      width: image.width ?? null,
      height: image.height ?? null,
      sourceAssetId: image.sourceAssetId ?? null,
    }));
  }
}

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function snapshot(agentType: "image" | "copy"): AgentSnapshot {
  return {
    agentType,
    enabled: true,
    name: `${agentType} Agent`,
    gatewayId: "gateway-1",
    protocol: "openai-chat",
    baseUrl: "https://gw.example.com/v1",
    modelId: agentType === "image" ? null : "text-model",
    role: "角色",
    systemPrompt: "系统提示词",
    outputRequirements: "输出要求",
  };
}

const imageStage: StageHandler = {
  stage: "image",
  async run(context) {
    return {
      stage: "image",
      // 一图对一图：每张原图各一张成品，`sort_order` 用原图序号（ADR 0008）。
      images: context.collection.assets.map((asset, index) => ({
        bytes: PNG,
        mimeType: "image/png",
        sortOrder: index + 1,
        sourceAssetId: asset.id,
      })),
      meta: { model: "fake-image" },
    };
  },
};

const copyStage: StageHandler = {
  stage: "copy",
  async run() {
    return {
      stage: "copy",
      copy: { title: "标题", body: "正文", tags: ["标签"] },
      meta: { model: "fake-copy" },
    };
  },
};

/** 造 N 张原图：成品张数就等于它（ADR 0008），任务参数里不再有张数。 */
function collectionWith(assetCount: number): CollectionContext {
  return {
    id: "collection-1",
    platform: "xiaohongshu",
    sourceTitle: "原始标题",
    sourceBody: "原始文案",
    assets: Array.from({ length: assetCount }, (_, index) => ({
      id: `source-${index + 1}`,
      fileName: `${index + 1}.png`,
      mimeType: "image/png",
    })),
  };
}

const COLLECTION = collectionWith(2);

function setup(
  handlers: readonly StageHandler[] = [imageStage, copyStage],
  options: {
    timeoutMs?: number;
    registry?: StageRegistry;
    /** 这次资源夹里有几张原图：成品张数由它决定（ADR 0008）。 */
    assetCount?: number;
  } = {},
) {
  const collection = collectionWith(options.assetCount ?? 2);
  const store = new MemoryStore();
  const files = new MemoryFiles();
  const runner = createRunner({
    store,
    files,
    registry: options.registry ?? createStageRegistry(handlers),
    loadCollection: async () => collection,
    loadSourceImage: async (collectionId: string, assetId: string) => ({
      bytes: Buffer.from(`${collectionId}/${assetId}`),
      mimeType: "image/png",
    }),
    timeoutMs: options.timeoutMs,
  });
  return { store, files, runner };
}

async function createTask(store: MemoryStore, extraPrompt: string | null = null) {
  const created = await store.createTask({
    collectionId: COLLECTION.id,
    visualStyle: "fresh",
    copyStyle: "story",
    extraPrompt,
    agentSnapshot: { image: snapshot("image"), copy: snapshot("copy") },
  });
  return created.task;
}

describe("任务推进与产出写入时机（AC-04-2、AC-04-5、AC-05-11）", () => {
  it("两个阶段都成功后任务为 succeeded，结果带图片与文案", async () => {
    const { store, runner } = setup(undefined, { assetCount: 3 });
    const task = await createTask(store);

    expect(await runner.runOnce()).toMatchObject({ ran: true, stage: "image", status: "succeeded" });
    expect(await runner.runOnce()).toMatchObject({ ran: true, stage: "copy", status: "succeeded" });
    expect(await runner.runOnce()).toEqual({ ran: false });

    const detail = await store.findTask(task.id);
    expect(detail?.stages.map((stage) => stage.status)).toEqual(["succeeded", "succeeded"]);

    expect(store.results).toHaveLength(1);
    expect(store.results[0]?.assets).toHaveLength(3);
    expect(store.results[0]).toMatchObject({ title: "标题", body: "正文", tags: ["标签"] });
  });

  it("AC-05-11 生图阶段失败时不创建创作结果，文案阶段保持排队且不被执行", async () => {
    const failing: StageHandler = {
      stage: "image",
      async run() {
        throw new StageError("UPSTREAM_REJECTED", "上游拒绝了这次请求");
      },
    };
    const { store, runner } = setup([failing, copyStage]);
    const task = await createTask(store);

    expect(await runner.runOnce()).toMatchObject({ ran: true, stage: "image", status: "failed" });
    expect(store.results).toHaveLength(0);

    const detail = await store.findTask(task.id);
    const image = detail?.stages.find((stage) => stage.stage === "image");
    const copy = detail?.stages.find((stage) => stage.stage === "copy");
    expect(image?.error?.code).toBe("UPSTREAM_REJECTED");
    expect(copy?.status).toBe("queued");

    // 生图失败后没有可跑的阶段：文案阶段不得被执行。
    expect(await runner.runOnce()).toEqual({ ran: false });
  });

  it("AC-04-5 文案阶段失败时任务为 partial，结果存在且图片完整、文案为空", async () => {
    const failingCopy: StageHandler = {
      stage: "copy",
      async run() {
        throw new StageError("COPY_FORMAT", "模型返回的不是 JSON");
      },
    };
    const { store, runner } = setup([imageStage, failingCopy], { assetCount: 4 });
    const task = await createTask(store);

    await runner.runOnce();
    expect(await runner.runOnce()).toMatchObject({ stage: "copy", status: "failed" });

    const detail = await store.findTask(task.id);
    expect(detail?.stages.map((stage) => stage.status)).toEqual(["succeeded", "failed"]);

    expect(store.results).toHaveLength(1);
    expect(store.results[0]?.assets).toHaveLength(4);
    expect(store.results[0]).toMatchObject({ title: null, body: null, tags: [] });
  });
});

describe("重试只重跑失败阶段（AC-04-6、AC-04-7）", () => {
  it("AC-04-6 重试文案阶段：复用已有结果、图片不换、生图次数不变", async () => {
    let attempts = 0;
    const onceFailing: StageHandler = {
      stage: "copy",
      async run() {
        attempts += 1;
        if (attempts === 1) throw new StageError("COPY_FORMAT", "第一次按脚本失败");
        return { stage: "copy", copy: { title: "标题", body: "正文", tags: ["a"] } };
      },
    };
    const { store, files, runner } = setup([imageStage, onceFailing]);
    const task = await createTask(store);

    await runner.runOnce();
    await runner.runOnce();
    const beforeRetry = await store.findTask(task.id);
    const imageBefore = beforeRetry?.stages.find((stage) => stage.stage === "image");
    const resultIdBefore = store.results[0]?.id;
    const assetIdsBefore = store.results[0]?.assets.map((asset) => asset.id);

    await store.resetStages(task.id, ["copy"]);
    expect(await runner.runOnce()).toMatchObject({ stage: "copy", status: "succeeded" });

    const afterRetry = await store.findTask(task.id);
    const imageAfter = afterRetry?.stages.find((stage) => stage.stage === "image");
    const copyAfter = afterRetry?.stages.find((stage) => stage.stage === "copy");

    expect(copyAfter?.attempts).toBe(2);
    expect(imageAfter?.attempts).toBe(1);
    expect(imageAfter?.finishedAt).toEqual(imageBefore?.finishedAt);
    expect(store.results).toHaveLength(1);
    expect(store.results[0]?.id).toBe(resultIdBefore);
    expect(store.results[0]?.assets.map((asset) => asset.id)).toEqual(assetIdsBefore);
    expect(store.results[0]?.title).toBe("标题");
    // 只写了一次图片：重试文案不会再落盘。
    expect(files.writes).toHaveLength(1);
  });

  it("AC-04-7 重试生图阶段：只重跑生图，成功后创建结果并继续文案", async () => {
    let imageAttempts = 0;
    const onceFailing: StageHandler = {
      stage: "image",
      async run(context) {
        imageAttempts += 1;
        if (imageAttempts === 1) throw new StageError("UPSTREAM_TIMEOUT", "第一次超时");
        return {
          stage: "image",
          images: context.collection.assets.map((asset, index) => ({
            bytes: PNG,
            mimeType: "image/png",
            sortOrder: index + 1,
            sourceAssetId: asset.id,
          })),
        };
      },
    };
    const { store, runner } = setup([onceFailing, copyStage]);
    const task = await createTask(store);

    await runner.runOnce();
    expect(store.results).toHaveLength(0);

    await store.resetStages(task.id, ["image"]);
    expect(await runner.runOnce()).toMatchObject({ stage: "image", status: "succeeded" });
    expect(await runner.runOnce()).toMatchObject({ stage: "copy", status: "succeeded" });

    const detail = await store.findTask(task.id);
    expect(detail?.stages.find((stage) => stage.stage === "image")?.attempts).toBe(2);
    expect(detail?.stages.find((stage) => stage.stage === "copy")?.attempts).toBe(1);
    expect(store.results).toHaveLength(1);
    expect(store.results[0]?.title).toBe("标题");
  });

  it("生图阶段重跑时复用已有结果行并替换图片，不再新建（避免撞 task_id 唯一约束）", async () => {
    const { store, files, runner } = setup();
    const task = await createTask(store);

    await runner.runOnce();
    const firstResult = store.results[0];
    expect(firstResult?.assets).toHaveLength(2);
    const firstAssetIds = firstResult?.assets.map((asset) => asset.id) ?? [];

    // 模拟异常中断后的数据：结果行已存在，但生图阶段被改判为失败。
    const image = store.stages.find(
      (stage) => stage.taskId === task.id && stage.stage === "image",
    );
    if (image) image.status = "failed";
    await store.resetStages(task.id, ["image"]);

    expect(await runner.runOnce()).toMatchObject({ stage: "image", status: "succeeded" });

    expect(store.results).toHaveLength(1);
    expect(store.results[0]?.id).toBe(firstResult?.id);
    expect(store.results[0]?.assets).toHaveLength(2);
    expect(store.results[0]?.assets.map((asset) => asset.id)).not.toEqual(firstAssetIds);
    // 图片写了两轮：第一轮建结果，第二轮替换。
    expect(files.writes).toHaveLength(2);
  });
});

describe("重启恢复与超时（AC-04-10）", () => {
  it("重启前 running 的阶段记为 SERVER_RESTARTED，排队阶段照常执行", async () => {
    const { store, runner } = setup();
    const crashed = await createTask(store);
    const waiting = await createTask(store);

    // 模拟：waiting 任务的生图已完成、文案在排队；crashed 任务的生图正在执行时进程被杀。
    const waitingStages = store.stages.filter((stage) => stage.taskId === waiting.id);
    for (const stage of waitingStages) {
      if (stage.stage === "image") {
        stage.status = "succeeded";
        stage.finishedAt = new Date();
      }
    }
    // 生图成功后结果行已经存在，文案阶段才会有东西可写。
    await store.createResult({
      id: `result-${waiting.id}`,
      taskId: waiting.id,
      collectionId: COLLECTION.id,
      visualStyle: "fresh",
      assets: [
        {
          storageKey: `generated-assets/result-${waiting.id}/0.png`,
          fileName: "1.png",
          mimeType: "image/png",
          sortOrder: 1,
          width: null,
          height: null,
          sourceAssetId: COLLECTION.assets[0]?.id ?? null,
        },
      ],
    });

    const crashedImage = store.stages.find(
      (stage) => stage.taskId === crashed.id && stage.stage === "image",
    );
    if (crashedImage) {
      crashedImage.status = "running";
      crashedImage.startedAt = new Date();
    }

    expect(await runner.recover()).toBe(1);

    const recovered = await store.findTask(crashed.id);
    expect(recovered?.stages.find((stage) => stage.stage === "image")).toMatchObject({
      status: "failed",
      error: { code: "SERVER_RESTARTED" },
    });

    // 排队中的文案阶段不受影响，重启后继续执行。
    expect(await runner.runOnce()).toMatchObject({
      ran: true,
      taskId: waiting.id,
      stage: "copy",
      status: "succeeded",
    });
  });

  it("阶段超时时记为 TIMEOUT，并 abort 处理器的 signal", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    const hanging: StageHandler = {
      stage: "image",
      async run(context) {
        seenSignal = context.signal;
        return new Promise<never>(() => {});
      },
    };

    try {
      const { store, runner } = setup([hanging, copyStage], { timeoutMs: 30 });
      const task = await createTask(store);

      const pending = runner.runOnce();
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({ stage: "image", status: "failed" });

      const detail = await store.findTask(task.id);
      expect(detail?.stages.find((stage) => stage.stage === "image")?.error?.code).toBe(
        STAGE_ERROR_CODES.timeout,
      );
      expect(seenSignal?.aborted).toBe(true);
      expect(store.results).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("失败的可诊断性与边界（MUST 5）", () => {
  it("没有注册处理器时记 STAGE_HANDLER_MISSING", async () => {
    const { store, runner } = setup([]);
    const task = await createTask(store);

    expect(await runner.runOnce()).toMatchObject({ stage: "image", status: "failed" });
    const detail = await store.findTask(task.id);
    expect(detail?.stages.find((stage) => stage.stage === "image")?.error?.code).toBe(
      STAGE_ERROR_CODES.handlerMissing,
    );
  });

  it("文案阶段找不到结果行时失败，不新建结果", async () => {
    const { store, runner } = setup();
    const task = await createTask(store);
    // 直接让生图阶段「成功」但不建结果，模拟异常数据。
    const image = store.stages.find(
      (stage) => stage.taskId === task.id && stage.stage === "image",
    );
    if (image) image.status = "succeeded";

    expect(await runner.runOnce()).toMatchObject({ stage: "copy", status: "failed" });
    const copy = store.stages.find((stage) => stage.taskId === task.id && stage.stage === "copy");
    expect(copy?.error?.code).toBe(STAGE_ERROR_CODES.resultMissing);
    expect(store.results).toHaveLength(0);
  });

  it("处理器返回别的阶段的产出时记 STAGE_OUTCOME_MISMATCH，不写结果", async () => {
    const wrong: StageHandler = {
      stage: "image",
      async run() {
        return { stage: "copy", copy: { title: "标题", body: "正文", tags: [] } };
      },
    };
    const { store, runner } = setup([wrong, copyStage]);
    const task = await createTask(store);

    expect(await runner.runOnce()).toMatchObject({ stage: "image", status: "failed" });
    const detail = await store.findTask(task.id);
    expect(detail?.stages.find((stage) => stage.stage === "image")?.error?.code).toBe(
      STAGE_ERROR_CODES.outcomeMismatch,
    );
    expect(store.results).toHaveLength(0);
  });

  it("落盘失败时阶段记为失败，不留下结果行", async () => {
    const { store, files, runner } = setup();
    const task = await createTask(store);
    files.failNext = true;

    expect(await runner.runOnce()).toMatchObject({ stage: "image", status: "failed" });
    expect(store.results).toHaveLength(0);
    const detail = await store.findTask(task.id);
    expect(detail?.stages.find((stage) => stage.stage === "image")?.error).toMatchObject({
      code: STAGE_ERROR_CODES.stageFailed,
      message: "写盘失败",
    });
  });

  it("读不到资源夹时记 COLLECTION_MISSING", async () => {
    const store = new MemoryStore();
    const runner = createRunner({
      store,
      files: new MemoryFiles(),
      registry: createStageRegistry([imageStage, copyStage]),
      loadCollection: async () => {
        throw AppError.notFound("资源夹不存在");
      },
      loadSourceImage: async () => ({ bytes: PNG, mimeType: "image/png" }),
    });
    const task = await createTask(store);

    expect(await runner.runOnce()).toMatchObject({ stage: "image", status: "failed" });
    const detail = await store.findTask(task.id);
    expect(detail?.stages.find((stage) => stage.stage === "image")?.error?.code).toBe(
      STAGE_ERROR_CODES.collectionMissing,
    );
  });

  it("阶段错误消息里的凭据形态被脱敏", async () => {
    const leaky: StageHandler = {
      stage: "image",
      async run() {
        throw new Error("请求失败：Authorization: Bearer abc123def456");
      },
    };
    const { store, runner } = setup([leaky, copyStage]);
    const task = await createTask(store);

    await runner.runOnce();
    const detail = await store.findTask(task.id);
    const message = detail?.stages.find((stage) => stage.stage === "image")?.error?.message ?? "";
    expect(message).not.toContain("abc123def456");
    expect(message).toContain("[REDACTED]");
  });

  it("队列为空时返回 ran=false", async () => {
    const { runner } = setup();
    expect(await runner.runOnce()).toEqual({ ran: false });
  });
});
