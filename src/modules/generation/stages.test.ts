import { beforeAll, describe, expect, it } from "vitest";
import { createStageRegistry } from "./registry";
import { defaultStageRegistry } from "./stages";
import { MOCK_SCRIPT_HINTS, mockCopyStage, mockFailImageAt } from "./stages/mock";
import type { StageContext } from "./types";

/** 单测不依赖外部环境变量；`@/lib/env` 只在调用时读取。 */
beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://localhost:5432/sparkflow_test";
  process.env.AUTH_SECRET ??= "unit-test-secret-value-0123456789abcd";
  process.env.GENERATION_ADAPTER = "mock";
});

const CONTEXT: StageContext = {
  taskId: "task-1",
  attempt: 1,
  params: { extractRequirement: "faithful", copyStyle: "story", extraPrompt: null },
  agents: {
    image: {
      agentType: "image",
      enabled: true,
      name: "图片提取 Agent",
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
    extractTarget: "桌垫的织物纹理",
  },
  collection: {
    id: "collection-1",
    platform: null,
    sourceTitle: null,
    sourceBody: null,
    extractTarget: "桌垫的织物纹理",
    assets: [
      { id: "asset-1", fileName: "a.png", mimeType: "image/png" },
      { id: "asset-2", fileName: "b.png", mimeType: "image/png" },
    ],
  },
  resultId: "result-1",
  signal: new AbortController().signal,
  readSourceImage: async (assetId: string) => ({
    bytes: Buffer.from(`bytes-of-${assetId}`),
    mimeType: "image/png",
  }),
  reportProgress: async () => {},
};

function withPrompt(prompt: string): StageContext {
  return { ...CONTEXT, params: { ...CONTEXT.params, extraPrompt: prompt } };
}

describe("阶段注册表", () => {
  it("按阶段名取处理器，未注册返回 null", () => {
    const registry = createStageRegistry([mockCopyStage]);
    expect(registry.get("copy")).toBe(mockCopyStage);
    expect(registry.get("image")).toBeNull();
    expect(registry.registeredStages()).toEqual(["copy"]);
  });

  it("同一阶段重复注册直接报错，避免两套实现悄悄互相覆盖", () => {
    const registry = createStageRegistry([mockCopyStage]);
    expect(() => registry.register(mockCopyStage)).toThrowError(/已有处理器/);
  });

  it("mock 适配器下两个阶段都注册好，真实实现可以按阶段追加", () => {
    expect(defaultStageRegistry().registeredStages()).toEqual(["image", "copy"]);
  });
});

describe("mock 阶段处理器（GENERATION_ADAPTER=mock）", () => {
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

describe("mock 失败脚本的标记解析", () => {
  it("读到第 n 张原图失败的标记", () => {
    expect(mockFailImageAt(`要求 ${MOCK_SCRIPT_HINTS.failImageAt}-2`)).toBe(2);
    expect(mockFailImageAt(`要求 ${MOCK_SCRIPT_HINTS.failImageAt}-11`)).toBe(11);
  });

  it("整体失败标记与普通提示词都不产生单张失败", () => {
    expect(mockFailImageAt(MOCK_SCRIPT_HINTS.failImage)).toBeNull();
    expect(mockFailImageAt("画面干净")).toBeNull();
    expect(mockFailImageAt(`${MOCK_SCRIPT_HINTS.failImageAt}-0`)).toBeNull();
  });
});
