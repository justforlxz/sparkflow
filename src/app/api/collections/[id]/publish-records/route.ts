import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { listPublishRecordsQuerySchema } from "@/modules/publish/schema";
import { listPublishRecords } from "@/modules/publish/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `GET /api/collections/[id]/publish-records`：资源夹内的发布记录（docs/prd/08 接口表）。
 * 与全局列表是同一个 service，只是固定了资源夹条件，两处数据不会出现两份口径。
 */
export const GET = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const query = listPublishRecordsQuerySchema.parse({
    ...Object.fromEntries(new URL(request.url).searchParams),
    collectionId: id,
  });
  return okResponse(await listPublishRecords(query));
});
