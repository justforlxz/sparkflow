process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
process.env.AUTH_SECRET ||= "unit-test-auth-secret-for-agent-service-0123456789";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { AgentGatewayBinding } from "./readiness";
import type { AgentConfigRecord } from "./repo";

vi.mock("./repo", () => ({
  listAgentConfigs: vi.fn(),
  findAgentConfig: vi.fn(),
  updateAgentConfigRecord: vi.fn(),
  listAgentConfigsByGateway: vi.fn(),
}));

const repo = await import("./repo");
const service = await import("./service");

function record(overrides: Partial<AgentConfigRecord> = {}): AgentConfigRecord {
  return {
    type: "image",
    enabled: true,
    name: "图片创作 Agent",
    gatewayId: "gw-1",
    gatewayModelId: null,
    role: "角色",
    systemPrompt: "提示词",
    outputRequirements: "要求",
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function gateways(): AgentGatewayBinding[] {
  return [
    {
      id: "gw-1",
      name: "本地网关",
      protocol: "openai-chat",
      baseUrl: "https://gw.example.com/v1",
      models: [
        { modelId: "gpt-image-1", capability: "image" },
        { modelId: "gpt-4o-mini", capability: "text" },
      ],
    },
  ];
}

beforeEach(() => {
  vi.mocked(repo.findAgentConfig).mockResolvedValue(record());
  vi.mocked(repo.updateAgentConfigRecord).mockImplementation(async (type, input) =>
    record({ ...input, type }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("更新配置（MUST 5、MUST 3）", () => {
  it("只提交一个字段时，绑定按合并后的结果校验并写回", async () => {
    await service.updateAgent("image", { enabled: false }, gateways());

    expect(vi.mocked(repo.updateAgentConfigRecord).mock.calls[0][1]).toMatchObject({
      enabled: false,
      gatewayId: "gw-1",
      gatewayModelId: null,
    });
  });

  it("空串与纯空白归一成 null，不写进库", async () => {
    vi.mocked(repo.findAgentConfig).mockResolvedValue(record({ gatewayModelId: "gpt-image-1" }));

    await service.updateAgent("image", { gatewayModelId: "  " }, gateways());

    const input = vi.mocked(repo.updateAgentConfigRecord).mock.calls[0][1];
    expect(input.gatewayModelId).toBeNull();
  });

  it("文案 Agent 缺模型时拒绝保存，且不写库（AC-03-4）", async () => {
    vi.mocked(repo.findAgentConfig).mockResolvedValue(record({ type: "copy", gatewayModelId: null }));

    const error = await service
      .updateAgent("copy", { name: "换个名字", gatewayModelId: null }, gateways())
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { code: "AGENT_MODEL_REQUIRED" },
    });
    expect(repo.updateAgentConfigRecord).not.toHaveBeenCalled();
  });

  it("只改文案字段时不校验绑定：未绑定模型的文案 Agent 也能改提示词", async () => {
    vi.mocked(repo.findAgentConfig).mockResolvedValue(record({ type: "copy", gatewayModelId: null }));

    await service.updateAgent("copy", { systemPrompt: "新的提示词" }, gateways());

    expect(vi.mocked(repo.updateAgentConfigRecord).mock.calls[0][1]).toMatchObject({
      systemPrompt: "新的提示词",
      gatewayId: "gw-1",
      gatewayModelId: null,
    });
  });

  it("模型留空但网关已被删除时返回 VALIDATION_FAILED，且不写库", async () => {
    vi.mocked(repo.findAgentConfig).mockResolvedValue(
      record({ type: "image", gatewayId: null, gatewayModelId: null }),
    );

    const error = await service
      .updateAgent("image", { gatewayId: "deleted-gw", gatewayModelId: null }, gateways())
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { code: "AGENT_GATEWAY_NOT_FOUND" },
    });
    expect(repo.updateAgentConfigRecord).not.toHaveBeenCalled();
  });

  it("未知类型返回 NOT_FOUND", async () => {
    await expect(service.updateAgent("video", {}, gateways())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("恢复默认只重置文案字段（MUST 7、AC-03-6）", () => {
  it("写回的是名称与三段文本，不含模型绑定与启用状态", async () => {
    await service.resetAgent("image", gateways());

    const input = vi.mocked(repo.updateAgentConfigRecord).mock.calls[0][1];
    expect(Object.keys(input).sort()).toEqual([
      "name",
      "outputRequirements",
      "role",
      "systemPrompt",
    ]);
    expect(input.gatewayId).toBeUndefined();
    expect(input.gatewayModelId).toBeUndefined();
    expect(input.enabled).toBeUndefined();
  });
});

describe("模型候选按能力过滤（MUST 2、AC-03-2）", () => {
  it("图片 Agent 只有 image 能力的模型", () => {
    expect(service.listModelCandidates("image", gateways()).map((model) => model.modelId)).toEqual([
      "gpt-image-1",
    ]);
  });

  it("文案 Agent 有 text 与 image_input 能力的模型", () => {
    const withMultimodal: AgentGatewayBinding[] = [
      { ...gateways()[0], models: [...gateways()[0].models, { modelId: "qwen-vl", capability: "image_input" }] },
    ];

    expect(
      service.listModelCandidates("copy", withMultimodal).map((model) => model.modelId),
    ).toEqual(["gpt-4o-mini", "qwen-vl"]);
  });
});

describe("创建任务前的就绪校验（MUST 8、AC-03-7）", () => {
  it("有 Agent 停用时返回 CONFLICT + AGENT_NOT_READY，并逐条说明缺什么", async () => {
    vi.mocked(repo.listAgentConfigs).mockResolvedValue([
      record({ type: "image", enabled: false }),
      record({ type: "copy", gatewayModelId: "gpt-4o-mini" }),
    ]);

    const error = await service
      .requireReadyAgentViews(gateways())
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "CONFLICT",
      status: 409,
      details: {
        code: "AGENT_NOT_READY",
        // 界面名字来自登记表（AGENT_TYPES.label），与库里的 name 字段无关。
        agents: [{ type: "image", name: "图片提取 Agent", issues: ["Agent 已停用"] }],
      },
    });
    expect((error as AppError).message).toContain("图片提取 Agent");
  });

  it("文案 Agent 缺模型时也被拦下", async () => {
    vi.mocked(repo.listAgentConfigs).mockResolvedValue([
      record({ type: "image", gatewayModelId: null }),
      record({ type: "copy", gatewayModelId: null }),
    ]);

    const error = await service
      .requireReadyAgentViews(gateways())
      .catch((cause: unknown) => cause);

    expect((error as AppError).details?.agents).toEqual([
      {
        type: "copy",
        name: "文案创作 Agent",
        issues: ["未选择模型：文案创作 Agent 必须绑定一个具体模型"],
      },
    ]);
  });

  it("两个都就绪时通过", async () => {
    vi.mocked(repo.listAgentConfigs).mockResolvedValue([
      record({ type: "image", gatewayModelId: null }),
      record({ type: "copy", gatewayModelId: "gpt-4o-mini" }),
    ]);

    const views = await service.requireReadyAgentViews(gateways());

    expect(views.map((view) => [view.type, view.ready])).toEqual([
      ["image", true],
      ["copy", true],
    ]);
  });
});

describe("按类型取就绪快照（MUST 6、docs/prd/12 MUST 1）", () => {
  it("只取指定类型：图片 Agent 的 modelId 为 null", async () => {
    vi.mocked(repo.listAgentConfigs).mockResolvedValue([
      record({ type: "image", gatewayModelId: null }),
      record({ type: "copy", gatewayModelId: "gpt-4o-mini" }),
    ]);

    const snapshot = await service.requireAgentSnapshotOf(gateways(), "image");

    expect([snapshot.agentType, snapshot.modelId]).toEqual(["image", null]);
  });

  it("另一个类型未就绪不牵连本类型：提取只要求图片 Agent", async () => {
    vi.mocked(repo.listAgentConfigs).mockResolvedValue([
      record({ type: "image", gatewayModelId: null }),
      record({ type: "copy", enabled: false, gatewayModelId: "gpt-4o-mini" }),
    ]);

    await expect(service.requireAgentSnapshotOf(gateways(), "image")).resolves.toMatchObject({
      agentType: "image",
    });
    await expect(service.requireAgentSnapshotOf(gateways(), "copy")).rejects.toMatchObject({
      details: { code: "AGENT_NOT_READY" },
    });
  });

  it("该类型未就绪时不产出快照", async () => {
    vi.mocked(repo.listAgentConfigs).mockResolvedValue([
      record({ type: "image", enabled: false }),
      record({ type: "copy", gatewayModelId: "gpt-4o-mini" }),
    ]);

    await expect(service.requireAgentSnapshotOf(gateways(), "image")).rejects.toMatchObject({
      details: { code: "AGENT_NOT_READY" },
    });
  });
});

describe("配置缺失属于部署问题（MUST 1）", () => {
  it("迁移没跑时明确报 INTERNAL，而不是当成空配置", async () => {
    vi.mocked(repo.listAgentConfigs).mockResolvedValue([]);

    await expect(service.listAgentViews(gateways())).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });
});
