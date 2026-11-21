/** 请求体校验：发起提取（docs/prd/12「接口」表第一行）。 */
import { z } from "zod";
import { MAX_EXTRA_PROMPT_LENGTH, MAX_STYLE_KEY_LENGTH } from "@/lib/limits";
import { MAX_CATEGORIES, MAX_SOURCE_ASSETS } from "./constants";

/**
 * 类别与提取要求的**取值**不在这里判定：可选类别来自 `categories.ts`，提取要求来自
 * `image-generation/styles.ts`，本文件只校验形状，避免复制一份枚举。
 * 取值校验在 `service.createExtraction` 里做，报错时能给出可读的选项名。
 */
export const createExtractionSchema = z.object({
  sourceAssetIds: z
    .array(z.string().trim().min(1))
    .min(1, "至少勾选一张原图")
    .max(MAX_SOURCE_ASSETS),
  categories: z
    .array(z.string().trim().min(1))
    .min(1, "至少选择一个类别")
    .max(MAX_CATEGORIES),
  requirement: z.string().trim().min(1, "请选择提取要求").max(MAX_STYLE_KEY_LENGTH),
  extraPrompt: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(MAX_EXTRA_PROMPT_LENGTH).nullish(),
  ),
});

export type CreateExtractionInput = z.infer<typeof createExtractionSchema>;
