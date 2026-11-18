import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { listPublishRecordsQuerySchema } from "@/modules/publish/schema";
import { listPublishRecords } from "@/modules/publish/service";

export const dynamic = "force-dynamic";

/** `GET /api/publish-records`：全局发布记录，按发布时间倒序，可按资源夹筛选（docs/prd/08）。 */
export const GET = route(async (request) => {
  await requireUser();

  const query = listPublishRecordsQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  return okResponse(await listPublishRecords(query));
});
