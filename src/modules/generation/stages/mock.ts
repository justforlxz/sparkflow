/**
 * mock 阶段处理器（`GENERATION_ADAPTER=mock`，docs/acceptance.md 第 3 节）：
 * 不调用任何上游，按脚本返回固定文案，供自动化验收跑通任务链路。
 *
 * 生图阶段不需要单独的 mock 处理器：它的处理器在两种模式下是同一个，
 * 差别只在于内部按环境变量换成 `MockImageGenerator`（`src/modules/image-generation/service.ts`）。
 *
 * 失败路径按脚本触发：任务参数 `extraPrompt` 里带上下面几个标记之一，对应阶段就按约定失败。
 * 这样 e2e 能用真实请求驱动「生图失败」「某一张原图失败」「文案先失败后重试成功」，
 * 不需要测试接口或改环境变量。
 */
import { StageError, type StageContext, type StageHandler } from "../types";

export const MOCK_SCRIPT_HINTS = {
  /** 生图阶段直接失败：用来验证「失败时不创建结果」。 */
  failImage: "mock:fail-image-all",
  /** 只让第 n 张原图失败（后面接 `-<n>`）：验证 AC-05-5 的部分成功。 */
  failImageAt: "mock:fail-image-at",
  /** 文案阶段第一次失败、重试后成功：用来验证「只重试失败阶段」（AC-04-6）。 */
  failCopyOnce: "mock:fail-copy-once",
} as const;

/**
 * 从提示词里读「让第几张原图失败」。
 * 与 `failImage` 是两条独立标记：`mock:fail-image-at-2` 只让第 2 张失败，不会被当成整体失败。
 */
export function mockFailImageAt(prompt: string): number | null {
  const matched = new RegExp(`${MOCK_SCRIPT_HINTS.failImageAt}-(\\d+)`).exec(prompt);
  if (!matched) return null;
  const index = Number.parseInt(matched[1] ?? "", 10);
  return Number.isInteger(index) && index > 0 ? index : null;
}

function hasHint(context: StageContext, hint: string): boolean {
  return context.params.extraPrompt?.includes(hint) ?? false;
}

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
      meta: { model: "mock-copy", totalMs: 0, visualExtraction: "done", visualDescriptionCount: 0 },
    };
  },
};
