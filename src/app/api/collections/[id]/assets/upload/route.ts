import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { readMultipart } from "@/modules/media-collection/form";
import { uploadCollectionAssets } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/collections/[id]/assets/upload`：夹内上传（multipart，可多张）。
 * 入池 + 建关联一次事务（AC-POOL-6）；只入池不建关联走 `POST /api/library/assets`。
 */
export const POST = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const { files } = await readMultipart(request);
  return okResponse(await uploadCollectionAssets(id, files), 201);
});
