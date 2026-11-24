import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { readMultipart } from "@/modules/media-collection/form";
import { uploadPoolAssets } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

/**
 * `POST /api/library/assets`：上传到总资源库（multipart，可多张）。
 * 只入池，不建任何资源夹关联 —— 夹内上传走 `POST /api/collections/[id]/assets/upload`。
 */
export const POST = route(async (request) => {
  await requireUser();

  const { files } = await readMultipart(request);
  return okResponse(await uploadPoolAssets(files), 201);
});
