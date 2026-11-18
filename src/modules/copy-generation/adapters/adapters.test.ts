import { describe, expect, it } from "vitest";
import { ANTHROPIC_VERSION } from "@/modules/gateway/adapters/anthropic-messages";
import { ANTHROPIC_MAX_TOKENS, COPY_ERROR_CODES } from "../constants";
import { anthropicMessagesTextGenerator } from "./anthropic-messages";
import { buildAnthropicMessagesRequest, readAnthropicMessagesText } from "./anthropic-messages";
import { findTextGenerator } from "./index";
import { buildOpenAiChatRequest, openAiChatTextGenerator, readOpenAiChatText } from "./openai-chat";
import { joinUrl, type TextGenerationInput } from "./types";

const API_KEY = "sk-test-local-do-not-use-1234";

const INPUT: TextGenerationInput = {
  baseUrl: "https://gw.example.com/v1",
  apiKey: API_KEY,
  modelId: "text-model",
  system: "系统提示词",
  user: "用户提示词",
};

interface FakeResponse {
  status?: number;
  body?: string;
}

function fakeFetch(responses: FakeResponse[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("测试用例准备的响应不够用");
    return new Response(next.body ?? "", { status: next.status ?? 200 });
  };
  return { calls, fetchImpl: impl as unknown as typeof fetch };
}

