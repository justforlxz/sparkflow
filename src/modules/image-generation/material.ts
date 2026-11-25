/**
 * 材质描述（MKACG-1000、docs/prd/05「输出形态」）：两段式提示词的第一段。
 *
 * 图生图之前先让视觉模型（`magpie-vision`）对**同一张原图**说一句材质与图案，
 * 再把它作为 `Material: ...` 段拼进生图提示词。同类纹理提取流水线的通行做法：
 * 先描述材质、再把「描述 + 原图」交给图生图，模型不必从零猜材质。
 *
 * 边界：
 * 1. 只描述看到的材质、颜色与图案构成，不评价、不推测用途，避免把评价写进提示词；
 * 2. 拿不到描述就**跳过该段**，不记失败、不阻断提取 —— 它只是一段补充说明，
 *    不该让一条本来能成的素材失败（AC-PROMPT-3）；
 * 3. 提问带固定标记 `MATERIAL_PROMPT_MARK`，mock 适配器据此把这类调用与「存在判定」
 *    分开，不占用判定序号（`mock:vision-absent-at-<n>` 的计数只数判定）。
 *
 * 两个函数都是纯的，单测在 `material.test.ts`。
 */
import { findCategory } from "@/modules/extraction/categories";

/** 材质描述提问的固定开头：同时是 mock 适配器区分两类调用的标记。 */
export const MATERIAL_PROMPT_MARK = "【材质描述】";

/** 描述长度上限：只要一句话，超长截断，不把视觉模型的长篇整段塞进生图提示词。 */
export const MAX_MATERIAL_DESCRIPTION_LENGTH = 160;

/**
 * 材质描述的提问：指着该类别的主体要一句材质与图案说明。
 *
 * 认不出的 key 拼一个同形状的句子，而不是把裸 key 塞进中文句子（历史数据里的陌生值不该让提示词变形）。
 */
export function buildMaterialPrompt(category: string): string {
  const label = findCategory(category)?.label ?? category;
  return [
    `${MATERIAL_PROMPT_MARK}用一句话描述这张原图里「${label}」的材质、颜色与图案构成`,
    "（例如：深灰色织物，表面有细密斜纹）。",
    "只描述看到的材质与图案，不评价好坏，不推测价格或用途。",
  ].join("");
}

/**
 * 把视觉模型的回复收成一句提示词里能用的描述。
 *
 * 空白归一化后为空（模型什么都没回）就返回 `null`，调用方据此跳过 `Material:` 段；
 * 超长截断并补省略号，不半句半句地卡在字中间。
 */
export function parseMaterialDescription(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  if (normalized.length <= MAX_MATERIAL_DESCRIPTION_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_MATERIAL_DESCRIPTION_LENGTH)}…`;
}
