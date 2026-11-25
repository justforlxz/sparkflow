import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { EXTRACTION_ERROR_CODES } from "@/modules/extraction/constants";
import type {
  ExtractionContext,
  ExtractionProgress,
  SourceAssetRef,
} from "@/modules/extraction/types";
import { findCategory } from "@/modules/extraction/categories";
import type { VisionAnalyzer } from "@/modules/gateway/vision";
import { StageError } from "@/lib/job-failure";
import type { GenerateImageInput, ImageGenerator } from "./adapters/types";
import { extractImages } from "./extraction";
import { MATERIAL_PROMPT_MARK } from "./material";
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
      return [{ bytes: Buffer.from("png"), mimeType: "image/png", width: 1536, height: 1024 }];
    },
  };
}

/**
 * 假视觉判定：默认每个条目都「存在」；`absent` 里的类别 key 回「不存在」。
 * 记录每次判定的提示词，用来断言判定确实发生在图生图之前。
 *
 * 按 `presenceQuestion` 认类别（MUST 2b-1：判定问的是主体存不存在，不是产物形态）。
 */
interface CountedVision extends VisionAnalyzer {
  /** 判定问法的提示词（不含材质描述那一类）。 */
  prompts: string[];
  /** 材质描述的提示词：与判定分开记，用来断言「先判定、再要材质描述」。 */
  materialPrompts: string[];
}

function vision(
  absent: readonly string[] = [],
  options: { materialFails?: boolean } = {},
): CountedVision {
  const prompts: string[] = [];
  const materialPrompts: string[] = [];
  return {
    prompts,
    materialPrompts,
    async analyzeImage(input) {
      // 材质描述是另一类调用（MKACG-1000）：单独记，不占判定序号。
      if (input.prompt.includes(MATERIAL_PROMPT_MARK)) {
        materialPrompts.push(input.prompt);
        if (options.materialFails) throw new Error("图片理解网关返回 500");
        return "深灰色织物，表面有细密斜纹";
      }
      prompts.push(input.prompt);
      const missing = absent.some((value) => {
        const question = findCategory(value)?.presenceQuestion;
        return question !== undefined && input.prompt.includes(question);
      });
      return missing ? "不存在：画面里没有这个目标" : "存在：目标位于画面中央";
    },
  };
}

function context(
  categories: readonly string[],
  progress: ExtractionProgress[] = [],
  extraPrompt: string | null = null,
  currentKeys: Array<string | null> = [],
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
    reportProgress: async (value, currentItemKey) => {
      progress.push(value);
      currentKeys.push(currentItemKey);
    },
  };
}

/** 单测注入：跳过 sharp，直接给出固定的原图尺寸（3:2）。 */
const readSize = async () => ({ width: 900, height: 600 });
const compress = async () => "data:image/jpeg;base64,AA==";

/** 单测注入：默认「去水印成功且字节不变」，这样不用真 sharp 也能断言后处理的三种结局。 */
const watermark = async (bytes: Buffer) => ({
  bytes,
  removed: true,
  note: null,
  subjectRatio: 0,
});

function deps(generator: ImageGenerator, absent: readonly string[] = []) {
  return { generator, vision: vision(absent), compress, readSize, watermark };
}

