import { describe, expect, it } from "vitest";
import { MagpieVisionClient, VisionError } from "./vision";

/**
 * 图片理解网关的执行客户端（docs/prd/06「视觉提取」、docs/prd/02 `magpie-vision`）：
 * `initialize` 之后用 `tools/call` 调 `analyze_image{image, prompt}`，取回文字。
 *
 * 上游用脚本化 fetch 代替：验证端点、入参、会话复用与失败消息，不碰真实网关。
 */

const API_KEY = "sk-test-local-do-not-use-1234";
const DATA_URL = `data:image/jpeg;base64,${Buffer.from("reference").toString("base64")}`;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function scriptedFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (!next) throw new Error("脚本化的回包不够用");
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonRpc(result: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function textResult(text: string): Response {
  return jsonRpc({ content: [{ type: "text", text }], isError: false });
}

const INIT = () => jsonRpc({ protocolVersion: "2025-06-18", capabilities: {} }, { "mcp-session-id": "s-1" });

function client(fetchImpl: typeof fetch) {
  return new MagpieVisionClient({
    baseUrl: "https://magpie.example.com/",
    apiKey: API_KEY,
    fetchImpl,
    timeoutMs: 5_000,
  });
}

describe("analyze_image 调用", () => {
  it("发到图片理解端点，入参是 { image: dataURL, prompt }", async () => {
    const { fetchImpl, calls } = scriptedFetch([INIT, () => textResult("一张咖啡杯")]);

    const text = await client(fetchImpl).analyzeImage({ image: DATA_URL, prompt: "两句话以内" });

    expect(text).toBe("一张咖啡杯");
    expect(calls[0]?.body.method).toBe("initialize");
    expect(calls[1]?.url).toBe("https://magpie.example.com/mcp/magpie/vision");
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[1]?.headers["mcp-session-id"]).toBe("s-1");
    const params = calls[1]?.body.params as { name: string; arguments: Record<string, unknown> };
    expect(params.name).toBe("analyze_image");
    expect(params.arguments).toEqual({ image: DATA_URL, prompt: "两句话以内" });
  });

  it("同一实例连续识别多张只握手一次", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      INIT,
      () => textResult("第一张"),
      () => textResult("第二张"),
    ]);
    const vision = client(fetchImpl);

    await vision.analyzeImage({ image: DATA_URL, prompt: "p" });
    await vision.analyzeImage({ image: DATA_URL, prompt: "p" });

    expect(calls.filter((call) => call.body.method === "initialize")).toHaveLength(1);
    expect(calls.filter((call) => call.body.method === "tools/call")).toHaveLength(2);
  });
});

describe("失败分类与消息", () => {
  it("工具结果 isError 时抛 VisionError，消息是中文且不回显原文", async () => {
    const { fetchImpl } = scriptedFetch([
      INIT,
      () => jsonRpc({ content: [{ type: "text", text: "boom: upstream detail" }], isError: true }),
    ]);

    const error = await client(fetchImpl)
      .analyzeImage({ image: DATA_URL, prompt: "p" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VisionError);
    expect((error as Error).message).toContain("没能识别");
    expect((error as Error).message).not.toContain("upstream detail");
  });

  it("401 时提示检查网关的 API Key", async () => {
    const { fetchImpl } = scriptedFetch([INIT, () => new Response("unauthorized", { status: 401 })]);

    await expect(client(fetchImpl).analyzeImage({ image: DATA_URL, prompt: "p" })).rejects.toThrow(
      /API Key/,
    );
  });

  it("回包没有文字时抛 VisionError", async () => {
    const { fetchImpl } = scriptedFetch([INIT, () => jsonRpc({ content: [], isError: false })]);

    await expect(client(fetchImpl).analyzeImage({ image: DATA_URL, prompt: "p" })).rejects.toThrow(
      /没有返回描述内容/,
    );
  });

  it("网关不可达时抛 VisionError，消息是中文", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const error = await client(fetchImpl)
      .analyzeImage({ image: DATA_URL, prompt: "p" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VisionError);
    expect((error as Error).message).toContain("无法连接到图片理解网关");
  });
});
