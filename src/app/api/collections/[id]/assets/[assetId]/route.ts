import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { removeCollectionAsset } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; assetId: string }>;
}

/** 解除单张原图的关联：只删关联记录，磁盘文件保留（MUST 4）。 */
export const DELETE = route<Context>(async (_request, context) => {
  await requireUser();

  const { id, assetId } = await context.params;
  const collection = await removeCollectionAsset(id, assetId);
  return okResponse(collection);
});