/** 提取粒度 = 原图 × 类别（docs/prd/12 MUST 2、AC-LIB-1、AC-LIB-2）。 */
describe("提取处理器", () => {
  it("2 张原图 × 2 个类别 = 4 次调用，进度 total 也是 4", async () => {
    const generator = countingGenerator();
    const progress: ExtractionProgress[] = [];

    const outcome = await extractImages(context(["topdown", "texture"], progress), deps(generator));

    expect(generator.calls).toHaveLength(4);
    expect(outcome.images).toHaveLength(4);
    expect(outcome.failures).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(progress.at(-1)).toEqual({ done: 4, total: 4 });
    // 每条素材都带来源原图与类别（MUST 3）。
    expect(outcome.images.map((image) => image.category).sort()).toEqual([
      "texture",
      "texture",
      "topdown",
      "topdown",
    ]);
    expect(new Set(outcome.images.map((image) => image.sourceAssetId))).toEqual(
      new Set(["asset-1", "asset-2"]),
    );
    // 序号用原图位置：同一张原图的两个类别共用同一个序号。
    expect(outcome.images.filter((image) => image.sourceAssetId === "asset-1").map((i) => i.sortOrder))
      .toEqual([1, 1]);
  });

  it("进度写入同时带出「正在处理的那一格」：随处理顺序前移，全部轮完清空（MKACG-999）", async () => {
    const generator = countingGenerator();
    const progress: ExtractionProgress[] = [];
    const currentKeys: Array<string | null> = [];

    await extractImages(
      context(["topdown", "texture"], progress, null, currentKeys),
      deps(generator),
    );

    // 2 张原图 × 2 个类别：先指向第一格，每做完一格指向下一格；最后一格做完仍指向它，
    // 运行进终态时才清空（运行期间始终恰好一格「处理中」）。
    expect(currentKeys).toEqual([
      "asset-1|topdown",
      "asset-1|texture",
      "asset-2|topdown",
      "asset-2|texture",
      "asset-2|texture",
    ]);
  });

  it("单项失败不中断其他项：其余照常交出，失败项带可读原因（AC-LIB-2）", async () => {
    const generator = countingGenerator(2);
    const progress: ExtractionProgress[] = [];

    const outcome = await extractImages(context(["topdown", "texture"], progress), deps(generator));

    // 第 2 次调用抛错：4 次调用都发生了，但只有 3 条产出。
    expect(generator.calls).toHaveLength(4);
    expect(outcome.images).toHaveLength(3);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({
      category: "texture",
      sourceAssetId: "asset-1",
      fileName: "a.png",
      code: "UPSTREAM_REJECTED",
    });
    expect(progress.at(-1)).toEqual({ done: 4, total: 4 });
  });

  it("生图提示词按类别拼装：带 description（产物形态）、提取要求与补充要求", async () => {
    const generator = countingGenerator();
    await extractImages(context(["topdown"], [], "mock:强调耐用"), deps(generator));

    const prompt = generator.calls[0]?.prompt ?? "";
    expect(prompt).toContain("桌面俯视图");
    // 只有 `promptDescription`（给模型的产物形态描述）进生图提示词（MUST 2b-1、AC-PROMPT-6）。
    expect(prompt).toContain(findCategory("topdown")?.promptDescription);
    expect(prompt).not.toContain(findCategory("topdown")?.description);
    expect(prompt).toContain("忠实还原");
    expect(prompt).toContain("补充要求：mock:强调耐用");
    // 只带当前这一张原图，不是整个资源夹（一图一类别一次调用）。
    expect(generator.calls[0]?.image).toBe("data:image/jpeg;base64,AA==");
  });

  it("尺寸按原图长宽比推导：3:2 原图请求 1536x1024（AC-LIB-13）", async () => {
    const generator = countingGenerator();
    await extractImages(context(["topdown"]), deps(generator));

    expect(generator.calls[0]?.size).toBe("1536x1024");
  });

  it("判定为不存在：记 skipped、保存模型原话、不发起图生图（AC-LIB-11）", async () => {
    const generator = countingGenerator();
    const progress: ExtractionProgress[] = [];

    const outcome = await extractImages(
      context(["graphic"], progress),
      deps(generator, ["graphic"]),
    );

    // 关键断言：图生图调用计数为 0。
    expect(generator.calls).toHaveLength(0);
    expect(outcome.images).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.skipped).toHaveLength(2);
    expect(outcome.skipped[0]).toMatchObject({
      category: "graphic",
      sourceAssetId: "asset-1",
      reason: "不存在：画面里没有这个目标",
    });
    // 跳过的条目也算处理完：进度照常推进到总数。
    expect(progress.at(-1)).toEqual({ done: 2, total: 2 });
  });

  it("先判定再提取：每个条目都先问一次视觉模型，存在时才调图生图", async () => {
    const generator = countingGenerator();
    const judge = vision(["texture"]);

    const outcome = await extractImages(context(["topdown", "texture"]), {
      generator,
      vision: judge,
      compress,
      readSize,
    });

    // 2 张原图 × 2 个类别 = 4 次判定；只有 topdown 的 2 条发起图生图。
    expect(judge.prompts).toHaveLength(4);
    expect(generator.calls).toHaveLength(2);
    expect(outcome.skipped.map((skip) => skip.category)).toEqual(["texture", "texture"]);
    // 判定提示词要求模型用固定的两个词回答。
    expect(judge.prompts[0]).toContain("只回答「存在」或「不存在」");
    // 判定问的是原图里有没有主体，不是产物形态（MUST 2b-1、AC-LIB-16）。
    expect(judge.prompts[0]).toContain(findCategory("topdown")?.presenceQuestion);
    expect(judge.prompts[0]).not.toContain(findCategory("topdown")?.promptDescription);
    // 判定为不存在的类别不发起材质描述：只有 topdown 的 2 条要了描述（AC-PROMPT-3）。
    expect(judge.materialPrompts).toHaveLength(2);
    expect(judge.materialPrompts[0]).toContain(MATERIAL_PROMPT_MARK);
  });

  it("AC-PROMPT-3 判定存在后先要一句材质描述，作为 Material 段拼进生图提示词", async () => {
    const generator = countingGenerator();
    const judge = vision();

    await extractImages(context(["topdown"]), {
      generator,
      vision: judge,
      compress,
      readSize,
    });

    expect(judge.materialPrompts).toHaveLength(2);
    const prompt = generator.calls[0]?.prompt ?? "";
    expect(prompt).toContain("Material: 深灰色织物，表面有细密斜纹");
    // 材质描述排在提取要求之前：先说清是什么材质，再说按哪种要求处理。
    expect(prompt.indexOf("Material: ")).toBeLessThan(prompt.indexOf("提取要求："));
  });

  it("AC-PROMPT-3 材质描述失败不阻断提取：该段缺席，素材照常产出", async () => {
    const generator = countingGenerator();
    const judge = vision([], { materialFails: true });

    const outcome = await extractImages(context(["topdown"]), {
      generator,
      vision: judge,
      compress,
      readSize,
    });

    // 关键断言：拿不到描述只是少一段提示词，不记失败、不影响产出。
    expect(judge.materialPrompts).toHaveLength(2);
    expect(outcome.failures).toEqual([]);
    expect(outcome.images).toHaveLength(2);
    expect(generator.calls).toHaveLength(2);
    for (const call of generator.calls) {
      expect(call.prompt).not.toContain("Material:");
    }
  });

  it("没有可用的理解网关：按失败处理，不跳过判定直接提取", async () => {
    const generator = countingGenerator();
    const outcome = await extractImages(context(["topdown"]), {
      generator,
      vision: null,
      compress,
      readSize,
    });

    expect(generator.calls).toHaveLength(0);
    expect(outcome.images).toEqual([]);
    expect(outcome.failures[0]).toMatchObject({
      category: "topdown",
      code: EXTRACTION_ERROR_CODES.visionFailed,
    });
    expect(outcome.failures[0]?.message).toContain("magpie-vision");
  });

  it("判定回复里没有「存在 / 不存在」：如实失败，不替模型下结论", async () => {
    const generator = countingGenerator();
    const outcome = await extractImages(context(["topdown"]), {
      generator,
      vision: { analyzeImage: async () => "看起来像是有的" },
      compress,
      readSize,
    });

    expect(generator.calls).toHaveLength(0);
    expect(outcome.failures[0]?.code).toBe(EXTRACTION_ERROR_CODES.visionFailed);
    expect(outcome.failures[0]?.message).toContain("看起来像是有的");
  });

  it("勾选的原图都已被移除：直接失败，不调上游", async () => {
    const generator = countingGenerator();
    const base = context(["topdown"]);

    await expect(
      extractImages(
        { ...base, sourceAssetIds: ["gone"], collection: { ...base.collection, assets: ASSETS } },
        deps(generator),
      ),
    ).rejects.toMatchObject({ code: EXTRACTION_ERROR_CODES.jobFailed });
    expect(generator.calls).toHaveLength(0);
  });

  it("被中止时不再继续下一项：不把剩下所有上游超时都等一遍", async () => {
    const controller = new AbortController();
    const generator = countingGenerator();
    const base = context(["topdown", "texture"]);
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
        { generator: slowGenerator, vision: vision(), compress, readSize, watermark },
      ),
    ).rejects.toMatchObject({ code: EXTRACTION_ERROR_CODES.timeout });
    expect(generator.calls).toHaveLength(1);
  });

  it("mock 适配器的脚本标记能驱动单项失败", async () => {
    // 标记本身与用例共用一份常量：改一处即可。
    expect(MOCK_SCRIPT_HINTS.failImageAt).toBe("mock:fail-image-at");
    expect(MOCK_SCRIPT_HINTS.visionAbsentAll).toBe("mock:vision-absent-all");
  });

  it("进度从这个运行的 total 起步，先写 done = 0", async () => {
    const progress: ExtractionProgress[] = [];
    await extractImages(context(["topdown", "texture"], progress), deps(countingGenerator()));
    expect(progress[0]).toEqual({ done: 0, total: 4 });
  });

  it("不发任何文案请求：提取处理器只依赖出图适配器", async () => {
    // 用调用计数锁住：一次提取只调图片生成，次数等于 原图数 × 类别数。
    const generator = vi.fn(countingGenerator().generate);
    await extractImages(context(["topdown", "texture"]), {
      generator: { generate: generator },
      vision: vision(),
      compress,
      readSize,
      watermark,
    });
    expect(generator).toHaveBeenCalledTimes(4);
  });
});

