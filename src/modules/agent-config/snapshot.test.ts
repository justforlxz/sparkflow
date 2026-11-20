import { describe, expect, it } from "vitest";
import { findAgentType } from "./constants";
import type { AgentGatewayBinding } from "./readiness";
import type { AgentConfigRecord } from "./repo";
import { buildAgentSnapshot } from "./snapshot";
import { toAgentView } from "./view";

/** 只用于「不许出现在快照里」的全文搜索断言。 */
const PLAIN_KEY = "sk-test-should-never-appear-in-snapshot";

/** 网关记录在库里确实带密文与掩码：快照不能把它们带出去。 */
function gateway(): AgentGatewayBinding & { encryptedApiKey: string; apiKeyMask: string } {
  return {
    id: "gw-1",
    name: "本地网关",
    protocol: "openai-chat",
    baseUrl: "https://gw.example.com/v1",
    encryptedApiKey: "v1:aXY:dGFn:Y2lwaGVy",
    apiKeyMask: `••••${PLAIN_KEY.slice(-4)}`,
    models: [
      { modelId: "gpt-image-1", capability: "image" },
      { modelId: "gpt-4o-mini", capability: "text" },
    ],
  };
}

function record(overrides: Partial<AgentConfigRecord> = {}): AgentConfigRecord {
  return {
    type: "image",
    enabled: true,
    name: "图片创作 Agent",
    gatewayId: "gw-1",
    gatewayModelId: null,
    role: "角色说明",
    systemPrompt: "系统提示词",
    outputRequirements: "输出要求",
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function snapshotOf(config: AgentConfigRecord) {
  const definition = findAgentType(config.type)!;
  const binding = gateway();
  const view = toAgentView(definition, config, binding);
  return buildAgentSnapshot(view, binding);
}

const SNAPSHOT_KEYS = [
  "agentType",
  "baseUrl",
  "enabled",
  "gatewayId",
  "modelId",
  "name",
  "outputRequirements",
  "protocol",
  "role",
  "systemPrompt",
];

describe("创建任务用的配置快照（MUST 6）", () => {
  it("字段就是 MUST 6 列出的那几项，键名里没有密钥相关词", () => {
    const snapshot = snapshotOf(record());
    const keys = Object.keys(snapshot).sort();

    expect(keys).toEqual(SNAPSHOT_KEYS);
    for (const key of keys) expect(key).not.toMatch(/api-?key|secret|token/i);
  });

  it("图片 Agent 的模型留空时 modelId 为 null（执行时省略模型参数）", () => {
    expect(snapshotOf(record({ type: "image", gatewayModelId: null })).modelId).toBeNull();
  });


  it("文案 Agent 的快照带上绑定的模型名", () => {
    expect(
      snapshotOf(record({ type: "copy", gatewayModelId: "gpt-4o-mini" })).modelId,
    ).toBe("gpt-4o-mini");
  });

  it("取到的是配置里的文本与网关的协议与地址", () => {
    expect(snapshotOf(record())).toMatchObject({
      agentType: "image",
      enabled: true,
      name: "图片创作 Agent",
      gatewayId: "gw-1",
      protocol: "openai-chat",
      baseUrl: "https://gw.example.com/v1",
      role: "角色说明",
      systemPrompt: "系统提示词",
      outputRequirements: "输出要求",
    });
  });
});

describe("快照里没有任何密钥（AC-03-9、AC-04-10）", () => {
  it("键名断言：不存在 apiKey / encryptedApiKey / apiKeyMask", () => {
    const snapshot = snapshotOf(record());
    const text = JSON.stringify(snapshot);

    expect(snapshot).not.toHaveProperty("apiKey");
    expect(snapshot).not.toHaveProperty("encryptedApiKey");
    expect(snapshot).not.toHaveProperty("apiKeyMask");
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("encryptedApiKey");
  });

  it("全文搜索：测试密钥与密文命中 0 次", () => {
    const text = JSON.stringify({
      image: snapshotOf(record()),
      copy: snapshotOf(record({ type: "copy", gatewayModelId: "gpt-4o-mini" })),
    });

    expect(text.includes(PLAIN_KEY)).toBe(false);
    expect(text.includes("v1:aXY:dGFn:Y2lwaGVy")).toBe(false);
  });
});

describe("快照的前置条件", () => {
  it("没绑定网关时拒绝生成，避免产出无法执行的快照", () => {
    const definition = findAgentType("image")!;
    const config = record({ gatewayId: null });

    expect(() => buildAgentSnapshot(toAgentView(definition, config, null), gateway())).toThrow();
  });
});
