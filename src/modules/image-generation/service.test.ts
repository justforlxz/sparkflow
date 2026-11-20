import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { MOCK_SCRIPT_HINTS } from "@/modules/generation/stages/mock";
import { StageError, type GeneratedImage, type StageContext } from "@/modules/generation/types";
import type { GenerateImageInput, ImageGenerator } from "./adapters/types";
import { MagpieImageGenerator } from "./adapters/magpie-mcp";
import { createImageGenerator, generateImages, resolveImageGenerator } from "./service";

// 真实模式要查网关密钥：单测把这一层换成可注入的桩，其余逻辑仍是真实实现。
vi.mock("@/modules/gateway/service", () => ({ getGatewayExecutionTarget: vi.fn() }));
const { getGatewayExecutionTarget: mockedGetGatewayTarget } = await import(
  "@/modules/gateway/service"
);
const getTarget = vi.mocked(mockedGetGatewayTarget);

// `resolveImageGenerator` 读环境变量决定适配器；单测只需要能通过环境校验。
process.env.DATABASE_URL ??= "postgresql://localhost:5432/sparkflow_test";
process.env.AUTH_SECRET ??= "unit-test-auth-secret-at-least-32-characters";
process.env.GENERATION_ADAPTER = "real";

/**
 * 图片创作业务层（docs/prd/05 MUST 1、2、4、5、7、9；AC-05-1、AC-05-3、AC-05-5）：
 *
 * 适配器一律注入假实现：这里验证的是「一图对一图、模型取快照、进度、失败如实记录、日志不含密钥」。
 * 上游协议本身由 `adapters/magpie-edit.test.ts` 覆盖，压缩规则由 `compress.test.ts` 覆盖。
 */

const API_KEY = "sk-test-local-do-not-use-1234";

const IMAGE_AGENT: AgentSnapshot = {
  agentType: "image",
  enabled: true,
  name: "图片提取 Agent",
  gatewayId: "gateway-1",
  protocol: "magpie-mcp",
  baseUrl: "https://magpie.example.com",
  modelId: null,
  role: "你是生活方式图片创作者",
  systemPrompt: "画面干净，主体明确",
  outputRequirements: "竖版，适合手机浏览",
};

const COPY_AGENT: AgentSnapshot = {
  ...IMAGE_AGENT,
  agentType: "copy",
  name: "文案创作 Agent",
  protocol: "openai-chat",
  modelId: "text-model",
};

interface ContextOverrides {
  /** 这次资源夹里有几张原图（提取图张数 = 它）。 */
  assetCount?: number;
  extractRequirement?: string;
  /** 快照里的提取目标；传 null 模拟 ADR 0009 之前的旧任务。 */
  extractTarget?: string | null;
  extraPrompt?: string | null;
  imageModel?: string | null;
}

/** 记住要读哪几张原图：读原图这一步由 runner 提供，单测直接回字节。 */
function buildContext(overrides: ContextOverrides = {}): StageContext {
  const assetCount = overrides.assetCount ?? 3;
  return {
    taskId: "task-1",
    attempt: 1,
    params: {
      extractRequirement: overrides.extractRequirement ?? "faithful",
      copyStyle: "story",
      extraPrompt: overrides.extraPrompt ?? null,
    },
    agents: {
      image: { ...IMAGE_AGENT, modelId: overrides.imageModel ?? null },
      copy: COPY_AGENT,
      extractTarget:
        overrides.extractTarget === undefined ? "桌垫的织物纹理" : overrides.extractTarget,
    },
    collection: {
      id: "collection-1",
      platform: "小红书",
      sourceTitle: "原始标题",
      sourceBody: "原始文案",
      extractTarget: "桌垫的织物纹理",
      assets: Array.from({ length: assetCount }, (_, index) => ({
        id: `source-${index + 1}`,
        fileName: `${String.fromCharCode(97 + index)}.png`,
        mimeType: "image/png",
      })),
    },
    resultId: null,
    signal: new AbortController().signal,
    readSourceImage: async (assetId: string) => ({
      bytes: Buffer.from(`raw-of-${assetId}`),
      mimeType: "image/png",
    }),
    reportProgress: async (progress) => {
      progressLog.push(progress);
    },
  };
}

