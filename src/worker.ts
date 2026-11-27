/**
 * 进程内 worker（ADR 0002）：与 web 进程同生命周期，轮询提取作业并逐条推进。
 *
 * 作业链只剩一条（ADR 0012 第 3 条下线了文案与发布）：提取运行（`extraction_run`），
 * 勾选的原图 × 类别。
 *
 * 任意时刻只有一个作业在跑；一轮里把能跑的作业推到没有为止。启动顺序：先把上次残留的
 * `running` 记为失败，再进入轮询 —— 清理没完成之前绝不认领新作业。
 */
import { logger } from "@/lib/logger";
import { listGatewayViews } from "@/modules/gateway/service";
import { requireAgentSnapshotOf } from "@/modules/agent-config/service";
import {
  getAssetImage,
  getCollection,
  getRectifiedImage,
} from "@/modules/media-collection/service";
import { isAppError } from "@/lib/errors";
import { DEFAULT_POLL_INTERVAL_MS } from "@/modules/extraction/constants";
import { extractionStore } from "@/modules/extraction/repo";
import { createExtractionRunner, type ExtractionRunner } from "@/modules/extraction/runner";
import { libraryAssetWriter } from "@/modules/extraction/storage";
import type { CollectionContext, SourceImageBytes } from "@/modules/extraction/types";
import { createExtractionHandler } from "@/modules/image-generation/extraction";

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
      // 已保存的框选用途决定这一张走「矫正图当输入」还是「矫正图直接当产物」（MKACG-1001）。
      rectifiedKind: asset.quadKind,
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

/**
 * 读一张原图的**矫正图**字节（MKACG-1001）。没框选或矫正失败时返回 null：
 * 提取按「未校正」走原来的路径，不让一张图的框选问题挡住整条运行。
 */
export async function loadRectifiedImage(
  _collectionId: string,
  assetId: string,
): Promise<SourceImageBytes | null> {
  try {
    const rectified = await getRectifiedImage(assetId);
    return { bytes: rectified.bytes, mimeType: rectified.mimeType };
  } catch (error) {
    // 只有「还没有矫正图」是正常情形；其它错误（磁盘读失败）也退回原图，但记一条日志。
    if (!isAppError(error) || error.code !== "NOT_FOUND") {
      logger.warn("读取矫正图失败，按未校正处理", { assetId, error });
    }
    return null;
  }
}

/** 执行时现取图片 Agent 配置（`extraction_run` 不落 Agent 快照，PRD 12 的字段清单里没有）。 */
async function loadImageAgent() {
  return requireAgentSnapshotOf(await listGatewayViews(), "image");
}

function buildExtractionRunner(): ExtractionRunner {
  return createExtractionRunner({
    store: extractionStore,
    files: libraryAssetWriter,
    handler: createExtractionHandler(),
    loadCollection: loadStageCollectionContext,
    loadSourceImage,
    loadRectifiedImage,
    loadAgent: loadImageAgent,
  });
}

export interface WorkerOptions {
  pollIntervalMs?: number;
  extraction?: ExtractionRunner;
}

/** 启动 worker；返回停止函数。重复调用是幂等的（第二次直接返回空停止函数）。 */
export function startWorker(options: WorkerOptions = {}): () => void {
  if (workerGlobal[WORKER_FLAG]) return () => {};
  workerGlobal[WORKER_FLAG] = true;

  const extraction = options.extraction ?? buildExtractionRunner();
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let stopped = false;
  let working = false;

  const tick = async (): Promise<void> => {
    if (stopped || working) return;
    working = true;
    try {
      while (!stopped) {
        // 一次推进一条；没有活干就结束本轮。
        const extractionOutcome = await extraction.runOnce();
        if (!extractionOutcome.ran) break;
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
