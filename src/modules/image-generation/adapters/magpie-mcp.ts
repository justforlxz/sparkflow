/**
 * magpie 图片 MCP 适配器（MCP Streamable HTTP，JSON-RPC），端点 `POST <baseUrl>/mcp/magpie/image`。
 *
 * 接口事实见 docs/prd/05「调研结论」与 magpie 的 `internal/gateway/image_mcp.go`：
 *
 * - `generate_image` 约 20 秒内画完就直接回图：图片作为 MCP 的 image content 内联（≤ 5 MiB），
 *   同时在 `_meta["usemagpie.ai/files"]` 里给出每个文件的 URL 与是否内联；
 * - 超过 20 秒回 `_meta["usemagpie.ai/pending"]` 里的 id，要用 `generation_result` 轮询取回；
 * - 网关 URL 只保留 1 小时，所以拿到 URL 也要立刻取回字节（MUST 3）。
 *
 * 本版本不传 `reference_images`（MUST NOT），也不认识视频工具。
 */
import {
  MCP_PATH,
  MCP_PROTOCOL_VERSION,
  parseJsonRpc,
} from "@/modules/gateway/adapters/magpie-mcp";
import { StageError, type GeneratedImage } from "@/modules/generation/types";
import { IMAGE_ERROR_CODES, type GenerateImageInput, type ImageGenerator } from "./types";

const CLIENT_NAME = "sparkflow";
const CLIENT_VERSION = "1.0.0";

/** 单次 HTTP 请求的超时：上游约 20 秒会回 id 或图，留到 60 秒足够。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** 未就绪时的轮询间隔（MUST 4）。 */
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
/** 轮询上限，与任务总超时一致（docs/prd/04 SHOULD 15 分钟）。 */
export const DEFAULT_MAX_POLL_MS = 15 * 60_000;

const GENERATE_IMAGE_TOOL = "generate_image";
const GENERATION_RESULT_TOOL = "generation_result";

/** magpie 在工具结果的 `_meta` 里用这两个键告知「还没好」与「存了哪些文件」。 */
export const PENDING_META_KEY = "usemagpie.ai/pending";
export const FILES_META_KEY = "usemagpie.ai/files";


interface ToolResultMeta {
  [PENDING_META_KEY]?: unknown;
  [FILES_META_KEY]?: unknown;
}

export interface McpToolResult {
  content?: unknown;
  isError?: unknown;
  _meta?: ToolResultMeta;
}

/**
 * `generate_image` 的请求参数（AC-05-2、AC-05-3）：
 * 本版本不传 `reference_images`，快照没有模型时不出现 `model` 字段。
 */
export function buildGenerateArguments(input: GenerateImageInput): Record<string, unknown> {
  const args: Record<string, unknown> = { prompt: input.prompt, n: input.n };
  if (input.size) args.size = input.size;
  if (input.quality) args.quality = input.quality;
  if (input.model) args.model = input.model;
  return args;
}

function contentBlocks(result: McpToolResult): unknown[] {
  return Array.isArray(result.content) ? result.content : [];
}

/** 工具结果里的文字部分：上游把原因写在这里（`isError` 时的错误原因也在其中）。 */
export function joinTextContent(result: McpToolResult): string {
  return contentBlocks(result)
    .map((block) => (block as { text?: unknown } | null)?.text)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join("\n")
    .trim();
}

/** 内联图片（`type: "image"` 的 content 块，data 是 base64）。 */
export function parseInlineImages(result: McpToolResult): GeneratedImage[] {
  const images: GeneratedImage[] = [];

  for (const block of contentBlocks(result)) {
    const entry = block as { type?: unknown; data?: unknown; mimeType?: unknown } | null;
    if (entry?.type !== "image" || typeof entry.data !== "string") continue;
    images.push({
      bytes: Buffer.from(entry.data, "base64"),
      mimeType: typeof entry.mimeType === "string" && entry.mimeType.startsWith("image/")
        ? entry.mimeType
        : "image/png",
    });
  }

  return images;
}

