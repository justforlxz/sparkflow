import { describe, expect, it } from "vitest";
import { MagpieMcpImageGenerator } from "./magpie-mcp";

/**
 * magpie 图片 MCP 适配器（docs/prd/05 MUST 2、MUST 3、MUST 4、MUST 5、MUST NOT）。
 *
 * 全部用脚本化的 fetch：既证明请求体的形状（不传参考图、模型省略），
 * 也证明响应解析（内联图、URL 下载、未就绪轮询、错误分类）。
 */

const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
).toString("base64");

const API_KEY = "magpie-gateway-secret-for-tests";

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Step = (call: RecordedCall) => Response | Promise<Response>;

function jsonResponse(payload: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function rpcResult(result: unknown, init: { status?: number; sessionId?: string } = {}): Response {
  const response = jsonResponse({ jsonrpc: "2.0", id: 1, result }, init);
  if (init.sessionId) response.headers.set("mcp-session-id", init.sessionId);
  return response;
}

/** 脚本化 fetch：按顺序消费步骤，并记录每次调用。 */
function scriptedFetch(steps: Step[]) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url: typeof input === "string" ? input : input.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);

    const step = steps.shift();
    if (!step) throw new Error(`没有更多脚本步骤：${call.url}`);
    return step(call);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function toolCall(call: RecordedCall): { name: string; arguments: Record<string, unknown> } {
  const params = (call.body?.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  return { name: params.name ?? "", arguments: params.arguments ?? {} };
}

function imageResult(
  images: { data: string; mimeType?: string }[],
  files: { url: string; inline?: boolean }[] = [],
): Response {
  const content: unknown[] = [{ type: "text", text: "Generated with test-model." }];
  for (const image of images) {
    content.push({ type: "image", data: image.data, mimeType: image.mimeType ?? "image/png" });
  }
  return rpcResult({
    content,
    isError: false,
    ...(files.length > 0 ? { _meta: { "usemagpie.ai/files": files } } : {}),
  });
}

function pendingResult(id: string): Response {
  return rpcResult({
    content: [{ type: "text", text: `The image is still being made. Call generation_result with id "${id}"` }],
    isError: false,
    _meta: { "usemagpie.ai/pending": id },
  });
}

function buildGenerator(fetchImpl: typeof fetch) {
  return new MagpieMcpImageGenerator({
    baseUrl: "https://magpie.example.com/",
    apiKey: API_KEY,
    fetchImpl,
    pollIntervalMs: 1,
    maxPollMs: 10_000,
    sleep: async () => {},
  });
}

const INPUT = {
  prompt: "一只在窗边晒太阳的猫",
  n: 2,
  size: "1024x1536",
  quality: null,
  model: null,
};

describe("magpie 图片 MCP 请求形状", () => {
  it("AC-05-2、AC-05-3 请求体不传 reference_images，快照没有模型时不出现 model", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => rpcResult({ protocolVersion: "2025-06-18" }, { sessionId: "session-1" }),
      () => imageResult([{ data: PNG_ONE_PIXEL }]),
    ]);

    const images = await buildGenerator(fetchImpl).generate(INPUT);

    expect(images).toHaveLength(1);
    expect(images[0]?.bytes.toString("base64")).toBe(PNG_ONE_PIXEL);
    expect(images[0]?.mimeType).toBe("image/png");

    // 端点与鉴权头
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://magpie.example.com/mcp/magpie/image");
    expect(calls[0]?.body?.method).toBe("initialize");
    expect(calls[1]?.body?.method).toBe("tools/call");
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[1]?.headers["mcp-session-id"]).toBe("session-1");

    const { name, arguments: args } = toolCall(calls[1]!);
    expect(name).toBe("generate_image");
    expect(args).toEqual({ prompt: INPUT.prompt, n: 2, size: "1024x1536" });
    expect(args).not.toHaveProperty("reference_images");
    expect(args).not.toHaveProperty("model");
  });

  it("AC-06-10 模型取自本次请求：两次调用各带各自的 model", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => rpcResult({}),
      () => imageResult([{ data: PNG_ONE_PIXEL }]),
      () => imageResult([{ data: PNG_ONE_PIXEL }]),
    ]);

    const generator = buildGenerator(fetchImpl);
    await generator.generate({ ...INPUT, model: "image-model-a" });
    await generator.generate({ ...INPUT, model: "image-model-b" });

    expect(toolCall(calls[1]!).arguments.model).toBe("image-model-a");
    expect(toolCall(calls[2]!).arguments.model).toBe("image-model-b");
  });

  it("只握手一次：同一适配器的多次出图复用会话", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => rpcResult({}, { sessionId: "session-1" }),
      () => imageResult([{ data: PNG_ONE_PIXEL }]),
      () => imageResult([{ data: PNG_ONE_PIXEL }]),
    ]);

    const generator = buildGenerator(fetchImpl);
    await generator.generate(INPUT);
    await generator.generate(INPUT);

    expect(calls.filter((call) => call.body?.method === "initialize")).toHaveLength(1);
  });
});

