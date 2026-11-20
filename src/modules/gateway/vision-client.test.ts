import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_PROTOCOLS } from "./constants";
import { MagpieVisionClient } from "./vision";

/**
 * 视觉提取的网关选择（docs/prd/02 `magpie-vision`、06「视觉提取」）：
 * `createVisionClient()` 取最近更新的 `magpie-vision` 网关并带上解出来的密钥；
 * 没配置、或密钥解不开时返回 `null`，由文案阶段按「未包含照片内容」降级。
 *
 * 这里替换持久化与解密两处边界：验证的是选择与失败分支，不碰数据库。
 */
vi.mock("./repo", () => ({ findGatewayByProtocol: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: vi.fn(), encryptSecret: vi.fn() }));

const repo = await import("./repo");
const crypto = await import("@/lib/crypto");
const { VISION_PROTOCOL, createVisionClient } = await import("./service");

const findGatewayByProtocol = vi.mocked(repo.findGatewayByProtocol);
const decryptSecret = vi.mocked(crypto.decryptSecret);

function gatewayRecord(overrides: { id?: string; baseUrl?: string } = {}) {
  return {
    id: overrides.id ?? "gw-vision",
    name: "图片理解网关",
    protocol: VISION_PROTOCOL,
    baseUrl: overrides.baseUrl ?? "https://magpie.example.com",
    encryptedApiKey: "v1:cipher",
    lastTestStatus: null,
    lastTestMessage: null,
    lastTestedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    models: [],
  };
}

/** 假网关：initialize 回会话，tools/call 回一句描述。 */
function fakeVisionFetch() {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const responses = [
    () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "s-1" },
      }),
    () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "一只橘猫" }], isError: false },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (!next) throw new Error("响应用完了");
    return next();
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("视觉网关的选择", () => {
  it("注册表里有 magpie-vision，且与 VISION_PROTOCOL 一致", () => {
    expect(VISION_PROTOCOL).toBe("magpie-vision");
    expect(GATEWAY_PROTOCOLS.map((entry) => entry.value)).toContain(VISION_PROTOCOL);
  });

  it("没有该协议的网关时返回 null（文案阶段据此降级）", async () => {
    findGatewayByProtocol.mockResolvedValue(null);

    await expect(createVisionClient()).resolves.toBeNull();
    expect(findGatewayByProtocol).toHaveBeenCalledWith(VISION_PROTOCOL);
  });

  it("存在网关时返回客户端，请求打到记录里的地址并带解出来的密钥", async () => {
    findGatewayByProtocol.mockResolvedValue(
      gatewayRecord({ baseUrl: "https://magpie.example.com" }),
    );
    decryptSecret.mockReturnValue("plain-vision-key");
    const { fetchImpl, calls } = fakeVisionFetch();

    const client = await createVisionClient({ fetchImpl });

    expect(client).toBeInstanceOf(MagpieVisionClient);
    await expect(client?.analyzeImage({ image: "data:image/jpeg;base64,AAA", prompt: "描述" })).resolves.toBe("一只橘猫");

    expect(calls[1]?.url).toBe("https://magpie.example.com/mcp/magpie/vision");
    expect(calls[1]?.headers.authorization).toBe("Bearer plain-vision-key");
    expect((calls[1]?.body.params as { name: string }).name).toBe("analyze_image");
  });

  it("密钥解不开时返回 null，不抛错", async () => {
    findGatewayByProtocol.mockResolvedValue(gatewayRecord());
    decryptSecret.mockImplementation(() => {
      throw new Error("密文格式不正确");
    });

    await expect(createVisionClient()).resolves.toBeNull();
  });
});
