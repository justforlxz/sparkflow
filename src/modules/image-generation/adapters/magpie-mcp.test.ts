import { describe, expect, it } from "vitest";
import {
  GENERATE_IMAGE_TOOL,
  GENERATION_RESULT_TOOL,
  IMAGES_PER_CALL,
  MagpieImageGenerator,
  buildGenerateArguments,
  parseFiles,
  parseInlineImages,
  parsePendingId,
} from "./magpie-mcp";
import type { GenerateImageInput } from "./types";

/**
 * 适配器协议（docs/prd/05「上游接口事实」2026-11-20 线上实测、MUST 1、5、6；AC-05-1、AC-05-3、AC-05-4）：
 * 工具是 `generate_image`（`reference_images` 传 data URL，`n = 1`）与 `generation_result`（按 id 轮询），
 * 不是插件的 `edit_image` / `image_result`。
 *
 * 上游用脚本化 fetch 代替：验证请求形状、回包解释与失败分类，不碰真实网关。
 */

const API_KEY = "sk-test-local-do-not-use-1234";
const DATA_URL = `data:image/jpeg;base64,${Buffer.from("reference-bytes").toString("base64")}`;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function scriptedFetch(responses: (() => Response)[]): { fetchImpl: typeof fetch; calls: Call[] } {
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

function jsonRpc(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** magpie 内置图片 MCP 的成功回包：图片内联在 content 里。 */
function inlineImage(data = "generated-bytes", mimeType = "image/webp"): Response {
  return jsonRpc({
    content: [{ type: "image", data: Buffer.from(data).toString("base64"), mimeType }],
    isError: false,
  });
}

function withFiles(files: unknown[]): Response {
  return jsonRpc({ content: [], isError: false, _meta: { "usemagpie.ai/files": files } });
}

function pending(id: string): Response {
  return jsonRpc({ content: [], isError: false, _meta: { "usemagpie.ai/pending": id } });
}

const INIT = () => jsonRpc({ protocolVersion: "2025-06-18", capabilities: {} });

function input(overrides: Partial<GenerateImageInput> = {}): GenerateImageInput {
  return { prompt: "按原图重绘", image: DATA_URL, size: "1024x1536", model: null, ...overrides };
}

function generator(fetchImpl: typeof fetch): MagpieImageGenerator {
  return new MagpieImageGenerator({
    baseUrl: "https://magpie.example.com/",
    apiKey: API_KEY,
    fetchImpl,
    sleep: async () => {},
  });
}

describe("请求形状（AC-05-1、AC-05-3）", () => {
  it("generate_image：n=1，reference_images 只有那一张原图且是 data URL", () => {
    expect(IMAGES_PER_CALL).toBe(1);
    expect(buildGenerateArguments(input())).toEqual({
      prompt: "按原图重绘",
      n: 1,
      reference_images: [DATA_URL],
      size: "1024x1536",
    });
    expect(GENERATE_IMAGE_TOOL).toBe("generate_image");
    expect(GENERATION_RESULT_TOOL).toBe("generation_result");
  });

  it("没有模型与尺寸时省掉这两个字段；请求发到图片 MCP 端点并带密钥", async () => {
    const { fetchImpl, calls } = scriptedFetch([INIT, () => inlineImage()]);

    await generator(fetchImpl).generate(input({ size: null, model: null }));

    expect(calls[0]?.body.method).toBe("initialize");
    expect(calls[1]?.url).toBe("https://magpie.example.com/mcp/magpie/image");
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    const params = calls[1]?.body.params as { name: string; arguments: Record<string, unknown> };
    expect(params.name).toBe("generate_image");
    expect(params.arguments).not.toHaveProperty("size");
    expect(params.arguments).not.toHaveProperty("model");
  });

  it("有模型时带上 model", () => {
    expect(buildGenerateArguments(input({ model: "img-model" })).model).toBe("img-model");
  });
});

describe("回包解释（MUST 6、AC-05-4）", () => {
  it("内联图片：按回包取字节，mimeType 以回包为准", async () => {
    const { fetchImpl } = scriptedFetch([INIT, () => inlineImage("abc", "image/webp")]);

    const images = await generator(fetchImpl).generate(input());

    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/webp");
    expect(images[0]?.bytes.toString()).toBe("abc");
  });

  it("_meta 里内联的文件直接用 content 里的字节，不重复下载", async () => {
    const result = jsonRpc({
      content: [{ type: "image", data: Buffer.from("inline").toString("base64"), mimeType: "image/png" }],
      isError: false,
      _meta: { "usemagpie.ai/files": [{ url: "https://cdn.example.com/a.png", inline: true }] },
    });
    const { fetchImpl, calls } = scriptedFetch([INIT, () => result]);

    const images = await generator(fetchImpl).generate(input());

    expect(images[0]?.bytes.toString()).toBe("inline");
    expect(calls).toHaveLength(2);
  });

  it("_meta 里只给 URL 的图片：立刻取回字节，content-type 必须是 image/*", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      INIT,
      () => withFiles([{ url: "https://cdn.example.com/a.png", inline: false }]),
      () => new Response("file-bytes", { status: 200, headers: { "content-type": "image/png" } }),
    ]);

    const images = await generator(fetchImpl).generate(input());

    expect(images[0]?.bytes.toString()).toBe("file-bytes");
    expect(images[0]?.mimeType).toBe("image/png");
    expect(calls[2]?.url).toBe("https://cdn.example.com/a.png");
    // 图片 URL 打开不需要鉴权，也不能把网关密钥发给别的域名（MKACG-920 实测）。
    expect(calls[2]?.headers).not.toHaveProperty("authorization");
  });

  it("成品大于 5 MB 时回包只在文字里给 URL：照样下载转存（MKACG-920 AC-MCP-6）", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      INIT,
      () =>
        jsonRpc({
          content: [
            { type: "text", text: "image generated (5.86 MB): https://cdn.example.com/big.png" },
          ],
          isError: false,
        }),
      () => new Response("big-bytes", { status: 200, headers: { "content-type": "image/png" } }),
    ]);

    const images = await generator(fetchImpl).generate(input());

    expect(images).toHaveLength(1);
    expect(images[0]?.bytes.toString()).toBe("big-bytes");
    expect(calls[2]?.url).toBe("https://cdn.example.com/big.png");
    expect(calls[2]?.headers).not.toHaveProperty("authorization");
  });

  it("文字里的 URL 返回的不是图片时按格式异常处理", async () => {
    const { fetchImpl } = scriptedFetch([
      INIT,
      () => jsonRpc({ content: [{ type: "text", text: "see https://cdn.example.com/oops" }], isError: false }),
      () => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);

    await expect(generator(fetchImpl).generate(input())).rejects.toMatchObject({
      code: "UPSTREAM_FORMAT",
    });
  });

  it("URL 返回非图片（错误页）时按格式异常处理，不把错误页当成品落盘", async () => {
    const { fetchImpl } = scriptedFetch([
      INIT,
      () => withFiles([{ url: "https://cdn.example.com/a.png", inline: false }]),
      () => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);

    await expect(generator(fetchImpl).generate(input())).rejects.toMatchObject({
      code: "UPSTREAM_FORMAT",
    });
  });

  it("既没有图也没有 id 时按格式异常处理", async () => {
    const { fetchImpl } = scriptedFetch([INIT, () => jsonRpc({ content: [], isError: false })]);

    await expect(generator(fetchImpl).generate(input())).rejects.toMatchObject({
      code: "UPSTREAM_FORMAT",
    });
  });

  it("解析工具结果的三类字段（单测直接覆盖纯函数）", () => {
    expect(parsePendingId({ _meta: { "usemagpie.ai/pending": " job-1 " } })).toBe("job-1");
    expect(parsePendingId({})).toBeNull();
    expect(
      parseFiles({ _meta: { "usemagpie.ai/files": [{ url: "https://x/a.png", inline: true }] } }),
    ).toEqual([{ url: "https://x/a.png", inline: true }]);
    expect(
      parseInlineImages({
        content: [{ type: "image", data: Buffer.from("x").toString("base64"), mimeType: "image/jpeg" }],
      })[0]?.mimeType,
    ).toBe("image/jpeg");
  });
});