/** 记录进度上报；每个用例自己决定要不要收集。 */
let progressLog: { done: number; total: number }[] = [];

function pngImage(index: number): GeneratedImage {
  return { bytes: Buffer.from(`image-${index}`), mimeType: "image/png" };
}

/** 单测跳过 sharp：把原图字节换成可断言的 data URL（压缩规则由 compress.test.ts 覆盖）。 */
const fakeCompress = async (bytes: Buffer): Promise<string> =>
  `data:image/jpeg;base64,${bytes.toString()}`;

class RecordingGenerator implements ImageGenerator {
  readonly inputs: GenerateImageInput[] = [];

  constructor(
    private readonly respond: (input: GenerateImageInput, index: number) => GeneratedImage[] = (
      _input,
      index,
    ) => [pngImage(index)],
  ) {}

  async generate(input: GenerateImageInput): Promise<GeneratedImage[]> {
    this.inputs.push(input);
    return this.respond(input, this.inputs.length);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  progressLog = [];
});

describe("一图对一图（AC-05-1）", () => {
  it("3 张原图发 3 次调用，每次只带那一张，按原图顺序对应", async () => {
    const generator = new RecordingGenerator();
    const result = await generateImages(buildContext({ assetCount: 3 }), {
      generator,
      compress: fakeCompress,
    });

    expect(generator.inputs).toHaveLength(3);
    // 每次的 `image` 就是对应那张原图压缩后的 data URL：第 k 次对应第 k 张原图。
    expect(generator.inputs.map((input) => input.image)).toEqual([
      "data:image/jpeg;base64,raw-of-source-1",
      "data:image/jpeg;base64,raw-of-source-2",
      "data:image/jpeg;base64,raw-of-source-3",
    ]);
    // 成品按原图顺序编号，并记录对应原图。
    expect(result.images.map((image) => image.sortOrder)).toEqual([1, 2, 3]);
    expect(result.images.map((image) => image.sourceAssetId)).toEqual([
      "source-1",
      "source-2",
      "source-3",
    ]);
    expect(result.meta.calls.map((call) => call.index)).toEqual([1, 2, 3]);
    expect(result.meta.failures).toEqual([]);
  });

  it("AC-05-1 期望每次只回一张：上游多给的只取第一张", async () => {
    const generator = new RecordingGenerator((_input, index) => [
      pngImage(index),
      { bytes: Buffer.from("extra"), mimeType: "image/png" },
    ]);

    const result = await generateImages(buildContext({ assetCount: 2 }), {
      generator,
      compress: fakeCompress,
    });

    expect(result.images).toHaveLength(2);
    expect(result.images.every((image) => image.bytes.toString().startsWith("image-"))).toBe(true);
  });

  it("模型取自任务快照；快照没有模型时省略", async () => {
    const withModel = new RecordingGenerator();
    await generateImages(buildContext({ assetCount: 1, imageModel: "image-model-a" }), {
      generator: withModel,
      compress: fakeCompress,
    });
    expect(withModel.inputs[0]?.model).toBe("image-model-a");

    const withoutModel = new RecordingGenerator();
    await generateImages(buildContext({ assetCount: 1, imageModel: null }), {
      generator: withoutModel,
      compress: fakeCompress,
    });
    expect(withoutModel.inputs[0]?.model).toBeNull();
  });

  it("提示词带上提取目标、提取要求与补充要求", async () => {
    const generator = new RecordingGenerator();
    await generateImages(
      buildContext({
        assetCount: 1,
        extraPrompt: "不要出现文字",
        extractRequirement: "flatten",
        extractTarget: "桌垫的织物纹理",
      }),
      { generator, compress: fakeCompress },
    );

    const prompt = generator.inputs[0]?.prompt ?? "";
    expect(prompt).toContain("你是生活方式图片创作者");
    expect(prompt).toContain("提取目标：桌垫的织物纹理");
    expect(prompt).toContain("提取要求：平整化");
    expect(prompt).toContain("补充要求：不要出现文字");
  });
});

