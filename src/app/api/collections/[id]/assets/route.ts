import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { collectionAssetIdsSchema } from "@/modules/media-collection/schema";
import { addAssetsToCollection } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/collections/[id]/assets`：从总资源库挑照片加入资源夹（body `{ assetIds }`）。
 * 语义是「建关联」不是「上传」：幂等，已在夹里的照片跳过（AC-POOL-5）。
 * 夹内上传走 `POST /api/collections/[id]/assets/upload`。
 */
export const POST = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const input = collectionAssetIdsSchema.parse(await readJson(request));
  return okResponse(await addAssetsToCollection(id, input.assetIds));
});
