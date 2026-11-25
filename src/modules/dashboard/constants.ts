/**
 * 工作台的文案与展示上限（docs/prd/09-dashboard.md MUST 2）。
 * 与其它模块一样，文案集中在常量文件里，页面不写死中文。
 */
export const RECENT_COLLECTIONS_LIMIT = 6;

export const DASHBOARD_COPY = {
  title: "工作台",
  subtitle: "收集与提取的状态一眼看清：多少资源夹在等处理。",
  statsLabel: "收集与提取统计",
  statCollections: "媒体资源夹",
  statCollectionsHint: "已归档的素材夹总数",
  statPendingGeneration: "待处理",
  statPendingGenerationHint: "还没有素材的资源夹",
  recentCollections: "最近的媒体资源夹",
  viewAll: "查看全部",
  emptyCollections: "还没有媒体资源夹。先建一个，把收集到的图片和来源信息存进来。",
  assetCountLabel: "张原图",
  noCover: "还没有原始图片",
} as const;