describe("阶段进度（供界面显示「正在生图 第 k/N 张」）", () => {
  it("从 0/N 开始，每处理完一张上报一次，直到 N/N", async () => {
    progressLog = [];
    const generator = new RecordingGenerator();

    await generateImages(buildContext({ assetCount: 3 }), {
      generator,
      compress: fakeCompress,
    });

    expect(progressLog).toEqual([
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);
  });

  it("单张失败也照样上报进度，不让界面卡在第 k 张", async () => {
    progressLog = [];
    const generator = new RecordingGenerator((_input, index) => {
      if (index === 2) throw new StageError("UPSTREAM_TIMEOUT", "第 2 张超时");
      return [pngImage(index)];
    });

    await generateImages(buildContext({ assetCount: 2 }), { generator, compress: fakeCompress });

    expect(progressLog?.map((progress) => progress.done)).toEqual([0, 1, 2]);
  });
});

describe("部分原图失败（AC-05-5）", () => {
  it("3 张里第 2 张失败：保留 1 与 3，编号不连续，错误点名第 2 张原图", async () => {
    const generator = new RecordingGenerator((_input, index) => {
      if (index === 2) throw new StageError("UPSTREAM_REJECTED", "上游不接受这次重绘");
      return [pngImage(index)];
    });

    const result = await generateImages(buildContext({ assetCount: 3 }), {
      generator,
      compress: fakeCompress,
    });

    expect(result.images.map((image) => image.sortOrder)).toEqual([1, 3]);
    expect(result.images.map((image) => image.sourceAssetId)).toEqual(["source-1", "source-3"]);
    expect(result.partialError).toMatchObject({ code: "UPSTREAM_PARTIAL" });
    expect(result.partialError?.message).toContain("第 2 张原图（b.png）");
    expect(result.partialError?.message).toContain("已保留 2/3 张成品");
    expect(result.meta.failures).toEqual([
      expect.objectContaining({ index: 2, sourceAssetId: "source-2", code: "UPSTREAM_REJECTED" }),
    ]);
  });

  it("全部失败才把整阶段判失败，并带上已尝试的摘要", async () => {
    const generator = new RecordingGenerator(() => {
      throw new StageError("UPSTREAM_TIMEOUT", "上游超时");
    });

    const error = await generateImages(buildContext({ assetCount: 2 }), {
      generator,
      compress: fakeCompress,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StageError);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect((error as Error).message).toContain("全部 2 张原图都未提取出素材图");
    expect((error as Error).message).toContain("第 1 张原图（a.png）");
    expect((error as Error).message).toContain("第 2 张原图（b.png）");
    expect((error as StageError).meta).toMatchObject({ failures: [{ index: 1 }, { index: 2 }] });
  });

  it("适配器之外的内部异常按 STAGE_FAILED 记录，英文原文只进日志", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // 只有第 1 张炸掉：阶段仍有第 2 张成品，因此走「部分成功」路径。
    const generator = new RecordingGenerator((_input, index) => {
      if (index === 1) throw new TypeError("Cannot read properties of undefined (reading 'url')");
      return [pngImage(index)];
    });

    const result = await generateImages(buildContext({ assetCount: 2 }), {
      generator,
      compress: fakeCompress,
    });

    expect(result.partialError?.code).toBe("UPSTREAM_PARTIAL");
    expect(result.meta.failures[0]?.code).toBe("STAGE_FAILED");
    expect(result.meta.failures[0]?.message).not.toContain("Cannot read");
    expect(JSON.stringify(log.mock.calls)).toContain("Cannot read");
  });

  it("资源夹没有原图时直接拒绝，不调用上游", async () => {
    const generator = new RecordingGenerator();

    await expect(
      generateImages(buildContext({ assetCount: 0 }), { generator, compress: fakeCompress }),
    ).rejects.toMatchObject({ code: "UPSTREAM_REJECTED" });
    expect(generator.inputs).toHaveLength(0);
  });
});

describe("失败摘要为中文可操作文案（MKACG-902）", () => {
  it("上游原文不进阶段错误，只进日志", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const upstream =
      "no image: api.siliconflow.cn: 400 Bad Request: " +
      '{"code":20012,"message":"Model does not exist. Please check it carefully.","data":null}';
    // 真实适配器 + 脚本化 fetch：走与线上同一条路径（initialize 与工具调用都回 isError）。
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: upstream }], isError: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const error = await generateImages(buildContext({ assetCount: 1 }), {
      generator: createImageGenerator({
        adapter: "real",
        baseUrl: "https://magpie.example.com",
        apiKey: API_KEY,
        fetchImpl,
      }),
      compress: fakeCompress,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_REJECTED" });
    const message = (error as Error).message;
    expect(message).toContain("第 1 张原图（a.png）失败");
    expect(message).toContain("模型");
    expect(message).toContain("设置页");
    for (const fragment of ["null", "{", "}", "api.", "Model does not exist", "siliconflow"]) {
      expect(message).not.toContain(fragment);
    }
    // 同一条失败的上游原因留在服务端日志里。
    expect(JSON.stringify(log.mock.calls)).toContain("Model does not exist");
  });

  it("四类失败的摘要拼装都是中文说明，且不含上游原文", async () => {
    const jsonResult = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const cases: {
      name: string;
      code: string;
      respond: () => Response;
      mustContain: string;
      forbidden: string[];
    }[] = [
      {
        name: "鉴权失败",
        code: "UPSTREAM_AUTH",
        respond: () => new Response("unauthorized: bad key", { status: 401 }),
        mustContain: "API Key",
        forbidden: ["unauthorized"],
      },
      {
        name: "上游不可用",
        code: "UPSTREAM_TIMEOUT",
        respond: () => new Response("upstream boom", { status: 503 }),
        mustContain: "稍后重试",
        forbidden: ["boom"],
      },
      {
        name: "结构不符",
        code: "UPSTREAM_FORMAT",
        respond: () => new Response("<html>oops</html>", { status: 200 }),
        mustContain: "JSON-RPC",
        forbidden: ["<html>", "oops"],
      },
      {
        name: "上游拒绝但没说模型",
        code: "UPSTREAM_REJECTED",
        respond: () =>
          jsonResult({ content: [{ type: "text", text: "no image: invalid size" }], isError: true }),
        mustContain: "提取要求",
        forbidden: ["invalid size"],
      },
    ];

    for (const item of cases) {
      const fetchImpl = (async () => item.respond()) as unknown as typeof fetch;
      const error = await generateImages(buildContext({ assetCount: 1 }), {
        generator: createImageGenerator({
          adapter: "real",
          baseUrl: "https://magpie.example.com",
          apiKey: API_KEY,
          fetchImpl,
        }),
        compress: fakeCompress,
      }).catch((caught: unknown) => caught);

      const message = (error as Error).message;
      expect(error, item.name).toMatchObject({ code: item.code });
      expect(message, item.name).toContain("第 1 张原图（a.png）失败");
      expect(message, item.name).toContain(item.mustContain);
      for (const fragment of item.forbidden) {
        expect(message, item.name).not.toContain(fragment);
      }
    }
  });
});

