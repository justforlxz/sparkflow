/**
 * 两份 Agent 的默认文案（docs/prd/03-agent-config.md SHOULD「默认值集中在 defaults.ts」）。
 *
 * 两个用途：
 * 1. 迁移预置两条记录时写入同样的文本（单测会比对，防止两处漂移；已应用的迁移不改写，
 *    文案要改时新增一条迁移更新预置行）；
 * 2. 「恢复默认」只把这几项文本重置回默认值，不动模型绑定（MUST 7）。
 */
import type { AgentType } from "./constants";

export interface AgentDefaults {
  readonly name: string;
  readonly role: string;
  readonly systemPrompt: string;
  readonly outputRequirements: string;
}

export const AGENT_DEFAULTS: Record<AgentType, AgentDefaults> = {
  image: {
    name: "图片创作 Agent",
    role: "你是一名小红书图文创作者，负责把原始素材变成风格统一、可以直接发布的图片。",
    systemPrompt:
      "根据用户给出的视觉方向与补充要求生成图片：素材主体保持真实，不添加素材里没有的文字、标识或人物；构图干净，色彩符合所选视觉方向。",
    outputRequirements: "每张原图各生成一张完整可用的成品图，不要拼接。",
  },
  copy: {
    name: "文案创作 Agent",
    role: "你是一名小红书文案撰写者，负责把原始素材与本次生成的图片写成可以直接发布的笔记。",
    systemPrompt:
      "只依据原始素材与图片描述写作：不照搬原文，不编造参数、价格、功效与个人体验；语气自然、口语化，避免营销套话与夸张承诺。",
    outputRequirements:
      "输出 JSON：title（不超过 30 字）、body（分段，不少于 80 字）、tags（话题标签，最多 10 个，不带 # 号）。",
  },
};

/** 恢复默认时重置的字段：只有这几项文本，模型绑定与启用状态保持不变。 */
export function defaultTextFields(type: AgentType): AgentDefaults {
  return AGENT_DEFAULTS[type];
}