describe("magpie 图片 MCP 响应解析", () => {
  it("AC-05-4 回 id 时只轮询 generation_result，不重复 generate_image", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => rpcResult({}),
      () => pendingResult("img_abc"),
      () => pendingResult("img_abc"),
      () => imageResult([{ data: PNG_ONE_PIXEL }]),
    ]);

    const images = await buildGenerator(fetchImpl).generate(INPUT);

    expect(images).toHaveLength(1);
    const tools = calls
      .map((call) => (call.body?.method === "tools/call" ? toolCall(call) : null))
      .filter((call): call is { name: string; arguments: Record<string, unknown> } => call !== null);
    expect(tools.map((call) => call.name)).toEqual([
      "generate_image",
      "generation_result",
      "generation_result",
    ]);
    expect(tools[1]!.arguments).toEqual({ id: "img_abc" });
  });

  it("轮询超过上限时以 UPSTREAM_TIMEOUT 结束，并指出上游任务 id", async () => {
    const { fetchImpl } = scriptedFetch([
      () => rpcResult({}),
      () => pendingResult("img_slow"),
      () => pendingResult("img_slow"),
    ]);

    const generator = new MagpieMcpImageGenerator({
      baseUrl: "https://magpie.example.com",
      apiKey: API_KEY,
      fetchImpl,
      now: (() => {
        let current = 0;
        return () => (current += 6_000);
      })(),
      maxPollMs: 5_000,
      sleep: async () => {},
    });

    await expect(generator.generate(INPUT)).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      message: expect.stringContaining("img_slow") as unknown as string,
    });
  });

  it("内联图之外的图片按 _meta 的 URL 下载，并带上鉴权头", async () => {
    const webpBytes = Buffer.from("RIFF0000WEBP", "binary");
    const { fetchImpl, calls } = scriptedFetch([
      () => rpcResult({}),
      () =>
        imageResult([{ data: PNG_ONE_PIXEL }], [
          { url: "https://magpie.example.com/mcp/magpie/image/files/a.png", inline: true },
          { url: "https://magpie.example.com/mcp/magpie/image/files/b.webp" },
        ]),
      () =>
        new Response(new Uint8Array(webpBytes), {
          status: 200,
          headers: { "content-type": "image/webp" },
        }),
    ]);

    const images = await buildGenerator(fetchImpl).generate({ ...INPUT, n: 2 });

    expect(images).toHaveLength(2);
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[1]?.mimeType).toBe("image/webp");
    expect(images[1]?.bytes.equals(webpBytes)).toBe(true);
    expect(calls[2]?.method).toBe("GET");
    expect(calls[2]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("MUST NOT 下载失败时抛错，不把阶段当成功；状态码按失败分类翻译", async () => {
    // 5xx：网关暂时不可用 → 超时类
    const serverError = scriptedFetch([
      () => rpcResult({}),
      () => imageResult([], [{ url: "https://magpie.example.com/files/gone.png" }]),
      () => new Response("gone", { status: 500 }),
    ]);
    await expect(buildGenerator(serverError.fetchImpl).generate(INPUT)).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });

    // 403：图片 URL 过期（网关只保留 1 小时）→ 鉴权类
    const forbidden = scriptedFetch([
      () => rpcResult({}),
      () => imageResult([], [{ url: "https://magpie.example.com/files/expired.png" }]),
      () => new Response("expired", { status: 403 }),
    ]);
    await expect(buildGenerator(forbidden.fetchImpl).generate(INPUT)).rejects.toMatchObject({
      code: "UPSTREAM_AUTH",
    });

    // 404：地址或参数不被接受 → 拒绝类
    const notFound = scriptedFetch([
      () => rpcResult({}),
      () => imageResult([], [{ url: "https://magpie.example.com/files/missing.png" }]),
      () => new Response("missing", { status: 404 }),
    ]);
    await expect(buildGenerator(notFound.fetchImpl).generate(INPUT)).rejects.toMatchObject({
      code: "UPSTREAM_REJECTED",
    });
  });

  it("上游 isError 的工具结果归为 UPSTREAM_REJECTED 并带上原因", async () => {
    const { fetchImpl } = scriptedFetch([
      () => rpcResult({}),
      () =>
        rpcResult({
          content: [{ type: "text", text: "no image: the model doesn't take size" }],
          isError: true,
        }),
    ]);

    await expect(buildGenerator(fetchImpl).generate(INPUT)).rejects.toMatchObject({
      code: "UPSTREAM_REJECTED",
      message: expect.stringContaining("the model doesn't take size") as unknown as string,
    });
  });

  it("既没有图片也没有任务 id 时归为 UPSTREAM_FORMAT", async () => {
    const { fetchImpl } = scriptedFetch([() => rpcResult({}), () => rpcResult({ content: [] })]);

    await expect(buildGenerator(fetchImpl).generate(INPUT)).rejects.toMatchObject({
      code: "UPSTREAM_FORMAT",
    });
  });

  it("SSE 回包的响应体也能读图", async () => {
    const sse = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "image", data: PNG_ONE_PIXEL, mimeType: "image/png" }],
        isError: false,
      },
    })}\n\n`;

    const { fetchImpl } = scriptedFetch([
      () => rpcResult({}),
      () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]);

    const images = await buildGenerator(fetchImpl).generate(INPUT);
    expect(images).toHaveLength(1);
    expect(images[0]?.bytes.toString("base64")).toBe(PNG_ONE_PIXEL);
  });
});

describe("magpie 图片 MCP 失败分类", () => {
  it("AC-06-9 上游 401 归为 UPSTREAM_AUTH，消息里没有密钥", async () => {
    const { fetchImpl } = scriptedFetch([() => jsonResponse({ error: "unauthorized" }, { status: 401 })]);

    const error = await buildGenerator(fetchImpl)
      .generate(INPUT)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_AUTH" });
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it("上游 500 归为 UPSTREAM_TIMEOUT，消息里没有密钥", async () => {
    const { fetchImpl } = scriptedFetch([() => jsonResponse({ error: "boom" }, { status: 500 })]);

    const error = await buildGenerator(fetchImpl)
      .generate(INPUT)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it("上游 400 归为 UPSTREAM_REJECTED", async () => {
    const { fetchImpl } = scriptedFetch([() => jsonResponse({ error: "bad" }, { status: 400 })]);

    await expect(buildGenerator(fetchImpl).generate(INPUT)).rejects.toMatchObject({
      code: "UPSTREAM_REJECTED",
    });
  });

  it("JSON-RPC 的 error 字段归为 UPSTREAM_REJECTED，带上游码与说明", async () => {
    const { fetchImpl } = scriptedFetch([
      () => rpcResult({}),
      () => jsonResponse({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "no tool generate_image" } }),
    ]);

    await expect(buildGenerator(fetchImpl).generate(INPUT)).rejects.toMatchObject({
      code: "UPSTREAM_REJECTED",
      message: expect.stringContaining("no tool generate_image") as unknown as string,
    });
  });

  it("返回非 JSON-RPC 时归为 UPSTREAM_FORMAT", async () => {
    const { fetchImpl } = scriptedFetch([() => new Response("<html>oops</html>", { status: 200 })]);

    await expect(buildGenerator(fetchImpl).generate(INPUT)).rejects.toMatchObject({
      code: "UPSTREAM_FORMAT",
    });
  });
});
