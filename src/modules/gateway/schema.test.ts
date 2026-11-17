import { describe, expect, it } from "vitest";
import {
  createGatewayModelSchema,
  createGatewaySchema,
  normalizeBaseUrl,
  updateGatewaySchema,
} from "./schema";

describe("Base URL 归一化与校验", () => {
  it("去掉尾部斜杠，避免拼出双斜杠", () => {
    expect(normalizeBaseUrl("https://gw.example.com/")).toBe("https://gw.example.com");
    expect(normalizeBaseUrl("  https://gw.example.com//  ")).toBe("https://gw.example.com");
  });

  it("创建时归一化 Base URL", () => {
    const parsed = createGatewaySchema.parse({
      name: "  测试网关 ",
      protocol: "openai-chat",
      baseUrl: "https://gw.example.com/v1/",
      apiKey: " sk-local-test-key-9f8e7d6c5b4a4321cdef ",
    });

    expect(parsed.baseUrl).toBe("https://gw.example.com/v1");
    expect(parsed.name).toBe("测试网关");
    expect(parsed.apiKey).toBe("sk-local-test-key-9f8e7d6c5b4a4321cdef");
  });

  it("拒绝非 http(s) 与非 URL", () => {
    expect(() =>
      createGatewaySchema.parse({
        name: "x",
        protocol: "openai-chat",
        baseUrl: "ftp://gw.example.com",
        apiKey: "k",
      }),
    ).toThrowError(/http/);

    expect(() =>
      createGatewaySchema.parse({
        name: "x",
        protocol: "openai-chat",
        baseUrl: "gw.example.com",
        apiKey: "k",
      }),
    ).toThrowError(/http\(s\)|http/);
  });

  it("创建时必须填密钥，接口形状必须是已登记的取值", () => {
    expect(() =>
      createGatewaySchema.parse({
        name: "x",
        protocol: "openai-chat",
        baseUrl: "https://gw.example.com",
        apiKey: "   ",
      }),
    ).toThrowError(/API Key/);

    expect(() =>
      createGatewaySchema.parse({
        name: "x",
        protocol: "grpc",
        baseUrl: "https://gw.example.com",
        apiKey: "k",
      }),
    ).toThrowError(/接口形状/);
  });

  it("编辑时所有字段可省略，密钥留空也是合法输入（等于保留原密钥）", () => {
    expect(updateGatewaySchema.parse({})).toEqual({});
    expect(updateGatewaySchema.parse({ apiKey: "" })).toEqual({ apiKey: "" });
    expect(updateGatewaySchema.parse({ name: "改名" })).toEqual({ name: "改名" });
  });
});

describe("模型条目", () => {
  it("能力必须是已登记的标签", () => {
    expect(createGatewayModelSchema.parse({ modelId: "gpt-4o", capability: "text" })).toEqual({
      modelId: "gpt-4o",
      capability: "text",
    });

    expect(() =>
      createGatewayModelSchema.parse({ modelId: "gpt-4o", capability: "multimodal" }),
    ).toThrowError(/模型能力/);
  });

  it("模型 ID 不能为空", () => {
    expect(() => createGatewayModelSchema.parse({ modelId: "  ", capability: "text" })).toThrowError(
      /模型 ID/,
    );
  });
});
