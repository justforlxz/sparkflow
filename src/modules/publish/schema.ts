/**
 * 发布模块的请求校验（docs/prd/08「数据与接口」）。
 * 长度上限复用创作结果的护栏常量，不在发布模块另造一套口径。
 */
import { z } from "zod";
import { MAX_TAGS } from "@/modules/copy-generation/constants";
import {
  MAX_RESULT_BODY_LENGTH,
  MAX_SELECTED_ASSET_IDS,
  MAX_RESULT_TAG_LENGTH,
  MAX_RESULT_TITLE_LENGTH,
} from "@/modules/generation/constants";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/modules/media-collection/constants";
import { DEFAULT_PLATFORM, MAX_PLATFORM_LENGTH } from "./constants";

const emptyToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || value === "" ? undefined : value;

/**
 * 标记已发布（`POST /api/results/[id]/publish`）。
 *
 * 标题 / 正文 / 标签就是发布准备弹窗里编辑后的当前内容：保存时写回 `generation_result`，
 * 同时把标题存进记录的 `title_snapshot`（AC-08-6）。
 */
export const markPublishedSchema = z.object({
  title: z.string().trim().max(MAX_RESULT_TITLE_LENGTH).default(""),
  body: z.string().max(MAX_RESULT_BODY_LENGTH).default(""),
  tags: z
    .array(z.string().trim().min(1).max(MAX_RESULT_TAG_LENGTH))
    .max(MAX_TAGS)
    .default([]),
  platform: z.string().trim().min(1).max(MAX_PLATFORM_LENGTH).default(DEFAULT_PLATFORM),
  selectedAssetIds: z
    .array(z.string().trim().min(1))
    .min(1, "至少选择一张图片")
    .max(MAX_SELECTED_ASSET_IDS),
});

export type MarkPublishedInput = z.infer<typeof markPublishedSchema>;

/** 发布记录列表（全局页与资源夹页签共用同一组分页参数）。 */
export const listPublishRecordsQuerySchema = z.object({
  // 资源夹主键是 `@default(uuid())`：格式不对的 id 一定查不到资源夹，当作参数不合法处理，
  // 由调用方决定是报错（接口）还是忽略筛选（页面）。
  collectionId: z.preprocess(emptyToUndefined, z.uuid().optional()),
  page: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(1)),
  pageSize: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  ),
});

export type ListPublishRecordsQuery = z.infer<typeof listPublishRecordsQuerySchema>;

/** `GET /api/results/[id]/download?assets=a,b` 的图片选择：缺省表示「全部图片」。 */
export const downloadQuerySchema = z.object({
  assets: z.preprocess(
    emptyToUndefined,
    z.array(z.string().trim().min(1)).optional(),
  ),
});

export type DownloadQuery = z.infer<typeof downloadQuerySchema>;
