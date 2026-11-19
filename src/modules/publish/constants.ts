/**
 * 发布记录的常量与界面文案（AGENTS.md 硬性规则 1：默认值、枚举与文案集中在这里，
 * 不写死在路由或组件里）。依据 docs/prd/08-publish.md。
 */

/** 记录的平台默认取小红书：本版本只服务这一个平台，但平台是数据列而不是代码分支。 */
export const DEFAULT_PLATFORM = "小红书";

/** 平台名称入库前的长度上限（防止把整段粘贴内容写进平台列）。 */
export const MAX_PLATFORM_LENGTH = 40;

/** 打包下载与文案复制都在发布模块内完成，这里是它们的固定参数。 */
export const ZIP_MIME_TYPE = "application/zip";
/** 结果没有标题时 ZIP 用的兜底文件名（标题可能为空，见 docs/prd/06 的 partial 结果）。 */
export const ZIP_FALLBACK_NAME = "发布图片";
/** ZIP 内文件名的序号位数：至少两位，保证 `01-`、`02-` 排序与选中顺序一致（AC-09-10）。 */
export const ZIP_NAME_MIN_DIGITS = 2;

export const PUBLISH_COPY = {
  /** 全局页与资源夹页签共用的标题。 */
  pageTitle: "发布记录",
  pageSubtitle: "这里是你手动确认过的发布记录。系统不会自动推断发布成功，也不会对接小红书。",
  collectionTab: "发布记录",
  emptyList: "还没有发布记录。在「AI 创作结果」里准备好图文，再标记为已发布。",
  emptyCollection: "这个资源夹还没有发布记录。",
  publishedAtLabel: "发布时间",
  imageCountLabel: "图片",
  sourceCollectionLabel: "来源资源夹",
  platformLabel: "平台",
  filterLabel: "来源资源夹",
  filterAll: "全部资源夹",
  filterAction: "筛选",
  /** 结果卡上的发布状态（docs/prd/07 MUST 1：结果项展示发布状态）。 */
  statusPublished: "已发布",
  statusUnpublished: "未发布",
  /** 发布准备弹窗。 */
  prepareAction: "发布准备",
  prepareTitle: "发布准备",
  prepareIntro: "勾选要发布的图片，确认文案后下载或复制，再标记为已发布。",
  selectAllAction: "全选",
  selectNoneAction: "全不选",
  selectImagesLabel: "要发布的图片",
  /**
   * 上游模型生成的图片可能自带水印或角标：结果页签与发布准备各展示一次（MKACG-901 MUST 1）。
   * 只说「可能带」与「发布前请自行确认」，不声称已去除水印、也不把图片说成已校验合格（MUST 2）。
   */
  upstreamWatermarkNotice: "图片由上游模型生成，可能带上游模型自带的水印或角标，发布前请自行确认。",

  /** 弹窗里可编辑的三个文案字段。措辞与结果编辑弹窗一致（AC-FIX-4：只搬位置，不改措辞）。 */
  titleLabel: "标题",
  bodyLabel: "正文",
  tagsLabel: "标签",
  tagsHint: "用逗号或换行分隔",
  downloadAction: "下载所选图片",
  downloadZipHint: "选多张时打包成 ZIP，文件名按勾选顺序编号。",
  copyAction: "复制文案",
  copiedNotice: "文案已复制，可以直接粘贴到小红书。",
  copyFailed: "复制失败：浏览器拒绝了剪贴板权限，请手动选择文案复制。",
  markPublishedAction: "标记为已发布",
  markedNotice: "已标记为已发布。",
  markFailed: "标记失败",
  selectAtLeastOne: "至少选择一张图片",
  closeAction: "关闭",
  // 分享按钮的文案来自功能开关注册表（`share-to-xiaohongshu`），这里不重复写一份。
  noTitle: "（无标题）",
  previousPage: "上一页",
  nextPage: "下一页",
} as const;
