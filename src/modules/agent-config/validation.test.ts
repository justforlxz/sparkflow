import { describe, expect, it } from "vitest";
import { isAppError } from "@/lib/errors";
import { findAgentType } from "./constants";
import type { AgentGatewayBinding } from "./readiness";
import { assertBindingSavable } from "./validation";

const image = findAgentType("image")!;
const copy = findAgentType("copy")!;

const gateways: AgentGatewayBinding[] = [
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
  {
    id: "gw-2",
    name: "另一个网关",
    protocol: "anthropic-messages",
    baseUrl: "https://other.example.com",
    models: [{ modelId: "claude-sonnet", capability: "text" }],
  },
];

function catchAppError(run: () => void) {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("预期抛出 AppError，但没有抛出");
}

describe("文案 Agent 的模型不能留空（MUST 4、AC-03-4）", () => {
  it("留空时拒绝保存，并在消息里指出缺模型", () => {
    const error = catchAppError(() =>
      assertBindingSavable(copy, { gatewayId: "gw-1", gatewayModelId: null, gateways }),
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details).toMatchObject({ code: "AGENT_MODEL_REQUIRED" });
    expect(error.message).toContain("必须绑定");
    expect(error.message).toContain("模型");
  });

  it("空串与纯空白同样视为留空", () => {
    for (const gatewayModelId of ["", "   "]) {
      expect(
        catchAppError(() =>
          assertBindingSavable(copy, { gatewayId: "gw-1", gatewayModelId, gateways }),
        ).details,
      ).toMatchObject({ code: "AGENT_MODEL_REQUIRED" });
    }
  });
});

describe("图片 Agent 的模型可以留空（MUST 3、AC-03-3）", () => {
  it("绑定网关但模型留空时允许保存", () => {
    expect(() =>
      assertBindingSavable(image, { gatewayId: "gw-1", gatewayModelId: null, gateways }),
    ).not.toThrow();
  });

  it("还没绑网关、模型也留空时允许保存（只是不可就绪）", () => {
    expect(() =>
      assertBindingSavable(image, { gatewayId: null, gatewayModelId: null, gateways }),
    ).not.toThrow();
  });
});

describe("模型必须属于所选网关（MUST 5、AC-03-5）", () => {
  it("选了另一个网关的模型时拒绝，并指出网关名", () => {
    const error = catchAppError(() =>
      assertBindingSavable(copy, {
        gatewayId: "gw-1",
        gatewayModelId: "claude-sonnet",
        gateways,
      }),
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details).toMatchObject({ code: "AGENT_MODEL_NOT_IN_GATEWAY" });
    expect(error.message).toContain("本地网关");
  });

  it("网关不存在时拒绝", () => {
    const error = catchAppError(() =>
      assertBindingSavable(copy, { gatewayId: "gone", gatewayModelId: "gpt-4o-mini", gateways }),
    );

    expect(error.details).toMatchObject({ code: "AGENT_GATEWAY_NOT_FOUND" });
  });
  // 模型留空也要先确认网关存在：否则不存在的 id 会被外键拒绝，接口只能返回 500。
  it("模型留空但网关不存在时同样拒绝（图片 Agent）", () => {
    const error = catchAppError(() =>
      assertBindingSavable(image, { gatewayId: "gone", gatewayModelId: null, gateways }),
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details).toMatchObject({ code: "AGENT_GATEWAY_NOT_FOUND" });
    expect(error.message).toContain("网关不存在");
  });

  it("模型留空且网关不存在时，先报网关不存在而不是缺模型（文案 Agent）", () => {
    const error = catchAppError(() =>
      assertBindingSavable(copy, { gatewayId: "gone", gatewayModelId: null, gateways }),
    );

    expect(error.details).toMatchObject({ code: "AGENT_GATEWAY_NOT_FOUND" });
  });

  it("有模型但没有网关时拒绝", () => {
    const error = catchAppError(() =>
      assertBindingSavable(copy, { gatewayId: null, gatewayModelId: "gpt-4o-mini", gateways }),
    );

    expect(error.details).toMatchObject({ code: "AGENT_GATEWAY_REQUIRED" });
  });

  it("能力不匹配时拒绝（图片 Agent 选文本模型）", () => {
    const error = catchAppError(() =>
      assertBindingSavable(image, { gatewayId: "gw-1", gatewayModelId: "gpt-4o-mini", gateways }),
    );

    expect(error.details).toMatchObject({
      code: "AGENT_MODEL_CAPABILITY_MISMATCH",
      capability: "text",
    });
  });

  it("合法绑定时通过", () => {
    expect(() =>
      assertBindingSavable(copy, { gatewayId: "gw-2", gatewayModelId: "claude-sonnet", gateways }),
    ).not.toThrow();
  });
});
