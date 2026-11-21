import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { deleteLibraryAsset } from "@/modules/extraction/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ assetId: string }>;
}

/**
 * `DELETE /api/library/[assetId]`：删除一张素材（docs/prd/12 MAY）。
 * 引用它的文案版本仍能打开，被删素材显示为「已删除素材」（MUST 4）。
 */
export const DELETE = route<Context>(async (_request, context) => {
  await requireUser();

  const { assetId } = await context.params;
  await deleteLibraryAsset(assetId);
  return okResponse({ id: assetId });
});
