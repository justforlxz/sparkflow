import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { MOCK_SCRIPT_HINTS } from "@/modules/generation/stages/mock";
import { StageError, type GeneratedImage, type StageContext } from "@/modules/generation/types";
import type { GenerateImageInput, ImageGenerator } from "./adapters/types";
import { MagpieMcpImageGenerator } from "./adapters/magpie-mcp";
import {
  MAX_IMAGES_PER_BATCH,
  createImageGenerator,
  generateImages,
  resolveImageGenerator,
} from "./service";
import { findVisualStyle } from "./styles";

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
 * 图片创作业务层（docs/prd/05 MUST 1、2、6、7；AC-05-1、AC-05-6、AC-05-8；AC-06-10）。
 *
 * 适配器一律注入假实现：这里验证的是「分批、模型取快照、失败如实记录、日志不含密钥」，
 * 上游协议本身由 `adapters/magpie-mcp.test.ts` 覆盖。
 */

const API_KEY = "magpie-gateway-secret-for-tests";

const IMAGE_AGENT: AgentSnapshot = {
  agentType: "image",
  enabled: true,
  name: "图片创作 Agent",
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
  imageCount?: number;
  visualStyle?: string;
  extraPrompt?: string | null;
  imageModel?: string | null;
}

function buildContext(overrides: ContextOverrides = {}): StageContext {
  return {
    taskId: "task-1",
    attempt: 1,
    params: {
      visualStyle: overrides.visualStyle ?? "fresh",
      copyStyle: "story",
      imageCount: overrides.imageCount ?? 3,
      extraPrompt: overrides.extraPrompt ?? null,
    },
    agents: {
      image: { ...IMAGE_AGENT, modelId: overrides.imageModel ?? null },
      copy: COPY_AGENT,
    },
    collection: {
      id: "collection-1",
      platform: "小红书",
      sourceTitle: "原始标题",
      sourceBody: "原始文案",
      assetCount: 1,
    },
    resultId: null,
    signal: new AbortController().signal,
  };
}

function pngImage(index: number): GeneratedImage {
  return { bytes: Buffer.from(`image-${index}`), mimeType: "image/png" };
}

class RecordingGenerator implements ImageGenerator {
  readonly inputs: GenerateImageInput[] = [];

  constructor(private readonly respond: (input: GenerateImageInput) => Promise<GeneratedImage[]> | GeneratedImage[] = (input) => Array.from({ length: input.n }, (_, index) => pngImage(index))) {}

