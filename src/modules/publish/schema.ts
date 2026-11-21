/**
 * 发布模块的请求校验（docs/prd/12「接口」表最后一行、docs/prd/08）。
 *
 * 发布的对象是**文案版本**：标题、正文与素材快照都取自版本本身，
 * 请求里只需要平台（默认小红书）。界面在发布前编辑文案时走版本的 PATCH 接口。
 */
import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/modules/media-collection/constants";
import { DEFAULT_PLATFORM, MAX_PLATFORM_LENGTH } from "./constants";

const emptyToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || value === "" ? undefined : value;

/** `POST /api/copy-versions/[id]/publish`。 */
export const markPublishedSchema = z.object({
  platform: z.string().trim().min(1).max(MAX_PLATFORM_LENGTH).default(DEFAULT_PLATFORM),
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
