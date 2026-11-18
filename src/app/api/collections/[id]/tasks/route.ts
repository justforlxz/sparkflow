import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { createTaskSchema } from "@/modules/generation/schema";
import { createTask } from "@/modules/generation/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/collections/[id]/tasks`：创建任务（docs/prd/04「数据与接口」）。
 * 同一接口也是「重新生成」的入口：每次调用都新建任务，旧任务与旧结果保留（AC-04-9）。
 * 只写库并立即返回，执行由进程内 worker 推进（MUST 1）。
 */
export const POST = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const input = createTaskSchema.parse(await readJson(request));
  return okResponse({ task: await createTask(id, input) }, 201);
});
