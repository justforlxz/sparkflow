/**
 * mock 出图适配器（`GENERATION_ADAPTER=mock`，docs/acceptance.md 第 2、3 节）：
 * 不调用任何上游，按脚本返回仓内的 1×1 PNG，供 CI 跑通任务链路、不消耗真实额度。
 *
 * 一次调用只回一张图（一图对一图，ADR 0008），与真实插件一致。
 * 失败路径按脚本触发：提示词里带 `mock:fail-image-all` 时每一次都失败，
 * 带 `mock:fail-image-at-<n>` 时只让第 n 次调用失败（验证 AC-LIB-2 的部分成功）。
 */
import { StageError } from "@/lib/job-failure";
import { MOCK_SCRIPT_HINTS, mockFailImageAt } from "../mock-script";
import type { GeneratedImage } from "./types";
import { IMAGE_ERROR_CODES, type GenerateImageInput, type ImageGenerator } from "./types";

/** 1×1 的 PNG：用例只关心「图片落盘且可读」，不关心像素。 */
const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export class MockImageGenerator implements ImageGenerator {
  /** 本次运行里第几次调用；一条运行一个实例，因此计数与「第几项」一致。 */
  private calls = 0;

  async generate(input: GenerateImageInput): Promise<GeneratedImage[]> {
    this.calls += 1;

    if (input.prompt.includes(MOCK_SCRIPT_HINTS.failImage)) {
      throw new StageError(IMAGE_ERROR_CODES.rejected, "mock：生图阶段按脚本失败");
    }

    const failAt = mockFailImageAt(input.prompt);
    if (failAt !== null && failAt === this.calls) {
      throw new StageError(IMAGE_ERROR_CODES.rejected, `mock：按脚本让第 ${failAt} 张原图失败`);
    }

    return [
      {
        bytes: PNG_ONE_PIXEL,
        mimeType: "image/png",
        // 不自带给展示名：文件名由 storage 按 `sort_order` 生成，e2e 看到的才是真实命名。
        width: 1,
        height: 1,
      },
    ];
  }
}
