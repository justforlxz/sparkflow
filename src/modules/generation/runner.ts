/**
 * 阶段执行编排（docs/prd/04-generation-task.md「异步执行」「产出写入时机」，ADR 0002、0005）。
 *
 * 一次 `runOnce()` 只推进一个阶段：认领 → 调处理器 → 按产出写库 → 标成功/失败。
 * 落库、状态流转都在这里，阶段处理器只负责调上游并交出产出，因此 N6 / N7 换实现不需要改这里。
 */
import { randomUUID } from "node:crypto";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { STAGE_ERROR_CODES, STAGE_LABELS, DEFAULT_TASK_TIMEOUT_MS, type StageName } from "./constants";
import type { StageRegistry } from "./registry";
import { stageErrorFrom, stageErrorRecord } from "./stage-error";
import type { ResultAssetWriter, TaskStore } from "./store";
import {
  StageError,
  type CollectionContext,
  type ResultRecord,
  type SourceImageBytes,
  type StageContext,
  type StageErrorRecord,
  type StageHandler,
  type StageOutcome,
  type StageRecord,
  type TaskRecord,
} from "./types";

export interface RunnerOptions {
  store: TaskStore;
  files: ResultAssetWriter;
  registry: StageRegistry;
  /** 从资源夹模块取阶段要用的来源信息与原图清单（不直接查别的模块的表）。 */
  loadCollection: (collectionId: string) => Promise<CollectionContext>;
  /** 按 id 读一张原图的字节：一图对一图时逐张读，不把整个资源夹的图片一次性载入内存。 */
  loadSourceImage: (collectionId: string, assetId: string) => Promise<SourceImageBytes>;
  now?: () => Date;
  /** 单任务总超时；默认 45 分钟，验收用例注入更短的值。 */
  timeoutMs?: number;
}

export type RunOutcome =
  | { ran: false }
  | { ran: true; taskId: string; stage: StageName; status: "succeeded" | "failed" };

export interface TaskRunner {
  /** 推进一个阶段；没有可跑的阶段时返回 `{ ran: false }`。 */
  runOnce(): Promise<RunOutcome>;
  /** 启动时清理残留状态（AC-04-10），返回值是改写的阶段条数。 */
  recover(): Promise<number>;
}

/** 超时不是处理器的错，单独区分以便记 `TIMEOUT` 而不是 `STAGE_FAILED`。 */
class StageTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`阶段执行超过 ${Math.round(timeoutMs / 1000)} 秒，已中止`);
    this.name = "StageTimeoutError";
  }
}