describe("日志与密钥（AC-05-7）", () => {
  it("成功与失败两条路径的日志、错误消息里都没有网关密钥与图片内容", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // 成功回包：图片内联在 content 里（magpie 内置图片 MCP 的形状）。
    const successFetch = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "image",
                data: Buffer.from("png").toString("base64"),
                mimeType: "image/png",
              },
            ],
            isError: false,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    await generateImages(buildContext({ assetCount: 1 }), {
      generator: createImageGenerator({
        adapter: "real",
        baseUrl: "https://magpie.example.com",
        apiKey: API_KEY,
        fetchImpl: successFetch,
      }),
      compress: fakeCompress,
    });

    const failingFetch = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    const failure = await generateImages(buildContext({ assetCount: 1 }), {
      generator: createImageGenerator({
        adapter: "real",
        baseUrl: "https://magpie.example.com",
        apiKey: API_KEY,
        fetchImpl: failingFetch,
      }),
      compress: fakeCompress,
    }).catch((caught: unknown) => caught);

    expect(failure).toMatchObject({ code: "UPSTREAM_AUTH" });
    expect((failure as Error).message).not.toContain(API_KEY);

    const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain("Bearer");
    // 回包里的图片内容不得进日志（MUST 9）。
    expect(output).not.toContain("cG5n");
  });
});

