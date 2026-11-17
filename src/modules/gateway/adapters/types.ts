/**
 * 适配器契约：每种接口形状一个实现，业务代码只依赖这个接口。
 * 新增一种形状 = `adapters/` 加文件 + 在 `adapters/index.ts` 登记（docs/architecture.md 第 5 节）。
 */
import type { ConnectionFailureKind, GatewayProtocol } from "../constants";

export interface ProbeTarget {
  /** 已归一化（无尾部 `/`）的 Base URL。 */
  baseUrl: string;
  /** 解密后的明文密钥，只在本进程内用于发请求，不写日志、不回响应。 */
  apiKey: string;
  /** 文本协议做最小 chat 调用需要模型；图片 MCP 不需要，可为 null。 */
  modelId: string | null;
}

export interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface ProbeDeps {
  /** 单测注入假 fetch；线上用全局 fetch。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ProbeResponse {
  status: number;
  bodyText: string;
  header: (name: string) => string | null;
}

export interface ProtocolAdapter {
  readonly protocol: GatewayProtocol;
  /** 发真实请求；成功返回可展示的结论，失败抛 `ConnectionTestError`。 */
  probe(target: ProbeTarget, deps?: ProbeDeps): Promise<string>;
}

/**
 * 连接测试失败：带类别（网络错误 / 鉴权失败 / 配置错误），由服务层翻译成结论与文案。
 * 消息里不写请求头、不写密钥、不回显上游响应体（MUST 7）。
 */
export class ConnectionTestError extends Error {
  readonly kind: ConnectionFailureKind;

  constructor(kind: ConnectionFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "ConnectionTestError";
    this.kind = kind;
  }

  static network(message: string, cause?: unknown): ConnectionTestError {
    return new ConnectionTestError("network", message, { cause });
  }

  static auth(message: string): ConnectionTestError {
    return new ConnectionTestError("auth", message);
  }

  static config(message: string): ConnectionTestError {
    return new ConnectionTestError("config", message);
  }
}

export function requireModel(target: ProbeTarget, purpose: string): string {
  if (!target.modelId) {
    throw ConnectionTestError.config(`${purpose}需要先在这个网关的模型清单里添加一个「文本」能力的模型`);
  }
  return target.modelId;
}
