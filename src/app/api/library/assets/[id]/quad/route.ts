import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { parseSaveQuadBody } from "@/modules/media-collection/schema";
import { clearAssetQuad, saveAssetQuad } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `PUT /api/library/assets/[id]/quad`：保存四角框选并同步生成矫正图
 * （MKACG-1001 AC-QUAD-1、AC-QUAD-4、AC-QUAD-5、AC-QUAD-6）。
 *
 * 幂等：同一个 body 重复提交覆盖同一次框选，矫正图落在同一个 storage_key 上。
 * 矫正失败时四角照常保存，响应里的 `rectifiedError` 说明原因。
 */
export const PUT = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const input = parseSaveQuadBody(await readJson(request));
  return okResponse(await saveAssetQuad(id, input));
});

/** `DELETE /api/library/assets/[id]/quad`：清除框选与矫正图，这张原图回到「未校正」。 */
export const DELETE = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  await clearAssetQuad(id);
  return okResponse({ id });
});