describe("还没画完时轮询 generation_result（AC-05-4）", () => {
  it("先回 pending id 再回图：只调一次 generate_image，之后是 generation_result{id}", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      INIT,
      () => pending("gen-1"),
      () => pending("gen-1"),
      () => inlineImage(),
    ]);

    const images = await generator(fetchImpl).generate(input());

    expect(images).toHaveLength(1);
    const names = calls.slice(1).map((call) => (call.body.params as { name: string }).name);
    expect(names).toEqual(["generate_image", "generation_result", "generation_result"]);
    expect((calls[3]?.body.params as { arguments: unknown }).arguments).toEqual({ id: "gen-1" });
  });

  it("轮询里换了 id 时按格式异常处理，不无限轮询", async () => {
    const { fetchImpl } = scriptedFetch([
      INIT,
      () => pending("gen-1"),
      () => pending("gen-2"),
    ]);

    await expect(generator(fetchImpl).generate(input())).rejects.toMatchObject({
      code: "UPSTREAM_FORMAT",
    });
  });

  it("轮询超出上限时记超时", async () => {
    const { fetchImpl } = scriptedFetch([INIT, () => pending("gen-1"), () => pending("gen-1")]);
    let clock = 0;
    const slow = new MagpieImageGenerator({
      baseUrl: "https://magpie.example.com",
      apiKey: API_KEY,
      fetchImpl,
      sleep: async () => {},
      maxPollMs: 10,
      now: () => (clock += 100),
    });

    await expect(slow.generate(input())).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  });
});

