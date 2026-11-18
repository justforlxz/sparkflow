/**
 * 视觉方向登记表（docs/prd/05 SHOULD「视觉方向」）：描述集中在这里，
 * 任务参数只传 key，提示词拼装与将来的界面都从这里取（AGENTS.md 硬性规则 1）。
 *
 * 本版本不实现图生图，因此这里没有「参考图」相关项。
 */

export interface VisualStyleDefinition {
  readonly value: string;
  readonly label: string;
  /** 拼进提示词的视觉描述，写成给图片模型看的正向描述。 */
  readonly description: string;
  /** 这个方向的默认尺寸；任务参数可以覆盖。 */
  readonly size: string;
}

/** 默认出图尺寸：竖版（docs/prd/05 SHOULD）。 */
export const DEFAULT_IMAGE_SIZE = "1024x1536";

export const VISUAL_STYLES = [
  {
    value: "fresh",
    label: "清新生活感",
    description: "自然光拍摄、浅色背景、真实生活场景，构图松弛，色调柔和明快，画面有通透的空气感",
    size: DEFAULT_IMAGE_SIZE,
  },
  {
    value: "editorial",
    label: "杂志视觉",
    description: "杂志版面式构图、大面积留白、克制的配色与强对比，主体突出，细节锐利，有编辑感",
    size: DEFAULT_IMAGE_SIZE,
  },
  {
    value: "product",
    label: "产品质感",
    description: "棚拍布光、纯净背景、材质与纹理清晰，边缘干净，商业广告级的质感表现",
    size: "1024x1024",
  },
] as const satisfies readonly VisualStyleDefinition[];


export function findVisualStyle(value: string): VisualStyleDefinition | undefined {
  return VISUAL_STYLES.find((entry) => entry.value === value);
}

/**
 * 拼提示词时用的方向名：认不出的 key 原样使用。
 * 任务参数里的视觉方向是自由字符串（docs/prd/04 只校验形状），
 * 这里不能因为一个陌生 key 就让整个生图阶段失败。
 */
export function visualStyleLabel(value: string): string {
  return findVisualStyle(value)?.label ?? value;
}
