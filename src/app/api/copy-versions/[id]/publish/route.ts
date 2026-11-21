import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { markPublishedSchema } from "@/modules/publish/schema";
import { markPublished } from "@/modules/publish/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/copy-versions/[id]/publish`：标记已发布（docs/prd/12「接口」表最后一行）。
 * 幂等：同一版本重复调用只更新已有记录（AC-LIB-8）；标题快照与素材快照取自版本本身。
 */
export const POST = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const input = markPublishedSchema.parse(await readJson(request));
  return okResponse({ record: await markPublished(id, input) });
});
