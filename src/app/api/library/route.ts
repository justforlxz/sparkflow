import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { listPoolAssetsQuerySchema } from "@/modules/media-collection/schema";
import { listPoolAssets } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/library`：总资源库（照片池）列表（ADR 0012 第 1 条）。
 * 每张照片带它被归到了哪些资源夹；分页信封与资源夹列表一致。
 */
export const GET = route(async (request) => {
  await requireUser();

  const query = listPoolAssetsQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  return okResponse(await listPoolAssets(query));
});
