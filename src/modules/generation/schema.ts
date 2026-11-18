/** 请求体校验：创建任务（docs/prd/04）与编辑结果（docs/prd/07「数据与接口」）。 */
import { z } from "zod";
import { MAX_TAGS } from "@/modules/copy-generation/constants";
import {
  MAX_EXTRA_PROMPT_LENGTH,
  MAX_IMAGE_COUNT,
  MAX_RESULT_BODY_LENGTH,
  MAX_RESULT_TAG_LENGTH,
  MAX_RESULT_TITLE_LENGTH,
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

/**
 * 编辑结果的请求体（docs/prd/07 MUST 3）：四个字段都可选，至少要改一个。
 *
 * 这里的长度上限只是「防止超长输入」的护栏，不是产品规则：标题字数在 PRD 06 与解析器里
 * 本来就有三处不同口径（20 字示例 / 30 字默认要求 / 40 字截断），PL 已定不改，编辑端不再造第四种。
 */
export const updateResultSchema = z
  .object({
    title: z.string().trim().min(1, "标题不能为空").max(MAX_RESULT_TITLE_LENGTH).optional(),
    body: z.string().trim().min(1, "正文不能为空").max(MAX_RESULT_BODY_LENGTH).optional(),
    tags: z
      .array(z.string().trim().min(1).max(MAX_RESULT_TAG_LENGTH))
      // 标签数量与文案解析同一口径（docs/prd/06：最多 10 个），只保留一处定义。
      .max(MAX_TAGS)
      .optional(),
    visualStyle: z.string().trim().min(1).max(MAX_STYLE_LENGTH).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "至少要修改一个字段",
  });

export type UpdateResultInput = z.infer<typeof updateResultSchema>;
