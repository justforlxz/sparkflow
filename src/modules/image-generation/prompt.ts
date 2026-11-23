/**
 * 提取提示词拼装（docs/prd/05 SHOULD、docs/prd/12 MUST 2）：
 * 「Agent 快照的 role / systemPrompt / outputRequirements」+「类别目标」+「提取要求」+「补充要求」。
 *
 * 拼装只有一个入口，便于单测与将来调整文案。类别描述来自 `extraction/categories.ts`，
 * 提取要求的描述来自 `styles.ts`，本文件不写死任何一项的内容。
 */
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { findCategory } from "@/modules/extraction/categories";
import { extractRequirementLabel, findExtractRequirement } from "./styles";

export interface ImagePromptInput {
  /** 图片提取 Agent 的配置快照。 */
  agents: AgentSnapshot;
  /** 本次要提取的类别 key（topdown / texture / graphic），登记在 `extraction/categories.ts`。 */
  category: string;
  /** 提取要求 key（faithful / flatten / dereflect）。 */
  extractRequirement: string;
  /** 补充要求；null 表示没有。 */
  extraPrompt: string | null;
}

/** 类别进提示词的样子：名称加描述；认不出的 key 按原文交给模型，不编造描述。 */
export function describeCategory(value: string): string {
  const category = findCategory(value);
  return category ? `${category.label}——${category.description}` : value;
}

/** 空行分段，空字段整段跳过：不让提示词里出现「补充要求：」这种没有内容的标题。 */
export function buildImagePrompt(input: ImagePromptInput): string {
  const requirement = findExtractRequirement(input.extractRequirement);
  const requirementLine = requirement
    ? `${requirement.label}——${requirement.description}`
    : extractRequirementLabel(input.extractRequirement);

  const sections = [
    input.agents.role,
    input.agents.systemPrompt,
    `提取目标：${describeCategory(input.category)}`,
    `提取要求：${requirementLine}`,
    input.agents.outputRequirements ? `输出要求：${input.agents.outputRequirements}` : "",
    input.extraPrompt?.trim() ? `补充要求：${input.extraPrompt.trim()}` : "",
  ];

  return sections
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
    .join("\n\n");
}
