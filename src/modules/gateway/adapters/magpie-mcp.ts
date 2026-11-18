/**
 * magpie 图片 MCP（MCP Streamable HTTP，JSON-RPC）。端点 `POST <baseUrl>/mcp/magpie/image`。
 *
 * 连接测试按 docs/prd/02 SHOULD 发两步真实请求：`initialize` 确认端点存在且 key 可用，
 * 再 `tools/list` 确认这个端点上确实挂着 MCP 工具。
 * 这里只做连通性判定，不实现出图调用（属 `docs/prd/05`）。
 */
import { sendProbe } from "./http";
import { ConnectionTestError, type ProbeDeps, type ProbeRequest, type ProbeTarget, type ProtocolAdapter } from "./types";

/** 我们自己开口说话时声明的 MCP 版本；服务端在 `initialize` 回复里给出它选定的版本。 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** 图片 MCP 的端点路径：连接测试与出图共用（docs/prd/02、05）。 */
export const MCP_PATH = "/mcp/magpie/image";
const CLIENT_NAME = "sparkflow";

function baseHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    // Streamable HTTP 允许服务端用 SSE 回包，两种都要接受。
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${apiKey}`,
  };
}

export function buildInitializeRequest(target: ProbeTarget): ProbeRequest {
  return {
    url: `${target.baseUrl}${MCP_PATH}`,
    headers: baseHeaders(target.apiKey),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
      },
    }),
  };
}

export function buildToolsListRequest(target: ProbeTarget, sessionId: string | null): ProbeRequest {
  const headers = baseHeaders(target.apiKey);
  if (sessionId) headers["mcp-session-id"] = sessionId;
  headers["mcp-protocol-version"] = MCP_PROTOCOL_VERSION;
  return {
    url: `${target.baseUrl}${MCP_PATH}`,
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  };
}

export interface JsonRpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** 取最后一条 `data:` 里的 JSON（SSE 回包），否则按整段 JSON 解析。连接测试与出图共用。 */
export function parseJsonRpc(bodyText: string): JsonRpcEnvelope | null {
  const candidates: string[] = [];
  const dataLines = bodyText
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0);

  if (dataLines.length > 0) candidates.push(...dataLines.reverse());
  candidates.push(bodyText.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as JsonRpcEnvelope;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // 换下一个候选。
    }
  }
  return null;
}

export function extractToolNames(envelope: JsonRpcEnvelope): string[] {
  const result = envelope.result as { tools?: unknown } | undefined;
  if (!result || !Array.isArray(result.tools)) return [];
  return result.tools
    .map((tool) => (tool as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === "string");
}

export const magpieMcpAdapter: ProtocolAdapter = {
  protocol: "magpie-mcp",
  async probe(target: ProbeTarget, deps: ProbeDeps = {}): Promise<string> {
    const initialize = await sendProbe(buildInitializeRequest(target), deps);
    const initializeEnvelope = parseJsonRpc(initialize.bodyText);
    if (!initializeEnvelope || initializeEnvelope.error) {
      throw ConnectionTestError.config("MCP 端点没有按 JSON-RPC 回应 initialize，地址可能不对");
    }

    const toolsList = await sendProbe(
      buildToolsListRequest(target, initialize.header("mcp-session-id")),
      deps,
    );
    const toolsEnvelope = parseJsonRpc(toolsList.bodyText);
    if (!toolsEnvelope || toolsEnvelope.error) {
      throw ConnectionTestError.config("MCP 端点没有按 JSON-RPC 回应 tools/list");
    }

    const tools = extractToolNames(toolsEnvelope);
    if (tools.length === 0) {
      throw ConnectionTestError.config("MCP 端点没有返回任何工具，请确认地址是图片 MCP");
    }

    return `MCP 端点可用（${tools.length} 个工具）`;
  },
};
