process.env.AUTH_SECRET ||= "unit-test-auth-secret-for-service-0123456789";
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import type { GatewayRecord } from "./repo";

vi.mock("./repo", () => ({
  listGateways: vi.fn(),
  findGateway: vi.fn(),
  findGatewayByProtocol: vi.fn(),
  createGatewayRecord: vi.fn(),
  updateGatewayRecord: vi.fn(),
  deleteGatewayRecord: vi.fn(),
  createModelRecord: vi.fn(),
  findModelRecord: vi.fn(),
  deleteModelRecord: vi.fn(),
  listModelsByCapability: vi.fn(),
  recordTestResult: vi.fn(),
}));

const repo = await import("./repo");
const service = await import("./service");

const PLAIN_KEY = "sk-local-test-key-0000123456789";
const NEW_KEY = "sk-local-test-key-new-000000001";

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

beforeEach(() => {
  vi.mocked(repo.createGatewayRecord).mockImplementation(async (input) => record(input));
  vi.mocked(repo.updateGatewayRecord).mockImplementation(async (_id, input) =>
    record({ ...input, encryptedApiKey: input.encryptedApiKey ?? encryptSecret(PLAIN_KEY) }),
  );
  vi.mocked(repo.deleteGatewayRecord).mockResolvedValue();
  vi.mocked(repo.recordTestResult).mockResolvedValue();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("删除网关的引用检查（MUST 3、AC-02-4）", () => {
  it("被引用时返回 409 并指出引用方，且不删数据", async () => {
    vi.mocked(repo.findGateway).mockResolvedValue(record());
    const lookup = vi.fn().mockResolvedValue([{ source: "agent", name: "图片创作 Agent" }]);

    const error = await service.deleteGateway("gw-1", lookup).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "CONFLICT",
      status: 409,
      details: { code: "GATEWAY_IN_USE", references: [{ source: "agent", name: "图片创作 Agent" }] },
    });
    expect((error as AppError).message).toContain("图片创作 Agent");
    expect(repo.deleteGatewayRecord).not.toHaveBeenCalled();
  });

  it("没有引用时正常删除（模型条目随外键级联）", async () => {
    vi.mocked(repo.findGateway).mockResolvedValue(record());

    await service.deleteGateway("gw-1", async () => []);

    expect(repo.deleteGatewayRecord).toHaveBeenCalledWith("gw-1");
  });

  it("网关不存在时返回 NOT_FOUND", async () => {
    vi.mocked(repo.findGateway).mockResolvedValue(null);

    await expect(service.deleteGateway("missing", async () => [])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("编辑时密钥留空保留原密钥（MUST 2、AC-02-3）", () => {
  it("apiKey 为空串时不传加密字段", async () => {
    vi.mocked(repo.findGateway).mockResolvedValue(record());

    await service.updateGateway("gw-1", { name: "改名", apiKey: "" }, async () => []);

    const input = vi.mocked(repo.updateGatewayRecord).mock.calls[0][1];
    expect(input).toEqual({ name: "改名" });
    expect(input).not.toHaveProperty("encryptedApiKey");
  });

  it("返回形状与列表一致：带上引用情况", async () => {
    vi.mocked(repo.findGateway).mockResolvedValue(record());

    const view = await service.updateGateway("gw-1", { name: "改名" }, async () => [
      { source: "agent", name: "图片提取 Agent" },
    ]);

    expect(view.references).toEqual([{ source: "agent", name: "图片提取 Agent" }]);
  });

  it("重新填入密钥时写入新的密文", async () => {
    vi.mocked(repo.findGateway).mockResolvedValue(record());

    await service.updateGateway("gw-1", { apiKey: NEW_KEY }, async () => []);

    const input = vi.mocked(repo.updateGatewayRecord).mock.calls[0][1];
    expect(input.encryptedApiKey).toBeDefined();
    expect(input.encryptedApiKey).not.toContain(NEW_KEY);
    expect(decryptSecret(input.encryptedApiKey as string)).toBe(NEW_KEY);
  });
});

describe("新增网关", () => {
  it("明文不落库：写进去的是密文，返回的是掩码", async () => {
    const view = await service.createGateway({
      name: "本地网关",
      protocol: "openai-chat",
      baseUrl: "https://gw.example.com/v1",
      apiKey: PLAIN_KEY,
    });

    const stored = vi.mocked(repo.createGatewayRecord).mock.calls[0][0];
    expect(stored.encryptedApiKey).not.toContain(PLAIN_KEY);
    expect(view.apiKeyMask).toBe(`••••${PLAIN_KEY.slice(-4)}`);
    expect(JSON.stringify(view)).not.toContain(PLAIN_KEY);
  });
});

describe("连接测试落库（SHOULD）", () => {
  it("成功时记录 ok 与结论", async () => {
    vi.mocked(repo.findGateway).mockResolvedValue(record());
    vi.stubGlobal("fetch", (async () => new Response("", { status: 200 })) as unknown as typeof fetch);

    const result = await service.testGatewayConnection("gw-1");

    expect(result.result).toMatchObject({ outcome: "ok", ok: true });
    expect(repo.recordTestResult).toHaveBeenCalledWith(
      "gw-1",
      "ok",
      expect.stringContaining("OpenAI Chat 接口可用"),
      expect.any(Date),
    );
  });

  it("鉴权失败时记录 auth", async () => {
    vi.mocked(repo.findGateway).mockResolvedValue(record());
    vi.stubGlobal("fetch", (async () => new Response("", { status: 401 })) as unknown as typeof fetch);

    const result = await service.testGatewayConnection("gw-1");

    expect(result.result).toMatchObject({ outcome: "auth", ok: false });
    expect(repo.recordTestResult).toHaveBeenCalledWith(
      "gw-1",
      "auth",
      expect.any(String),
      expect.any(Date),
    );
  });
});

describe("阶段执行期取网关参数（docs/prd/04 MUST 4）", () => {
  it("返回协议、Base URL 与解密后的密钥", async () => {
    vi.mocked(repo.findGateway).mockResolvedValue(
      record({ protocol: "magpie-mcp", baseUrl: "https://magpie.example.com" }),
    );

    await expect(service.getGatewayExecutionTarget("gw-1")).resolves.toEqual({
      id: "gw-1",
      protocol: "magpie-mcp",
      baseUrl: "https://magpie.example.com",
      apiKey: PLAIN_KEY,
    });
  });

  it("网关不存在时抛 NOT_FOUND，不尝试解密", async () => {
    vi.mocked(repo.findGateway).mockResolvedValue(null);

    await expect(service.getGatewayExecutionTarget("gw-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("密钥无法解密时抛 UPSTREAM_FAILED + GATEWAY_KEY_UNREADABLE，日志里没有密钥", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(repo.findGateway).mockResolvedValue(
      record({ protocol: "magpie-mcp", encryptedApiKey: "v1:broken:broken:broken" }),
    );

    const error = await service.getGatewayExecutionTarget("gw-1").catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "UPSTREAM_FAILED",
      details: { code: "GATEWAY_KEY_UNREADABLE" },
    });
    expect((error as Error).message).not.toContain(PLAIN_KEY);
    expect(JSON.stringify([...log.mock.calls, ...errorLog.mock.calls])).not.toContain(PLAIN_KEY);
  });
});
