/**
 * 图片理解网关的执行客户端（docs/prd/06「视觉提取」、docs/prd/02 `magpie-vision`）：
 * MCP `tools/call` 调 `analyze_image{image, prompt}`，取回一段文字描述。
 *
 * 边界：
 * 1. 只依赖 MCP 工具名与返回结构，不认识具体视觉模型；
 * 2. 图片按 `data:` URL 传入（与出图的 `reference_images` 同一形式）；
 * 3. 上游原文只进日志，错误消息是中文，不写密钥。
 */
import { logger } from "@/lib/logger";
import {
  MCP_PROTOCOL_VERSION,
  parseJsonRpc,
  VISION_MCP_PATH,
  VISION_TOOL,
} from "./adapters/magpie-mcp";

/** 单次识别请求的超时：一张图的分析通常几秒内回，留到 60 秒。 */
export const DEFAULT_VISION_TIMEOUT_MS = 60_000;

const CLIENT_NAME = "sparkflow";
const CLIENT_VERSION = "1.0.0";

export interface VisionClientOptions {
  /** 网关 Base URL（已去掉尾部 `/`）。 */
  baseUrl: string;
  /** 解密后的网关密钥，只用于请求头，不写日志、不进错误消息。 */
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface AnalyzeImageInput {
  /** `data:<mime>;base64,<...>` 形式的图片。 */
  image: string;
  /** 一句话要求（中文），由调用方拼好。 */
  prompt: string;
}

/** 识别失败：消息是中文可读说明，不含上游原文与密钥。 */
export class VisionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "VisionError";
  }
}

interface McpToolResult {
  content?: unknown;
  isError?: unknown;
}

function textOf(result: McpToolResult): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks
    .map((block) => (block as { text?: unknown } | null)?.text)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join("\n")
    .trim();
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class MagpieVisionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;
  private initialized = false;
  private nextRequestId = 1;

  constructor(options: VisionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;
  }

  /** 识别一张图，返回描述文字。同一个实例复用一次 MCP 会话，连续识别多张不重复握手。 */
  async analyzeImage(input: AnalyzeImageInput, options: { signal?: AbortSignal } = {}): Promise<string> {
    const { signal } = options;

    await this.ensureInitialized(signal);

    const result = await this.callTool(
      VISION_TOOL,
      { image: input.image, prompt: input.prompt },
      signal,
    );

    if (result.isError === true) {
      const reason = textOf(result);
      logger.warn("magpie 图片理解 MCP 拒绝了识别请求", { reason });
      throw new VisionError("图片理解网关没能识别这张图");
    }

    const description = textOf(result);
    if (description.length === 0) {
      throw new VisionError("图片理解网关没有返回描述内容");
    }
    return description;
  }

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
      throw new VisionError("图片理解网关的工具结果不是对象");
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
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.apiKey}`,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${VISION_MCP_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextRequestId++, method, params }),
        signal: requestSignal(this.timeoutMs, signal),
      });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      const message =
        name === "TimeoutError" || name === "AbortError"
          ? `调用图片理解网关超时（${Math.round(this.timeoutMs / 1000)} 秒）`
          : "无法连接到图片理解网关";
      throw new VisionError(message, { cause: error });
    }

    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;

    if (response.status === 401 || response.status === 403) {
      throw new VisionError("图片理解网关鉴权失败，请到设置页检查该网关的 API Key");
    }
    if (!response.ok) {
      // 4xx/5xx 的正文可能是上游英文原因：只进日志，不写进错误消息。
      const reason = await response.text().catch(() => "");
      logger.warn("magpie 图片理解 MCP 请求失败", { status: response.status, reason });
      throw new VisionError(`图片理解网关返回 ${response.status}`);
    }

    const bodyText = await response.text().catch(() => "");
    const envelope = parseJsonRpc(bodyText);
    if (!envelope) {
      throw new VisionError("图片理解网关没有返回合法的 JSON-RPC 响应");
    }
    if (envelope.error) {
      logger.warn("magpie 图片理解 MCP 返回 JSON-RPC 错误", {
        code: envelope.error.code ?? null,
        reason: envelope.error.message?.trim() ?? "",
      });
      throw new VisionError("图片理解网关拒绝了这次识别请求");
    }
    return envelope.result;
  }
}