/** 未就绪时回的任务 id（没有就是 null）。 */
export function parsePendingId(result: McpToolResult): string | null {
  const pending = result._meta?.[PENDING_META_KEY];
  return typeof pending === "string" && pending.trim().length > 0 ? pending.trim() : null;
}

export interface MadeFile {
  url: string;
  inline: boolean;
}

/** `_meta` 里登记的文件：内联的已经随 content 回来了，其余要给 URL 下载。 */
export function parseFiles(result: McpToolResult): MadeFile[] {
  const files = result._meta?.[FILES_META_KEY];
  if (!Array.isArray(files)) return [];

  const made: MadeFile[] = [];
  for (const entry of files) {
    const file = entry as { url?: unknown; inline?: unknown } | null;
    if (typeof file?.url !== "string" || file.url.trim().length === 0) continue;
    made.push({ url: file.url.trim(), inline: file.inline === true });
  }
  return made;
}

export interface MagpieMcpOptions {
  /** 网关 Base URL（已去掉尾部 `/`）。 */
  baseUrl: string;
  /** 解密后的网关密钥，只用于请求头，不写日志、不进错误消息。 */
  apiKey: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPollMs?: number;
  now?: () => number;
  /** 单测注入：不必真的等 3 秒。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StageError(IMAGE_ERROR_CODES.timeout, "阶段已中止，停止等待图片"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new StageError(IMAGE_ERROR_CODES.timeout, "阶段已中止，停止等待图片"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 把调用方的 signal 与单次请求超时合成一个 signal（Node 20+ 的 `AbortSignal.any`）。 */
function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function describeFetchFailure(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError") {
    return `请求超时（${Math.round(timeoutMs / 1000)} 秒内没有响应）`;
  }
  if (name === "AbortError") return "请求已中止";
  return "无法连接到网关（地址不可达或网络不通）";
}

export class MagpieMcpImageGenerator implements ImageGenerator {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  private sessionId: string | null = null;
  private initialized = false;
  private nextRequestId = 1;

  constructor(options: MagpieMcpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollMs = options.maxPollMs ?? DEFAULT_MAX_POLL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
  }

