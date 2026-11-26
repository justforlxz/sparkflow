import { describe, expect, it } from "vitest";
import { StageError } from "@/lib/job-failure";
import { IMAGE_REJECTION_COPY } from "../failure";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  IMAGES_EDITS_PATH,
  IMAGES_PER_CALL,
  MagpieImageGenerator,
  buildImageEditRequest,
  errorCodeForStatus,
  parseImageUrl,
  parseInlineImage,
} from "./magpie-rest";
import { IMAGE_ERROR_CODES, type GenerateImageInput } from "./types";

/**
 * REST 适配器（MKACG-1008）：`POST <baseUrl>/v1/images/edits`，请求体固定带 `watermark: false`。
 *
 * 上游用脚本化 fetch 代替：验证请求形状、回包解释与失败分类，不碰真实网关。
 * 真实连通性（无水印、尺寸、耗时）由验收记录里的人工验证覆盖。
 */

const API_KEY = "sk-test-local-do-not-use-1234";
const DATA_URL = `data:image/jpeg;base64,${Buffer.from("reference-bytes").toString("base64")}`;
const GENERATED = "generated-png-bytes";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function scriptedFetch(
  responses: (() => Response)[],
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    const next = responses.shift();
    if (!next) throw new Error("脚本化的回包不够用");
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function ok(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 成功回包：一张 base64 内联的图（线上还带 `mime_type`）。 */
function generated(b64 = Buffer.from(GENERATED).toString("base64"), mimeType = "image/png"): Response {
  return ok({ created: 1, data: [{ b64_json: b64, mime_type: mimeType }], model: "sensenova-ai/x" });
}

function failed(status: number, message = "upstream said no"): Response {
  return new Response(JSON.stringify({ error: { code: null, message, type: "invalid_request_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function input(overrides: Partial<GenerateImageInput> = {}): GenerateImageInput {
  return { prompt: "提取图案", image: DATA_URL, size: "1536x1152", model: null, ...overrides };
}

function generator(fetchImpl: typeof fetch, overrides: { requestTimeoutMs?: number } = {}) {
  return new MagpieImageGenerator({
    baseUrl: "https://magpie.example.com/",
    apiKey: API_KEY,
    fetchImpl,
    ...overrides,
  });
}

describe("AC-REST-1 请求体固定带 watermark:false，一图对一图", () => {
  it("AC-REST-1 请求体带 watermark:false 与 response_format=b64_json，n=1，images 只有那一张原图", () => {
    const body = buildImageEditRequest(input());

    expect(body[`watermark`]).toBe(false);
    expect(body.response_format).toBe("b64_json");
    expect(body.n).toBe(IMAGES_PER_CALL);
    expect(body.images).toEqual([{ image_url: DATA_URL }]);
  });

  it("AC-REST-1 真的发到 <baseUrl>/v1/images/edits，带 Bearer 密钥", async () => {
    const { fetchImpl, calls } = scriptedFetch([generated]);

    await generator(fetchImpl).generate(input());

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`https://magpie.example.com${IMAGES_EDITS_PATH}`);
    expect(calls[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0].body.watermark).toBe(false);
  });

  it("AC-REST-1 快照没有模型时不出现 model 字段（用网关侧默认图片模型）", () => {
    expect(buildImageEditRequest(input({ model: null }))).not.toHaveProperty("model");
    expect(buildImageEditRequest(input({ model: "sensenova-ai/x" })).model).toBe("sensenova-ai/x");
  });

  it("AC-REST-1 尺寸原样转发，不在这里改写（长宽比由 deriveExtractionSize 推导）", () => {
    expect(buildImageEditRequest(input({ size: "1536x1024" })).size).toBe("1536x1024");
    expect(buildImageEditRequest(input({ size: null }))).not.toHaveProperty("size");
  });

  it("AC-REST-1 一枚回包里带 mime_type 时按它记录，缺省按 image/png", () => {
    expect(parseInlineImage({ data: [{ b64_json: "YWJj", mime_type: "image/webp" }] })?.mimeType).toBe(
      "image/webp",
    );
    expect(parseInlineImage({ data: [{ b64_json: "YWJj" }] })?.mimeType).toBe("image/png");
  });

  it("AC-REST-1 回包字节与 base64 解码结果一致", async () => {
    const [image] = await generator(scriptedFetch([generated]).fetchImpl).generate(input());

    expect(image.bytes.toString()).toBe(GENERATED);
    expect(image.mimeType).toBe("image/png");
  });
});

describe("AC-REST-4 失败分类与可读原因", () => {
  it("AC-REST-4 401 / 403 记 UPSTREAM_AUTH，并指向设置页的 API Key", async () => {
    for (const status of [401, 403]) {
      const error = (await generator(scriptedFetch([() => failed(status)]).fetchImpl)
        .generate(input())
        .catch((caught: unknown) => caught)) as StageError;

      expect(error).toBeInstanceOf(StageError);
      expect(error.code).toBe(IMAGE_ERROR_CODES.auth);
      expect(error.message).toContain("网关鉴权失败");
      expect(error.message).toContain(String(status));
    }
  });

  it("AC-REST-4 5xx 记 UPSTREAM_TIMEOUT，说明「暂时不可用，请稍后重试」", async () => {
    const error = (await generator(scriptedFetch([() => failed(503)]).fetchImpl)
      .generate(input())
      .catch((caught: unknown) => caught)) as StageError;

    expect(error.code).toBe(IMAGE_ERROR_CODES.timeout);
    expect(error.message).toContain("网关暂时不可用");
  });

  it("AC-REST-4 请求超时按 UPSTREAM_TIMEOUT 报出，并写明超时秒数", async () => {
    const timeoutError = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const fetchImpl = (async () => {
      throw timeoutError;
    }) as unknown as typeof fetch;

    const error = (await generator(fetchImpl, { requestTimeoutMs: 300_000 })
      .generate(input())
      .catch((caught: unknown) => caught)) as StageError;

    expect(error.code).toBe(IMAGE_ERROR_CODES.timeout);
    expect(error.message).toContain("300 秒");
  });

  it("AC-REST-4 请求参数被拒记 UPSTREAM_REJECTED，并且不回显上游英文原文", async () => {
    const error = (await generator(
      scriptedFetch([() => failed(400, "invalid size, should be auto or WIDTHxHEIGHT")]).fetchImpl,
    )
      .generate(input())
      .catch((caught: unknown) => caught)) as StageError;

    expect(error.code).toBe(IMAGE_ERROR_CODES.rejected);
    expect(error.message).toBe(`${IMAGE_REJECTION_COPY.request}（HTTP 400）`);
    expect(error.message).not.toContain("invalid size");
  });

  it("AC-REST-4 上游在说模型不存在时，指出要改的是 Agent 绑定的模型", async () => {
    const error = (await generator(
      scriptedFetch([() => failed(404, "token.sensenova.ai: 404 Not Found: model is not found")]).fetchImpl,
    )
      .generate(input())
      .catch((caught: unknown) => caught)) as StageError;

    expect(error.code).toBe(IMAGE_ERROR_CODES.rejected);
    expect(error.message).toBe(`${IMAGE_REJECTION_COPY.model}（HTTP 404）`);
  });

  it("AC-REST-4 回包不是 JSON、或既没有图片也没有地址，记 UPSTREAM_FORMAT", async () => {
    const notJson = (async () =>
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const notJsonError = (await generator(notJson)
      .generate(input())
      .catch((caught: unknown) => caught)) as StageError;
    expect(notJsonError.code).toBe(IMAGE_ERROR_CODES.format);

    const empty = (await generator(scriptedFetch([() => ok({ data: [] })]).fetchImpl)
      .generate(input())
      .catch((caught: unknown) => caught)) as StageError;
    expect(empty.code).toBe(IMAGE_ERROR_CODES.format);
    expect(empty.message).toContain("没有图片内容");
  });

  it("AC-REST-4 状态码到错误子码的映射只有三档，不新增枚举", () => {
    expect(errorCodeForStatus(401)).toBe(IMAGE_ERROR_CODES.auth);
    expect(errorCodeForStatus(403)).toBe(IMAGE_ERROR_CODES.auth);
    expect(errorCodeForStatus(500)).toBe(IMAGE_ERROR_CODES.timeout);
    expect(errorCodeForStatus(400)).toBe(IMAGE_ERROR_CODES.rejected);
  });

  it("AC-REST-4 单次请求默认超时是 5 分钟（实测单张最长 208 秒）", () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(300_000);
  });
});

describe("AC-REST-1 回包只给 URL 时立刻取回字节", () => {
  it("AC-REST-1 回包给 url 时下载它，并按下载响应的 content-type 记录", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => ok({ data: [{ url: "https://files.example.com/a.webp" }] }),
      () =>
        new Response(Buffer.from(GENERATED), {
          status: 200,
          headers: { "content-type": "image/webp" },
        }),
    ]);

    const [image] = await generator(fetchImpl).generate(input());

    expect(calls[1].url).toBe("https://files.example.com/a.webp");
    expect(image.bytes.toString()).toBe(GENERATED);
    expect(image.mimeType).toBe("image/webp");
  });

  it("AC-REST-1 下载回来不是图片（错误页 200）时记 UPSTREAM_FORMAT，不把错误页当成品", async () => {
    const { fetchImpl } = scriptedFetch([
      () => ok({ data: [{ url: "https://files.example.com/a.png" }] }),
      () => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);

    const error = (await generator(fetchImpl)
      .generate(input())
      .catch((caught: unknown) => caught)) as StageError;

    expect(error.code).toBe(IMAGE_ERROR_CODES.format);
    expect(error.message).toContain("不是图片");
  });

  it("AC-REST-1 非 http(s) 的地址直接拒绝", async () => {
    const { fetchImpl, calls } = scriptedFetch([() => ok({ data: [{ url: "file:///etc/passwd" }] })]);

    const error = (await generator(fetchImpl)
      .generate(input())
      .catch((caught: unknown) => caught)) as StageError;

    expect(error.code).toBe(IMAGE_ERROR_CODES.format);
    expect(calls).toHaveLength(1);
  });

  it("AC-REST-1 parseImageUrl 只在给到非空 url 时返回它", () => {
    expect(parseImageUrl({ data: [{ url: " https://a/b.png " }] })).toBe("https://a/b.png");
    expect(parseImageUrl({ data: [{ url: "" }] })).toBeNull();
    expect(parseImageUrl({ data: [{ b64_json: "YWJj" }] })).toBeNull();
    expect(parseImageUrl(null)).toBeNull();
  });
});
