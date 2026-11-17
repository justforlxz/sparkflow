import { describe, expect, it } from "vitest";
import { classifyStatus } from "./http";
import {
  buildInitializeRequest,
  buildToolsListRequest,
  extractToolNames,
  magpieMcpAdapter,
} from "./magpie-mcp";
import { buildAnthropicMessagesRequest, ANTHROPIC_VERSION } from "./anthropic-messages";
import { buildOpenAiChatRequest, openAiChatAdapter } from "./openai-chat";
import { ConnectionTestError, type ProbeTarget } from "./types";

const TARGET: ProbeTarget = {
  baseUrl: "https://gw.example.com/v1",
  apiKey: "sk-test-local-do-not-use-1234",
  modelId: "gpt-4o-mini",
};

interface FakeResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

function fakeFetch(responses: FakeResponse[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("测试用例准备的响应不够用");
    return new Response(next.body ?? "", {
      status: next.status ?? 200,
      headers: next.headers ?? {},
    });
  };
  return { calls, fetchImpl: impl as unknown as typeof fetch };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe("HTTP 状态码分类（MUST 6）", () => {
  it("2xx 成功，401/403 鉴权失败，其余 4xx 配置错误，5xx 归入网络类", () => {
    expect(classifyStatus(200)).toBeNull();
    expect(classifyStatus(401)).toBe("auth");
    expect(classifyStatus(403)).toBe("auth");
    expect(classifyStatus(400)).toBe("config");
    expect(classifyStatus(404)).toBe("config");
    expect(classifyStatus(500)).toBe("network");
    expect(classifyStatus(503)).toBe("network");
  });
});

describe("OpenAI Chat 请求拼装", () => {
  it("拼在 /chat/completions，Bearer 鉴权，最小调用 max_tokens=1", () => {
    const request = buildOpenAiChatRequest(TARGET);

    expect(request.url).toBe("https://gw.example.com/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer sk-test-local-do-not-use-1234");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request.body)).toEqual({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
  });

  it("没有文本模型时给配置错误，而不是发出没有 model 的请求", () => {
    expect(() => buildOpenAiChatRequest({ ...TARGET, modelId: null })).toThrowError(
      ConnectionTestError,
    );
  });

  it("鉴权失败抛 auth", async () => {
    const { fetchImpl } = fakeFetch([{ status: 401, body: "unauthorized" }]);

    await expect(openAiChatAdapter.probe(TARGET, { fetchImpl })).rejects.toMatchObject({
      kind: "auth",
    });
  });
});

describe("Anthropic Messages 请求拼装", () => {
  it("拼在 /messages，x-api-key 与 anthropic-version 头", () => {
    const request = buildAnthropicMessagesRequest(TARGET);

    expect(request.url).toBe("https://gw.example.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe("sk-test-local-do-not-use-1234");
    expect(request.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(request.headers.authorization).toBeUndefined();
    expect(JSON.parse(request.body)).toEqual({
      model: "gpt-4o-mini",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
  });
});

describe("magpie MCP 请求拼装与探测", () => {
  const imageTarget: ProbeTarget = { ...TARGET, modelId: null };

  it("initialize 用 JSON-RPC，端点固定在 /mcp/magpie/image", () => {
    const request = buildInitializeRequest(imageTarget);
    const body = JSON.parse(request.body);

    expect(request.url).toBe("https://gw.example.com/v1/mcp/magpie/image");
    expect(request.headers.authorization).toBe("Bearer sk-test-local-do-not-use-1234");
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("initialize");
    expect(body.params.protocolVersion).toBeTruthy();
  });

  it("tools/list 带上服务端给的会话 ID", () => {
    const request = buildToolsListRequest(imageTarget, "session-1");

    expect(request.headers["mcp-session-id"]).toBe("session-1");
    expect(JSON.parse(request.body).method).toBe("tools/list");
  });

  it("initialize + tools/list 都成功时返回工具数量（SSE 回包也认）", async () => {
    const { calls, fetchImpl } = fakeFetch([
      {
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }),
        headers: { "mcp-session-id": "session-1" },
      },
      {
        body: 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"generate_image"},{"name":"generation_result"}]}}\n\n',
      },
    ]);

    await expect(magpieMcpAdapter.probe(imageTarget, { fetchImpl })).resolves.toBe(
      "MCP 端点可用（2 个工具）",
    );
    expect(calls).toHaveLength(2);
    expect(headersOf(calls[1].init)["mcp-session-id"]).toBe("session-1");
  });

  it("没有工具时判定为配置错误", async () => {
    const { fetchImpl } = fakeFetch([
      { body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) },
      { body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }) },
    ]);

    await expect(magpieMcpAdapter.probe(imageTarget, { fetchImpl })).rejects.toMatchObject({
      kind: "config",
    });
  });

  it("回应不是 JSON-RPC 时判定为配置错误", async () => {
    const { fetchImpl } = fakeFetch([{ body: "<html>not found</html>" }]);

    await expect(magpieMcpAdapter.probe(imageTarget, { fetchImpl })).rejects.toMatchObject({
      kind: "config",
    });
  });

  it("extractToolNames 对异常结构返回空数组", () => {
    expect(extractToolNames({ result: {} })).toEqual([]);
    expect(extractToolNames({ result: { tools: [{ name: "a" }, {}, null] } })).toEqual(["a"]);
  });
});

describe("网络错误", () => {
  it("fetch 直接抛错时归入网络错误，且消息里没有密钥", async () => {
    const failingFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(openAiChatAdapter.probe(TARGET, { fetchImpl: failingFetch })).rejects.toMatchObject({
      kind: "network",
      message: expect.not.stringContaining("sk-test-local-do-not-use-1234"),
    });
  });

  it("超时也是网络错误", async () => {
    const timeoutFetch = (async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof fetch;

    await expect(openAiChatAdapter.probe(TARGET, { fetchImpl: timeoutFetch })).rejects.toMatchObject({
      kind: "network",
      message: expect.stringContaining("超时"),
    });
  });
});
