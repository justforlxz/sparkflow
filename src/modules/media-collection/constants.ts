/**
 * 媒体资源夹的常量：可接受的图片类型、状态枚举与界面文案（AGENTS.md 硬性规则 1：
 * 选项、枚举与文案集中在这里，不写死在组件或路由里）。
 */

/** MUST 3：只接受这三种图片类型，判断以文件内容为准。 */
export const ACCEPTED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

export type ImageMime = (typeof ACCEPTED_IMAGE_MIME)[number];

/** 落盘文件扩展名由内容判断结果决定，与用户上传时的文件名无关。 */
export const IMAGE_EXTENSION: Record<ImageMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** 原图存储子目录（assets/architecture.md「文件」）。 */
export const ASSET_STORAGE_PREFIX = "media-assets";

/** 资源夹状态是派生值，不落库（docs/prd/01-media-collection.md「数据与接口」）。 */
export const COLLECTION_STATUSES = ["draft", "generating", "has_results", "published"] as const;

export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export const COLLECTION_STATUS_LABELS: Record<CollectionStatus, string> = {
  draft: "待创作",
  generating: "生成中",
  has_results: "待发布",
  published: "已发布",
};

/** 列表分页默认与上限。 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 60;

/** 缩略图请求宽度：网格统一 `?w=400`（docs/prd/07-results.md SHOULD）。 */
export const DEFAULT_THUMBNAIL_WIDTH = 400;
export const MAX_THUMBNAIL_WIDTH = 1600;

export const COLLECTION_COPY = {
  listTitle: "媒体资源夹",
  listSubtitle: "把一次素材收集归档成资源夹，后续所有创作都基于它进行。",
  emptyList: "还没有媒体资源夹。先建一个，把收集到的图片和来源信息存进来。",
  emptySearch: "没有匹配的资源夹。换个关键词或清空筛选试试。",
  emptyAssets: "这个资源夹还没有原始图片。",
  createAction: "新建媒体资源夹",
  editAction: "编辑",
  deleteAction: "删除",
  saveAction: "保存",
  cancelAction: "取消",
  addImagesLabel: "添加图片",
  assetTab: "原始素材",
  sourceSection: "来源信息",
  imagesSection: "原始图片",
  deleteConfirmTitle: "删除这个资源夹？",
  deleteConfirmAction: "确认删除",
  deletingLabel: "删除中…",
  deleteConfirmBody:
    "删除后，它的创作任务、结果与发布记录会一并删除，资源夹内的原始图片文件也会被清理。此操作不可撤销。",
  assetStateSaved: "已保存",
  assetStatePendingAdd: "待添加",
  assetStatePendingRemove: "待移除",
  undoRemove: "撤销移除",
  dropPending: "取消添加",
  searchPlaceholder: "按名称、来源标题或链接搜索",
  statusFilterLabel: "状态",
  allStatuses: "全部状态",
  searchAction: "搜索",
  notFoundSource: "未填写",
} as const;
