/**
 * 提示词拼装（docs/prd/05 MUST 6）：
 * 「Agent 快照的 role / systemPrompt / outputRequirements」+「视觉方向」+「补充要求」。
 *
 * 拼装只有一个入口，便于单测与将来调整文案；视觉方向的描述来自 `styles.ts`，
 * 这里不写死任何方向的内容。
 */
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { findVisualStyle, visualStyleLabel } from "./styles";

export interface ImagePromptInput {
  /** 图片创作 Agent 的配置快照。 */
  agents: AgentSnapshot;
  /** 任务参数里的视觉方向 key。 */
  visualStyle: string;
  /** 任务的补充要求；null 表示没有。 */
  extraPrompt: string | null;
}

/** 空行分段，空字段整段跳过：不让提示词里出现「补充要求：」这种没有内容的标题。 */
export function buildImagePrompt(input: ImagePromptInput): string {
  const style = findVisualStyle(input.visualStyle);
  const styleLine = style
    ? `${style.label}——${style.description}`
    : visualStyleLabel(input.visualStyle);

  const sections = [
    input.agents.role,
    input.agents.systemPrompt,
    `视觉方向：${styleLine}`,
    input.agents.outputRequirements ? `输出要求：${input.agents.outputRequirements}` : "",
    input.extraPrompt?.trim() ? `补充要求：${input.extraPrompt.trim()}` : "",
  ];

  return sections
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
    .join("\n\n");
}
