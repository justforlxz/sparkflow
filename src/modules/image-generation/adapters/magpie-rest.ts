/**
 * magpie 图片 REST 适配器（OpenAI 兼容）：`POST <baseUrl>/v1/images/edits`。
 *
 * 为什么不再走 MCP 的 `generate_image`（MKACG-1008，2026-11-26 线上实测）：
 *
 * - `generate_image` 的 schema 里**没有** `watermark` 字段（参数只有 background、complexity、
 *   model、n、prompt、quality、reference_images、resolution、size），传了被静默丢弃，
 *   成品右下角始终带「日日新 / senseNova」水印；
 * - REST 的 `/v1/images/generations` 与 `/v1/images/edits` 认 `watermark: false`，实测成品无水印
 *   （纯色提示词出图后，右下角与背景色有差异的像素占比：不传 4.8%，传 false 0.0%）。
 *
 * 端点就挂在现有网关的 `baseUrl` 上，用同一个密钥，协议值仍是 `magpie-mcp`，
 * **用户不需要重新配置网关**（AC-REST-6）。
 *
 * 其余约定沿用 docs/prd/05：一图对一图（ADR 0008）—— 一次 `generate` 只带一张原图，只要一张成品；
 * 尺寸由上层按原图长宽比推导（`deriveExtractionSize`），本适配器原样转发。
 *
 * REST 是**同步**的：实测单张 31–208 秒（1536×1536，含排队）。所以：
 * - 单次请求超时 5 分钟（`DEFAULT_REQUEST_TIMEOUT_MS`），实测值的 1.4 倍以上；
 * - 调用发生在提取 worker 里，不经过 Next.js 的路由处理，**不触发热 route 超时**；
 * - 不在适配器里盲目重试：一次调用已经几十秒到几分钟，重试会把一条运行翻倍，
 *   而 45 分钟的阶段总超时是硬上限。失败按 `IMAGE_ERROR_CODES` 分类记到条目上，
 *   用户在结果格里点「重试」只重跑那一格（ADR 0005）。
 */
import { logger } from "@/lib/logger";
import { StageError } from "@/lib/job-failure";
import { describeImageRejection } from "../failure";
import { IMAGE_ERROR_CODES, type GenerateImageInput, type GeneratedImage, type ImageGenerator } from "./types";

/** 图生图的 REST 路径：拼在网关 `baseUrl` 后面（线上 `https://magpie.mkacg.com`）。 */
export const IMAGES_EDITS_PATH = "/v1/images/edits";

/** 一图对一图固定只要 1 张（ADR 0008）；上游 `n` 上限是 4，这里不放开。 */
export const IMAGES_PER_CALL = 1;

/**
 * 关掉上游水印的请求字段（MKACG-1008 的根因就在这一行）：
 * magpie 的 REST 会把它转给 sensenova，`false` 时成品不带「日日新 / senseNova」水印。
 */
export const WATERMARK_PARAM = "watermark";

/** 要 base64 而不是 URL：URL 只保留约 1 小时，拿到就得立刻取回，不如直接内联。 */
export const RESPONSE_FORMAT = "b64_json";

/**
 * 单次请求超时（MUST 4）：实测单张 31–208 秒，取 5 分钟留出上游排队余量。
 * 超时按 `UPSTREAM_TIMEOUT` 记到条目上，可重试、不静默。
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;

/** 上游没给 `mime_type` 时按响应体默认值处理（实测都是 png）。 */
const FALLBACK_MIME_TYPE = "image/png";

/**
 * `/v1/images/edits` 的请求体（AC-REST-1、AC-REST-2）：
 * 一图对一图 —— `n = 1`，`images` 只有那一张原图（data URL）；`watermark: false` 固定带上。
 * 快照没有模型时不出现 `model` 字段，用网关侧默认图片模型（docs/prd/05 MUST 5）。
 */
export function buildImageEditRequest(input: GenerateImageInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    n: IMAGES_PER_CALL,
    images: [{ image_url: input.image }],
    // 关水印就是这个字段：MCP 通道的 schema 没有它，所以以前传了也没用。
    [WATERMARK_PARAM]: false,
    response_format: RESPONSE_FORMAT,
  };
  if (input.size) body.size = input.size;
  if (input.model) body.model = input.model;
  return body;
}

/** 上游回包里的一个条目：base64 内联，或者一个要自己下载的 URL。 */
interface ImageEntry {
  b64_json?: unknown;
  url?: unknown;
  mime_type?: unknown;
}

/** 取 `data[0]` 及它声明的 MIME；`null` 表示响应体不是约定的形状。 */
export function parseImageEntry(payload: unknown): { entry: ImageEntry; mimeType: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const entry = data[0] as ImageEntry | null;
  if (!entry || typeof entry !== "object") return null;

  const declared = typeof entry.mime_type === "string" ? entry.mime_type.trim().toLowerCase() : "";
  return { entry, mimeType: declared.startsWith("image/") ? declared : FALLBACK_MIME_TYPE };
}

/** 回包里的 base64 图片字节；没有或解不出内容返回 `null`。 */
export function parseInlineImage(payload: unknown): GeneratedImage | null {
  const parsed = parseImageEntry(payload);
  if (!parsed || typeof parsed.entry.b64_json !== "string") return null;
  const bytes = Buffer.from(parsed.entry.b64_json, "base64");
  if (bytes.length === 0) return null;
  return { bytes, mimeType: parsed.mimeType };
}

