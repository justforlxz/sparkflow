/**
 * 提示词拼装（docs/prd/05 SHOULD）：
 * 「Agent 快照的 role / systemPrompt / outputRequirements」+「提取目标」+「提取要求」+「补充要求」。
 *
 * 拼装只有一个入口，便于单测与将来调整文案；提取要求的描述来自 `styles.ts`，
 * 提取目标是资源夹的原文，任务创建时已固化进快照，这里不写死任何一项的内容。
 */
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { extractRequirementLabel, findExtractRequirement } from "./styles";

export interface ImagePromptInput {
  /** 图片提取 Agent 的配置快照。 */
  agents: AgentSnapshot;
  /** 资源夹的提取目标原文（ADR 0009），例如「桌垫的织物纹理」。 */
  extractTarget: string;
  /** 任务参数里的提取要求 key。 */
  extractRequirement: string;
  /** 任务的补充要求；null 表示没有。 */
  extraPrompt: string | null;
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
    `提取目标：${input.extractTarget.trim()}`,
    `提取要求：${requirementLine}`,
    input.agents.outputRequirements ? `输出要求：${input.agents.outputRequirements}` : "",
    input.extraPrompt?.trim() ? `补充要求：${input.extraPrompt.trim()}` : "",
  ];

  return sections
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
    .join("\n\n");
}
