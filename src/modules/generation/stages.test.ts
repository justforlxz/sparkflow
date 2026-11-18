import { beforeAll, describe, expect, it } from "vitest";
import { createStageRegistry } from "./registry";
import { defaultStageRegistry } from "./stages";
import { MOCK_SCRIPT_HINTS, mockCopyStage, mockImageStage } from "./stages/mock";
import { StageError, type StageContext } from "./types";

/** 单测不依赖外部环境变量；`@/lib/env` 只在调用时读取。 */
beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://localhost:5432/sparkflow_test";
  process.env.AUTH_SECRET ??= "unit-test-secret-value-0123456789abcd";
  process.env.GENERATION_ADAPTER = "mock";
});

const CONTEXT: StageContext = {
  taskId: "task-1",
  attempt: 1,
  params: { visualStyle: "fresh", copyStyle: "story", imageCount: 3, extraPrompt: null },
  agents: {
    image: {
      agentType: "image",
      enabled: true,
      name: "图片创作 Agent",
      gatewayId: "gateway-1",
      protocol: "magpie-mcp",
      baseUrl: "https://magpie.example.com",
      modelId: null,
      role: "角色",
      systemPrompt: "系统提示词",
      outputRequirements: "输出要求",
    },
    copy: {
      agentType: "copy",
      enabled: true,
      name: "文案创作 Agent",
      gatewayId: "gateway-1",
      protocol: "openai-chat",
      baseUrl: "https://gw.example.com/v1",
      modelId: "text-model",
      role: "角色",
      systemPrompt: "系统提示词",
      outputRequirements: "输出要求",
    },
  },
  collection: {
    id: "collection-1",
    platform: null,
    sourceTitle: null,
    sourceBody: null,
    assetCount: 2,
  },
  resultId: "result-1",
  signal: new AbortController().signal,
};

function withPrompt(prompt: string): StageContext {
  return { ...CONTEXT, params: { ...CONTEXT.params, extraPrompt: prompt } };
}

describe("阶段注册表", () => {
  it("按阶段名取处理器，未注册返回 null", () => {
    const registry = createStageRegistry([mockImageStage]);
    expect(registry.get("image")).toBe(mockImageStage);
    expect(registry.get("copy")).toBeNull();
    expect(registry.registeredStages()).toEqual(["image"]);
  });

  it("同一阶段重复注册直接报错，避免两套实现悄悄互相覆盖", () => {
    const registry = createStageRegistry([mockImageStage]);
    expect(() => registry.register(mockImageStage)).toThrowError(/已有处理器/);
  });

  it("mock 适配器下两个阶段都注册好，真实实现可以按阶段追加", () => {
    expect(defaultStageRegistry().registeredStages()).toEqual(["image", "copy"]);
  });
});

describe("mock 阶段处理器（GENERATION_ADAPTER=mock）", () => {
  it("生图阶段按目标张数返回图片，并记录调用摘要", async () => {
    const outcome = await mockImageStage.run(CONTEXT);
    expect(outcome.stage).toBe("image");
    if (outcome.stage !== "image") throw new Error("阶段类型不符");
    expect(outcome.images).toHaveLength(3);
    expect(outcome.images.every((image) => image.mimeType === "image/png")).toBe(true);
    expect(outcome.meta).toMatchObject({ model: "mock-image" });
  });

  it("按脚本让生图阶段失败（AC-05-11 用）", async () => {
    await expect(mockImageStage.run(withPrompt(MOCK_SCRIPT_HINTS.failImage))).rejects.toThrowError(
      StageError,
    );
  });

  it("文案阶段返回标题、正文与标签", async () => {
    const outcome = await mockCopyStage.run(CONTEXT);
    expect(outcome.stage).toBe("copy");
    if (outcome.stage !== "copy") throw new Error("阶段类型不符");
    expect(outcome.copy.title.length).toBeGreaterThan(0);
    expect(outcome.copy.body.length).toBeGreaterThan(0);
    expect(outcome.copy.tags.length).toBeGreaterThan(0);
  });

  it("按脚本让文案阶段只在第一次失败，第二次成功（AC-04-6、AC-05-12 用）", async () => {
    const scripted = withPrompt(MOCK_SCRIPT_HINTS.failCopyOnce);
    await expect(mockCopyStage.run(scripted)).rejects.toMatchObject({ code: "COPY_FORMAT" });

    const second = await mockCopyStage.run({ ...scripted, attempt: 2 });
    expect(second.stage).toBe("copy");
  });
});