describe("mock 适配器", () => {
  it("一次只回一张 PNG，并按脚本失败", async () => {
    const generator = createImageGenerator({ adapter: "mock", baseUrl: "", apiKey: "" });

    const result = await generateImages(buildContext({ assetCount: 2 }), {
      generator,
      compress: fakeCompress,
    });
    expect(result.images).toHaveLength(2);
    expect(result.images.every((image) => image.mimeType === "image/png")).toBe(true);

    const partial = await generateImages(
      buildContext({
        assetCount: 2,
        extraPrompt: `${MOCK_SCRIPT_HINTS.failImageAt}-2`,
      }),
      { generator: createImageGenerator({ adapter: "mock", baseUrl: "", apiKey: "" }), compress: fakeCompress },
    );
    expect(partial.partialError?.message).toContain("第 2 张原图（b.png）");

    await expect(
      generateImages(buildContext({ assetCount: 2, extraPrompt: MOCK_SCRIPT_HINTS.failImage }), {
        generator: createImageGenerator({ adapter: "mock", baseUrl: "", apiKey: "" }),
        compress: fakeCompress,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_REJECTED" });
  });

  it("适配器工厂按 adapter 返回对应实现", () => {
    expect(createImageGenerator({ adapter: "mock", baseUrl: "", apiKey: "" })).not.toBeInstanceOf(
      MagpieImageGenerator,
    );
    expect(
      createImageGenerator({ adapter: "real", baseUrl: "https://magpie.example.com", apiKey: API_KEY }),
    ).toBeInstanceOf(MagpieImageGenerator);
  });
});

describe("真实模式：按快照选适配器并取网关密钥", () => {
  const SNAPSHOT: AgentSnapshot = { ...IMAGE_AGENT, protocol: "magpie-mcp", modelId: "img-model" };
  const TARGET = {
    id: "gateway-1",
    protocol: "magpie-mcp" as const,
    baseUrl: "https://magpie.example.com",
    apiKey: API_KEY,
  };

  afterEach(() => getTarget.mockReset());

  it("协议不是 magpie 图片 MCP 时拒绝", async () => {
    await expect(
      resolveImageGenerator({ ...SNAPSHOT, protocol: "openai-chat" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_REJECTED" });
  });

  it("网关不存在时拒绝，并指向设置页", async () => {
    const { AppError } = await import("@/lib/errors");
    getTarget.mockRejectedValue(AppError.notFound("网关不存在"));

    await expect(resolveImageGenerator(SNAPSHOT)).rejects.toMatchObject({
      code: "UPSTREAM_REJECTED",
      message: expect.stringContaining("网关已不存在"),
    });
  });

  it("取不到密钥时记 UPSTREAM_AUTH", async () => {
    getTarget.mockRejectedValue(new Error("解密失败"));

    await expect(resolveImageGenerator(SNAPSHOT)).rejects.toMatchObject({
      code: "UPSTREAM_AUTH",
    });
  });

  it("正常时用快照里的网关地址与解出来的密钥建适配器", async () => {
    getTarget.mockResolvedValue(TARGET);

    const generator = await resolveImageGenerator(SNAPSHOT);
    expect(generator).toBeInstanceOf(MagpieImageGenerator);
    expect(getTarget).toHaveBeenCalledWith("gateway-1");
  });
});