/** 回包里的图片 URL（`response_format` 不是 b64 时才给）；没有返回 `null`。 */
export function parseImageUrl(payload: unknown): string | null {
  const parsed = parseImageEntry(payload);
  if (!parsed || typeof parsed.entry.url !== "string") return null;
  const url = parsed.entry.url.trim();
  return url.length > 0 ? url : null;
}

/** 从上游回包里取错误说明：REST 把它写在 `error.message`（只用于判定与日志，不回显）。 */
export function parseErrorMessage(bodyText: string): string {
  try {
    const payload = JSON.parse(bodyText) as { error?: { message?: unknown } } | null;
    const message = payload?.error?.message;
    return typeof message === "string" ? message : "";
  } catch {
    return "";
  }
}

export interface MagpieImageOptions {
  /** 网关 Base URL（已去掉尾部 `/`）。 */
  baseUrl: string;
  /** 解密后的网关密钥，只用于请求头，不写日志、不进错误消息。 */
  apiKey: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

function describeFetchFailure(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError") {
    return `请求超时（${Math.round(timeoutMs / 1000)} 秒内没有响应）`;
  }
  if (name === "AbortError") return "请求已中止";
  return "无法连接到网关（地址不可达或网络不通）";
}

/** 把调用方的 signal 与单次请求超时合成一个 signal。 */
function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * 出图失败的业务子码（docs/prd/05 MUST 7）：
 * 401 / 403 是鉴权；5xx 与网络超时按暂时不可用；其余 4xx 是请求被拒（含模型不存在）。
 */
export function errorCodeForStatus(status: number): string {
  if (status === 401 || status === 403) return IMAGE_ERROR_CODES.auth;
  if (status >= 500) return IMAGE_ERROR_CODES.timeout;
  return IMAGE_ERROR_CODES.rejected;
}

export class MagpieImageGenerator implements ImageGenerator {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: MagpieImageOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async generate(
    input: GenerateImageInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<GeneratedImage[]> {
    const { signal } = options;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${IMAGES_EDITS_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(buildImageEditRequest(input)),
        signal: requestSignal(this.requestTimeoutMs, signal),
      });
    } catch (error) {
      throw new StageError(
        IMAGE_ERROR_CODES.timeout,
        `调用 magpie 出图接口失败：${describeFetchFailure(error, this.requestTimeoutMs)}`,
        { cause: error },
      );
    }

    const bodyText = await response.text().catch(() => "");

    if (!response.ok) {
      // 上游原文只进日志（MUST 2）：界面摘要由 `describeImageRejection` 说成中文，
      // 不回显 JSON、英文正文与域名（MKACG-902 MUST 1）。
      const reason = parseErrorMessage(bodyText);
      const code = errorCodeForStatus(response.status);
      logger.warn("magpie 出图接口拒绝了请求", { status: response.status, reason });
      const message =
        code === IMAGE_ERROR_CODES.auth
          ? `网关鉴权失败（HTTP ${response.status}），请到设置页检查网关 API Key`
          : code === IMAGE_ERROR_CODES.timeout
            ? "网关暂时不可用，请稍后重试"
            : describeImageRejection(reason);
      throw new StageError(code, `${message}（HTTP ${response.status}）`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new StageError(IMAGE_ERROR_CODES.format, "网关没有返回合法的 JSON 回包");
    }

    const inline = parseInlineImage(payload);
    if (inline) return [inline];

    const url = parseImageUrl(payload);
    if (url) return [await this.download(url, signal)];

    throw new StageError(
      IMAGE_ERROR_CODES.format,
      "网关的回包里既没有图片内容，也没有可下载的图片地址",
    );
  }

  /** `response_format` 被上游忽略、只给了 URL 时，立刻取回字节（URL 只保留约 1 小时）。 */
  private async download(url: string, signal?: AbortSignal): Promise<GeneratedImage> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new StageError(IMAGE_ERROR_CODES.format, "上游返回的图片地址不是合法 URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new StageError(IMAGE_ERROR_CODES.format, "上游返回的图片地址不是 http(s) 协议");
    }

    let response: Response;
    try {
      // 图片 URL 打开不需要任何 header，也不该把网关密钥发给别的域名。
      response = await this.fetchImpl(parsed.toString(), {
        method: "GET",
        signal: requestSignal(this.requestTimeoutMs, signal),
      });
    } catch (error) {
      throw new StageError(
        IMAGE_ERROR_CODES.timeout,
        `下载生成的图片失败：${describeFetchFailure(error, this.requestTimeoutMs)}`,
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new StageError(
        errorCodeForStatus(response.status),
        `下载生成的图片失败：网关返回 ${response.status}`,
      );
    }

    // 2xx 不代表拿到了图片：错误页同样是 200（MKACG-872）。只收 image/* 的响应。
    const contentType =
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) {
      throw new StageError(
        IMAGE_ERROR_CODES.format,
        `下载生成的图片失败：上游返回的不是图片（content-type: ${contentType || "未提供"}）`,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new StageError(IMAGE_ERROR_CODES.format, "下载生成的图片失败：网关返回了空文件");
    }

    return { bytes, mimeType: contentType };
  }
}
