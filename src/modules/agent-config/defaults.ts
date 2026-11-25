/**
 * 图片提取 Agent 的默认文案（docs/prd/03-agent-config.md SHOULD「默认值集中在 defaults.ts」）。
 *
 * 两个用途：
 * 1. 迁移预置记录时写入同样的文本（单测会比对，防止两处漂移；已应用的迁移不改写，
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
      "只做提取，不做重绘：忠实保留目标自身的纹理、材质、图案与颜色，不美化、不改变结构、不添加原图里没有的元素。几何要求：perfectly flat orthographic view、zero perspective、zero foreshortening；目标内的长线、格线与纹理走向必须 exactly horizontal or vertical；均匀漫射光，no shadows、无高光、无景深线索。去掉与目标无关的场景元素（桌面、道具、背景、反光、边缘阴影），也不要添加原图里没有的文字、水印或标识。这是材质与图案本身，不是场景（This is a material texture, not a scene）。",
    outputRequirements:
      "每张原图各输出一张提取图，画面里只包含提取目标本身；保持目标自身的真实长宽比，不要为了填满画布而拉伸或裁切；目标之外留纯色空边即可；不拼接、不加边框、不添加原图里没有的文字或水印。",
  },
};

/** 恢复默认时重置的字段：只有这几项文本，模型绑定与启用状态保持不变。 */
export function defaultTextFields(type: AgentType): AgentDefaults {
  return AGENT_DEFAULTS[type];
}
