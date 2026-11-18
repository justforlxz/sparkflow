/**
 * mock 出图适配器（`GENERATION_ADAPTER=mock`，docs/acceptance.md 第 2、3 节）：
 * 不调用任何上游，按脚本返回仓内的 1×1 PNG，供 CI 跑通任务链路、不消耗真实额度。
 *
 * 失败路径也按脚本触发：提示词里带 `mock:fail-image`（`MOCK_SCRIPT_HINTS.failImage`）时整批失败，
 * 用来验证「生图失败不创建结果」（AC-05-11）。标记由 generation 模块统一定义，避免两处字面量漂移。
 */
import { MOCK_SCRIPT_HINTS } from "@/modules/generation/stages/mock";
import { StageError, type GeneratedImage } from "@/modules/generation/types";
import { IMAGE_ERROR_CODES, type GenerateImageInput, type ImageGenerator } from "./types";

/** 1×1 的 PNG：用例只关心「图片落盘且可读」，不关心像素。 */
const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export class MockImageGenerator implements ImageGenerator {
  async generate(input: GenerateImageInput): Promise<GeneratedImage[]> {
    if (input.prompt.includes(MOCK_SCRIPT_HINTS.failImage)) {
      throw new StageError(IMAGE_ERROR_CODES.rejected, "mock：生图阶段按脚本失败");
    }

    return Array.from({ length: input.n }, (_, index) => ({
      bytes: PNG_ONE_PIXEL,
      mimeType: "image/png",
      fileName: `mock-${index + 1}.png`,
      width: 1,
      height: 1,
    }));
  }
}
