/**
 * mock 出图适配器（`GENERATION_ADAPTER=mock`，docs/acceptance.md 第 2、3 节）：
 * 不调用任何上游，按请求的 `size` 生成一张纯色 PNG，供 CI 跑通任务链路、不消耗真实额度。
 *
 * 按请求尺寸出图（而不是固定 1×1）：AC-LIB-13 断言「3:2 原图产出长边 1536 的 3:2 图」，
 * 只有产物尺寸真的跟随请求才测得出「不拉伸」。
 *
 * 一次调用只回一张图（一图对一图，ADR 0008），与真实插件一致。
 * 失败路径按脚本触发：提示词里带 `mock:fail-image-all` 时每一次都失败，
 * 带 `mock:fail-image-at-<n>` 时只让第 n 次调用失败（验证 AC-LIB-2 的部分成功）。
 */
import sharp from "sharp";
import { StageError } from "@/lib/job-failure";
import { MOCK_SCRIPT_HINTS, mockFailImageAt } from "../mock-script";
import type { GeneratedImage } from "./types";
import { IMAGE_ERROR_CODES, type GenerateImageInput, type ImageGenerator } from "./types";

/** 上游没给尺寸时用的兜底（与真实适配器省略 `size` 时的语义一致）。 */
const FALLBACK_EDGE = 1024;

/** `"1536x1024"` → `{ width, height }`；解析不出来时退回正方形。 */
function parseMockSize(size: string | null): { width: number; height: number } {
  const matched = size ? /^(\d+)x(\d+)$/.exec(size.trim()) : null;
  if (!matched) return { width: FALLBACK_EDGE, height: FALLBACK_EDGE };
  return { width: Number(matched[1]), height: Number(matched[2]) };
}

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

    const { width, height } = parseMockSize(input.size);
    const bytes = await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();

    return [
      {
        bytes,
        mimeType: "image/png",
        // 不自带给展示名：文件名由 storage 按 `sort_order` 生成，e2e 看到的才是真实命名。
        width,
        height,
      },
    ];
  }
}
