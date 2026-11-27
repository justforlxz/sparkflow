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
import type { QuadKind, QuadPoints } from "./quad";

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
 * 保存四角框选（`PUT /api/library/assets/[id]/quad`，MKACG-1001）。
 *
 * `points` 是归一化的四点 `[[x,y]×4]`，顺序「左上、右上、右下、左下」；
 * 每个分量都夹在 0–1 —— 拖动只在图上发生，越界坐标一定是界面算错了，直接拒掉。
 * `realSize` 是可选的手输实际尺寸（毫米）：有值时以它的比例为准（AC-QUAD-6）。
 */
const quadCoord = z.number().min(0, "四角坐标必须在图片范围内").max(1, "四角坐标必须在图片范围内");

export const quadPointsSchema = z.tuple([
  z.tuple([quadCoord, quadCoord]),
  z.tuple([quadCoord, quadCoord]),
  z.tuple([quadCoord, quadCoord]),
  z.tuple([quadCoord, quadCoord]),
]);

export const quadRealSizeSchema = z.object({
  width: z.number().int().positive("实际宽度必须是正整数毫米"),
  height: z.number().int().positive("实际高度必须是正整数毫米"),
});

export const saveQuadSchema = z.object({
  kind: z.enum(["surface", "pattern"]),
  points: quadPointsSchema,
  /** 没填或填 null 表示按估算比例；填了就以它为准。 */
  realSize: quadRealSizeSchema.nullable().optional(),
});

/** 保存四角的服务层入参：四点是只读的 4 元组（与 `toQuadPoints` 同一个形状）。 */
export interface SaveQuadInput {
  kind: QuadKind;
  points: QuadPoints;
  realSize: { width: number; height: number } | null;
}

/**
 * 解析请求体。
 *
 * zod 的 `z.tuple` 推出来的是可变元组，服务层用的是只读元组（`QuadPoints`）：
 * 这里做唯一一次形状转换，调用方拿到的就是服务层的类型，不用各自再断言一遍。
 */
export function parseSaveQuadBody(value: unknown): SaveQuadInput {
  const body = saveQuadSchema.parse(value);
  return {
    kind: body.kind,
    points: body.points as unknown as QuadPoints,
    realSize: body.realSize ?? null,
  };
}

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
