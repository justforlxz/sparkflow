/**
 * 提取运行执行器：认领 → 调处理器 → 落盘 + 入库 → 写终态。
 *
 * 边界（docs/prd/12 MUST 2）：
 * 1. 一项失败不影响其它项：成功项照常入库，整体记 `partial` 并带上逐项原因；
 * 2. 全部项都失败才记 `failed`，且不写任何素材；
 * 3. 落盘或写库失败按失败处理，不得把没写进去的产出说成成功。
 *
 * 这里只推进「一条运行」，轮询与进程生命周期在 `src/worker.ts`。
 */
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  JobTimeoutError,
  failureFrom,
  failureRecord,
  runWithTimeout,
  type FailureRecord,
} from "@/lib/job-failure";
import {
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  EXTRACTION_ERROR_CODES,
  type ExtractionStatus,
} from "./constants";
import type { ExtractionStore, LibraryWriter } from "./store";
import type {
  CollectionContext,
  ExtractionContext,
  ExtractionErrorRecord,
  ExtractionFailure,
  ExtractionHandler,
  ExtractionItemInput,
  ExtractionRunRecord,
  ExtractionOutcome,
  ExtractionSkip,
  LibraryAssetRecord,
  SourceImageBytes,
} from "./types";

export interface ExtractionRunnerOptions {
  store: ExtractionStore;
  files: LibraryWriter;
  handler: ExtractionHandler;
  /** 从资源夹模块取处理器要用的来源信息与原图清单（不直接查别的模块的表）。 */
  loadCollection: (collectionId: string) => Promise<CollectionContext>;
  /** 按 id 读一张原图的字节：逐张读，不把整个资源夹的图片一次性载入内存。 */
  loadSourceImage: (collectionId: string, assetId: string) => Promise<SourceImageBytes>;
  /**
   * 取执行时用的图片 Agent 快照。`extraction_run` 不落 Agent 快照（PRD 12 的字段清单里没有），
   * 因此每条运行执行时现取一次当前配置。
   */
  loadAgent: () => Promise<AgentSnapshot>;
  now?: () => Date;
  timeoutMs?: number;
}

export type ExtractionRunOutcome =
  | { ran: false }
  | { ran: true; runId: string; status: ExtractionStatus };

export interface ExtractionRunner {
  /** 推进一条运行；没有可跑的就是 `{ ran: false }`。 */
  runOnce(): Promise<ExtractionRunOutcome>;
  /** 启动时清理残留状态，返回值是改写的运行条数。 */
  recover(): Promise<number>;
}

/** 一项失败的说明：点名是哪张原图、哪个类别，不回显上游原文（已由适配器换成中文）。 */
function describeFailure(failure: ExtractionFailure, position: number): string {
  return `第 ${position} 项（${failure.fileName} · 类别 ${failure.category}）失败：${failure.message}`;
}

/**
 * 部分失败的整段说明：逐项点名，并说明保留了几条（AC-LIB-2）。
 *
 * `attempted` 是**发起过图生图的条目数**（成功 + 失败），不含 `skipped` ——
 * 判定为不存在的条目按设计不产出素材，把它算进分母会让「已保留 2/3」读起来像丢了一条。
 * 因此这里的分母与 `progress.total` 口径不同：后者是全部条目（含 skipped）。
 */
export function describePartialFailure(
  failures: readonly ExtractionFailure[],
  attempted: number,
  kept: number,
): string {
  const parts = failures.map((failure, index) => describeFailure(failure, index + 1));
  return `${parts.join("；")}。已保留 ${kept}/${attempted} 条素材`;
}

/** 全部失败的整段说明：同样逐项点名，并说明没有素材入库。 */
export function describeAllFailed(failures: readonly ExtractionFailure[]): string {
  const parts = failures.map((failure, index) => describeFailure(failure, index + 1));
  return `全部 ${failures.length} 项都未提取成功：${parts.join("；")}，没有素材入库`;
}

