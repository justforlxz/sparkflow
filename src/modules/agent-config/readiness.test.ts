import { describe, expect, it } from "vitest";
import { findAgentType } from "./constants";
import { resolveAgentReadiness, type AgentGatewayBinding } from "./readiness";

const image = findAgentType("image")!;
const copy = findAgentType("copy")!;

function gateway(overrides: Partial<AgentGatewayBinding> = {}): AgentGatewayBinding {
  return {
    id: "gw-1",
    name: "本地网关",
    protocol: "openai-chat",
    baseUrl: "https://gw.example.com/v1",
    models: [
      { modelId: "gpt-image-1", capability: "image" },
      { modelId: "gpt-4o-mini", capability: "text" },
      { modelId: "qwen-vl", capability: "image_input" },
    ],
    ...overrides,
  };
}

describe("图片 Agent 的模型可以留空（MUST 3、AC-03-3）", () => {
  it("绑定网关、模型留空时是 gateway-default 且就绪", () => {
    const readiness = resolveAgentReadiness(
      image,
      { enabled: true, gatewayId: "gw-1", gatewayModelId: null },
      gateway(),
    );

    expect(readiness.state).toBe("gateway-default");
    expect(readiness.ready).toBe(true);
    expect(readiness.issues).toEqual([]);
  });

  it("没有绑定网关时是 unbound，不能用来创建任务", () => {
    const readiness = resolveAgentReadiness(
      image,
      { enabled: true, gatewayId: null, gatewayModelId: null },
      null,
    );

    expect(readiness.state).toBe("unbound");
    expect(readiness.ready).toBe(false);
    expect(readiness.issues).toContain("未绑定网关");
  });

  it("绑定了 image 能力的模型时是 ok", () => {
    expect(
      resolveAgentReadiness(
        image,
        { enabled: true, gatewayId: "gw-1", gatewayModelId: "gpt-image-1" },
        gateway(),
      ).state,
    ).toBe("ok");
  });
});

describe("文案 Agent 必须绑定模型（MUST 4）", () => {
  it("模型留空时是 invalid，并说明未选择模型", () => {
    const readiness = resolveAgentReadiness(
      copy,
      { enabled: true, gatewayId: "gw-1", gatewayModelId: null },
      gateway(),
    );

    expect(readiness.state).toBe("invalid");
    expect(readiness.ready).toBe(false);
    expect(readiness.issues.join()).toContain("未选择模型");
  });

  it("text 与 image_input 能力的模型都能绑", () => {
    for (const modelId of ["gpt-4o-mini", "qwen-vl"]) {
      const readiness = resolveAgentReadiness(
        copy,
        { enabled: true, gatewayId: "gw-1", gatewayModelId: modelId },
        gateway(),
      );
      expect(readiness.state).toBe("ok");
      expect(readiness.ready).toBe(true);
    }
  });
});

describe("绑定失效时显式提示，不静默回退（SHOULD）", () => {
  it("网关不存在", () => {
    const readiness = resolveAgentReadiness(
      image,
      { enabled: true, gatewayId: "deleted-gw", gatewayModelId: null },
      null,
    );

    expect(readiness.state).toBe("invalid");
    expect(readiness.issues.join()).toContain("绑定已失效");
  });

  it("网关里已经没有这个模型", () => {
    const readiness = resolveAgentReadiness(
      copy,
      { enabled: true, gatewayId: "gw-1", gatewayModelId: "removed-model" },
      gateway(),
    );

    expect(readiness.state).toBe("invalid");
    expect(readiness.issues.join()).toContain("绑定已失效");
  });

  it("能力不匹配：给图片 Agent 绑了文本模型", () => {
    const readiness = resolveAgentReadiness(
      image,
      { enabled: true, gatewayId: "gw-1", gatewayModelId: "gpt-4o-mini" },
      gateway(),
    );

    expect(readiness.state).toBe("invalid");
    expect(readiness.ready).toBe(false);
    expect(readiness.issues.join()).toContain("能力");
  });

  it("有模型但没绑定网关时也算失效", () => {
    const readiness = resolveAgentReadiness(
      image,
      { enabled: true, gatewayId: null, gatewayModelId: "gpt-image-1" },
      null,
    );

    expect(readiness.state).toBe("invalid");
    expect(readiness.ready).toBe(false);
  });
});

describe("停用的 Agent 不能用于创建任务（MUST 8）", () => {
  it("绑定可用但已停用时，就绪为 false 并说明已停用", () => {
    const readiness = resolveAgentReadiness(
      image,
      { enabled: false, gatewayId: "gw-1", gatewayModelId: null },
      gateway(),
    );

    expect(readiness.state).toBe("gateway-default");
    expect(readiness.ready).toBe(false);
    expect(readiness.issues).toContain("Agent 已停用");
  });
});
