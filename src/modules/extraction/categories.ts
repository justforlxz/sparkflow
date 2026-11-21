/**
 * 提取类别的登记表（ADR 0010 第 2 条、docs/prd/12 MUST 2）。
 *
 * 内置两类可选类别：`material`（材质纹理）与 `border`（边框样式）；`other` 只用于历史数据迁移，
 * 界面归到「其他（历史）」，新提取不接受它。加第三类只改这里一处（AGENTS.md 硬性规则 1）。
 *
 * 类别取代了旧模型的单值「提取目标」（ADR 0010）：每个类别自带一句给图片模型看的目标描述，
 * 提示词按「原图 × 类别」逐项拼装。
 */
export interface ExtractionCategoryDefinition {
  readonly value: string;
  readonly label: string;
  /** 拼进提示词的提取目标描述，写成给图片模型看的正向描述。 */
  readonly description: string;
  /** 新提取是否可选。历史类别（other）不可选。 */
  readonly selectable: boolean;
}

export const EXTRACTION_CATEGORIES = [
  {
    value: "material",
    label: "材质纹理",
    description:
      "把原图里的材质与纹理本身单独取出来：布纹、皮革、木纹、纸感、金属拉丝等表面质感，只要质感，不要场景与道具",
    selectable: true,
  },
  {
    value: "border",
    label: "边框样式",
    description:
      "把原图里的边框样式单独取出来：线宽、颜色、圆角与转角连接方式、包边或描边的结构，只要边框本身",
    selectable: true,
  },
  {
    value: "other",
    label: "其他（历史）",
    description: "历史数据迁移而来的素材，不再用于新的提取",
    selectable: false,
  },
] as const satisfies readonly ExtractionCategoryDefinition[];

/** 新提取可选的类别（`other` 排除在外）。 */
export const SELECTABLE_CATEGORIES = EXTRACTION_CATEGORIES.filter((entry) => entry.selectable);

export function findCategory(value: string): ExtractionCategoryDefinition | undefined {
  return EXTRACTION_CATEGORIES.find((entry) => entry.value === value);
}

/** 认不出的 key 原样使用：历史数据里的陌生值不该让整个视图崩掉。 */
export function categoryLabel(value: string): string {
  return findCategory(value)?.label ?? value;
}

export function isSelectableCategory(value: string): boolean {
  return findCategory(value)?.selectable === true;
}
