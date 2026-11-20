/** 请求体校验：创建任务（docs/prd/04）与编辑结果（docs/prd/07「数据与接口」）。 */
import { z } from "zod";
import { MAX_TAGS } from "@/modules/copy-generation/constants";
import {
  MAX_EXTRA_PROMPT_LENGTH,
  MAX_RESULT_BODY_LENGTH,
  MAX_RESULT_TAG_LENGTH,
  MAX_RESULT_TITLE_LENGTH,
  MAX_STYLE_LENGTH,
} from "./constants";

/**
 * 提取要求与文案风格在这里只校验形状，取值是否合法由各自的登记表判定：
 * 可选值来自图片提取（`image-generation/styles.ts`）与文案创作（`copy-generation/styles.ts`），
 * 本节点不复制一份枚举。提取要求的取值校验在 `service.createTask`（旧三项要被拒绝，AC-EX-3）。
 */
export const createTaskSchema = z.object({
  extractRequirement: z.string().trim().min(1, "请选择提取要求").max(MAX_STYLE_LENGTH),
  copyStyle: z.string().trim().min(1, "请选择文案风格").max(MAX_STYLE_LENGTH),
  // 不再接收 imageCount：成品张数 = 原图张数（ADR 0008）。旧客户端多传的字段被忽略。
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