  async generate(
    input: GenerateImageInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<GeneratedImage[]> {
    const { signal } = options;

    await this.ensureInitialized(signal);

    const result = await this.callTool(GENERATE_IMAGE_TOOL, buildGenerateArguments(input), signal);
    const images = await this.readImages(result, signal);
    if (images) return images;

    const pendingId = parsePendingId(result);
    if (!pendingId) {
      throw new StageError(
        IMAGE_ERROR_CODES.format,
        "上游既没有返回图片，也没有返回可轮询的任务 id",
      );
    }

    return this.pollGenerationResult(pendingId, signal);
  }

  /**
   * 轮询 `generation_result` 直到拿到图片（MUST 4）。
   * 期间绝不重复调用 `generate_image`：那会重新画一遍并产生新的任务。
   */
  private async pollGenerationResult(id: string, signal?: AbortSignal): Promise<GeneratedImage[]> {
    const deadline = this.now() + this.maxPollMs;

    for (;;) {
      if (this.now() >= deadline) {
        throw new StageError(
          IMAGE_ERROR_CODES.timeout,
          `图片在 ${Math.round(this.maxPollMs / 60_000)} 分钟内仍未生成完成（上游任务 ${id}）`,
        );
      }

      await this.sleep(this.pollIntervalMs, signal);
      const result = await this.callTool(GENERATION_RESULT_TOOL, { id }, signal);
      const images = await this.readImages(result, signal);
      if (images) return images;

      if (parsePendingId(result) !== id) {
        throw new StageError(
          IMAGE_ERROR_CODES.format,
          "上游既没有返回图片，也没有继续报告同一个任务 id",
        );
      }
    }
  }

  /**
   * 读一次工具结果：有图就取回全部字节（内联的直接用，更大的从 URL 下载），
   * 没图返回 null（可能是还没就绪，也可能是上游报错，由调用方判定）。
   */
  private async readImages(
    result: McpToolResult,
    signal?: AbortSignal,
  ): Promise<GeneratedImage[] | null> {
    if (result.isError === true) {
      const reason = joinTextContent(result);
      throw new StageError(
        IMAGE_ERROR_CODES.rejected,
        reason.length > 0 ? `上游拒绝了这次出图请求：${reason}` : "上游拒绝了这次出图请求",
      );
    }

    const inline = parseInlineImages(result);
    const files = parseFiles(result);

    // 没有 _meta 文件清单时，内联图片就是全部产出。
    if (files.length === 0) return inline.length > 0 ? inline : null;

    const images: GeneratedImage[] = [];
    let inlineIndex = 0;

    for (const file of files) {
      if (file.inline && inlineIndex < inline.length) {
        images.push(inline[inlineIndex]);
        inlineIndex += 1;
        continue;
      }
      images.push(await this.download(file.url, signal));
    }

    return images.length > 0 ? images : null;
  }

  /** 从网关 URL 取回字节（MUST 3）：下载失败直接抛错，不能把阶段标成成功。 */
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
      response = await this.fetchImpl(parsed.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${this.apiKey}` },
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
      // 图片 URL 只有 1 小时有效期：过期后网关返回 403/404，要按「地址或鉴权不被接受」
      // 报出来，而不是都记成超时（与 docs/prd/05 的失败分类对齐）。
      const code =
        response.status === 401 || response.status === 403
          ? IMAGE_ERROR_CODES.auth
          : response.status >= 500
            ? IMAGE_ERROR_CODES.timeout
            : IMAGE_ERROR_CODES.rejected;
      throw new StageError(code, `下载生成的图片失败：网关返回 ${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new StageError(IMAGE_ERROR_CODES.format, "下载生成的图片失败：网关返回了空文件");
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    return {
      bytes,
      mimeType: contentType.startsWith("image/") ? contentType : "image/png",
    };
  }

  /** MCP 握手：每个阶段一次。没有会话 id 也继续（magpie 的单次调用不要求会话）。 */
  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;

    await this.postJsonRpc(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
      signal,
    );
    this.initialized = true;
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const result = await this.postJsonRpc("tools/call", { name, arguments: args }, signal);
    if (!result || typeof result !== "object") {
      throw new StageError(IMAGE_ERROR_CODES.format, "上游的工具结果不是对象");
    }
    return result as McpToolResult;
  }

  private async postJsonRpc(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Streamable HTTP 允许服务端用 SSE 回包，两种都要接受。
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.apiKey}`,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: this.nextRequestId++,
      method,
      params,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${MCP_PATH}`, {
        method: "POST",
        headers,
        body,
        signal: requestSignal(this.requestTimeoutMs, signal),
      });
    } catch (error) {
      throw new StageError(
        IMAGE_ERROR_CODES.timeout,
        `调用 magpie 图片 MCP 失败：${describeFetchFailure(error, this.requestTimeoutMs)}`,
        { cause: error },
      );
    }

    // 会话 id 可能在 initialize 的响应头里；没有就沿用空值。
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;

    if (response.status === 401 || response.status === 403) {
      throw new StageError(
        IMAGE_ERROR_CODES.auth,
        `网关鉴权失败（HTTP ${response.status}），请到设置页检查网关 API Key`,
      );
    }
    if (!response.ok) {
      const code = response.status >= 500 ? IMAGE_ERROR_CODES.timeout : IMAGE_ERROR_CODES.rejected;
      const reason = response.status >= 500 ? "网关暂时不可用" : "网关拒绝了请求";
      throw new StageError(code, `${reason}（HTTP ${response.status}）`);
    }

    const bodyText = await response.text().catch(() => "");
    const envelope = parseJsonRpc(bodyText);
    if (!envelope) {
      throw new StageError(IMAGE_ERROR_CODES.format, "网关没有返回合法的 JSON-RPC 响应");
    }
    if (envelope.error) {
      const message = envelope.error.message?.trim() || "没有说明";
      throw new StageError(
        IMAGE_ERROR_CODES.rejected,
        `上游拒绝了请求（${envelope.error.code ?? "未知错误码"}）：${message}`,
      );
    }
    if (envelope.result === undefined) {
      throw new StageError(IMAGE_ERROR_CODES.format, "网关的 JSON-RPC 响应里没有 result");
    }

    return envelope.result;
  }
}
