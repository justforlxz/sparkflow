/**
 * 网关模块的常量登记表（docs/prd/02-model-gateway.md「接口形状与模型能力是两件事」）。
 * 选项集中在模块常量里，页面与路由都从这里取，不在组件里写死（AGENTS.md 硬性规则 1）。
 */

export interface ProtocolDefinition {
  readonly value: string;
  readonly label: string;
  /** 这个形状通常用来干什么（文本 / 图片），只作界面说明，不参与判定。 */
  readonly usage: string;
  /** 端点约定，用于界面提示与文档对照。 */
  readonly endpoint: string;
}

export const GATEWAY_PROTOCOLS = [
  {
    value: "openai-chat",
    label: "OpenAI Chat 兼容",
    usage: "文本",
    endpoint: "POST <baseUrl>/chat/completions",
  },
  {
    value: "anthropic-messages",
    label: "Anthropic Messages 兼容",
    usage: "文本",
    endpoint: "POST <baseUrl>/messages",
  },
  {
    value: "magpie-mcp",
    label: "magpie 图片 MCP",
    usage: "图片",
    endpoint: "POST <baseUrl>/mcp/magpie/image",
  },
] as const satisfies readonly ProtocolDefinition[];

export type GatewayProtocol = (typeof GATEWAY_PROTOCOLS)[number]["value"];

export const GATEWAY_PROTOCOL_VALUES = GATEWAY_PROTOCOLS.map((entry) => entry.value) as [
  GatewayProtocol,
  ...GatewayProtocol[],
];

export function findProtocol(value: string): ProtocolDefinition | undefined {
  return GATEWAY_PROTOCOLS.find((entry) => entry.value === value);
}

export interface CapabilityDefinition {
  readonly value: string;
  readonly label: string;
  /** 谁可以选它，与 docs/prd/03-agent-config.md 的候选过滤规则对应。 */
  readonly hint: string;
}

/**
 * 模型能力标签。「多模态」不作为标签使用：能读图不等于能出图，
 * 把只读图的模型选给图片 Agent 必然失败。
 */
export const MODEL_CAPABILITIES = [
  { value: "text", label: "文本", hint: "能生成文本，文案 Agent 可选" },
  { value: "image", label: "出图", hint: "能输出图片，图片 Agent 候选" },
  { value: "image_input", label: "读图", hint: "能吃图片输入，本版本仅作提示" },
] as const satisfies readonly CapabilityDefinition[];

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number]["value"];

export const MODEL_CAPABILITY_VALUES = MODEL_CAPABILITIES.map((entry) => entry.value) as [
  ModelCapability,
  ...ModelCapability[],
];

export function findCapability(value: string): CapabilityDefinition | undefined {
  return MODEL_CAPABILITIES.find((entry) => entry.value === value);
}

/** 连接测试的失败类别：网络错误 / 鉴权失败 / 配置错误（MUST 6）。 */
export const CONNECTION_FAILURE_KINDS = ["network", "auth", "config"] as const;

export type ConnectionFailureKind = (typeof CONNECTION_FAILURE_KINDS)[number];

/**
 * 连接测试的结论，落库在 `gateway.last_test_status`：成功记 `ok`，失败直接记类别，
 * 这样列表不需要再解析文案就知道上次是哪一类失败。
 */
export const CONNECTION_TEST_OUTCOMES = ["ok", ...CONNECTION_FAILURE_KINDS] as const;

export type ConnectionTestOutcome = (typeof CONNECTION_TEST_OUTCOMES)[number];

/** 失败类别在界面上的说法。 */
export const CONNECTION_FAILURE_LABELS: Record<ConnectionFailureKind, string> = {
  network: "网络错误",
  auth: "鉴权失败",
  config: "配置错误",
};
