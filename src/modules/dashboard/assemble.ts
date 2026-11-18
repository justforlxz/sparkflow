/**
 * 工作台统计的纯逻辑（docs/prd/09-dashboard.md MUST 1）。
 *
 * 四个数字都由各自的模块用一次聚合查询给出，这里只做「组装 + 裁剪最近列表」，
 * 不遍历全量列表算数（MUST NOT），也不产生任何演示数字。
 * 单独成函数是为了让「上限 6 / 4」与「零数据」这两条口径能被单测锁住。
 */
import type { RecentResultView } from "@/modules/generation/recent";
import type { CollectionSummaryView } from "@/modules/media-collection/service";
import { RECENT_COLLECTIONS_LIMIT, RECENT_RESULTS_LIMIT } from "./constants";

/** 四个统计数字（`GET /api/stats` 的前四个字段）。 */
export interface DashboardCounts {
  collections: number;
  pendingGeneration: number;
  pendingPublish: number;
  published: number;
}

/** 统计结果：四个数字 + 两份最近列表，全部来自服务端查询；页面与接口拿到的是同一个形状。 */
export interface DashboardStats extends DashboardCounts {
  recentCollections: CollectionSummaryView[];
  recentResults: RecentResultView[];
}

export function assembleStats(source: DashboardStats): DashboardStats {
  return {
    collections: source.collections,
    pendingGeneration: source.pendingGeneration,
    pendingPublish: source.pendingPublish,
    published: source.published,
    // 查询已经带了 limit；这里再裁一次，保证换实现（比如批量取多了）也不会让首页变长。
    recentCollections: source.recentCollections.slice(0, RECENT_COLLECTIONS_LIMIT),
    recentResults: source.recentResults.slice(0, RECENT_RESULTS_LIMIT),
  };
}
