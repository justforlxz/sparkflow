import { afterEach, describe, expect, it, vi } from "vitest";
import { createStageRegistry } from "./registry";
import type { ResultAssetWriter, TaskStore } from "./store";
import type { CollectionContext } from "./types";
import { startTaskWorker } from "./worker";

/**
 * worker 的启动顺序（ADR 0002、AC-04-10 的边界）：
 * 启动清理会把库里所有 `running` 阶段改成失败，所以**认领必须等清理结束**；
 * 清理失败时只重试清理，绝不提前开始认领，否则会把刚认领、正在执行的阶段改判成失败。
 */

const COLLECTION: CollectionContext = {
  id: "collection-1",
  platform: null,
  sourceTitle: null,
  sourceBody: null,
  assetCount: 1,
};

const files: ResultAssetWriter = { write: async () => [] };
const registry = createStageRegistry([]);

let stopWorker: (() => void) | undefined;

afterEach(() => {
  stopWorker?.();
  stopWorker = undefined;
  vi.restoreAllMocks();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("worker 启动顺序", () => {
  it("启动清理没结束前不认领阶段", async () => {
    let releaseRecover: () => void = () => {};
    const recoverGate = new Promise<void>((resolve) => {
      releaseRecover = resolve;
    });
    let claims = 0;

    const store = {
      failRunningStages: async () => {
        await recoverGate;
        return 1;
      },
      claimNextStage: async () => {
        claims += 1;
        return null;
      },
    } as unknown as TaskStore;

    stopWorker = startTaskWorker({
      store,
      files,
      registry,
      loadCollection: async () => COLLECTION,
      pollIntervalMs: 10,
    });

    // 清理一直挂着：给足轮询周期，也不能认领。
    await sleep(80);
    expect(claims).toBe(0);

    releaseRecover();
    await sleep(80);
    expect(claims).toBeGreaterThan(0);
  });

  it("启动清理失败时只重试清理，清理成功前不认领", async () => {
    let recoverAttempts = 0;
    const claimsBeforeRecover: boolean[] = [];
    let recovered = false;

    const store = {
      failRunningStages: async () => {
        recoverAttempts += 1;
        if (recoverAttempts < 3) throw new Error("数据库暂时不可达");
        recovered = true;
        return 1;
      },
      claimNextStage: async () => {
        claimsBeforeRecover.push(!recovered);
        return null;
      },
    } as unknown as TaskStore;

    stopWorker = startTaskWorker({
      store,
      files,
      registry,
      loadCollection: async () => COLLECTION,
      pollIntervalMs: 10,
    });

    await sleep(150);

    expect(recoverAttempts).toBeGreaterThanOrEqual(3);
    expect(claimsBeforeRecover.length).toBeGreaterThan(0);
    // 任何一次认领发生时，清理都必须已经成功过。
    expect(claimsBeforeRecover.every((claimedBeforeRecover) => claimedBeforeRecover === false)).toBe(
      true,
    );
  });
});

interface FakeTimer {
  run: () => void;
  unref: ReturnType<typeof vi.fn>;
}

function fakeTimerFactory(created: FakeTimer[]) {
  return ((callback: () => void) => {
    const timer: FakeTimer = { run: callback, unref: vi.fn() };
    created.push(timer);
    return timer;
  }) as unknown as typeof globalThis.setTimeout;
}

/** 让 boot() 里的 await 链跑完：只用微任务，不依赖真实时间。 */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

/**
 * AC-FIX-4：worker 的两处定时器（启动清理重试的 `setTimeout`、轮询的 `setInterval`）
 * 都要 `unref()`，否则它们的等待会单独让 web 进程活着，服务无法正常退出。
 */
describe("worker 定时器（AC-FIX-4）", () => {
  it("启动清理重试与轮询的定时器都调用 unref，不阻止进程退出", async () => {
    const timeouts: FakeTimer[] = [];
    const intervals: FakeTimer[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(fakeTimerFactory(timeouts));
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      fakeTimerFactory(intervals) as unknown as typeof globalThis.setInterval,
    );

    let recoverAttempts = 0;
    const store = {
      failRunningStages: async () => {
        recoverAttempts += 1;
        if (recoverAttempts === 1) throw new Error("数据库暂时不可达");
        return 0;
      },
      claimNextStage: async () => null,
    } as unknown as TaskStore;

    stopWorker = startTaskWorker({
      store,
      files,
      registry,
      loadCollection: async () => COLLECTION,
      pollIntervalMs: 10,
    });

    // 第一次清理失败：排下一次清理，这个等待不该拖住进程。
    await flushMicrotasks();
    expect(recoverAttempts).toBe(1);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].unref).toHaveBeenCalledTimes(1);
    expect(intervals).toHaveLength(0);

    // 第二次清理成功：进入轮询，轮询间隔同样不该拖住进程。
    timeouts[0].run();
    await flushMicrotasks();
    expect(recoverAttempts).toBe(2);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].unref).toHaveBeenCalledTimes(1);
  });
});
