import { afterEach, describe, expect, it } from "vitest";
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
