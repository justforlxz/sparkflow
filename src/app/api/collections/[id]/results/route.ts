import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { listCollectionResults } from "@/modules/generation/results";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/** `GET /api/collections/[id]/results`：该资源夹的全部结果，按创建时间倒序（docs/prd/07）。 */
export const GET = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  return okResponse({ results: await listCollectionResults(id) });
});
