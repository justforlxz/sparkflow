/**
 * 进程内 worker（ADR 0002）：与 web 进程同生命周期，轮询两类作业并逐条推进。
 *
 * 两条互不触发的作业链（docs/prd/12 MUST NOT）：
 * - 提取运行（`extraction_run`）：勾选的原图 × 类别；
 * - 文案版本（`copy_version`）：选中的素材 → 一次文案。
 *
 * 任意时刻只有一个作业在跑；一轮里把能跑的作业推到没有为止。启动顺序：先把上次残留的
 * `running` 记为失败，再进入轮询 —— 清理没完成之前绝不认领新作业。
 */
import { logger } from "@/lib/logger";
import { listGatewayViews } from "@/modules/gateway/service";
import { requireAgentSnapshotOf } from "@/modules/agent-config/service";
import { getAssetImage, getCollection } from "@/modules/media-collection/service";
import { getLibraryAssets, getLibraryImage } from "@/modules/extraction/service";
import { DEFAULT_POLL_INTERVAL_MS } from "@/modules/extraction/constants";
import { extractionStore } from "@/modules/extraction/repo";
import { createExtractionRunner, type ExtractionRunner } from "@/modules/extraction/runner";
import { libraryAssetWriter } from "@/modules/extraction/storage";
import type { CollectionContext, SourceImageBytes } from "@/modules/extraction/types";
import { createExtractionHandler } from "@/modules/image-generation/extraction";
import { createCopyHandler } from "@/modules/copy-generation/stage";
import { createCopyRunner, type CopyRunner } from "@/modules/copy-generation/runner";
import {
  claimNextVersion,
  failRunningVersions,
  markVersionFailed,
  markVersionSucceeded,
} from "@/modules/copy-generation/repo";
import type { CopyCollectionContext, SelectedAssetRef } from "@/modules/copy-generation/types";

/** 开发热重载会重复调用启动钩子；用全局标记保证一个进程只有一个循环。 */
const WORKER_FLAG = Symbol.for("sparkflow.worker");

interface WorkerGlobal {
  [WORKER_FLAG]?: boolean;
}

const workerGlobal = globalThis as WorkerGlobal;

/** 提取处理器要的来源信息与原图清单；图片字节按需逐张读（不一次性载入内存）。 */
export async function loadStageCollectionContext(collectionId: string): Promise<CollectionContext> {
  const collection = await getCollection(collectionId);
  return {
    id: collection.id,
    platform: collection.platform,
    sourceTitle: collection.sourceTitle,
    sourceBody: collection.sourceBody,
    assets: collection.assets.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
    })),
  };
}

/** 读一张原图的字节（鉴权读取用例走同一条路径）。照片属于总资源库，与资源夹无关（ADR 0012）。 */
export async function loadSourceImage(
  _collectionId: string,
  assetId: string,
): Promise<SourceImageBytes> {
  const asset = await getAssetImage(assetId);
  return { bytes: asset.bytes, mimeType: asset.mimeType };
}

/** 文案只读选中的素材（按版本里记录的顺序），已删除的自动缺席。 */
async function loadSelectedAssets(assetIds: readonly string[]): Promise<SelectedAssetRef[]> {
  const records = await getLibraryAssets(assetIds);
  const byId = new Map(records.map((record) => [record.id, record]));
  const selected: SelectedAssetRef[] = [];
  for (const assetId of assetIds) {
    const record = byId.get(assetId);
    if (record) {
      selected.push({
        id: record.id,
        category: record.category,
        fileName: record.fileName,
        mimeType: record.mimeType,
      });
    }
  }
  return selected;
}

async function loadCopyCollection(collectionId: string): Promise<CopyCollectionContext> {
  const collection = await getCollection(collectionId);
  return {
    id: collection.id,
    platform: collection.platform,
    sourceTitle: collection.sourceTitle,
    sourceBody: collection.sourceBody,
  };
}

/** 执行时现取图片 Agent 配置（`extraction_run` 不落 Agent 快照，PRD 12 的字段清单里没有）。 */
async function loadImageAgent() {
  return requireAgentSnapshotOf(await listGatewayViews(), "image");
}

function buildRunners(): { extraction: ExtractionRunner; copy: CopyRunner } {
  return {
    extraction: createExtractionRunner({
      store: extractionStore,
      files: libraryAssetWriter,
      handler: createExtractionHandler(),
      loadCollection: loadStageCollectionContext,
      loadSourceImage,
      loadAgent: loadImageAgent,
    }),
    copy: createCopyRunner({
      store: { claimNextVersion, markVersionSucceeded, markVersionFailed, failRunningVersions },
      handler: createCopyHandler(),
      loadCollection: loadCopyCollection,
      loadAssets: loadSelectedAssets,
      loadAssetImage: async (assetId: string) => {
        const image = await getLibraryImage(assetId);
        return { bytes: image.bytes, mimeType: image.mimeType };
      },
    }),
  };
}

export interface WorkerOptions {
  pollIntervalMs?: number;
  extraction?: ExtractionRunner;
  copy?: CopyRunner;
}

/** 启动 worker；返回停止函数。重复调用是幂等的（第二次直接返回空停止函数）。 */
export function startWorker(options: WorkerOptions = {}): () => void {
  if (workerGlobal[WORKER_FLAG]) return () => {};
  workerGlobal[WORKER_FLAG] = true;

  const runners = options.extraction && options.copy ? null : buildRunners();
  const extraction = options.extraction ?? (runners as NonNullable<typeof runners>).extraction;
  const copy = options.copy ?? (runners as NonNullable<typeof runners>).copy;
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let stopped = false;
  let working = false;

  const tick = async (): Promise<void> => {
    if (stopped || working) return;
    working = true;
    try {
      while (!stopped) {
        // 两类作业各认领各的队列，一次推进一条；两条都没活干就结束本轮。
        const extractionOutcome = await extraction.runOnce();
        if (stopped) break;
        const copyOutcome = await copy.runOnce();
        if (!extractionOutcome.ran && !copyOutcome.ran) break;
      }
    } catch (error) {
      // 数据库暂时不可达等问题：记日志，下个周期重试，不退出循环。
      logger.error("worker 轮询失败，下个周期重试", { error });
    } finally {
      working = false;
    }
  };
  // 启动清理必须先完成，轮询才能开始：清理会把库里所有 running 作业改成 failed，
  // 如果此时已经认领了新的作业，就会把它改判成失败，而它的处理器还在继续执行。
  let bootTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const boot = async (): Promise<void> => {
    bootTimer = undefined;
    if (stopped) return;

    try {
      await extraction.recover();
      await copy.recover();
    } catch (error) {
      logger.error("worker 启动清理失败，稍后重试", { error });
      if (!stopped) {
        bootTimer = setTimeout(() => void boot(), intervalMs);
        // 与轮询定时器同一条取舍：清理重试的等待也不该单独让进程活着。
        bootTimer.unref();
      }
      return;
    }

    if (stopped) return;
    pollTimer = setInterval(() => void tick(), intervalMs);
    // 计时器不该单独让进程活着：web 进程退出时 worker 一起停。
    pollTimer.unref();
    void tick();
  };

  void boot();

  return () => {
    stopped = true;
    if (bootTimer !== undefined) clearTimeout(bootTimer);
    if (pollTimer !== undefined) clearInterval(pollTimer);
    delete workerGlobal[WORKER_FLAG];
  };
}
