/**
 * 资源夹接口的请求校验。创建走 multipart、编辑走 JSON，两者共用同一份字段 schema，
 * 保证页面与接口在不同入口看到的规则一致。
 */
import { z } from "zod";
import {
  COLLECTION_STATUSES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_THUMBNAIL_WIDTH,
} from "./constants";

/** 可选文本：缺省、空串、纯空白都归一成 `null`，便于 `platform` 等字段在库里只有一种「没有值」。 */
function optionalText(label: string, max: number) {
  return z.preprocess(
    (value) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    },
    z.string().max(max, `${label}不超过 ${max} 个字符`).nullable(),
  );
}

const collectionName = z.preprocess(
  (value) => (typeof value === "string" ? value : ""),
  z
    .string()
    .trim()
    .min(1, "请填写资源夹名称")
    .max(100, "资源夹名称不超过 100 个字符"),
);

export const collectionFieldsSchema = z.object({
  name: collectionName,
  platform: optionalText("来源平台", 60),
  sourceUrl: optionalText("来源链接", 2000),
  sourceTitle: optionalText("原始标题", 200),
  sourceBody: optionalText("原始文案", 20000),
  // 没有「提取目标」：类别（material / border）取代了单值目标（ADR 0010、MKACG-938）。
});

export type CollectionFieldsInput = z.infer<typeof collectionFieldsSchema>;

const emptyToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || value === "" ? undefined : value;

export const listCollectionsQuerySchema = z.object({
  q: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .max(100, "搜索关键词不超过 100 个字符")
      .optional(),
  ),
  status: z.preprocess(emptyToUndefined, z.enum(COLLECTION_STATUSES).optional()),
  page: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(1)),
  pageSize: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  ),
});

export type ListCollectionsQuery = z.infer<typeof listCollectionsQuerySchema>;

/**
 * 总资源库列表（`GET /api/library`）的分页参数。
 * 与资源夹列表同一套默认值与上限，界面不必记两个数。
 */
export const listPoolAssetsQuerySchema = z.object({
  page: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(1)),
  pageSize: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  ),
});

export type ListPoolAssetsQuery = z.infer<typeof listPoolAssetsQuerySchema>;

/**
 * `POST /api/collections/[id]/assets` 的请求体：从总资源库挑几张照片加入资源夹。
 * 语义是「建关联」不是「上传」——上传走 `POST /api/collections/[id]/assets/upload`。
 */
export const collectionAssetIdsSchema = z.object({
  assetIds: z
    .array(z.string().min(1, "缺少图片标识"))
    .min(1, "请选择要加入资源夹的照片"),
});

/** `GET /api/files/assets/[assetId]?w=400` 的缩略图宽度。 */
export const thumbnailWidthSchema = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().min(1).max(MAX_THUMBNAIL_WIDTH).optional(),
);

/**
 * 整组保存（`POST /api/collections/[id]/save`）的图片清单。
 * 数组顺序就是保存后每张图片的 `sort_order`：`keep` 保留已有图片、`remove` 解除关联、
 * `add` 指向本次随表单一起上传的文件（multipart 的 `file:<tempKey>` part）。
 */
export const collectionEditAssetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("keep"), assetId: z.string().min(1, "缺少图片标识") }),
  z.object({ kind: z.literal("remove"), assetId: z.string().min(1, "缺少图片标识") }),
  z.object({ kind: z.literal("add"), tempKey: z.string().min(1, "缺少上传文件标识") }),
]);

export const collectionEditAssetsSchema = z.array(collectionEditAssetSchema);

export type CollectionEditAssetInput = z.infer<typeof collectionEditAssetSchema>;
