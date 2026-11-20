/**
 * 提取要求登记表（docs/prd/05「提取目标与提取要求」，ADR 0009）：描述集中在这里，
 * 任务参数只传 key，提示词拼装、取值校验与界面都从这里取（AGENTS.md 硬性规则 1）。
 *
 * 「提取要求」取代原来的「视觉方向」：旧的清新生活感 / 杂志视觉 / 产品质感三项已删除，
 * 新任务只接受下面三项（AC-EX-3）。
 */

export interface ExtractRequirementDefinition {
  readonly value: string;
  readonly label: string;
  /** 拼进提示词的提取描述，写成给图片模型看的正向描述。 */
  readonly description: string;
  /** 这个要求的默认尺寸；任务参数可以覆盖。 */
  readonly size: string;
}

/** 默认出图尺寸：竖版（docs/prd/05 SHOULD）。 */
export const DEFAULT_IMAGE_SIZE = "1024x1536";

export const EXTRACT_REQUIREMENTS = [
  {
    value: "faithful",
    label: "忠实还原",
    description: "不改颜色与结构，只把目标拉平、去透视，保留原本的纹理走向与细微瑕疵",
    size: DEFAULT_IMAGE_SIZE,
  },
  {
    value: "flatten",
    label: "平整化",
    description: "压平褶皱、折痕与光照不均，让纹理均匀铺满画面，可直接当材质使用",
    size: DEFAULT_IMAGE_SIZE,
  },
  {
    value: "dereflect",
    label: "去反光",
    description: "去掉高光、反光与边缘阴影，还原目标真实的颜色与明暗",
    size: DEFAULT_IMAGE_SIZE,
  },
] as const satisfies readonly ExtractRequirementDefinition[];

export function findExtractRequirement(value: string): ExtractRequirementDefinition | undefined {
  return EXTRACT_REQUIREMENTS.find((entry) => entry.value === value);
}

/**
 * 界面与提示词里用的要求名：认不出的 key 原样使用。
 * 任务参数的取值在创建时已按登记表校验过；这里只是不让一个陌生 key 让整个阶段崩掉。
 */
export function extractRequirementLabel(value: string): string {
  return findExtractRequirement(value)?.label ?? value;
}

/**
 * 历史结果行的「视觉风格」存的是旧的视觉方向 key（ADR 0009 不做数据迁移，已有结果按旧语义展示）。
 * 这张表只用于把旧 key 显示成当时的中文名，不参与新任务的取值校验，也不再用于提示词。
 */
const LEGACY_VISUAL_STYLE_LABELS: Record<string, string> = {
  fresh: "清新生活感",
  editorial: "杂志视觉",
  product: "产品质感",
};

/** 结果上的「视觉风格」：新的提取要求与历史视觉方向都要能显示，认不出的 key 原样给出。 */
export function describeResultStyle(value: string): string {
  return findExtractRequirement(value)?.label ?? LEGACY_VISUAL_STYLE_LABELS[value] ?? value;
}