describe("请求拼装", () => {
  it("OpenAI Chat 拼在 /chat/completions，Bearer 鉴权，system 与 user 两条消息", () => {
    const request = buildOpenAiChatRequest(INPUT);

    expect(request.url).toBe("https://gw.example.com/v1/chat/completions");
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(request.body)).toEqual({
      model: "text-model",
      messages: [
        { role: "system", content: "系统提示词" },
        { role: "user", content: "用户提示词" },
      ],
    });
  });

  it("Anthropic Messages 拼在 /messages，x-api-key 与版本头，system 走顶层字段", () => {
    const request = buildAnthropicMessagesRequest(INPUT);

    expect(request.url).toBe("https://gw.example.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe(API_KEY);
    expect(request.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(request.headers.authorization).toBeUndefined();
    expect(JSON.parse(request.body)).toEqual({
      model: "text-model",
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: "系统提示词",
      messages: [{ role: "user", content: "用户提示词" }],
    });
  });

  it("Base URL 尾部斜杠不会拼出双斜杠", () => {
    expect(joinUrl("https://gw.example.com/v1/", "/messages")).toBe(
      "https://gw.example.com/v1/messages",
    );
  });

  it("按接口形状取适配器，未知形状返回 undefined", () => {
    expect(findTextGenerator("openai-chat")).toBe(openAiChatTextGenerator);
    expect(findTextGenerator("anthropic-messages")).toBe(anthropicMessagesTextGenerator);
    expect(findTextGenerator("magpie-mcp")).toBeUndefined();
  });
});

describe("回包取文本", () => {
  it("OpenAI 取 choices[0].message.content", () => {
    expect(readOpenAiChatText({ choices: [{ message: { content: "正文" } }] })).toBe("正文");
  });

  it("OpenAI 结构不符时记 COPY_FORMAT", () => {
    expect(() => readOpenAiChatText({ choices: [] })).toThrowError(
      expect.objectContaining({ code: COPY_ERROR_CODES.format }),
    );
  });

  it("Anthropic 取 content 里第一个文本块", () => {
    expect(
      readAnthropicMessagesText({
        content: [
          { type: "thinking", thinking: "先想一想" },
          { type: "text", text: "正文" },
        ],
      }),
    ).toBe("正文");
  });

  it("Anthropic 没有文本块时记 COPY_FORMAT", () => {
    expect(() => readAnthropicMessagesText({ content: [] })).toThrowError(
      expect.objectContaining({ code: COPY_ERROR_CODES.format }),
    );
  });
});

describe("失败分类（AC-06-5）", () => {
  it("正常回包时返回文本", async () => {
    const { fetchImpl } = fakeFetch([
      { body: JSON.stringify({ choices: [{ message: { content: "正文" } }] }) },
    ]);

    await expect(openAiChatTextGenerator.generate({ ...INPUT, fetchImpl })).resolves.toEqual({
      text: "正文",
    });
  });

  it("AC-06-5 上游 401 记 COPY_AUTH，消息里没有密钥", async () => {
    const { fetchImpl } = fakeFetch([{ status: 401, body: "unauthorized" }]);

    await expect(openAiChatTextGenerator.generate({ ...INPUT, fetchImpl })).rejects.toMatchObject({
      code: COPY_ERROR_CODES.auth,
      message: expect.not.stringContaining(API_KEY),
    });
  });

  it("其它非 2xx 记 COPY_REJECTED", async () => {
    const { fetchImpl } = fakeFetch([{ status: 500, body: "boom" }]);

    await expect(openAiChatTextGenerator.generate({ ...INPUT, fetchImpl })).rejects.toMatchObject({
      code: COPY_ERROR_CODES.rejected,
    });
  });

  it("请求超时记 COPY_TIMEOUT", async () => {
    const timeoutFetch = (async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof fetch;

    await expect(
      anthropicMessagesTextGenerator.generate({ ...INPUT, fetchImpl: timeoutFetch }),
    ).rejects.toMatchObject({ code: COPY_ERROR_CODES.timeout });
  });

  it("网络不可达记 COPY_REJECTED，且不回显密钥", async () => {
    const failingFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(
      openAiChatTextGenerator.generate({ ...INPUT, fetchImpl: failingFetch }),
    ).rejects.toMatchObject({
      code: COPY_ERROR_CODES.rejected,
      message: expect.not.stringContaining(API_KEY),
    });
  });

  it("2xx 但回包不是 JSON 记 COPY_FORMAT", async () => {
    const { fetchImpl } = fakeFetch([{ body: "<html>not json</html>" }]);

    await expect(openAiChatTextGenerator.generate({ ...INPUT, fetchImpl })).rejects.toMatchObject({
      code: COPY_ERROR_CODES.format,
    });
  });
});

/** 模拟「响应头已到、正文读取被信号打断」：status 可以给 2xx 或 4xx。 */
function bodyReadFails(status: number, error: Error): typeof fetch {
  return (async () => ({
    status,
    body: null,
    text: async (): Promise<string> => {
      throw error;
    },
  })) as unknown as typeof fetch;
}

function abortError(name: "TimeoutError" | "AbortError"): Error {
  const error = new Error("aborted while reading body");
  error.name = name;
  return error;
}

describe("正文读取阶段的失败分类（评审回归）", () => {
  it("正文读取期间超时记 COPY_TIMEOUT，不再误判成 COPY_FORMAT", async () => {
    const fetchImpl = bodyReadFails(200, abortError("TimeoutError"));

    await expect(openAiChatTextGenerator.generate({ ...INPUT, fetchImpl })).rejects.toMatchObject({
      code: COPY_ERROR_CODES.timeout,
    });
  });

  it("任务中止信号打断正文读取时同样记 COPY_TIMEOUT", async () => {
    const fetchImpl = bodyReadFails(200, abortError("AbortError"));

    await expect(
      anthropicMessagesTextGenerator.generate({ ...INPUT, fetchImpl }),
    ).rejects.toMatchObject({ code: COPY_ERROR_CODES.timeout });
  });

  it("正文读取的其它失败记 COPY_REJECTED", async () => {
    const fetchImpl = bodyReadFails(200, new Error("connection reset"));

    await expect(openAiChatTextGenerator.generate({ ...INPUT, fetchImpl })).rejects.toMatchObject({
      code: COPY_ERROR_CODES.rejected,
    });
  });

  it("401 先按状态码判定为 COPY_AUTH，正文读不出来也不改判", async () => {
    const fetchImpl = bodyReadFails(401, abortError("TimeoutError"));

    await expect(openAiChatTextGenerator.generate({ ...INPUT, fetchImpl })).rejects.toMatchObject({
      code: COPY_ERROR_CODES.auth,
    });
  });
});
