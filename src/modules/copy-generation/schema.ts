/** 请求体校验：生成文案与编辑当前版本（docs/prd/12「接口」表）。 */
import { z } from "zod";
import {
  MAX_BODY_LENGTH,
  MAX_EXTRA_PROMPT_LENGTH,
  MAX_SELECTED_ASSET_IDS,
  MAX_STYLE_KEY_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/limits";
import { MAX_TAGS } from "./constants";

const emptyToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

/** 生成文案：`{ selectedAssetIds, copyStyle, extraPrompt? }`。 */
export const createCopyVersionSchema = z.object({
  selectedAssetIds: z
    .array(z.string().trim().min(1))
    .min(1, "至少选择一张素材")
    .max(MAX_SELECTED_ASSET_IDS),
  copyStyle: z.string().trim().min(1, "请选择文案风格").max(MAX_STYLE_KEY_LENGTH),
  extraPrompt: z.preprocess(emptyToNull, z.string().trim().max(MAX_EXTRA_PROMPT_LENGTH).nullish()),
});

export type CreateCopyVersionInput = z.infer<typeof createCopyVersionSchema>;

/**
 * 编辑当前版本（原地）：三个字段都可选，至少要改一个（docs/prd/12 MUST NOT：编辑不产生新版本）。
 * 长度上限只是护栏，不是产品规则。
 */
export const updateCopyVersionSchema = z
  .object({
    title: z.string().trim().min(1, "标题不能为空").max(MAX_TITLE_LENGTH).optional(),
    body: z.string().trim().min(1, "正文不能为空").max(MAX_BODY_LENGTH).optional(),
    tags: z
      .array(z.string().trim().min(1).max(MAX_TAG_LENGTH))
      .max(MAX_TAGS)
      .optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "至少要修改一个字段",
  });

export type UpdateCopyVersionInput = z.infer<typeof updateCopyVersionSchema>;
