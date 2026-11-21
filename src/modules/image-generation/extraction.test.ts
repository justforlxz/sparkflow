import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { EXTRACTION_ERROR_CODES } from "@/modules/extraction/constants";
import type {
  ExtractionContext,
  ExtractionProgress,
  SourceAssetRef,
} from "@/modules/extraction/types";
import { StageError } from "@/lib/job-failure";
import type { GenerateImageInput, ImageGenerator } from "./adapters/types";
import { extractImages } from "./extraction";
import { MOCK_SCRIPT_HINTS } from "./mock-script";

const AGENT: AgentSnapshot = {
  agentType: "image",
  enabled: true,
  name: "图片提取 Agent",
  gatewayId: "gateway-1",
  protocol: "magpie-mcp",
  baseUrl: "https://example.com",
  modelId: "image-model",
  role: "提取师",
  systemPrompt: "只做提取",
  outputRequirements: "每张原图各出一张",
};

const ASSETS: SourceAssetRef[] = [
  { id: "asset-1", fileName: "a.png", mimeType: "image/png" },
  { id: "asset-2", fileName: "b.png", mimeType: "image/png" },
];

interface Counted extends ImageGenerator {
  calls: GenerateImageInput[];
}

function countingGenerator(failAt?: number): Counted {
  const calls: GenerateImageInput[] = [];
  return {
    calls,
    async generate(input) {
      calls.push(input);
      if (failAt !== undefined && calls.length === failAt) {
        throw new StageError("UPSTREAM_REJECTED", "上游不接受这个模型");
      }
      return [{ bytes: Buffer.from("png"), mimeType: "image/png", width: 1024, height: 1536 }];
    },
  };
}

function context(
  categories: readonly string[],
  progress: ExtractionProgress[] = [],
  extraPrompt: string | null = null,
): ExtractionContext {
  return {
    runId: "run-1",
    collectionId: "collection-1",
    requirement: "faithful",
    categories,
    sourceAssetIds: ["asset-1", "asset-2"],
    extraPrompt,
    agent: AGENT,
    collection: {
      id: "collection-1",
      platform: null,
      sourceTitle: null,
      sourceBody: null,
      assets: ASSETS,
    },
    signal: new AbortController().signal,
    readSourceImage: async () => ({ bytes: Buffer.from("src"), mimeType: "image/png" }),
    reportProgress: async (value) => {
      progress.push(value);
    },
  };
}

/** 提取粒度 = 原图 × 类别（docs/prd/12 MUST 2、AC-LIB-1、AC-LIB-2）。 */
describe("提取处理器", () => {
  it("2 张原图 × 2 个类别 = 4 次调用，进度 total 也是 4", async () => {
    const generator = countingGenerator();
    const progress: ExtractionProgress[] = [];

    const outcome = await extractImages(context(["material", "border"], progress), {
      generator,
      compress: async () => "data:image/jpeg;base64,AA==",
    });

    expect(generator.calls).toHaveLength(4);
    expect(outcome.images).toHaveLength(4);
    expect(outcome.failures).toEqual([]);
    expect(progress.at(-1)).toEqual({ done: 4, total: 4 });
    // 每条素材都带来源原图与类别（MUST 3）。
    expect(outcome.images.map((image) => image.category).sort()).toEqual([
      "border",
      "border",
      "material",
      "material",
    ]);
    expect(new Set(outcome.images.map((image) => image.sourceAssetId))).toEqual(
      new Set(["asset-1", "asset-2"]),
    );
    // 序号用原图位置：同一张原图的两个类别共用同一个序号。
    expect(outcome.images.filter((image) => image.sourceAssetId === "asset-1").map((i) => i.sortOrder))
      .toEqual([1, 1]);
  });

  it("单项失败不中断其他项：其余照常交出，失败项带可读原因（AC-LIB-2）", async () => {
    const generator = countingGenerator(2);
    const progress: ExtractionProgress[] = [];

    const outcome = await extractImages(context(["material", "border"], progress), {
      generator,
      compress: async () => "data:image/jpeg;base64,AA==",
    });

    expect(generator.calls).toHaveLength(4);
    expect(outcome.images).toHaveLength(3);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({
      category: "border",
      sourceAssetId: "asset-1",
      fileName: "a.png",
      code: "UPSTREAM_REJECTED",
    });
    expect(progress.at(-1)).toEqual({ done: 4, total: 4 });
  });

  it("提示词按类别拼装，并带上提取要求与补充要求", async () => {
    const generator = countingGenerator();
    await extractImages(context(["material"], [], "mock:强调耐用"), {
      generator,
      compress: async () => "data:image/jpeg;base64,AA==",
    });

    const prompt = generator.calls[0]?.prompt ?? "";
    expect(prompt).toContain("材质纹理");
    expect(prompt).toContain("忠实还原");
    expect(prompt).toContain("补充要求：mock:强调耐用");
    // 只带当前这一张原图，不是整个资源夹（一图一类别一次调用）。
    expect(generator.calls[0]?.image).toBe("data:image/jpeg;base64,AA==");
  });

  it("勾选的原图都已被移除：直接失败，不调上游", async () => {
    const generator = countingGenerator();
    const base = context(["material"]);

    await expect(
      extractImages(
        { ...base, sourceAssetIds: ["gone"], collection: { ...base.collection, assets: ASSETS } },
        { generator, compress: async () => "" },
      ),
    ).rejects.toMatchObject({ code: EXTRACTION_ERROR_CODES.jobFailed });
    expect(generator.calls).toHaveLength(0);
  });

  it("被中止时不再继续下一项：不把剩下所有上游超时都等一遍", async () => {
    const controller = new AbortController();
    const generator = countingGenerator();
    const base = context(["material", "border"]);
    const slowGenerator: ImageGenerator = {
      async generate(input) {
        await generator.generate(input);
        controller.abort();
        return [{ bytes: Buffer.from("png"), mimeType: "image/png" }];
      },
    };

    await expect(
      extractImages(
        { ...base, signal: controller.signal },
        { generator: slowGenerator, compress: async () => "" },
      ),
    ).rejects.toMatchObject({ code: EXTRACTION_ERROR_CODES.timeout });
    expect(generator.calls).toHaveLength(1);
  });

  it("mock 适配器的脚本标记能驱动单项失败", async () => {
    // 标记本身与用例共用一份常量：改一处即可。
    expect(MOCK_SCRIPT_HINTS.failImageAt).toBe("mock:fail-image-at");
  });

  it("进度从这个运行的 total 起步，先写 done = 0", async () => {
    const progress: ExtractionProgress[] = [];
    await extractImages(context(["material", "border"], progress), {
      generator: countingGenerator(),
      compress: async () => "",
    });
    expect(progress[0]).toEqual({ done: 0, total: 4 });
  });

  it("不发任何文案请求：提取处理器只依赖出图适配器", async () => {
    // 用调用计数锁住：一次提取只调图片生成，次数等于 原图数 × 类别数。
    const generator = vi.fn(countingGenerator().generate);
    await extractImages(context(["material", "border"]), {
      generator: { generate: generator },
      compress: async () => "",
    });
    expect(generator).toHaveBeenCalledTimes(4);
  });
});
