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
    name: "图片提取 Agent",
    role: "你是一名素材提取师：从原始照片里把指定目标（纹理、材质、图案或主体形象）单独提取出来，做成可以直接使用的素材图。",
    systemPrompt:
      "只做提取，不做重绘：忠实保留目标自身的纹理、材质、图案与颜色，不美化、不改变结构、不添加原图里没有的元素；去掉与目标无关的场景元素（桌面、道具、背景、反光、边缘阴影），把目标拉平成正面视角，四边完整、不带透视畸变；不要添加原图里没有的文字、水印或标识。",
    outputRequirements:
      "每张原图各输出一张提取图，画面里只包含提取目标本身；目标居中并铺满画面，边缘干净；不拼接、不加边框、不加文字。",
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
