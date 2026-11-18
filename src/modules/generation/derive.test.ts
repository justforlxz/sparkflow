import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { deriveTaskStatus, planStagesToRetry, type StageState } from "./derive";

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
