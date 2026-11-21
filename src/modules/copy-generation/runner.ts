/**
 * 文案版本执行器：认领 → 调处理器 → 写三段文案 → 写终态。
 *
 * 与提取运行是两条独立的作业链（docs/prd/12 MUST NOT：跑文案不触发提取、跑提取不触发文案）：
 * 各自认领各自的表，互不读写对方的队列。轮询与进程生命周期在 `src/worker.ts`。
 */
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  JobTimeoutError,
  failureFrom,
  failureRecord,
  runWithTimeout,
  type FailureRecord,
} from "@/lib/job-failure";
import { DEFAULT_COPY_JOB_TIMEOUT_MS, COPY_JOB_ERROR_CODES } from "./constants";
import type {
  AssetImageBytes,
  CopyCollectionContext,
  CopyContent,
  CopyContext,
  CopyHandler,
  CopyVersionRecord,
  SelectedAssetRef,
} from "./types";

export interface CopyStore {
  claimNextVersion(now: Date): Promise<CopyVersionRecord | null>;
  markVersionSucceeded(
    versionId: string,
    copy: CopyContent,
    meta: Record<string, unknown> | null,
    now: Date,
  ): Promise<number>;
  markVersionFailed(versionId: string, error: FailureRecord, now: Date): Promise<number>;
  failRunningVersions(error: FailureRecord, now: Date): Promise<number>;
}

export interface CopyRunnerOptions {
  store: CopyStore;
  handler: CopyHandler;
  loadCollection: (collectionId: string) => Promise<CopyCollectionContext>;
  /** 按 id 取仍然存在的素材（按 `selectedAssetIds` 顺序，已删除的自动缺席）。 */
  loadAssets: (assetIds: readonly string[]) => Promise<SelectedAssetRef[]>;
  loadAssetImage: (assetId: string) => Promise<AssetImageBytes>;
  now?: () => Date;
  timeoutMs?: number;
}

export type CopyRunOutcome =
  | { ran: false }
  | { ran: true; versionId: string; status: "succeeded" | "failed" };

export interface CopyRunner {
  runOnce(): Promise<CopyRunOutcome>;
  recover(): Promise<number>;
}

export function createCopyRunner(options: CopyRunnerOptions): CopyRunner {
  const { store, handler, loadCollection, loadAssets, loadAssetImage } = options;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_COPY_JOB_TIMEOUT_MS;

  async function recover(): Promise<number> {
    const at = now();
    const count = await store.failRunningVersions(
      failureRecord(
        COPY_JOB_ERROR_CODES.serverRestarted,
        "服务重启，生成中的文案已中断，请重新生成",
        at,
      ),
      at,
    );
    if (count > 0) logger.warn("服务重启：把生成中的文案版本记为失败", { count });
    return count;
  }

  async function fail(version: CopyVersionRecord, error: FailureRecord): Promise<CopyRunOutcome> {
    const count = await store.markVersionFailed(version.id, error, now());
    if (count === 0) {
      logger.warn("文案版本的失败状态没有写入：该版本已不存在或已不是 running", {
        versionId: version.id,
      });
    }
    return { ran: true, versionId: version.id, status: "failed" };
  }

  async function runOnce(): Promise<CopyRunOutcome> {
    const version = await store.claimNextVersion(now());
    if (!version) return { ran: false };

    let collection: CopyCollectionContext;
    try {
      collection = await loadCollection(version.collectionId);
    } catch (error) {
      const record = failureFrom(error, now(), COPY_JOB_ERROR_CODES.jobFailed);
      const code = isAppError(error) && error.code === "NOT_FOUND" ? COPY_JOB_ERROR_CODES.inputMissing : record.code;
      return fail(version, { ...record, code });
    }

    // 选中的素材可能已被删除：只用还在的那些，一条都不剩就如实失败（MUST 4 的展示在版本侧做）。
    const assets = await loadAssets(version.selectedAssetIds);
    if (assets.length === 0) {
      return fail(
        version,
        failureRecord(
          COPY_JOB_ERROR_CODES.inputMissing,
          "这次选中的素材都已经删除，无法生成文案；请重新选择素材",
          now(),
        ),
      );
    }

    const controller = new AbortController();
    const context: CopyContext = {
      versionId: version.id,
      collectionId: version.collectionId,
      copyStyle: version.copyStyle,
      extraPrompt: version.extraPrompt,
      agent: version.agentSnapshot,
      collection,
      assets,
      signal: controller.signal,
      readAssetImage: (assetId: string) => loadAssetImage(assetId),
    };

    try {
      const outcome = await runWithTimeout(
        (signal) => handler.run({ ...context, signal }),
        timeoutMs,
        controller,
      );
      const count = await store.markVersionSucceeded(
        version.id,
        outcome.copy,
        outcome.meta ?? null,
        now(),
      );
      if (count === 0) {
        logger.warn("文案版本的成功状态没有写入：该版本已不存在或已不是 running", {
          versionId: version.id,
        });
      }
      logger.info("文案生成完成", { versionId: version.id, assets: assets.length });
      return { ran: true, versionId: version.id, status: "succeeded" };
    } catch (error) {
      const record =
        error instanceof JobTimeoutError
          ? failureRecord(COPY_JOB_ERROR_CODES.timeout, error.message, now())
          : failureFrom(error, now(), COPY_JOB_ERROR_CODES.jobFailed);
      logger.warn("文案生成失败", {
        versionId: version.id,
        code: record.code,
        message: record.message,
      });
      return fail(version, record);
    }
  }

  return { runOnce, recover };
}
