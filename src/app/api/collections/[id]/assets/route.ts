import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { readMultipart } from "@/modules/media-collection/form";
import { addCollectionAssets } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/** 追加原始图片（multipart，可多张）：类型与大小逐张校验，全部合格才落库。 */
export const POST = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const { files } = await readMultipart(request);
  return okResponse(await addCollectionAssets(id, files), 201);
});