  async generate(input: GenerateImageInput): Promise<GeneratedImage[]> {
    this.inputs.push(input);
    return this.respond(input);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("分批调用", () => {
  it("AC-05-1 要 5 张时发 2 次（4+1），要 9 张时发 3 次（4+4+1）", async () => {
    const five = new RecordingGenerator();
    const result = await generateImages(buildContext({ imageCount: 5 }), { generator: five });

    expect(MAX_IMAGES_PER_BATCH).toBe(4);
    expect(five.inputs.map((input) => input.n)).toEqual([4, 1]);
    expect(result.images).toHaveLength(5);
    expect(result.meta.batches).toEqual([
      expect.objectContaining({ n: 4, ok: true }),
      expect.objectContaining({ n: 1, ok: true }),
    ]);

    const nine = new RecordingGenerator();
    await generateImages(buildContext({ imageCount: 9 }), { generator: nine });
    expect(nine.inputs.map((input) => input.n)).toEqual([4, 4, 1]);
  });

  it("要 1 张时只发一次，且请求里带上视觉方向的尺寸", async () => {
    const generator = new RecordingGenerator();
    await generateImages(buildContext({ imageCount: 1, visualStyle: "product" }), { generator });

    expect(generator.inputs).toHaveLength(1);
    expect(generator.inputs[0]?.size).toBe(findVisualStyle("product")!.size);
    expect(generator.inputs[0]?.size).toBe("1024x1024");
  });
});

describe("模型取自任务快照", () => {
  it("AC-06-10 连续两次任务各用各的模型，不串用", async () => {
    const generator = new RecordingGenerator();

    await generateImages(buildContext({ imageCount: 1, imageModel: "image-model-a" }), { generator });
    await generateImages(buildContext({ imageCount: 1, imageModel: "image-model-b" }), { generator });

    expect(generator.inputs.map((input) => input.model)).toEqual(["image-model-a", "image-model-b"]);
  });

  it("快照没有模型时传 null（适配器据此省略该参数）", async () => {
    const generator = new RecordingGenerator();
    const result = await generateImages(buildContext({ imageCount: 1 }), { generator });

    expect(generator.inputs[0]?.model).toBeNull();
    expect(result.meta.model).toBeNull();
  });

  it("提示词由 Agent 快照、视觉方向与补充要求拼成", async () => {
    const generator = new RecordingGenerator();
    await generateImages(buildContext({ imageCount: 1, extraPrompt: "不要出现文字" }), { generator });

    const prompt = generator.inputs[0]?.prompt ?? "";
    expect(prompt).toContain(IMAGE_AGENT.role);
    expect(prompt).toContain(IMAGE_AGENT.systemPrompt);
    expect(prompt).toContain(IMAGE_AGENT.outputRequirements);
    expect(prompt).toContain(findVisualStyle("fresh")!.description);
    expect(prompt).toContain("补充要求：不要出现文字");
  });
});

describe("失败如实记录", () => {
  it("AC-05-6 3 张里有一批失败：阶段失败、错误里写明已取回几张，批次摘要保留", async () => {
    const generator = new RecordingGenerator((input) => {
      if (input.n === 1) throw new StageError("UPSTREAM_REJECTED", "上游拒绝了这一批");
      return Array.from({ length: input.n }, (_, index) => pngImage(index));
    });

    const error = await generateImages(buildContext({ imageCount: 5 }), { generator }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(StageError);
    expect(error).toMatchObject({ code: "UPSTREAM_REJECTED" });
    expect((error as Error).message).toContain("第 2 批（1 张）失败");
    expect((error as Error).message).toContain("已取回 4/5 张");

    const meta = (error as StageError).meta as { batches: unknown[] };
    expect(meta.batches).toHaveLength(2);
    expect(meta.batches[0]).toMatchObject({ n: 4, ok: true });
    expect(meta.batches[1]).toMatchObject({ n: 1, ok: false, errorCode: "UPSTREAM_REJECTED" });
  });

  it("上游一次只回 1 张时按实际张数继续要：要 4 张就发 4 次，张数一张不少", async () => {
    // 真实 magpie 网关上可用的图片模型多数一次只出 1 张（workbuddy 系），
    // 也有直接拒绝 n>1 的（sensenova 报 invalid n, should be in [1, 1]）。
    const generator = new RecordingGenerator(() => [pngImage(0)]);

    const result = await generateImages(buildContext({ imageCount: 4 }), { generator });

    expect(generator.inputs.map((input) => input.n)).toEqual([4, 3, 2, 1]);
    expect(result.images).toHaveLength(4);
    // 批次摘要如实记录「要了几张、实际拿到几张」。
    expect(result.meta.batches.map((batch) => [batch.n, batch.received, batch.ok])).toEqual([
      [4, 1, true],
      [3, 1, true],
      [2, 1, true],
      [1, 1, true],
    ]);
  });

  it("上游拒绝 n>1 时把这一批降到 1 张重试，本阶段后续都按 1 张要", async () => {
    const generator = new RecordingGenerator((input) => {
      if (input.n > 1) {
        throw new StageError("UPSTREAM_REJECTED", "invalid n, should be in [1, 1]");
      }
      return [pngImage(0)];
    });

    const result = await generateImages(buildContext({ imageCount: 3 }), { generator });

    // 只降级一次：第一次按 3 张被拒，之后每批都按 1 张要，不再反复试探。
    expect(generator.inputs.map((input) => input.n)).toEqual([3, 1, 1, 1]);
    expect(result.images).toHaveLength(3);
    expect(result.meta.batches.map((batch) => [batch.n, batch.ok])).toEqual([
      [3, false],
      [1, true],
      [1, true],
      [1, true],
    ]);
  });

  it("上游一张图都没返回时阶段失败，不把空产出当成功", async () => {
    const generator = new RecordingGenerator(() => []);

    const error = await generateImages(buildContext({ imageCount: 2 }), { generator }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(StageError);
    expect(error).toMatchObject({ code: "UPSTREAM_REJECTED" });
    expect((error as Error).message).toContain("上游没有返回图片");
    expect((error as Error).message).toContain("已取回 0/2 张");
  });

  it("AC-902-1、AC-902-2 生图失败摘要为中文可操作文案，不含上游原始回包", async () => {
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

    const error = await generateImages(buildContext({ imageCount: 4 }), {
      generator: createImageGenerator({
        adapter: "real",
        baseUrl: "https://magpie.example.com",
        apiKey: API_KEY,
        fetchImpl,
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_REJECTED" });
    const message = (error as Error).message;
    // 第几批、已取回几张、阶段未产出结果：这些如实记录的信息保留（MUST 4）
    expect(message).toContain("第 2 批（1 张）失败");
    expect(message).toContain("已取回 0/4 张，阶段未产出结果");
    // 说明指向可改的配置项，且不含上游原始回包（MUST 1）
    expect(message).toContain("模型");
    expect(message).toContain("设置页");
    for (const fragment of ["null", "{", "}", "api.", "Model does not exist", "siliconflow"]) {
      expect(message).not.toContain(fragment);
    }
    // 同一条失败的上游原因留在服务端日志里（MUST 2、AC-902-3）
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("Model does not exist");
    expect(logged).toContain("UPSTREAM_REJECTED");
  });

  it("AC-902-4 四类失败的摘要拼装都是中文说明，且不含上游原文", async () => {
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
        mustContain: "视觉方向",
        forbidden: ["invalid size"],
      },
    ];

    for (const item of cases) {
      const fetchImpl = (async () => item.respond()) as unknown as typeof fetch;
      const error = await generateImages(buildContext({ imageCount: 1 }), {
        generator: createImageGenerator({
          adapter: "real",
          baseUrl: "https://magpie.example.com",
          apiKey: API_KEY,
          fetchImpl,
        }),
      }).catch((caught: unknown) => caught);

      const message = (error as Error).message;
      expect(error, item.name).toMatchObject({ code: item.code });
      expect(message, item.name).toContain("第 1 批（1 张）失败");
      expect(message, item.name).toContain(item.mustContain);
      for (const fragment of item.forbidden) {
        expect(message, item.name).not.toContain(fragment);
      }
    }
  });

  it("适配器之外的内部异常：摘要换成中文兜底，英文原文只进日志", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const generator = new RecordingGenerator(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'url')");
    });

    const error = await generateImages(buildContext({ imageCount: 1 }), { generator }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "STAGE_FAILED" });
    const message = (error as Error).message;
    expect(message).toContain("请重试该阶段");
    expect(message).not.toContain("Cannot read");
    expect(JSON.stringify(log.mock.calls)).toContain("Cannot read");
  });

  it("适配器抛的不是阶段错误时归为 STAGE_FAILED，批次摘要仍然保留", async () => {
    const generator = new RecordingGenerator(() => {
      throw new TypeError("适配器自己炸了");
    });

    const error = await generateImages(buildContext({ imageCount: 2 }), { generator }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "STAGE_FAILED" });
    expect((error as StageError).meta).toMatchObject({ batches: [{ n: 2, ok: false }] });
  });
});

describe("日志与密钥", () => {
  it("AC-05-8 成功与失败两条路径的日志、错误消息里都没有网关密钥", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const successFetch = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }],
            isError: false,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    await generateImages(buildContext({ imageCount: 1 }), {
      generator: createImageGenerator({
        adapter: "real",
        baseUrl: "https://magpie.example.com",
        apiKey: API_KEY,
        fetchImpl: successFetch,
      }),
    });

    const failingFetch = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    const failure = await generateImages(buildContext({ imageCount: 1 }), {
      generator: createImageGenerator({
        adapter: "real",
        baseUrl: "https://magpie.example.com",
        apiKey: API_KEY,
        fetchImpl: failingFetch,
      }),
    }).catch((caught: unknown) => caught);

    expect(failure).toMatchObject({ code: "UPSTREAM_AUTH" });
    expect((failure as Error).message).not.toContain(API_KEY);

    const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain("Bearer");
  });
});