describe("失败分类与中文摘要（MKACG-902、MUST 9）", () => {
  it("工具结果 isError 时记 UPSTREAM_REJECTED，消息是中文且不回显原文", async () => {
    const upstream = 'no image: api.example.cn 400 {"message":"Model does not exist"}';
    const { fetchImpl } = scriptedFetch([
      INIT,
      () => jsonRpc({ content: [{ type: "text", text: upstream }], isError: true }),
    ]);

    const error = await generator(fetchImpl).generate(input()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_REJECTED" });
    const message = (error as Error).message;
    expect(message).toContain("模型");
    for (const fragment of ["Model does not exist", "api.example.cn", "{", "}"]) {
      expect(message).not.toContain(fragment);
    }
  });

  it("401 记 UPSTREAM_AUTH，并指向设置页的 API Key", async () => {
    const { fetchImpl } = scriptedFetch([INIT, () => new Response("unauthorized", { status: 401 })]);

    await expect(generator(fetchImpl).generate(input())).rejects.toMatchObject({
      code: "UPSTREAM_AUTH",
      message: expect.stringContaining("API Key"),
    });
  });

  it("5xx 记 UPSTREAM_TIMEOUT，且不含上游正文", async () => {
    const { fetchImpl } = scriptedFetch([INIT, () => new Response("boom", { status: 503 })]);

    const error = await generator(fetchImpl).generate(input()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect((error as Error).message).not.toContain("boom");
  });

  it("网关没有返回合法 JSON-RPC 时记 UPSTREAM_FORMAT", async () => {
    const { fetchImpl } = scriptedFetch([INIT, () => new Response("<html>oops</html>", { status: 200 })]);

    await expect(generator(fetchImpl).generate(input())).rejects.toMatchObject({
      code: "UPSTREAM_FORMAT",
    });
  });

  it("网络不可达时记 UPSTREAM_TIMEOUT，消息是中文", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const error = await generator(fetchImpl).generate(input()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect((error as Error).message).toContain("无法连接到网关");
  });
});
