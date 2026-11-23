/**
 * 提取类别的登记表（ADR 0011、docs/prd/05「内置类别」、docs/prd/12 MUST 2、MUST 2b-1）。
 *
 * 内置三类可选类别：`topdown`（桌面俯视图）、`texture`（基本纹理）、`graphic`（形象设计）；
 * `other` 只用于历史数据迁移，界面归到「其他（历史）」，新提取不接受它。
 * 加第四类只改这里一处（AGENTS.md 硬性规则 1）。
 *
 * 类别取代了旧模型的单值「提取目标」（ADR 0010）。每个类别带**两句话**，分别给两个模型看：
 *
 * - `description`：给**生图**模型，描述产物形态（摆正、均匀、可平铺、背景干净），逐字取自 PRD 05 表格；
 * - `presenceQuestion`：给**视觉判定**模型，只问「这张原图里有没有该主体」。
 *
 * 两者**必须分开写**（MUST 2b-1、AC-LIB-16）：2026-11-23 真机把 `description` 当问题问，
 * 三类全判「不存在」——连有图案的桌垫也一样。因为 `description` 写的是产物形态，
 * 模型是在判断「这张照片是不是已经处理好的成品」，斜拍原图当然答「没有」。
 * **MUST NOT** 让两者共用一句话。
 */
export interface ExtractionCategoryDefinition {
  readonly value: string;
  readonly label: string;
  /** 拼进**生图**提示词的提取目标描述，写成给图片模型看的正向描述（产物形态）。 */
  readonly description: string;
  /**
   * 拼进**视觉判定**提示词的问题，只问原图里有没有该主体。
   * 不得出现产物形态的措辞（摆正、均匀、可平铺、背景干净）—— 那会让斜拍原图一律判「不存在」。
   */
  readonly presenceQuestion: string;
  /** 新提取是否可选。历史类别（other）不可选。 */
  readonly selectable: boolean;
}

export const EXTRACTION_CATEGORIES = [
  {
    value: "topdown",
    label: "桌面俯视图",
    description:
      "从正上方看桌面/桌垫的完整画面；去掉桌面上的摆件与杂物，被遮挡处按周围材质补全；保持原画面长宽比；不要透视畸变",
    presenceQuestion: "这张照片里是否拍到了桌垫或桌面本身？",
    selectable: true,
  },
  {
    value: "texture",
    label: "基本纹理",
    description:
      "只取桌垫上重复出现的那一块纹理单元；画面内纹理均匀、边缘可平铺；不要出现桌垫边缘与场景",
    presenceQuestion: "这张照片里的桌垫或桌面上是否能看到重复的材质纹理？",
    selectable: true,
  },
  {
    value: "graphic",
    label: "形象设计",
    description: "只取印刷在桌垫上的图案（卡通人物、插画、物品）；正面俯视、无角度、背景干净",
    presenceQuestion: "这张照片里的桌垫上是否印有图案（卡通人物、插画、物品之类）？",
    selectable: true,
  },
  {
    value: "other",
    label: "其他（历史）",
    description: "历史数据迁移而来的素材，不再用于新的提取",
    // 历史类别不参与新提取（`selectable: false`，服务层会拒绝），这句只是让类型完整；
    // 万一真的走到判定，问法仍是「原图里有没有内容」，不会退化成产物形态描述。
    presenceQuestion: "这张照片里是否有可提取的内容？",
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