describe("mock 适配器", () => {
  it("按目标张数返回 PNG，并按脚本让整批失败", async () => {
    const generator = createImageGenerator({ adapter: "mock", baseUrl: "", apiKey: "" });

    const result = await generateImages(buildContext({ imageCount: 3 }), { generator });
    expect(result.images).toHaveLength(3);
    expect(result.images.every((image) => image.mimeType === "image/png")).toBe(true);

    await expect(
      generateImages(buildContext({ imageCount: 2, extraPrompt: MOCK_SCRIPT_HINTS.failImage }), {
        generator,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_REJECTED" });
  });

  it("适配器工厂按 adapter 返回对应实现", () => {
    expect(createImageGenerator({ adapter: "mock", baseUrl: "", apiKey: "" })).not.toBeInstanceOf(
      MagpieMcpImageGenerator,
    );
    expect(
      createImageGenerator({ adapter: "real", baseUrl: "https://magpie.example.com", apiKey: API_KEY }),
    ).toBeInstanceOf(MagpieMcpImageGenerator);
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
  const PNG_ONE_PIXEL = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ).toString("base64");

  it("快照协议不是 magpie 图片 MCP 时直接拒绝，不去查网关", async () => {
    await expect(resolveImageGenerator({ ...SNAPSHOT, protocol: "openai-chat" })).rejects.toMatchObject(
      { code: "UPSTREAM_REJECTED" },
    );
    expect(getTarget).not.toHaveBeenCalled();
  });

  it("网关记录不存在时拒绝并提示重新选择网关", async () => {
    getTarget.mockRejectedValueOnce(AppError.notFound("网关不存在"));

    await expect(resolveImageGenerator(SNAPSHOT)).rejects.toMatchObject({
      code: "UPSTREAM_REJECTED",
      message: expect.stringContaining("已不存在") as unknown as string,
    });
  });

  it("取密钥失败归为 UPSTREAM_AUTH，消息里没有密钥", async () => {
    getTarget.mockRejectedValueOnce(
      new AppError("UPSTREAM_FAILED", "网关密钥无法解密，请到设置页重新填写 API Key", {
        details: { code: "GATEWAY_KEY_UNREADABLE" },
      }),
    );

    const error = await resolveImageGenerator(SNAPSHOT).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_AUTH" });
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it("网关记录里的协议与快照不一致时再拦一次", async () => {
    getTarget.mockResolvedValueOnce({ ...TARGET, protocol: "openai-chat" });

    await expect(resolveImageGenerator(SNAPSHOT)).rejects.toMatchObject({
      code: "UPSTREAM_REJECTED",
    });
  });

  it("成功时把 Base URL 与解密后的密钥交给真实适配器：请求地址与鉴权头可证", async () => {
    getTarget.mockResolvedValueOnce(TARGET);
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "image", data: PNG_ONE_PIXEL, mimeType: "image/png" }],
              isError: false,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const generator = await resolveImageGenerator(SNAPSHOT);
    expect(generator).toBeInstanceOf(MagpieMcpImageGenerator);

    const images = await generator.generate({
      prompt: "一只在窗边晒太阳的猫",
      n: 1,
      size: null,
      quality: null,
      model: null,
    });

    expect(images).toHaveLength(1);
    // initialize + tools/call：两次都打在图片 MCP 端点上，且带上解密后的密钥
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calls = fetchSpy.mock.calls as unknown as [string, RequestInit][];
    for (const [url, init] of calls) {
      expect(url).toBe("https://magpie.example.com/mcp/magpie/image");
      expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${API_KEY}` });
    }
  });
});
