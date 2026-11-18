/** 创建任务的请求体校验（docs/prd/04-generation-task.md「数据与接口」）。 */
import { z } from "zod";
import {
  MAX_EXTRA_PROMPT_LENGTH,
  MAX_IMAGE_COUNT,
  MAX_STYLE_LENGTH,
  MIN_IMAGE_COUNT,
} from "./constants";

/**
 * 视觉方向与文案风格只校验形状，不校验取值：可选值由图片创作（N6）与文案创作（N7）
 * 的 `styles.ts` 登记，本节点不复制一份枚举。
 */
export const createTaskSchema = z.object({
  visualStyle: z.string().trim().min(1, "请选择视觉方向").max(MAX_STYLE_LENGTH),
  copyStyle: z.string().trim().min(1, "请选择文案风格").max(MAX_STYLE_LENGTH),
  imageCount: z.number().int().min(MIN_IMAGE_COUNT).max(MAX_IMAGE_COUNT),
  extraPrompt: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(MAX_EXTRA_PROMPT_LENGTH).nullish(),
  ),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
