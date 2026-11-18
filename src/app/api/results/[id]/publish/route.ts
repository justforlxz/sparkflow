import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { markPublishedSchema } from "@/modules/publish/schema";
import { markPublished, revokePublished } from "@/modules/publish/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/results/[id]/publish`：标记为已发布（docs/prd/08 接口表）。
 * 幂等：同一结果重复调用只更新已有记录（AC-08-5）；标题快照与所选图片随之更新。
 */
export const POST = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const input = markPublishedSchema.parse(await readJson(request));
  return okResponse({ record: await markPublished(id, input) });
});

/** `DELETE /api/results/[id]/publish`：撤销发布记录；结果与图片不动。 */
export const DELETE = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  await revokePublished(id);
  return okResponse({ resultId: id });
});
