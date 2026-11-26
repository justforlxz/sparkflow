/**
 * 提取类别的登记表（ADR 0011、docs/prd/05「内置类别」、docs/prd/12 MUST 2、MUST 2b-1、MKACG-1000）。
 *
 * 内置三类可选类别：`topdown`（桌面俯视图）、`texture`（基本纹理）、`graphic`（形象设计）；
 * `other` 只用于历史数据迁移，界面归到「其他（历史）」，新提取不接受它。
 * 加第四类只改这里一处（AGENTS.md 硬性规则 1）。
 *
 * 类别取代了旧模型的单值「提取目标」（ADR 0010）。每个类别带**三句话**，分别给两个模型与用户看：
 *
 * - `description`：给**用户**看，渲染在资源夹详情右栏「提取设置」→「固定三类」列表里，
 *   必须是一句简短中文，**不得**出现提示词工程术语（AC-PROMPT-6）；
 * - `promptDescription`：拼进**生图**提示词，写成给图片模型看的要求。`topdown` / `texture` 写可判定的
 *   几何约束（AC-PROMPT-1、AC-PROMPT-2）；`graphic` 写保真约束（不改文字、不添加元素、不摆正，
 *   MKACG-1016）—— 几何约束会把图生图模型逼成整幅重画，文字随之变乱码；
 * - `presenceQuestion`：给**视觉判定**模型，只问「这张原图里有没有该主体」。
 *
 * 三项都**必须分开写**：
 *
 * 1. 界面说明与提示词描述共用一段文本时，提示词工程术语会直接漏到界面上（2026-11-25 合并前被打回）；
 * 2. 判定问法拿产物形态当问题问，三类会全判「不存在」——连有图案的桌垫也一样（MUST 2b-1、
 *    AC-LIB-16）：`promptDescription` 写的是产物形态，模型会判断「这张照片是不是已经处理好的成品」，
 *    斜拍原图当然答「没有」。
 *
 * **MUST NOT** 让它们共用一句话。
 */
export interface ExtractionCategoryDefinition {
  readonly value: string;
  readonly label: string;
  /** 给**界面**看的简短中文说明，逐字取自 docs/prd/05 的类别表；不得出现提示词工程术语。 */
  readonly description: string;
  /** 拼进**生图**提示词的提取目标描述，写成给图片模型看的正向描述（可判定的几何约束）。 */
  readonly promptDescription: string;
  /**
   * 拼进**视觉判定**提示词的问题，只问原图里有没有该主体。
   * 不得出现产物形态的措辞（摆正、均匀、可平铺、背景干净）—— 那会让斜拍原图一律判「不存在」。
   */
  readonly presenceQuestion: string;
  /** 新提取是否可选。历史类别（other）不可选。 */
  readonly selectable: boolean;
}

/**
 * 只允许出现在提示词里的术语（AC-PROMPT-6）：界面文案一条都不许出现。
 *
 * `topdown` / `texture` 的提示词仍在用这几句正交几何约束；`graphic` 从 MKACG-1016 起改成保真约束，
 * 不再使用其中任何一条 —— 实测「摆正透视」这类指令会把图生图模型逼成整幅重画（文字变乱码、
 * 凭空添标题）。名单保留给仍在用它们的两个类别，界面断言照旧一条都不许出现。
 *
 * 单测（`categories.test.ts`）与端到端用例（`tests/e2e/library.spec.ts`）都从这一份取，
 * 增加术语只改这里一处。
 */
export const PROMPT_ONLY_TERMS = [
  "orthographic",
  "zero perspective",
  "zero foreshortening",
  "exactly horizontal or vertical",
  "This is a material texture, not a scene",
] as const;

/** 界面说明的长度上限：「固定三类」列表在 375px 右栏里显示，太长会挤成一段。 */
export const MAX_CATEGORY_DESCRIPTION_LENGTH = 60;

export const EXTRACTION_CATEGORIES = [
  {
    value: "topdown",
    label: "桌面俯视图",
    description: "从正上方看桌面或桌垫的完整画面，去掉摆件与杂物，被遮挡处按周围材质补全",
    promptDescription:
      "完美平整的俯视图（perfectly flat orthographic view，zero perspective，zero foreshortening）；所有长边与纹理走向必须 exactly horizontal or vertical；均匀漫射光，no shadows、无高光、无景深；去掉桌面上的摆件与杂物，被遮挡处按周围材质补全；保持桌面自身的长宽比，不拉伸、不裁切",
    presenceQuestion: "这张照片里是否拍到了桌垫或桌面本身？",
    selectable: true,
  },
  {
    value: "texture",
    label: "基本纹理",
    description: "只取重复出现的那一块纹理单元，纹理均匀、四边可拼接，不出现桌垫边缘与场景",
    promptDescription:
      "只取重复出现的那一块纹理单元，四边可无缝拼接（matching opposite edges）；这是材质不是场景（This is a material texture, not a scene）；perfectly flat orthographic view，zero perspective，zero foreshortening；所有线与纹理走向必须 exactly horizontal or vertical；均匀漫射光，no shadows、无高光；不要出现桌垫边缘与场景；保持纹理自身的长宽比，不拉伸、不裁切",
    presenceQuestion: "这张照片里的桌垫或桌面上是否能看到重复的材质纹理？",
    selectable: true,
  },
  {
    value: "graphic",
    label: "形象设计",
    description: "只取印刷在桌垫上的图案（卡通人物、插画、物品），文字照原样、背景干净",
    promptDescription:
      "把这张照片里桌垫上印制的图案原样抠出来，铺在纯色背景上。严格保持图案里的一切不变：角色与动物的造型、表情、动作、线条、配色，以及全部文字的字形与拼写，必须与照片里完全一致。不要重新绘制、不要风格化、不要补全、不要添加照片里没有的任何元素（包括标题、边框、装饰、散落的点缀）。保留图案原本的倾斜与透视，不要旋转或摆正。不拉伸、不裁切",
    presenceQuestion: "这张照片里的桌垫上是否印有图案（卡通人物、插画、物品之类）？",
    selectable: true,
  },
  {
    value: "other",
    label: "其他（历史）",
    description: "历史数据迁移而来的素材，不再用于新的提取",
    promptDescription: "历史数据迁移而来的素材，不再用于新的提取",
    // 历史类别不参与新提取（`selectable: false`，服务层会拒绝），这两句只是让类型完整；
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