/**
 * 去水印后处理（MKACG-1004）：出图后、入库前处理一次，三种结局都不阻断提取。
 * 后处理本身的行为由 `watermark.test.ts` 覆盖；这里只锁处理器怎么用它、怎么标注素材。
 */
describe("去水印后处理（MKACG-1004）", () => {
  it("AC-WM-3 安全检测拒绝时：原图字节照常交出，标成未去水印并带上原因", async () => {
    const reason = "未去水印：底部 10% 条带里主体像素占 80.0%，裁掉会切掉主体，已保留原图";

    const outcome = await extractImages(context(["topdown"]), {
      ...deps(countingGenerator()),
      watermark: async (bytes) => ({
        bytes,
        removed: false,
        note: reason,
        subjectRatio: 0.8,
      }),
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.images).toHaveLength(2);
    for (const image of outcome.images) {
      expect(image.watermarkRemoved).toBe(false);
      expect(image.watermarkNote).toBe(reason);
      // 产物仍是上游给的原图：没有被换成处理后的字节。
      expect(image.bytes.equals(Buffer.from("png"))).toBe(true);
    }
  });

  it("AC-WM-4 后处理抛错时：提取仍成功，产物是原图，标成未去水印并写明原因", async () => {
    const outcome = await extractImages(context(["topdown", "texture"]), {
      ...deps(countingGenerator()),
      watermark: async () => {
        throw new Error("输入缓冲区不是受支持的图片");
      },
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.images).toHaveLength(4);
    for (const image of outcome.images) {
      expect(image.watermarkRemoved).toBe(false);
      expect(image.watermarkNote).toContain("未去水印");
      expect(image.watermarkNote).toContain("后处理失败");
      expect(image.bytes.equals(Buffer.from("png"))).toBe(true);
    }
  });

  it("去水印成功时：落库用的是处理后的字节，注明已去掉水印", async () => {
    const processed = Buffer.from("processed-png");

    const outcome = await extractImages(context(["topdown"]), {
      ...deps(countingGenerator()),
      watermark: async () => ({ bytes: processed, removed: true, note: null, subjectRatio: 0 }),
    });

    expect(outcome.images).toHaveLength(2);
    for (const image of outcome.images) {
      expect(image.bytes.equals(processed)).toBe(true);
      expect(image.watermarkRemoved).toBe(true);
      expect(image.watermarkNote).toBeNull();
    }
  });

  it("后处理只对成功产出的条目调用：判定为不存在的不处理", async () => {
    const processed: Buffer[] = [];

    const outcome = await extractImages(context(["topdown"]), {
      ...deps(countingGenerator(), ["topdown"]),
      watermark: async (bytes) => {
        processed.push(bytes);
        return { bytes, removed: true, note: null, subjectRatio: 0 };
      },
    });

    // 两张原图 × 1 个类别，全部判定为不存在：一件产物都没有，也就没有后处理。
    expect(outcome.images).toEqual([]);
    expect(outcome.skipped).toHaveLength(2);
    expect(processed).toEqual([]);
  });
});
