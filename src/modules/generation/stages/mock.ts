/**
 * mock 阶段处理器（`GENERATION_ADAPTER=mock`，docs/acceptance.md 第 3 节）：
 * 不调用任何上游，按脚本返回固定图片与文案，供自动化验收跑通任务链路。
 *
 * 失败路径也按脚本触发：任务参数 `extraPrompt` 里带上下面两个标记之一，对应阶段就按约定失败。
 * 这样 e2e 能用真实请求驱动「生图失败」「文案先失败后重试成功」，不需要测试接口或改环境变量。
 */
import { StageError, type StageContext, type StageHandler } from "../types";

/** 1×1 的 PNG：用例只关心「图片落盘且可读」，不关心像素。 */
const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export const MOCK_SCRIPT_HINTS = {
  /** 生图阶段直接失败：用来验证「失败时不创建结果」（AC-05-11）。 */
  failImage: "mock:fail-image",
  /** 文案阶段第一次失败、重试后成功：用来验证「只重试失败阶段」（AC-04-6）。 */
  failCopyOnce: "mock:fail-copy-once",
} as const;

function hasHint(context: StageContext, hint: string): boolean {
  return context.params.extraPrompt?.includes(hint) ?? false;
}

export const mockImageStage: StageHandler = {
  stage: "image",
  async run(context) {
    if (hasHint(context, MOCK_SCRIPT_HINTS.failImage)) {
      throw new StageError("UPSTREAM_REJECTED", "mock：生图阶段按脚本失败");
    }

    const count = context.params.imageCount;
    return {
      stage: "image",
      images: Array.from({ length: count }, (_, index) => ({
        bytes: PNG_ONE_PIXEL,
        mimeType: "image/png",
        fileName: `mock-${index + 1}.png`,
        width: 1,
        height: 1,
      })),
      meta: { model: "mock-image", batches: [{ n: count, ms: 0, ok: true }], totalMs: 0 },
    };
  },
};

export const mockCopyStage: StageHandler = {
  stage: "copy",
  async run(context) {
    if (hasHint(context, MOCK_SCRIPT_HINTS.failCopyOnce) && context.attempt <= 1) {
      throw new StageError("COPY_FORMAT", "mock：文案阶段按脚本失败（仅第一次）");
    }
    return {
      stage: "copy",
      copy: {
        title: "按脚本生成的标题",
        body: "这是一段由 mock 阶段处理器生成的正文，用于在不调用真实模型的情况下验证任务状态与产出写入。",
        tags: ["mock", "验收"],
      },
      meta: { model: "mock-copy", totalMs: 0 },
    };
  },
};
