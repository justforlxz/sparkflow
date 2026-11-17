import { describe, expect, it } from "vitest";
import { encryptSecret } from "@/lib/crypto";
import type { GatewayRecord } from "./repo";
import { toGatewayView } from "./view";

process.env.AUTH_SECRET ||= "unit-test-auth-secret-for-view-0123456789";
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const PLAIN_KEY = "sk-local-test-key-0000123456789";

function record(overrides: Partial<GatewayRecord> = {}): GatewayRecord {
  return {
    id: "gw-1",
    name: "本地网关",
    protocol: "openai-chat",
    baseUrl: "https://gw.example.com/v1",
    encryptedApiKey: encryptSecret(PLAIN_KEY),
    lastTestStatus: null,
    lastTestMessage: null,
    lastTestedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    models: [
      {
        id: "m-1",
        gatewayId: "gw-1",
        modelId: "gpt-4o-mini",
        capability: "text",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ],
    ...overrides,
  };
}

describe("网关对外形状", () => {
  it("只有掩码与 hasApiKey，没有密文也没有明文（MUST 1、AC-03-7）", () => {
    const view = toGatewayView(record());
    const serialized = JSON.stringify(view);

    expect(view.apiKeyMask).toBe(`••••${PLAIN_KEY.slice(-4)}`);
    expect(view.hasApiKey).toBe(true);
    expect(serialized).not.toContain(PLAIN_KEY);
    expect(serialized).not.toContain("encryptedApiKey");
    expect(serialized).not.toContain("encrypted_api_key");
  });

  it("带上模型清单与引用情况", () => {
    const view = toGatewayView(record(), [{ source: "agent", name: "图片创作 Agent" }]);

    expect(view.models).toEqual([{ id: "m-1", modelId: "gpt-4o-mini", capability: "text" }]);
    expect(view.references).toEqual([{ source: "agent", name: "图片创作 Agent" }]);
  });

  it("没有测试记录时 lastTest 为 null", () => {
    expect(toGatewayView(record()).lastTest).toBeNull();
  });

  it("有测试记录时给出成败与失败类别说法", () => {
    const failed = toGatewayView(
      record({
        lastTestStatus: "auth",
        lastTestMessage: "网关返回 401：鉴权失败，请检查 API Key",
        lastTestedAt: new Date("2026-01-02T03:04:05Z"),
      }),
    );
    expect(failed.lastTest).toMatchObject({
      ok: false,
      outcome: "auth",
      failureLabel: "鉴权失败",
      testedAt: "2026-01-02T03:04:05.000Z",
    });

    const ok = toGatewayView(
      record({ lastTestStatus: "ok", lastTestMessage: "接口可用", lastTestedAt: new Date() }),
    );
    expect(ok.lastTest).toMatchObject({ ok: true, outcome: "ok", failureLabel: null });
  });
});
