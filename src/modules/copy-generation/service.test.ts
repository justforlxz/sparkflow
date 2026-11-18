import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { createStageRegistry } from "@/modules/generation/registry";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import type { StageContext } from "@/modules/generation/types";
import { MOCK_COPY_TEXT, createMockTextGenerator } from "./adapters/mock";
import { COPY_ERROR_CODES } from "./constants";
import { createCopyStage, registerCopyGenerationStages } from "./service";

/**
 * 默认取密钥走网关模块的 `getGatewayExecutionTarget`：这里换成可复现的两类失败，
 * 覆盖「网关被删 → NOT_FOUND」与「密钥解不开 → UPSTREAM_FAILED」在阶段边界都翻成 COPY_AUTH。
 * 需要注入假实现的用例仍然传 `deps.loadApiKey`，不受这个替换影响。
 */
vi.mock("@/modules/gateway/service", async () => {
  const { AppError } = await import("@/lib/errors");
  return {
    getGatewayExecutionTarget: async (gatewayId: string) => {
      if (gatewayId === "gateway-missing") throw AppError.notFound("网关不存在");
      if (gatewayId === "gateway-bad-key") {
        throw new AppError("UPSTREAM_FAILED", "网关密钥无法解密，请到设置页重新填写 API Key");
      }
      return {
        id: gatewayId,
        protocol: "openai-chat",
        baseUrl: "https://gw.example.com/v1",
        apiKey: "sk-test-local-do-not-use-1234",
      };
    },
  };
});

const API_KEY = "sk-test-local-do-not-use-1234";

const COPY_AGENT: AgentSnapshot = {
  agentType: "copy",
  enabled: true,
  name: "文案创作 Agent",
  gatewayId: "gateway-1",
  protocol: "openai-chat",
  baseUrl: "https://gw.example.com/v1",
  modelId: "text-model",
  role: "你是一名小红书文案撰写者。",
  systemPrompt: "只依据原始素材写作。",
  outputRequirements: "输出 JSON：title、body、tags。",
};

const IMAGE_AGENT: AgentSnapshot = { ...COPY_AGENT, agentType: "image", protocol: "magpie-mcp" };

function makeContext(copy: Partial<AgentSnapshot> = {}): StageContext {
  return {
    taskId: "task-1",
    attempt: 1,
    params: { visualStyle: "fresh", copyStyle: "story", imageCount: 4, extraPrompt: "语气轻松" },
    agents: { image: IMAGE_AGENT, copy: { ...COPY_AGENT, ...copy } },
    collection: {
      id: "collection-1",
      platform: "小红书",
      sourceTitle: "原始标题",
      sourceBody: "原始文案内容",
      assetCount: 2,
    },
    resultId: "result-1",
    signal: new AbortController().signal,
  };
}

const okApiKey = async (): Promise<string> => API_KEY;

