import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { getDashboardStats } from "@/modules/dashboard/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/stats`（docs/prd/09-dashboard.md「数据与接口」）。
 *
 * 一次返回两个统计数字与最近资源夹列表：工作台与侧栏计数都读这一份数据，
 * 前端只发一次请求（SHOULD）。数字全部来自服务端聚合查询，不在前端遍历列表算（MUST NOT）。
 * 文案与发布下线后不再返回「待发布」「已发布」与「最近生成的内容」（MKACG-976）。
 */
export const GET = route(async () => {
  await requireUser();
  return okResponse(await getDashboardStats());
});
