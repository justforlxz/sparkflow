import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { retryTask } from "@/modules/generation/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/tasks/[id]/retry`：只重试失败阶段（ADR 0005、AC-04-6）。
 * 全部成功或阶段仍在排队/执行时返回 `CONFLICT`，不重复入队（AC-04-8、AC-05-12）。
 */
export const POST = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  return okResponse({ task: await retryTask(id) });
});
