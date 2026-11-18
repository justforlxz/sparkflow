import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { deleteResult, updateResult } from "@/modules/generation/results";
import { updateResultSchema } from "@/modules/generation/schema";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/** `PATCH /api/results/[id]`：编辑标题 / 正文 / 标签 / 视觉风格（docs/prd/07 MUST 3）。 */
export const PATCH = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const input = updateResultSchema.parse(await readJson(request));
  return okResponse({ result: await updateResult(id, input) });
});

/** `DELETE /api/results/[id]`：删除整组结果，连带它的发布记录（docs/prd/07 MUST 4）。 */
export const DELETE = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  await deleteResult(id);
  return okResponse({ id });
});
