import { describe, expect, it } from "vitest";
import { classifyResponse } from "./http";
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

describe("状态码与响应体的失败分类（MUST 6、AC-903-3）", () => {
  it("2xx 成功、401/403 鉴权失败、5xx 归入网络类", () => {
    expect(classifyResponse(200, "")).toBeNull();
    expect(classifyResponse(401, '{"error":"unauthorized"}')).toBe("auth");
    expect(classifyResponse(403, '{"error":"forbidden"}')).toBe("auth");
    expect(classifyResponse(500, "")).toBe("network");
    expect(classifyResponse(503, "")).toBe("network");
  });

  it("404 且响应体在说模型时归入模型类（含真实 magpie 的措辞）", () => {
    expect(
      classifyResponse(404, '{"error":{"message":"The model `group/x` does not exist"}}'),
    ).toBe("model");
    expect(
      classifyResponse(
        404,
        '{"error":{"code":null,"message":"magpie knows no model \\"group/mkacg903-unavailable\\" Name a model as provider/model (as /v1/models lists it)","type":"not_found_error"}}',
      ),
    ).toBe("model");
    expect(classifyResponse(404, '{"error":{"code":"model_not_found"}}')).toBe("model");
    expect(classifyResponse(404, '{"error":"invalid model_id: group/x"}')).toBe("model");
  });

  it("404 但正文只是在列端点（出现 models 字样）时仍是地址或参数类（回归：Base URL 多写一段）", () => {
    // 真实 magpie 对错误路径的 404 正文，唯一命中是 /v1beta/models/* 里的 models。
    const endpointList =
      '{"error":{"code":null,"message":"magpie serves /v1/chat/completions, /v1/responses, /v1/messages, /v1/systemone, /v1/images/generations, /v1/images/edits, /v1/videos, /v1/embeddings, /v1/rerank, /v1/decisions, /v1/audio/transcriptions, /v1/audio/translations, /v1/audio/speech, /v1/realtime (WebSocket) and /v1beta/models/*","param":null,"type":"not_found_error"}}';

    expect(classifyResponse(404, endpointList)).toBe("config");
  });

  it("404 没提模型时仍是地址或参数类", () => {
    expect(classifyResponse(404, "<html><body>Not Found</body></html>")).toBe("config");
    expect(classifyResponse(404, "")).toBe("config");
  });

  it("400 且响应体提到模型时归入模型类", () => {
    expect(
      classifyResponse(400, '{"error":{"message":"unsupported model: group/x"}}'),
    ).toBe("model");
  });

  it("400 没提模型时仍是地址或参数类", () => {
    expect(classifyResponse(400, '{"error":"missing parameter messages"}')).toBe("config");
  });

  it("401/403 即使响应体提到模型也归入鉴权类（MUST NOT：不把鉴权错误归错类）", () => {
    expect(classifyResponse(401, '{"error":"model not found"}')).toBe("auth");
    expect(classifyResponse(403, '{"error":"model access denied"}')).toBe("auth");
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

  it("模型不存在时抛模型类，文案指向模型 ID，且不回显响应体与英文原文（AC-903-1、AC-903-2）", async () => {
    const upstream =
      '{"error":{"message":"The model `group/mkacg903-missing` does not exist","code":"model_not_found"}}';
    const { fetchImpl } = fakeFetch([{ status: 404, body: upstream }]);

    const error = (await openAiChatAdapter.probe(TARGET, { fetchImpl }).catch((cause) => cause)) as
      | ConnectionTestError
      | undefined;

    expect(error).toBeInstanceOf(ConnectionTestError);
    expect(error?.kind).toBe("model");
    expect(error?.message).toContain("网关返回 404");
    expect(error?.message).toContain("模型");
    expect(error?.message).not.toContain("请求地址或参数");
    expect(error?.message).not.toContain("does not exist");
    expect(error?.message).not.toContain("mkacg903-missing");
  });

  it("404 但响应体没提模型时仍报地址或参数类", async () => {
    const { fetchImpl } = fakeFetch([{ status: 404, body: "<html>Not Found</html>" }]);

    await expect(openAiChatAdapter.probe(TARGET, { fetchImpl })).rejects.toMatchObject({
      kind: "config",
    });
  });

  it("Base URL 多写一段路径时仍报地址或参数类（回归：不回显端点清单）（AC-903-4）", async () => {
    const endpointList =
      '{"error":{"code":null,"message":"magpie serves /v1/chat/completions, /v1/responses, /v1/messages and /v1beta/models/*","type":"not_found_error"}}';
    const { fetchImpl } = fakeFetch([{ status: 404, body: endpointList }]);

    const error = (await openAiChatAdapter.probe(TARGET, { fetchImpl }).catch((cause) => cause)) as
      | ConnectionTestError
      | undefined;

    expect(error?.kind).toBe("config");
    expect(error?.message).toContain("请求地址或参数不被接受");
    expect(error?.message).not.toContain("模型");
    expect(error?.message).not.toContain("/v1beta/models");
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
