/**
 * 工作台业务层（docs/prd/09-dashboard.md）：`/api/stats` 与首页都只调用这里的函数。
 *
 * 统计口径（写死在这里，页面与接口都不再解释一遍）：
 * - `collections`：媒体资源夹总数。
 * - `pendingGeneration`（待处理）：还没有任何素材的资源夹数。
 * - `pendingPublish`（待发布）：有文案版本、但该版本还没有发布记录的条数。
 * - `published`（已发布）：发布记录数（同一条结果重复标记只有一行）。
 *
 * 每个数字都由它所属的模块给出一次聚合计数（`count`），本模块不遍历列表、不读别人的表
 * （AGENTS.md 硬性规则 2、docs/prd/09 MUST 1 / MUST NOT）。`/api/stats` 一次返回四个数字
 * 与两份最近列表，前端只发一次请求（docs/prd/09 SHOULD）。
 */
import { cache } from "react";
import { countUnpublishedVersions } from "@/modules/copy-generation/service";
import { listRecentVersions } from "@/modules/copy-generation/recent";
import {
  countCollections,
  countDraftCollections,
  listRecentCollections,
} from "@/modules/media-collection/service";
import { countAllPublishRecords } from "@/modules/publish/counts";
import { assembleStats, type DashboardStats } from "./assemble";
import { RECENT_COLLECTIONS_LIMIT, RECENT_RESULTS_LIMIT } from "./constants";

/** 侧栏计数的来源（docs/prd/09 MUST 2）：与工作台前两项统计是同一份数据。
 *  字段名与 `NAV_ITEMS` 的 `badge` 一一对应，见 `src/components/shell/navigation.ts`。 */
export interface NavCounts {
  collections: number;
  pendingGeneration: number;
}

/**
 * 侧栏与工作台共用的两项计数，按请求缓存（React `cache`）：外壳与首页在同一次渲染里
 * 都会读取这两个数字，缓存后只查一次，不会各查一遍（评审意见「同一次请求里算了两遍」）。
 * 缓存只在服务端渲染的请求作用域内生效；接口路由等无渲染上下文的调用照常每次执行。
 */
const loadNavCounts = cache(async (): Promise<NavCounts> => {
  const [collections, pendingGeneration] = await Promise.all([
    countCollections(),
    countDraftCollections(),
  ]);
  return { collections, pendingGeneration };
});

export async function getNavCounts(): Promise<NavCounts> {
  return loadNavCounts();
}

export async function getDashboardStats(): Promise<DashboardStats> {
  // 五项互不依赖，并发发出；每一项都是一次聚合查询或一次带 limit 的列表查询。
  // 「资源夹总数」「待创作」复用侧栏那两份按请求缓存的计数，同一次渲染不会查两遍。
  const [nav, pendingPublish, published, recentCollections, recentResults] = await Promise.all([
    loadNavCounts(),
    countUnpublishedVersions(),
    countAllPublishRecords(),
    listRecentCollections(RECENT_COLLECTIONS_LIMIT),
    listRecentVersions(RECENT_RESULTS_LIMIT),
  ]);

  return assembleStats({
    ...nav,
    pendingPublish,
    published,
    recentCollections,
    recentResults,
  });
}
