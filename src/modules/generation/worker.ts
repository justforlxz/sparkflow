/**
 * 进程内 worker（ADR 0002）：与 web 进程同生命周期，轮询 `queued` 阶段，一次执行一个。
 *
 * 启动顺序：先把上次残留的 `running` 记为失败（`SERVER_RESTARTED`），再进入轮询；
 * 队列里有多条时连续推进，但任意时刻只有一个阶段在跑。轮询间隔与超时可注入，单测与验收用短值。
 */
import { logger } from "@/lib/logger";
import { getCollection } from "@/modules/media-collection/service";
import { DEFAULT_POLL_INTERVAL_MS } from "./constants";
import type { StageRegistry } from "./registry";
import { taskStore } from "./repo";
import { createRunner } from "./runner";
import { defaultStageRegistry } from "./stages";
import { resultAssetWriter } from "./storage";
import type { ResultAssetWriter, TaskStore } from "./store";
import type { CollectionContext } from "./types";

/** 开发热重载会重复调用启动钩子；用全局标记保证一个进程只有一个循环。 */
const WORKER_FLAG = Symbol.for("sparkflow.generation.worker");

interface WorkerGlobal {
  [WORKER_FLAG]?: boolean;
}

const workerGlobal = globalThis as WorkerGlobal;

export interface WorkerOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  registry?: StageRegistry;
  store?: TaskStore;
  files?: ResultAssetWriter;
  loadCollection?: (collectionId: string) => Promise<CollectionContext>;
}

/** 阶段处理器只需要来源信息与图片张数，不读原图字节（本版本不传参考图）。 */
export async function loadStageCollectionContext(collectionId: string): Promise<CollectionContext> {
  const collection = await getCollection(collectionId);
  return {
    id: collection.id,
    platform: collection.platform,
    sourceTitle: collection.sourceTitle,
    sourceBody: collection.sourceBody,
    assetCount: collection.assetCount,
  };
}

/** 启动 worker；返回停止函数。重复调用是幂等的（第二次直接返回空停止函数）。 */
export function startTaskWorker(options: WorkerOptions = {}): () => void {
  if (workerGlobal[WORKER_FLAG]) return () => {};
  workerGlobal[WORKER_FLAG] = true;

  const runner = createRunner({
    store: options.store ?? taskStore,
    files: options.files ?? resultAssetWriter,
    registry: options.registry ?? defaultStageRegistry(),
    loadCollection: options.loadCollection ?? loadStageCollectionContext,
    timeoutMs: options.timeoutMs,
  });
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let stopped = false;
  let working = false;

  const tick = async (): Promise<void> => {
    if (stopped || working) return;
    working = true;
    try {
      while (!stopped) {
        const outcome = await runner.runOnce();
        if (!outcome.ran) break;
      }
    } catch (error) {
      // 数据库暂时不可达等问题：记日志，下个周期重试，不退出循环。
      logger.error("worker 轮询失败，下个周期重试", { error });
    } finally {
      working = false;
    }
  };
  // 启动清理必须先完成，轮询才能开始：清理会把库里所有 running 阶段改成 failed，
  // 如果此时已经认领了新的阶段，就会把它改判成失败，而它的处理器还在继续执行。
  // 清理失败（数据库暂时不可达）时按同一间隔重试，绝不在没清理的情况下开始认领。
  let bootTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const boot = async (): Promise<void> => {
    bootTimer = undefined;
    if (stopped) return;

    try {
      await runner.recover();
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
