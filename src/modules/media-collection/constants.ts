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

/**
 * 资源夹状态是派生值，不落库（docs/prd/01-media-collection.md「数据与接口」）。
 * 文案与发布下线后没有「已发布」状态（ADR 0012 第 3 条、MKACG-976）。
 */
export const COLLECTION_STATUSES = ["draft", "generating", "has_results"] as const;

export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export const COLLECTION_STATUS_LABELS: Record<CollectionStatus, string> = {
  draft: "待处理",
  generating: "生成中",
  has_results: "有结果",
};

/** 列表分页默认与上限。 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 60;

/** 缩略图请求宽度：网格统一 `?w=400`（docs/prd/07-results.md SHOULD）。 */
export const DEFAULT_THUMBNAIL_WIDTH = 400;
export const MAX_THUMBNAIL_WIDTH = 1600;

/**
 * 四角框选与单应矫正的界面文案（MKACG-1001；AGENTS.md 硬性规则 1：文案集中在模块常量里）。
 *
 * 「已校正」与「未校正」必须同时存在：用户要靠它判断这次提取用的是原照片还是矫正后的正视图
 * （AC-QUAD-5、AC-QUAD-7）。
 */
export const QUAD_COPY = {
  /** 原图上打开编辑器的入口。 */
  openAction: "框选四角",
  dialogTitle: "框选四角",
  intro:
    "把四个角拖到图案（或桌面）真正的四个角落。系统按这四个角做透视矫正，产物是原图像素的几何变换，文字与图案不会被重画。",
  kindLegend: "这次框的是哪四个角",
  kindHint: "图案四角：形象设计直接出原样裁切图。桌面四角：俯视图与纹理用矫正图当输入。",
  realSizeLegend: "实际尺寸（可选）",
  realSizeHint: "填了就以它的比例为准，比自动估算更可靠。单位毫米，例如 800 × 400。",
  realSizeWidthLabel: "宽（毫米）",
  realSizeHeightLabel: "高（毫米）",
  aspectLabel: "长宽比",
  /** 估算成功：`1.98 : 1` 这样的形状。 */
  aspectValue: (ratio: number) =>
    ratio >= 1 ? `${ratio.toFixed(2)} : 1` : `1 : ${(1 / ratio).toFixed(2)}`,
  aspectFromManual: "按你填的尺寸",
  aspectFromEstimate: "消失点法估算",
  /** 估算失败时如实说明，并说明**不阻断**后续提取（AC-QUAD-5）。 */
  aspectUnknown: "比例未能估算，将按原图比例输出。不影响继续提取。",
  invalidQuad: "这四个角连成的不是凸四边形（有凹陷或边框交叉），请把四个角拖到四个角落。",
  /** 原图长边偏小时的提示，**不阻止**保存（issue「边界」）。 */
  lowResolution: "分辨率偏低，矫正后可能模糊。",
  saveAction: "保存四角",
  savingAction: "保存中…",
  resetAction: "恢复默认四角",
  clearAction: "清除框选",
  cancelAction: "取消",
  closeAction: "关闭",
  saveFailed: "保存四角失败",
  /** 四角存下了但矫正图没生成：说明原因，四角不丢（issue「存储」节）。 */
  rectifyFailed: (reason: string) => `四个角已保存，但矫正图没有生成：${reason}`,
  /** 原图卡片上的状态角标。 */
  correctedBadge: (kind: string) => `已校正 · ${kind}`,
  uncorrectedBadge: "未校正",
  /** 原图长边低于这个值时提示「分辨率偏低」，不阻止保存。 */
  lowResolutionEdge: 1000,
} as const;

export const COLLECTION_COPY = {
  listTitle: "媒体资源夹",
  listSubtitle: "把一次素材收集归档成资源夹，后续所有创作都基于它进行。",
  emptyList: "还没有媒体资源夹。先建一个，把收集到的图片和来源信息存进来。",
  emptySearch: "没有匹配的资源夹。换个关键词或清空筛选试试。",
  /** 0 张图时的引导态：说明「先建夹后收集素材」是正常路径，并指出下一步做什么（AC-01-2）。 */
  emptyAssets: "这个资源夹还没有原始图片。",
  emptyAssetsHint: "先点「添加」把收集到的图片上传进来，之后再发起一键提取。",
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
    "删除后，它的提取运行与素材会一并删除。原始图片仍留在总资源库，不会被删除。此操作不可撤销。",
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
