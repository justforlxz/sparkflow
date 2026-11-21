/**
 * 发布记录的常量与界面文案（AGENTS.md 硬性规则 1：默认值、枚举与文案集中在这里，
 * 不写死在路由或组件里）。依据 docs/prd/08-publish.md、docs/prd/12-asset-library.md。
 */

/** 记录的平台默认取小红书：本版本只服务这一个平台，但平台是数据列而不是代码分支。 */
export const DEFAULT_PLATFORM = "小红书";

/** 平台名称入库前的长度上限（防止把整段粘贴内容写进平台列）。 */
export const MAX_PLATFORM_LENGTH = 40;

export const PUBLISH_COPY = {
  /** 全局页与资源夹页签共用的标题。 */
  pageTitle: "发布记录",
  pageSubtitle: "这里是你手动确认过的发布记录。系统不会自动推断发布成功，也不会对接小红书。",
  collectionTab: "发布记录",
  emptyList: "还没有发布记录。在「发布」页签里准备好文案，再标记为已发布。",
  emptyCollection: "这个资源夹还没有发布记录。",
  publishedAtLabel: "发布时间",
  versionLabel: "版本",
  imageCountLabel: "素材",
  imageCountSuffix: "张",
  sourceCollectionLabel: "来源资源夹",
  platformLabel: "平台",
  filterLabel: "来源资源夹",
  filterAll: "全部资源夹",
  filterAction: "筛选",
  /** 版本卡上的发布状态。 */
  statusPublished: "已发布",
  statusUnpublished: "未发布",
  copyAction: "复制文案",
  copiedNotice: "文案已复制，可以直接粘贴到小红书。",
  copyFailed: "复制失败：浏览器拒绝了剪贴板权限，请手动选择文案复制。",
  markPublishedAction: "标记为已发布",
  markedNotice: "已标记为已发布。",
  markFailed: "标记失败",
  /** 素材被删除后记录里仍保留快照：说明当时选了哪几张。 */
  deletedAssetLabel: "已删除素材",
  closeAction: "关闭",
  noTitle: "（无标题）",
  previousPage: "上一页",
  nextPage: "下一页",
  /** 全局列表尾部的统计行（条数 / 页码 / 每页条数）。 */
  listSummary: (total: number, page: number, pageSize: number) =>
    `共 ${total} 条发布记录 · 第 ${page} 页 · 每页 ${pageSize} 条`,
  /**
   * 水印提示的定稿文案（`docs/prd/05-image-generation.md`「水印提示文案（定稿）」）。
   * 让用户知道成品可能带模型水印；说明不是阻断，不加勾选、不阻止标记发布。
   */
  upstreamWatermarkNotice:
    "素材由你在设置里选择的图片模型生成，可能自带该模型的水印或角标。发布前请确认能否接受；不接受时，可在设置里换一个不加水印的模型重新处理。",
} as const;
