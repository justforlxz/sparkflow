/**
 * 工作台的文案与展示上限（docs/prd/09-dashboard.md MUST 2）。
 * 与其它模块一样，文案集中在常量文件里，页面不写死中文。
 */
export const RECENT_COLLECTIONS_LIMIT = 6;
export const RECENT_RESULTS_LIMIT = 4;

export const DASHBOARD_COPY = {
  title: "工作台",
  subtitle: "内容生产状态一眼看清：多少素材在等创作，多少结果在等发布。",
  statsLabel: "内容生产统计",
  statCollections: "媒体资源夹",
  statCollectionsHint: "已归档的素材夹总数",
  statPendingGeneration: "待创作",
  statPendingGenerationHint: "还没有生成结果的资源夹",
  statPendingPublish: "待发布",
  statPendingPublishHint: "有结果、还没标记发布",
  statPublished: "已发布",
  statPublishedHint: "已标记发布的记录",
  recentCollections: "最近的媒体资源夹",
  recentResults: "最近生成的内容",
  viewAll: "查看全部",
  emptyCollections: "还没有媒体资源夹。先建一个，把收集到的图片和来源信息存进来。",
  emptyResults: "还没有生成内容。选一个资源夹开始创作，结果会出现在这里。",
  emptyResultsAction: "去资源夹看看",
  untitledResult: "未命名结果",
  assetCountLabel: "张原图",
  noCover: "还没有原始图片",
} as const;
