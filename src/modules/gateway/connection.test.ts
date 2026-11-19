import { describe, expect, it } from "vitest";
import { pickProbeModelId, runConnectionTest } from "./connection";

const TARGET = {
  protocol: "openai-chat",
  baseUrl: "https://gw.example.com/v1",
  apiKey: "sk-test-local-do-not-use-1234",
  modelId: "gpt-4o-mini",
};

function fakeFetch(response: { status: number; body?: string }) {
  return (async () =>
    new Response(response.body ?? "", { status: response.status })) as unknown as typeof fetch;
}

const failingFetch = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

describe("连接测试的结论", () => {
  it("200 判定成功", async () => {
    const result = await runConnectionTest(TARGET, { fetchImpl: fakeFetch({ status: 200 }) });

    expect(result).toMatchObject({ outcome: "ok", ok: true });
  });

  it("401 判定鉴权失败", async () => {
    const result = await runConnectionTest(TARGET, { fetchImpl: fakeFetch({ status: 401 }) });

    expect(result).toMatchObject({ outcome: "auth", ok: false });
    expect(result.message).toContain("鉴权失败");
  });

  it("400 判定配置错误", async () => {
    const result = await runConnectionTest(TARGET, { fetchImpl: fakeFetch({ status: 400 }) });

    expect(result).toMatchObject({ outcome: "config", ok: false });
  });

  it("模型不存在判定模型类，与鉴权错误、地址错误三条文案互不相同（AC-903-1、AC-903-2）", async () => {
    const upstream =
      '{"error":{"message":"The model `group/mkacg903-missing` does not exist","code":"model_not_found"}}';
    const model = await runConnectionTest(
      TARGET,
      { fetchImpl: fakeFetch({ status: 404, body: upstream }) },
    );
    const auth = await runConnectionTest(TARGET, { fetchImpl: fakeFetch({ status: 401 }) });
    const config = await runConnectionTest(TARGET, { fetchImpl: fakeFetch({ status: 404 }) });

    expect(model).toMatchObject({ outcome: "model", ok: false });
    expect(model.message).toContain("模型");
    expect(model.message).not.toContain("请求地址或参数");
    expect(model.message).not.toContain("API Key");
    expect(new Set([model.message, auth.message, config.message]).size).toBe(3);
  });

  it("连不上判定网络错误（AC-02-6）", async () => {
    const result = await runConnectionTest(TARGET, { fetchImpl: failingFetch });

    expect(result).toMatchObject({ outcome: "network", ok: false });
    expect(result.message).toContain("无法连接");
  });

  it("未登记的接口形状按配置错误处理，不发请求", async () => {
    const result = await runConnectionTest({ ...TARGET, protocol: "grpc" });

    expect(result).toMatchObject({ outcome: "config", ok: false });
    expect(result.message).toContain("不支持的接口形状");
  });

  it("文本协议缺模型时是配置错误", async () => {
    const result = await runConnectionTest(
      { ...TARGET, modelId: null },
      { fetchImpl: fakeFetch({ status: 200 }) },
    );

    expect(result).toMatchObject({ outcome: "config", ok: false });
  });
});

describe("探测用的模型选择", () => {
  const models = [
    { modelId: "gpt-image-1", capability: "image" },
    { modelId: "gpt-4o-mini", capability: "text" },
  ];

  it("文本协议取第一个 text 能力的模型", () => {
    expect(pickProbeModelId("openai-chat", models)).toBe("gpt-4o-mini");
    expect(pickProbeModelId("anthropic-messages", models)).toBe("gpt-4o-mini");
  });

  it("图片 MCP 不需要模型（省略 model 参数）", () => {
    expect(pickProbeModelId("magpie-mcp", models)).toBeNull();
  });

  it("没有 text 能力模型时返回 null，由适配器报配置错误", () => {
    expect(pickProbeModelId("openai-chat", [{ modelId: "x", capability: "image" }])).toBeNull();
  });
});
