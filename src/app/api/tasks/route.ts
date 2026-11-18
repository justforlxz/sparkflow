import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { listTasks } from "@/modules/generation/service";

export const dynamic = "force-dynamic";

/** `GET /api/tasks`：任务列表，含派生状态与两条阶段的状态（docs/prd/04、07 接口表）。 */
export const GET = route(async () => {
  await requireUser();
  return okResponse({ tasks: await listTasks() });
});