export function createExtractionRunner(options: ExtractionRunnerOptions): ExtractionRunner {
  const { store, files, handler, loadCollection, loadSourceImage, loadAgent } = options;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;

  async function recover(): Promise<number> {
    const at = now();
    const count = await store.failRunningRuns(
      failureRecord(
        EXTRACTION_ERROR_CODES.serverRestarted,
        "服务重启，执行中的提取已中断，请重新发起提取",
        at,
      ),
      at,
    );
    if (count > 0) logger.warn("服务重启：把执行中的提取运行记为失败", { count });
    return count;
  }

  /** 终态写入 0 行时必须留痕：运行行可能已被删除（资源夹被删），也可能被启动清理改判。 */
  async function finish(
    run: ExtractionRunRecord,
    status: ExtractionStatus,
    error: ExtractionErrorRecord | null,
  ): Promise<ExtractionRunOutcome> {
    const count = await store.finishRun(run.id, status, error, now());
    if (count === 0) {
      logger.warn("提取运行的终态没有写入：该运行已不存在或已不是 running", { runId: run.id });
    }
    return { ran: true, runId: run.id, status };
  }

  function withFailures(record: FailureRecord, failures: ExtractionFailure[]): ExtractionErrorRecord {
    return failures.length > 0 ? { ...record, failures } : record;
  }

  /**
   * 把这一批的三种结局都写成提取条目（ADR 0011 第 3 条）：
   * 成功的指向产出的素材，跳过的保存模型原话，失败的保存可读原因。
   *
   * 条目写库失败只记日志：运行终态是主记录，不能因为条目没写就把已经入库的素材说成失败。
   */
  async function recordItems(
    runId: string,
    stored: readonly LibraryAssetRecord[],
    failures: readonly ExtractionFailure[],
    skipped: readonly ExtractionSkip[],
  ): Promise<void> {
    if (stored.length === 0 && failures.length === 0 && skipped.length === 0) return;

    const at = now().toISOString();
    const items: ExtractionItemInput[] = [
      ...stored.map((asset) => ({
        sourceAssetId: asset.sourceAssetId,
        category: asset.category,
        status: "succeeded" as const,
        libraryAssetId: asset.id,
        skipReason: null,
        error: null,
      })),
      ...skipped.map((skip) => ({
        sourceAssetId: skip.sourceAssetId,
        category: skip.category,
        status: "skipped" as const,
        libraryAssetId: null,
        skipReason: skip.reason,
        error: null,
      })),
      ...failures.map((failure) => ({
        sourceAssetId: failure.sourceAssetId,
        category: failure.category,
        status: "failed" as const,
        libraryAssetId: null,
        skipReason: null,
        error: { code: failure.code, message: failure.message, at },
      })),
    ];

    try {
      await store.saveItems(runId, items);
    } catch (error) {
      logger.error("提取条目写库失败，运行终态已写出", { runId, error });
    }
  }
  async function runOnce(): Promise<ExtractionRunOutcome> {
    const run = await store.claimNextRun(now());
    if (!run) return { ran: false };

    let collection: CollectionContext;
    try {
      collection = await loadCollection(run.collectionId);
    } catch (error) {
      // 资源夹被删（外键级联已带走运行行）时给出明确子码；其它错误保留自己的分类。
      const record = failureFrom(error, now(), EXTRACTION_ERROR_CODES.jobFailed);
      const code =
        isAppError(error) && error.code === "NOT_FOUND"
          ? EXTRACTION_ERROR_CODES.collectionMissing
          : record.code;
      return finish(run, "failed", { ...record, code });
    }

    let agent: AgentSnapshot;
    try {
      agent = await loadAgent();
    } catch (error) {
      const record = failureFrom(error, now(), EXTRACTION_ERROR_CODES.jobFailed);
      logger.warn("读取图片 Agent 配置失败", { runId: run.id, code: record.code });
      return finish(run, "failed", record);
    }

    const controller = new AbortController();
    const context: ExtractionContext = {
      runId: run.id,
      collectionId: run.collectionId,
      requirement: run.requirement,
      categories: run.categories,
      sourceAssetIds: run.sourceAssetIds,
      extraPrompt: run.extraPrompt,
      agent,
      collection,
      signal: controller.signal,
      readSourceImage: (assetId: string) => loadSourceImage(run.collectionId, assetId),
      reportProgress: async (progress) => {
        // 进度写入失败不该让整条运行失败：界面最多少刷新一次。
        const written = await store.updateRunProgress(run.id, progress).catch((error) => {
          logger.warn("提取进度写入失败，已跳过", { runId: run.id, error });
          return 0;
        });
        if (written === 0) {
          logger.warn("提取进度没有写入：该运行已不在执行中", { runId: run.id });
        }
      },
    };

    let outcome: ExtractionOutcome;
    try {
      outcome = await runWithTimeout((signal) => handler.run({ ...context, signal }), timeoutMs, controller);
    } catch (error) {
      const record =
        error instanceof JobTimeoutError
          ? failureRecord(EXTRACTION_ERROR_CODES.timeout, error.message, now())
          : failureFrom(error, now(), EXTRACTION_ERROR_CODES.jobFailed);
      logger.warn("提取运行执行失败", { runId: run.id, code: record.code, message: record.message });
      return finish(run, "failed", record);
    }

    const images = outcome.images;
    const failures = outcome.failures;
    const skipped = outcome.skipped;

    // 全部条目都判定为不存在：不是失败，也没有素材产出（MUST 2c、AC-LIB-12）。
    if (images.length === 0 && failures.length === 0 && skipped.length > 0) {
      await recordItems(run.id, [], [], skipped);
      logger.info("提取运行没有可提取内容", { runId: run.id, skipped: skipped.length });
      return finish(run, "empty", null);
    }

    if (images.length === 0) {
      await recordItems(run.id, [], failures, skipped);
      const record = failureRecord(
        failures[0]?.code ?? EXTRACTION_ERROR_CODES.allFailed,
        failures.length > 0
          ? describeAllFailed(failures)
          : "本次提取没有产出任何素材，请重试或检查图片 Agent 配置",
        now(),
      );
      logger.warn("提取运行没有任何产出", { runId: run.id, total: run.sourceAssetIds.length });
      return finish(run, "failed", withFailures(record, failures));
    }

    let stored: LibraryAssetRecord[];
    try {
      const written = await files.write(run.id, images);
      stored = written.length > 0 ? await store.saveAssets(run.id, run.collectionId, written) : [];
      logger.info("提取运行完成", {
        runId: run.id,
        kept: stored.length,
        failed: failures.length,
        skipped: skipped.length,
      });
    } catch (error) {
      // 落盘或写库失败：如实失败，不能把没写进去的产出说成成功。
      await recordItems(run.id, [], failures, skipped);
      const record = failureFrom(error, now(), EXTRACTION_ERROR_CODES.jobFailed);
      logger.error("提取结果写库失败", { runId: run.id, error });
      return finish(run, "failed", record);
    }

    await recordItems(run.id, stored, failures, skipped);

    if (failures.length === 0) return finish(run, "succeeded", null);

    const partial: ExtractionErrorRecord = {
      ...failureRecord(
        EXTRACTION_ERROR_CODES.partial,
        describePartialFailure(failures, images.length + failures.length, images.length),
        now(),
      ),
      failures,
    };
    return finish(run, "partial", partial);
  }

  return { runOnce, recover };
}
