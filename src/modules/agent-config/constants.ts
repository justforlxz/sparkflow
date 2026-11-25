/**
 * 固定 Agent 的登记表（docs/prd/03-agent-config.md MUST 1、MUST 2）。
 *
 * 类型、显示名称与「可选模型能力」都在这里：新增一个类型只改这一处，
 * 页面、接口与校验都从模块常量取，不在组件里写死（AGENTS.md 硬性规则 1）。
 */
import type { ModelCapability } from "@/modules/gateway/constants";

/**
 * 固定类型（ADR 0012 第 3 条下线文案创作 Agent 后只剩图片提取）：用户不能新增或删除。
 * 类型值同时出现在接口路径与数据库主键里，所以写成显式联合，编译器可据此检查穷尽性。
 */
export type AgentType = "image";

export interface AgentTypeDefinition {
  /** 存库的固定类型值。 */
  readonly value: AgentType;
  /** 界面与「网关被引用」提示里用的名字。 */
  readonly label: string;
  /** 这个 Agent 负责什么（设置页卡片说明）。 */
  readonly description: string;
  /** 允许绑定的模型能力（MUST 2）：图片提取 Agent 只列出图模型。 */
  readonly capabilities: readonly ModelCapability[];
  /**
   * 模型留空时界面上的说法：图片提取 Agent 是「使用网关默认图片模型」（AC-03-3）。
   * 界面与状态行都直接取这一句，不再另写一份。
   */
  readonly emptyModelLabel: string;
}

export const AGENT_TYPES = [
  {
    value: "image",
    label: "图片提取 Agent",
    description: "从原始素材里把指定目标提取成可直接使用的素材图。模型可以留空，表示用网关侧的默认图片模型。",
    capabilities: ["image"],
    emptyModelLabel: "使用网关默认图片模型",
  },
] as const satisfies readonly AgentTypeDefinition[];

/** 类型值，供 zod 枚举与接口校验使用。 */
export const AGENT_TYPE_VALUES = AGENT_TYPES.map((definition) => definition.value) as [
  AgentType,
  ...AgentType[],
];

export function findAgentType(value: string): AgentTypeDefinition | undefined {
  return AGENT_TYPES.find((definition) => definition.value === value);
}
