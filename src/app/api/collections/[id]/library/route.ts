import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { listLibrary } from "@/modules/extraction/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/** `GET /api/collections/[id]/library`：素材库，按类别分组返回（docs/prd/12「接口」表）。 */
export const GET = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  return okResponse(await listLibrary(id));
});
