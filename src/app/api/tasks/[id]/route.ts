import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { getTask } from "@/modules/generation/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/** `GET /api/tasks/[id]`：详情（阶段、快照、错误、结果 id）。 */
export const GET = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  return okResponse({ task: await getTask(id) });
});