async function runHandler(
  handler: StageHandler,
  context: StageContext,
  timeoutMs: number,
  controller: AbortController,
): Promise<StageOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handler.run(context),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new StageTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createRunner(options: RunnerOptions): TaskRunner {
  const { store, files, registry, loadCollection, loadSourceImage } = options;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  async function recover(): Promise<number> {
    const at = now();
    const count = await store.failRunningStages(
      stageErrorRecord(
        STAGE_ERROR_CODES.serverRestarted,
        "服务重启，执行中的阶段已中断，请重试该阶段",
        at,
      ),
      at,
    );
    if (count > 0) logger.warn("服务重启：把执行中的阶段记为失败", { count });
    return count;
  }

  /**
   * 阶段状态写入 0 行时必须留痕：阶段行可能已被删除（资源夹被删），
   * 也可能被另一条路径改判（例如启动清理）。静默失败会让任务停在无法解释的状态。
   */
  async function markStageSucceeded(
    stage: StageRecord,
    meta: Record<string, unknown> | null,
    /** 部分原图失败的原因：阶段仍是 succeeded，但 `error` 要留住它（AC-05-5）。 */
    error: StageErrorRecord | null = null,
  ): Promise<void> {
    const count = await store.markStageSucceeded(stage.id, meta, error, now());
    if (count === 0) {
      logger.warn("阶段成功状态没有写入：该阶段行已不存在或已不是 running", {
        taskId: stage.taskId,
        stage: stage.stage,
      });
    }
  }

  async function markStageFailed(
    task: TaskRecord,
    stage: StageRecord,
    error: StageErrorRecord,
    meta: Record<string, unknown> | null,
  ): Promise<void> {
    const count = await store.markStageFailed(stage.id, error, meta, now());
    if (count === 0) {
      logger.warn("阶段失败状态没有写入：该阶段行已不存在或已不是 running", {
        taskId: task.id,
        stage: stage.stage,
      });
    }
    logger.warn("阶段执行失败", {
      taskId: task.id,
      stage: stage.stage,
      code: error.code,
      message: error.message,
    });
  }

  /** 按产出写库（docs/prd/04「产出写入时机」）：处理器只给内容，结果与图片的写入都在这里。 */
  async function persistOutcome(
    task: TaskRecord,
    outcome: StageOutcome,
    existingResult: ResultRecord | null,
  ): Promise<void> {
    if (outcome.stage === "image") {
      // 生图成功才写结果：失败不留空壳（MUST 3、AC-05-11）。
      // 已有结果行时复用它并替换图片：再新建会撞 generation_result.task_id 的唯一约束，
      // 任务会永久无法重试成功（异常中断后留下的结果行就走这条路径恢复）。
      const resultId = existingResult?.id ?? randomUUID();
      const assets = await files.write(resultId, outcome.images);
      if (existingResult) {
        await store.replaceResultAssets(resultId, assets);
      } else {
        await store.createResult({
          id: resultId,
          taskId: task.id,
          collectionId: task.collectionId,
          visualStyle: task.visualStyle,
          assets,
        });
      }
      return;
    }

    // 文案阶段只能写在生图阶段建好的结果上；重试文案时复用它（MUST 4）。
    if (!existingResult) throw new Error("文案阶段缺少生图阶段建好的结果行");
    await store.updateResultCopy(existingResult.id, outcome.copy);
  }

  async function runOnce(): Promise<RunOutcome> {
    const claimed = await store.claimNextStage(now());
    if (!claimed) return { ran: false };

    const { task, stage } = claimed;

    const failWith = async (
      error: StageErrorRecord,
      meta: Record<string, unknown> | null = null,
    ): Promise<RunOutcome> => {
      await markStageFailed(task, stage, error, meta);
      return { ran: true, taskId: task.id, stage: stage.stage, status: "failed" };
    };

    const handler = registry.get(stage.stage);
    if (!handler) {
      return failWith(
        stageErrorRecord(
          STAGE_ERROR_CODES.handlerMissing,
          `${STAGE_LABELS[stage.stage]}没有注册处理器（GENERATION_ADAPTER=${process.env.GENERATION_ADAPTER ?? "real"}）`,
          now(),
        ),
      );
    }

    let collection: CollectionContext;
    try {
      collection = await loadCollection(task.collectionId);
    } catch (error) {
      const record = stageErrorFrom(error, now());
      // 资源夹被删（外键级联已带走阶段行）时给出明确子码；其它错误保留自己的分类。
      return failWith(
        isAppError(error) && error.code === "NOT_FOUND"
          ? { ...record, code: STAGE_ERROR_CODES.collectionMissing }
          : record,
      );
    }

    const existingResult = await store.findResultByTask(task.id);
    if (stage.stage === "copy" && !existingResult) {
      return failWith(
        stageErrorRecord(
          STAGE_ERROR_CODES.resultMissing,
          "找不到生图阶段建好的创作结果，文案阶段无法写入",
          now(),
        ),
      );
    }

    const controller = new AbortController();
    const context: StageContext = {
      taskId: task.id,
      attempt: stage.attempts,
      params: {
        visualStyle: task.visualStyle,
        copyStyle: task.copyStyle,
        extraPrompt: task.extraPrompt,
      },
      agents: task.agentSnapshot,
      collection,
      resultId: existingResult?.id ?? null,
      signal: controller.signal,
      readSourceImage: (assetId: string) => loadSourceImage(task.collectionId, assetId),
      reportProgress: async (progress) => {
        // 进度写入失败不该让阶段失败：界面最多少刷新一次「第 k/N 张」。
        const written = await store.updateStageProgress(stage.id, progress).catch((error) => {
          logger.warn("阶段进度写入失败，已跳过", { taskId: task.id, stage: stage.stage, error });
          return 0;
        });
        if (written === 0) {
          logger.warn("阶段进度没有写入：该阶段已不在执行中", {
            taskId: task.id,
            stage: stage.stage,
          });
        }
      },
    };

    let outcome: StageOutcome;
    try {
      outcome = await runHandler(handler, context, timeoutMs, controller);
    } catch (error) {
      const record =
        error instanceof StageTimeoutError
          ? stageErrorRecord(STAGE_ERROR_CODES.timeout, error.message, now())
          : stageErrorFrom(error, now());
      const meta = error instanceof StageError ? (error.meta ?? null) : null;
      return failWith(record, meta);
    }

    if (outcome.stage !== stage.stage) {
      return failWith(
        stageErrorRecord(
          STAGE_ERROR_CODES.outcomeMismatch,
          `处理器返回了 ${outcome.stage} 阶段的产出，但当前执行的是 ${stage.stage} 阶段`,
          now(),
        ),
      );
    }

    try {
      await persistOutcome(task, outcome, existingResult);
      // 部分原图失败：阶段仍是 succeeded，但错误要留在阶段上（docs/prd/05 MUST 7、AC-05-5）。
      const partial =
        outcome.stage === "image" && outcome.partialError
          ? stageErrorRecord(outcome.partialError.code, outcome.partialError.message, now())
          : null;
      await markStageSucceeded(stage, outcome.meta ?? null, partial);
    } catch (error) {
      // 落盘或写库失败：阶段必须如实失败，不能标成功。
      return failWith(stageErrorFrom(error, now()), outcome.meta ?? null);
    }

    logger.info("阶段执行成功", { taskId: task.id, stage: stage.stage, attempt: stage.attempts });
    return { ran: true, taskId: task.id, stage: stage.stage, status: "succeeded" };
  }

  return { runOnce, recover };
}
