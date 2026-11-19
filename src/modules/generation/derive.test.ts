import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  deriveRetryHint,
  deriveTaskStatus,
  planStagesToRetry,
  type AgentBindingState,
  type StageState,
} from "./derive";

/** 判定表逐行锁定（docs/prd/04「阶段与状态」）。 */
describe("任务状态派生（AC-04-2、AC-04-5）", () => {
  const statuses = (image: StageState["status"], copy: StageState["status"]): StageState[] => [
    { stage: "image", status: image },
    { stage: "copy", status: copy },
  ];

  it("两个阶段都成功 → succeeded", () => {
    expect(deriveTaskStatus(statuses("succeeded", "succeeded"))).toBe("succeeded");
  });

  it("生图成功、文案失败 → partial", () => {
    expect(deriveTaskStatus(statuses("succeeded", "failed"))).toBe("partial");
  });

  it("生图失败、文案保持排队 → failed", () => {
    expect(deriveTaskStatus(statuses("failed", "queued"))).toBe("failed");
  });

  it("两个阶段都失败 → failed", () => {
    expect(deriveTaskStatus(statuses("failed", "failed"))).toBe("failed");
  });

  it("任一阶段运行中 → running", () => {
    expect(deriveTaskStatus(statuses("running", "queued"))).toBe("running");
    expect(deriveTaskStatus(statuses("succeeded", "running"))).toBe("running");
  });

  it("生图成功、文案还没开始 → running（任务仍在推进）", () => {
    expect(deriveTaskStatus(statuses("succeeded", "queued"))).toBe("running");
  });

  it("两条阶段都没开始 → running", () => {
    expect(deriveTaskStatus(statuses("queued", "queued"))).toBe("running");
  });

  it("阶段记录缺失按排队处理，不把任务当成已完成", () => {
    expect(deriveTaskStatus([{ stage: "image", status: "succeeded" }])).toBe("running");
    expect(deriveTaskStatus([])).toBe("running");
  });
});

/** 重试语义（ADR 0005）：只挑失败阶段，没有失败阶段就 CONFLICT。 */
describe("重试只作用于失败阶段（AC-04-6、AC-04-7、AC-04-8、AC-05-12）", () => {
  it("partial 任务只重试文案阶段", () => {
    const stages: StageState[] = [
      { stage: "image", status: "succeeded" },
      { stage: "copy", status: "failed" },
    ];
    expect(planStagesToRetry(stages)).toEqual(["copy"]);
  });

  it("生图失败的任务只重试生图阶段", () => {
    const stages: StageState[] = [
      { stage: "image", status: "failed" },
      { stage: "copy", status: "queued" },
    ];
    expect(planStagesToRetry(stages)).toEqual(["image"]);
  });

  it("全部成功时返回 CONFLICT，并说明当前状态", () => {
    const stages: StageState[] = [
      { stage: "image", status: "succeeded" },
      { stage: "copy", status: "succeeded" },
    ];

    expect.assertions(4);
    try {
      planStagesToRetry(stages);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe("CONFLICT");
      expect(appError.details).toMatchObject({
        code: "NO_FAILED_STAGE",
        taskStatus: "succeeded",
      });
      expect(appError.message).toContain("没有失败的阶段");
    }
  });

  it("阶段已在排队（第一次重试之后）时再次重试返回 CONFLICT，不重复入队", () => {
    const stages: StageState[] = [
      { stage: "image", status: "succeeded" },
      { stage: "copy", status: "queued" },
    ];
    expect(() => planStagesToRetry(stages)).toThrowError(/没有失败的阶段/);
  });

  it("阶段正在执行时返回 CONFLICT", () => {
    const stages: StageState[] = [
      { stage: "image", status: "succeeded" },
      { stage: "copy", status: "running" },
    ];
    expect(() => planStagesToRetry(stages)).toThrowError(AppError);
  });
});

/**
 * 失败阶段上的重试说明（MKACG-904）：重试取的是任务快照，快照与当前配置不同就换警示文案。
 * 只比较失败阶段 —— 重试不碰已成功的阶段。
 */
describe("失败阶段上的重试说明（MKACG-904）", () => {
  const binding = (modelId: string | null, gatewayId = "gateway-1"): AgentBindingState => ({
    gatewayId,
    modelId,
  });
  const snapshot = { image: binding("image-model"), copy: binding("copy-model") };
  const imageFailed: StageState[] = [
    { stage: "image", status: "failed" },
    { stage: "copy", status: "queued" },
  ];

  it("没有失败阶段就没有重试入口，也不给说明", () => {
    const stages: StageState[] = [
      { stage: "image", status: "succeeded" },
      { stage: "copy", status: "succeeded" },
    ];
    expect(deriveRetryHint(stages, snapshot, snapshot)).toBeNull();
  });

  it("失败阶段的快照与当前配置一致时给普通说明", () => {
    expect(deriveRetryHint(imageFailed, snapshot, snapshot)).toBe("snapshot");
  });

  it("失败阶段换了模型时给警示", () => {
    const current = { ...snapshot, image: binding("sensenova-u1.5-lite") };
    expect(deriveRetryHint(imageFailed, snapshot, current)).toBe("snapshot-changed");
  });

  it("失败阶段换了网关时给警示", () => {
    const current = { ...snapshot, image: binding("image-model", "gateway-2") };
    expect(deriveRetryHint(imageFailed, snapshot, current)).toBe("snapshot-changed");
  });

  it("模型都留空视为一致，不当成改动", () => {
    const empty = { image: binding(null), copy: binding(null) };
    expect(deriveRetryHint(imageFailed, empty, empty)).toBe("snapshot");
  });

  it("只有已成功阶段的配置变了仍是普通说明（重试不碰它）", () => {
    const stages: StageState[] = [
      { stage: "image", status: "succeeded" },
      { stage: "copy", status: "failed" },
    ];
    const current = { ...snapshot, image: binding("another-image-model") };
    expect(deriveRetryHint(stages, snapshot, current)).toBe("snapshot");
  });
});
