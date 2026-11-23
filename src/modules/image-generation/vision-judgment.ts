/**
 * 两段式判定的纯逻辑（ADR 0011 第 2 条、docs/prd/12 MUST 2b / 2b-1 / 2d、AC-LIB-16）：
 * 先问视觉模型「这张原图里有没有这个主体」，再决定要不要发起图生图；
 * 以及「输出比例跟随原图」的尺寸推导。
 *
 * 三个函数都是纯的，单测在 `vision-judgment.test.ts`。提示词、解析与尺寸只写这一份：
 * 处理器（`extraction.ts`）与用例都从这里取。
 */
import { findCategory } from "@/modules/extraction/categories";
import { LIBRARY_COPY } from "@/modules/extraction/constants";

/** 产物长边（像素）：短边按原图长宽比取整（ADR 0011 第 4 条）。 */
export const EXTRACTION_LONG_EDGE = 1536;

/**
 * 判定提示词：问「**原图里**有没有该主体」，要求模型用固定的两个词回答。
 *
 * 问题取自类别的 `presenceQuestion`，**不用** `description`（MUST 2b-1、AC-LIB-16）：
 * `description` 描述的是产物形态（摆正、均匀、可平铺、背景干净），拿它当问题问，
 * 模型会判断「这张照片是不是已处理好的成品」，斜拍原图一律答「不存在」——2026-11-23 真机就是这样。
 *
 * 为什么必须固定措辞：解析器只认这两个词。模型答别的（「看起来像」「应该是」）时我们
 * 无法区分「没有」与「没看懂」，此时按失败处理比猜一个结论安全 —— 猜错就是幻觉素材。
 */
export function buildExistencePrompt(category: string): string {
  const definition = findCategory(category);
  // 认不出的 key 拼一个同形状的问题，而不是把裸 key 直接塞进句子。
  const question = definition ? definition.presenceQuestion : `这张照片里是否存在「${category}」？`;
  return [
    question,
    `只回答「${LIBRARY_COPY.verdictPresent}」或「${LIBRARY_COPY.verdictAbsent}」；`,
    `回答「${LIBRARY_COPY.verdictPresent}」时再用一句话说明它在画面里的位置。`,
  ].join("");
}

export interface ExistenceVerdict {
  /** 目标是否存在。 */
  exists: boolean;
  /** 模型原话（已归一化空白）：判定为不存在时作为 `skip_reason` 展示给用户。 */
  reason: string;
}

/**
 * 解析判定回复。先认「不存在」再认「存在」—— 前者包含后者，顺序反了会把「不存在」读成「存在」。
 *
 * 两个词都没出现时返回 `null`：调用方按失败处理并如实记录，不替模型下结论。
 */
export function parseExistenceVerdict(text: string): ExistenceVerdict | null {
  const reason = text.replace(/\s+/g, " ").trim();
  if (reason.length === 0) return null;
  if (reason.includes(LIBRARY_COPY.verdictAbsent)) return { exists: false, reason };
  if (reason.includes(LIBRARY_COPY.verdictPresent)) return { exists: true, reason };
  return null;
}

/**
 * 短边的最小值：与「比例 ≤ 3:1」等价 —— 长边 1536 时 1536/3 = 512。
 * 上游要求宽高都落在 [512, 4096]，长边固定 1536 时上界天然满足。
 */
export const MIN_EXTRACTION_EDGE = 512;

/** 上游要求宽高都是 32 的倍数（实测 `1536x1000` / `1537x1024` 都被 400 拒绝）。 */
export const EXTRACTION_EDGE_STEP = 32;

/**
 * 输出尺寸：长边固定 1536，短边按原图长宽比**向下取到 32 的倍数**再夹到 [512, 1536]
 * （MUST 2d、MUST 2d-1、AC-LIB-13、AC-LIB-17）。
 *
 * 上游原文：`width and height should be multiples of 32, width and height should be in
 * [512,4096], and aspect ratio should be within 3:1`。三条约束在这个算式里同时成立：
 * 倍数天然成立、下界 512 保证比例 ≤ 3:1、上界 1536 保证不越界。
 *
 * **MUST NOT** 只做四舍五入 —— 那样短边不是 32 的倍数，真实照片（各种长宽比）会直接 400。
 * 宽高不合法（0、负数、NaN）时退回正方形，不把「读不到尺寸」变成一次上游参数错误。
 */
export function deriveExtractionSize(width: number, height: number): string {
  const valid = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  if (!valid) return `${EXTRACTION_LONG_EDGE}x${EXTRACTION_LONG_EDGE}`;

  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const proportional = (short / long) * EXTRACTION_LONG_EDGE;
  const stepped = Math.floor(proportional / EXTRACTION_EDGE_STEP) * EXTRACTION_EDGE_STEP;
  const scaledShort = Math.min(EXTRACTION_LONG_EDGE, Math.max(MIN_EXTRACTION_EDGE, stepped));

  return width >= height
    ? `${EXTRACTION_LONG_EDGE}x${scaledShort}`
    : `${scaledShort}x${EXTRACTION_LONG_EDGE}`;
}