describe("文案阶段处理器", () => {
  it("调上游成功时交出三个字段、记录调用摘要，并使用快照里的地址与模型", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { content: MOCK_COPY_TEXT } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const stage = createCopyStage({ loadApiKey: okApiKey, fetchImpl });
    const outcome = await stage.run(makeContext());

    expect(outcome.stage).toBe("copy");
    if (outcome.stage !== "copy") throw new Error("阶段类型不符");
    expect(outcome.copy.title).toBe("按脚本生成的标题");
    expect(outcome.copy.tags).toEqual(["mock", "验收"]);
    expect(outcome.meta).toMatchObject({ protocol: "openai-chat", model: "text-model" });

    expect(calls[0].url).toBe("https://gw.example.com/v1/chat/completions");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("text-model");
    expect(body.messages[0].content).toContain("你是一名小红书文案撰写者。");
    expect(body.messages[1].content).toContain("原始标题");
    expect(body.messages[1].content).toContain("张数：4");
    expect(JSON.stringify(outcome.meta)).not.toContain(API_KEY);
  });

  it("密钥按快照里的 gatewayId 现取，不写进处理器产出", async () => {
    const seen: string[] = [];
    const generator = createMockTextGenerator();

    const stage = createCopyStage({
      generator,
      loadApiKey: async (gatewayId) => {
        seen.push(gatewayId);
        return API_KEY;
      },
    });
    const outcome = await stage.run(makeContext());

    expect(seen).toEqual(["gateway-1"]);
    expect(generator.calls[0].apiKey).toBe(API_KEY);
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
  });

  it("AC-07-7 模型返回空标题时阶段失败：COPY_EMPTY", async () => {
    const stage = createCopyStage({
      generator: createMockTextGenerator(JSON.stringify({ title: "", body: "x", tags: [] })),
      loadApiKey: okApiKey,
    });

    await expect(stage.run(makeContext())).rejects.toMatchObject({
      code: COPY_ERROR_CODES.empty,
    });
  });

  it("AC-06-3 回包不是 JSON 时阶段失败：COPY_FORMAT", async () => {
    const stage = createCopyStage({
      generator: createMockTextGenerator("好的，以下是文案……"),
      loadApiKey: okApiKey,
    });

    await expect(stage.run(makeContext())).rejects.toMatchObject({
      code: COPY_ERROR_CODES.format,
    });
  });

  it("网关密钥取不到时记 COPY_AUTH，原因可读", async () => {
    const stage = createCopyStage({
      generator: createMockTextGenerator(),
      loadApiKey: async () => {
        throw AppError.notFound("网关不存在");
      },
    });

    await expect(stage.run(makeContext())).rejects.toMatchObject({
      code: COPY_ERROR_CODES.auth,
      message: "网关不存在",
    });
  });

  it("默认取密钥路径：网关被删（NOT_FOUND）在阶段边界翻成 COPY_AUTH", async () => {
    const stage = createCopyStage({ generator: createMockTextGenerator() });

    await expect(stage.run(makeContext({ gatewayId: "gateway-missing" }))).rejects.toMatchObject({
      code: COPY_ERROR_CODES.auth,
    });
  });

  it("默认取密钥路径：密钥解不开（UPSTREAM_FAILED）同样翻成 COPY_AUTH", async () => {
    const stage = createCopyStage({ generator: createMockTextGenerator() });

    await expect(stage.run(makeContext({ gatewayId: "gateway-bad-key" }))).rejects.toMatchObject({
      code: COPY_ERROR_CODES.auth,
    });
  });

  it("默认取密钥路径：正常时用网关模块返回的密钥发请求", async () => {
    const generator = createMockTextGenerator();
    const stage = createCopyStage({ generator });

    await stage.run(makeContext());

    expect(generator.calls[0].apiKey).toBe(API_KEY);
  });

  it("Agent 已停用时拒绝执行", async () => {
    const stage = createCopyStage({ generator: createMockTextGenerator(), loadApiKey: okApiKey });
    await expect(stage.run(makeContext({ enabled: false }))).rejects.toMatchObject({
      code: COPY_ERROR_CODES.rejected,
    });
  });

  it("文案 Agent 没有绑定模型时拒绝执行", async () => {
    const stage = createCopyStage({ generator: createMockTextGenerator(), loadApiKey: okApiKey });
    await expect(stage.run(makeContext({ modelId: null }))).rejects.toMatchObject({
      code: COPY_ERROR_CODES.rejected,
    });
  });

  it("接口形状不支持文本生成时拒绝执行", async () => {
    const stage = createCopyStage({ loadApiKey: okApiKey });
    await expect(stage.run(makeContext({ protocol: "magpie-mcp" }))).rejects.toMatchObject({
      code: COPY_ERROR_CODES.rejected,
    });
  });
});

describe("阶段注册", () => {
  it("注册后注册表里能找到文案阶段处理器", () => {
    const registry = createStageRegistry();
    registerCopyGenerationStages(registry, {
      generator: createMockTextGenerator(),
      loadApiKey: okApiKey,
    });

    expect(registry.registeredStages()).toEqual(["copy"]);
    expect(registry.get("copy")?.stage).toBe("copy");
  });
});

describe("真实适配器接线", () => {
  it("GENERATION_ADAPTER=real 时默认注册表里有文案阶段处理器", async () => {
    // 环境变量是进程级缓存：本文件不碰 mock 分支，所以这里能安全地读一次 real 的注册结果。
    process.env.DATABASE_URL ??= "postgresql://localhost:5432/sparkflow_test";
    process.env.AUTH_SECRET ??= "unit-test-secret-value-0123456789abcd";
    process.env.GENERATION_ADAPTER = "real";

    const { defaultStageRegistry } = await import("@/modules/generation/stages");
    expect(defaultStageRegistry().registeredStages()).toContain("copy");
  });
});
